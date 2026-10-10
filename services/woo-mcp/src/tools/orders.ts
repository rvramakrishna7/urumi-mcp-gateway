import { z } from 'zod';
import { dayBounds, isInDay, localDay, widenedAfter, widenedBefore } from '../timezone.ts';
import type { DayBounds } from '../timezone.ts';
import { ToolInputError } from './common.ts';
import type { ToolDefinition } from './common.ts';

const ORDERS_PATH = '/wp-json/wc/v3/orders';

// A date-bounded list is read from WooCommerce in pages of 100 and filtered here, because the exact day
// edges cannot be asked of WooCommerce. This limit keeps one call from reading the whole order history.
const WINDOW_PAGE_SIZE = 100;
const MAX_WINDOW_PAGES = 5;

// The fields of a WooCommerce order that this server reads. Contact fields (email, phone, address), the
// customer note and the IP address are not listed here, so they can never be passed on.
interface WooLineItem {
  name: string;
  product_id: number;
  sku?: string;
  quantity: number;
  subtotal?: string;
  total: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created_gmt: string;
  date_modified_gmt?: string | null;
  date_paid_gmt?: string | null;
  date_completed_gmt?: string | null;
  discount_total?: string;
  shipping_total?: string;
  total_tax?: string;
  payment_method_title?: string;
  created_via?: string;
  billing?: { first_name?: string; last_name?: string };
  line_items?: WooLineItem[];
  shipping_lines?: Array<{ method_title: string; total: string }>;
  coupon_lines?: Array<{ code: string; discount: string }>;
  refunds?: Array<{ id: number; total: string }>;
}

// WooCommerce gives GMT dates without a zone suffix. They are shown as ISO 8601 UTC.
function utc(value: string | null | undefined): string | null {
  return value ? `${value}Z` : null;
}

function billingName(order: WooOrder): string {
  return `${order.billing?.first_name ?? ''} ${order.billing?.last_name ?? ''}`.trim();
}

function toOrderSummary(order: WooOrder) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    total: order.total,
    currency: order.currency,
    date: utc(order.date_created_gmt),
    line_items: (order.line_items ?? []).map((item) => ({
      name: item.name,
      product_id: item.product_id,
      quantity: item.quantity,
      total: item.total,
    })),
    billing_name: billingName(order),
  };
}

const orderStatus = z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']);

const dateSpec = z
  .string()
  .regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/, 'must be "today", "yesterday" or a date in the form YYYY-MM-DD');

const listOrdersSchema = z.strictObject({
  status: orderStatus.optional().describe('Only orders with this status.'),
  date_from: dateSpec.optional().describe('First day to include: "today", "yesterday" or YYYY-MM-DD, in the store timezone.'),
  date_to: dateSpec.optional().describe('Last day to include: "today", "yesterday" or YYYY-MM-DD, in the store timezone.'),
  page: z.number().int().min(1).max(10_000).default(1).describe('Page number, starting at 1.'),
  per_page: z.number().int().min(1).max(50).default(20).describe('Orders per page, 1 to 50.'),
});

// "today" and "yesterday" are days in the store timezone, not in UTC.
function resolveDay(name: string, spec: string, now: Date, timeZone: string): DayBounds {
  const today = localDay(now, timeZone);
  let day = spec;
  if (spec === 'today') day = today;
  if (spec === 'yesterday') day = localDay(new Date(dayBounds(today, timeZone).start.getTime() - 1), timeZone);
  try {
    return dayBounds(day, timeZone);
  } catch {
    throw new ToolInputError(`${name} is not a valid date. Use "today", "yesterday" or YYYY-MM-DD.`);
  }
}

export const listOrders: ToolDefinition<typeof listOrdersSchema> = {
  name: 'list_orders',
  title: 'List orders',
  description:
    'Lists orders of the WooCommerce store, newest first, one page at a time. date_from and date_to are whole days ' +
    'in the store timezone and both are included: "today", "yesterday" or YYYY-MM-DD. Each order has id, number, ' +
    'status, total, currency, date (UTC), line items and the billing name. Email, phone and address are not ' +
    'returned. The answer also gives the total number of matching orders, the store timezone and, when dates ' +
    'were given, the exact UTC window that was searched. For more detail on one order use get_order.',
  inputSchema: listOrdersSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, { woo, now, storeTimezone }) => {
    const from = args.date_from === undefined ? null : resolveDay('date_from', args.date_from, now(), storeTimezone);
    const to = args.date_to === undefined ? null : resolveDay('date_to', args.date_to, now(), storeTimezone);
    const start = from?.start ?? null;
    const end = to?.end ?? null;
    if (start !== null && end !== null && start >= end) {
      throw new ToolInputError('date_from is after date_to. date_from must be the same day or earlier.');
    }

    // No dates: WooCommerce does the paging and its totals are exact.
    if (start === null && end === null) {
      const query: Array<[string, string]> = [
        ['page', String(args.page)],
        ['per_page', String(args.per_page)],
      ];
      if (args.status !== undefined) query.push(['status', args.status]);
      const response = await woo.request<WooOrder[]>('GET', { path: ORDERS_PATH, query });
      return {
        orders: response.data.map(toOrderSummary),
        page: args.page,
        per_page: args.per_page,
        total: response.total,
        total_pages: response.totalPages,
        store_timezone: storeTimezone,
        window: null,
      };
    }

    // Dates: ask WooCommerce for the window widened by one second on each side, in UTC, then filter exactly on
    // date_created_gmt. The totals are counted after that filter, so they are exact. Paging is done here.
    const bounds: DayBounds = { start: start ?? new Date(0), end: end ?? new Date(8.64e15) };
    const baseQuery: Array<[string, string]> = [['dates_are_gmt', 'true'], ['per_page', String(WINDOW_PAGE_SIZE)]];
    if (start !== null) baseQuery.push(['after', widenedAfter(start)]);
    if (end !== null) baseQuery.push(['before', widenedBefore(end)]);
    if (args.status !== undefined) baseQuery.push(['status', args.status]);

    const inWindow: WooOrder[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const response = await woo.request<WooOrder[]>('GET', { path: ORDERS_PATH, query: [...baseQuery, ['page', String(page)]] });
      pages = response.totalPages ?? 1;
      if (pages > MAX_WINDOW_PAGES) {
        throw new ToolInputError(
          `More than ${MAX_WINDOW_PAGES * WINDOW_PAGE_SIZE} orders are in this date range. Use a shorter range or add a status.`,
        );
      }
      inWindow.push(...response.data.filter((order) => isInDay(order.date_created_gmt, bounds)));
    }

    const offset = (args.page - 1) * args.per_page;
    return {
      orders: inWindow.slice(offset, offset + args.per_page).map(toOrderSummary),
      page: args.page,
      per_page: args.per_page,
      total: inWindow.length,
      total_pages: Math.ceil(inWindow.length / args.per_page),
      store_timezone: storeTimezone,
      window: { from_utc: start?.toISOString() ?? null, to_utc: end?.toISOString() ?? null },
    };
  },
};

const getOrderSchema = z.strictObject({
  id: z.number().int().min(1).max(2_147_483_647).describe('The order id, as returned by list_orders.'),
});

export const getOrder: ToolDefinition<typeof getOrderSchema> = {
  name: 'get_order',
  title: 'Get order',
  description:
    'Returns one order of the WooCommerce store by id: status, totals, dates (UTC), payment method, line items with ' +
    'quantity and totals, shipping method, coupons, refunds and the billing name. It does not return email, phone, ' +
    'address or the customer note.',
  inputSchema: getOrderSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, { woo }) => {
    const response = await woo.request<WooOrder>('GET', { path: `${ORDERS_PATH}/${args.id}` });
    const order = response.data;
    return {
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        currency: order.currency,
        date: utc(order.date_created_gmt),
        date_modified: utc(order.date_modified_gmt),
        date_paid: utc(order.date_paid_gmt),
        date_completed: utc(order.date_completed_gmt),
        discount_total: order.discount_total ?? null,
        shipping_total: order.shipping_total ?? null,
        total_tax: order.total_tax ?? null,
        total: order.total,
        payment_method: order.payment_method_title ?? null,
        created_via: order.created_via ?? null,
        billing_name: billingName(order),
        line_items: (order.line_items ?? []).map((item) => ({
          name: item.name,
          sku: item.sku ?? '',
          product_id: item.product_id,
          quantity: item.quantity,
          subtotal: item.subtotal ?? null,
          total: item.total,
        })),
        shipping_lines: (order.shipping_lines ?? []).map((line) => ({ method: line.method_title, total: line.total })),
        coupon_lines: (order.coupon_lines ?? []).map((line) => ({ code: line.code, discount: line.discount })),
        refunds: (order.refunds ?? []).map((refund) => ({ id: refund.id, total: refund.total })),
      },
    };
  },
};

// "refunded" is left out on purpose: WooCommerce creates a refund record for it, and this server does not
// handle refunds. The other statuses are plain labels that WooCommerce can set on any order.
const settableStatus = z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'failed']);

const updateOrderStatusSchema = z.strictObject({
  id: z.number().int().min(1).max(2_147_483_647).describe('The order id, as returned by list_orders.'),
  status: settableStatus.describe('The new status of the order.'),
});

export const updateOrderStatus: ToolDefinition<typeof updateOrderStatusSchema> = {
  name: 'update_order_status',
  title: 'Update order status',
  description:
    'Changes the status of one order in the WooCommerce store: pending, processing, on-hold, completed, cancelled ' +
    'or failed. Returns the previous and the new status. WooCommerce runs its normal actions for a status change, ' +
    'for example stock changes when an order is cancelled and notification emails when it is completed. ' +
    'Refunds cannot be made with this tool. If the order already has the status, nothing is changed.',
  inputSchema: updateOrderStatusSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, { woo }) => {
    const path = `${ORDERS_PATH}/${args.id}`;
    const current = await woo.request<WooOrder>('GET', { path });
    const previous = current.data.status;
    if (previous === args.status) {
      return { id: args.id, previous_status: previous, new_status: previous, changed: false };
    }
    const updated = await woo.request<WooOrder>('PUT', { path, body: { status: args.status } });
    return { id: args.id, previous_status: previous, new_status: updated.data.status, changed: true };
  },
};
