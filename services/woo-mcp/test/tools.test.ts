import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.ts';
import { runTool } from '../src/tools/common.ts';
import type { ToolDefinition, ToolDeps } from '../src/tools/common.ts';
import { tools } from '../src/tools/index.ts';
import { getOrder, listOrders, updateOrderStatus } from '../src/tools/orders.ts';
import { createProduct, listProducts } from '../src/tools/products.ts';
import { WooApiError } from '../src/wooClient.ts';
import type { WooResponse } from '../src/wooClient.ts';

interface RecordedCall {
  method: string;
  path: string;
  query: Array<readonly [string, string]>;
  body: unknown;
}

// A stand-in for WooClient. It answers with the scripted responses in order and records every call.
function stub(script: Array<Partial<WooResponse> | Error>, now = '2026-10-10T05:00:00Z') {
  const calls: RecordedCall[] = [];
  const logLines: string[] = [];
  const deps: ToolDeps = {
    woo: {
      request: (async (method: string, request: { path: string; query?: ReadonlyArray<readonly [string, string]>; body?: unknown }) => {
        calls.push({ method, path: request.path, query: [...(request.query ?? [])], body: request.body });
        const next = script.shift();
        if (next === undefined) throw new Error('the stub has no more responses');
        if (next instanceof Error) throw next;
        return { status: 200, data: [], total: null, totalPages: null, ...next };
      }) as ToolDeps['woo']['request'],
    },
    storeTimezone: 'Asia/Kolkata',
    now: () => new Date(now),
  };
  const logger = createLogger((line) => logLines.push(line));
  return { calls, logLines, deps, logger };
}

// Validates the arguments with the tool schema, as the SDK does, and runs the tool.
async function call(tool: ToolDefinition<any>, rawArgs: unknown, setup: ReturnType<typeof stub>) {
  const args = tool.inputSchema.parse(rawArgs);
  const result = await runTool(tool, args, setup.deps, setup.logger);
  const text = result.content[0]!.text;
  return { isError: result.isError === true, text, data: result.isError ? undefined : JSON.parse(text) };
}

const queryOf = (callRecord: RecordedCall) => Object.fromEntries(callRecord.query);

const rawProduct = {
  id: 5,
  name: 'Test Mug',
  sku: 'MUG-1',
  price: '12.00',
  regular_price: '12.00',
  status: 'publish',
  stock_status: 'instock',
  stock_quantity: null,
  permalink: 'http://store.urumi.test/product/test-mug/',
  description: '<p>Long description</p>',
  meta_data: [{ key: 'secret_meta', value: 'must not be passed on' }],
};

const rawOrder = {
  id: 13,
  number: '13',
  status: 'processing',
  currency: 'INR',
  total: '24.00',
  date_created_gmt: '2026-10-09T10:15:00',
  date_modified_gmt: '2026-10-09T10:16:00',
  date_paid_gmt: null,
  date_completed_gmt: null,
  discount_total: '0.00',
  shipping_total: '0.00',
  total_tax: '0.00',
  payment_method_title: 'Cash on delivery',
  created_via: 'checkout',
  customer_note: 'Please ring the bell twice, door code 4821',
  customer_ip_address: '203.0.113.7',
  billing: {
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha.rao@example.com',
    phone: '+91 98765 43210',
    address_1: '12 Hidden Street',
    city: 'Chennai',
  },
  shipping: { first_name: 'Asha', address_1: '12 Hidden Street' },
  line_items: [{ id: 1, name: 'Test Mug', product_id: 5, sku: 'MUG-1', quantity: 2, subtotal: '24.00', total: '24.00', price: 12 }],
  shipping_lines: [{ method_title: 'Free shipping', total: '0.00' }],
  coupon_lines: [],
  refunds: [],
};
const PRIVATE_VALUES = ['asha.rao@example.com', '98765', '12 Hidden Street', 'Chennai', 'door code', '203.0.113.7'];

function assertNoPrivateData(text: string) {
  for (const value of PRIVATE_VALUES) assert.ok(!text.includes(value), `leaked: ${value}`);
}

describe('input schemas', () => {
  test('every tool rejects an unknown key', () => {
    for (const tool of tools) {
      assert.equal(tool.inputSchema.safeParse({ unexpected: 1 }).success, false, tool.name);
    }
    assert.equal(listProducts.inputSchema.safeParse({ per_page: 5, extra: true }).success, false);
  });

  test('list_products applies the defaults and the limits', () => {
    assert.deepEqual(listProducts.inputSchema.parse({}), { page: 1, per_page: 20 });
    for (const per_page of [0, 51, 1.5, '5']) assert.equal(listProducts.inputSchema.safeParse({ per_page }).success, false, String(per_page));
    for (const page of [0, -1, 1.5]) assert.equal(listProducts.inputSchema.safeParse({ page }).success, false, String(page));
    assert.equal(listProducts.inputSchema.safeParse({ search: '' }).success, false);
    assert.equal(listProducts.inputSchema.safeParse({ status: 'trash' }).success, false);
  });

  test('list_orders accepts today, yesterday and YYYY-MM-DD and rejects other dates', () => {
    for (const date_from of ['today', 'yesterday', '2026-10-09']) {
      assert.equal(listOrders.inputSchema.safeParse({ date_from }).success, true, date_from);
    }
    for (const date_from of ['tomorrow', '2026-10-9', '09-10-2026', '2026-10-09T00:00:00', '']) {
      assert.equal(listOrders.inputSchema.safeParse({ date_from }).success, false, date_from);
    }
    assert.equal(listOrders.inputSchema.safeParse({ status: 'shipped' }).success, false);
  });

  test('get_order needs a positive integer id', () => {
    assert.equal(getOrder.inputSchema.safeParse({ id: 13 }).success, true);
    for (const id of [0, -1, 1.5, '13', undefined, 2 ** 40]) assert.equal(getOrder.inputSchema.safeParse({ id }).success, false, String(id));
  });

  test('every tool has a plain description and annotations', () => {
    for (const tool of tools) {
      assert.ok(tool.description.length > 40 && tool.description.length < 700, tool.name);
      assert.ok(!/ignore|previous instructions|you must/i.test(tool.description), tool.name);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    }
  });
});

describe('list_products', () => {
  test('asks for the page, returns only the listed fields and the totals', async () => {
    const setup = stub([{ data: [rawProduct], total: 41, totalPages: 3 }]);
    const { data } = await call(listProducts, { search: 'mug', status: 'publish', page: 2, per_page: 15 }, setup);

    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0]!.method, 'GET');
    assert.equal(setup.calls[0]!.path, '/wp-json/wc/v3/products');
    assert.deepEqual(queryOf(setup.calls[0]!), { page: '2', per_page: '15', search: 'mug', status: 'publish' });
    assert.deepEqual(data, {
      products: [
        {
          id: 5,
          name: 'Test Mug',
          sku: 'MUG-1',
          price: '12.00',
          status: 'publish',
          stock: { status: 'instock', quantity: null },
          permalink: 'http://store.urumi.test/product/test-mug/',
        },
      ],
      page: 2,
      per_page: 15,
      total: 41,
      total_pages: 3,
    });
  });

  test('sends only page and per_page when no filter is given', async () => {
    const setup = stub([{ data: [], total: 0, totalPages: 0 }]);
    await call(listProducts, {}, setup);
    assert.deepEqual(queryOf(setup.calls[0]!), { page: '1', per_page: '20' });
  });
});

describe('list_orders', () => {
  test('without dates it uses the paging of WooCommerce and its totals', async () => {
    const setup = stub([{ data: [rawOrder], total: 7, totalPages: 1 }]);
    const { data } = await call(listOrders, { status: 'processing', page: 1, per_page: 10 }, setup);

    assert.deepEqual(queryOf(setup.calls[0]!), { page: '1', per_page: '10', status: 'processing' });
    assert.equal(data.total, 7);
    assert.equal(data.window, null);
    assert.equal(data.store_timezone, 'Asia/Kolkata');
    assert.deepEqual(data.orders[0], {
      id: 13,
      number: '13',
      status: 'processing',
      total: '24.00',
      currency: 'INR',
      date: '2026-10-09T10:15:00Z',
      line_items: [{ name: 'Test Mug', product_id: 5, quantity: 2, total: '24.00' }],
      billing_name: 'Asha Rao',
    });
  });

  test('never returns email, phone, address, note or IP address', async () => {
    const plain = await call(listOrders, {}, stub([{ data: [rawOrder], total: 1, totalPages: 1 }]));
    assertNoPrivateData(plain.text);
    const dated = await call(listOrders, { date_from: '2026-10-09' }, stub([{ data: [rawOrder], total: 1, totalPages: 1 }]));
    assertNoPrivateData(dated.text);
    assert.equal(dated.data.total, 1);
  });

  test('date_from yesterday: the store day, the widened UTC query and the resolved window', async () => {
    // 05:00 UTC on 2026-10-10 is 10:30 on 2026-10-10 in Kolkata, so yesterday is 2026-10-09.
    const setup = stub([{ data: [rawOrder], total: 1, totalPages: 1 }]);
    const { data } = await call(listOrders, { date_from: 'yesterday' }, setup);

    assert.deepEqual(queryOf(setup.calls[0]!), {
      dates_are_gmt: 'true',
      per_page: '100',
      after: '2026-10-08T18:29:59',
      page: '1',
    });
    assert.deepEqual(data.window, { from_utc: '2026-10-08T18:30:00.000Z', to_utc: null });
    assert.equal(data.orders[0].id, 13);
  });

  test('"today" is the store day, which can already be a different day than in UTC', async () => {
    // 19:00 UTC on 2026-10-09 is 00:30 on 2026-10-10 in Kolkata.
    const setup = stub([{ data: [], total: 0, totalPages: 0 }], '2026-10-09T19:00:00Z');
    const { data } = await call(listOrders, { date_from: 'today', date_to: 'today' }, setup);
    assert.deepEqual(data.window, { from_utc: '2026-10-09T18:30:00.000Z', to_utc: '2026-10-10T18:30:00.000Z' });
    assert.deepEqual(queryOf(setup.calls[0]!), {
      dates_are_gmt: 'true',
      per_page: '100',
      after: '2026-10-09T18:29:59',
      before: '2026-10-10T18:30:01',
      page: '1',
    });
  });

  test('the exact filter drops the orders in the widened edge, and the totals are counted after it', async () => {
    const at = (id: number, date_created_gmt: string) => ({ ...rawOrder, id, number: String(id), date_created_gmt });
    // Window for 2026-10-09 in Kolkata: 2026-10-08T18:30:00 (included) to 2026-10-09T18:30:00 (excluded).
    const setup = stub([
      {
        data: [
          at(1, '2026-10-09T18:30:00'), // on the end edge: out
          at(2, '2026-10-09T18:29:59'), // in
          at(3, '2026-10-09T05:00:00'), // in
          at(4, '2026-10-08T18:30:00'), // on the start edge: in
          at(5, '2026-10-08T18:29:59'), // one second before: out
        ],
        total: 5,
        totalPages: 1,
      },
    ]);
    const { data } = await call(listOrders, { date_from: '2026-10-09', date_to: '2026-10-09' }, setup);
    assert.deepEqual(data.orders.map((order: { id: number }) => order.id), [2, 3, 4]);
    assert.equal(data.total, 3);
    assert.equal(data.total_pages, 1);
  });

  test('pages the exact result itself, across several WooCommerce pages', async () => {
    const make = (id: number) => ({ ...rawOrder, id, number: String(id), date_created_gmt: '2026-10-09T10:00:00' });
    const setup = stub([
      { data: [make(1), make(2), make(3)], total: 5, totalPages: 2 },
      { data: [make(4), make(5)], total: 5, totalPages: 2 },
    ]);
    const { data } = await call(listOrders, { date_from: '2026-10-09', date_to: '2026-10-09', page: 2, per_page: 2 }, setup);
    assert.equal(setup.calls.length, 2);
    assert.deepEqual(setup.calls.map((record) => queryOf(record).page), ['1', '2']);
    assert.deepEqual(data.orders.map((order: { id: number }) => order.id), [3, 4]);
    assert.equal(data.total, 5);
    assert.equal(data.total_pages, 3);
  });

  test('passes the status filter in a dated query', async () => {
    const setup = stub([{ data: [], total: 0, totalPages: 0 }]);
    await call(listOrders, { status: 'completed', date_to: '2026-10-09' }, setup);
    const query = queryOf(setup.calls[0]!);
    assert.equal(query.status, 'completed');
    assert.equal(query.before, '2026-10-09T18:30:01');
    assert.equal(query.after, undefined);
  });

  test('reports a date range that ends before it starts', async () => {
    const setup = stub([]);
    const result = await call(listOrders, { date_from: '2026-10-09', date_to: '2026-10-08' }, setup);
    assert.equal(result.isError, true);
    assert.match(result.text, /date_from is after date_to/);
    assert.equal(setup.calls.length, 0);
  });

  test('reports a date that does not exist', async () => {
    const result = await call(listOrders, { date_from: '2026-02-30' }, stub([]));
    assert.equal(result.isError, true);
    assert.match(result.text, /date_from is not a valid date/);
  });

  test('refuses a range with more than 500 orders instead of reading them all', async () => {
    const setup = stub([{ data: [rawOrder], total: 900, totalPages: 9 }]);
    const result = await call(listOrders, { date_from: '2026-01-01' }, setup);
    assert.equal(result.isError, true);
    assert.match(result.text, /More than 500 orders/);
    assert.equal(setup.calls.length, 1);
  });
});

describe('get_order', () => {
  test('returns the detail without any contact field or note', async () => {
    const setup = stub([{ data: rawOrder }]);
    const { data, text } = await call(getOrder, { id: 13 }, setup);

    assert.equal(setup.calls[0]!.method, 'GET');
    assert.equal(setup.calls[0]!.path, '/wp-json/wc/v3/orders/13');
    assertNoPrivateData(text);
    assert.equal(data.order.id, 13);
    assert.equal(data.order.status, 'processing');
    assert.equal(data.order.date, '2026-10-09T10:15:00Z');
    assert.equal(data.order.date_paid, null);
    assert.equal(data.order.payment_method, 'Cash on delivery');
    assert.equal(data.order.billing_name, 'Asha Rao');
    assert.deepEqual(data.order.line_items, [
      { name: 'Test Mug', sku: 'MUG-1', product_id: 5, quantity: 2, subtotal: '24.00', total: '24.00' },
    ]);
    assert.deepEqual(data.order.shipping_lines, [{ method: 'Free shipping', total: '0.00' }]);
  });

  test('an unknown order id comes back as a tool error', async () => {
    const setup = stub([
      new WooApiError('http', 'WooCommerce answered with status 404 (woocommerce_rest_shop_order_invalid_id: Invalid ID.)', {
        status: 404,
        code: 'woocommerce_rest_shop_order_invalid_id',
      }),
    ]);
    const result = await call(getOrder, { id: 999999 }, setup);
    assert.equal(result.isError, true);
    assert.match(result.text, /status 404/);
    assert.match(result.text, /Invalid ID/);
  });
});

describe('write tool schemas', () => {
  test('create_product applies the default status and checks every field', () => {
    assert.deepEqual(createProduct.inputSchema.parse({ name: ' MCP Test Product ', regular_price: '19.99' }), {
      name: 'MCP Test Product',
      regular_price: '19.99',
      status: 'publish',
    });
    const valid = { name: 'Mug', regular_price: '5' };
    assert.equal(createProduct.inputSchema.safeParse(valid).success, true);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, regular_price: '5.50' }).success, true);
    for (const regular_price of ['', '5.555', '-5', 'abc', '1,50', '5.', '.5', ' 5', 5, '1234567890']) {
      assert.equal(createProduct.inputSchema.safeParse({ ...valid, regular_price }).success, false, String(regular_price));
    }
    for (const name of ['', '   ', 'x'.repeat(201), 5]) {
      assert.equal(createProduct.inputSchema.safeParse({ ...valid, name }).success, false, String(name));
    }
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, name: 'x'.repeat(200) }).success, true);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, description: 'd'.repeat(5001) }).success, false);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, description: 'd'.repeat(5000) }).success, true);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, sku: '' }).success, false);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, status: 'trash' }).success, false);
    assert.equal(createProduct.inputSchema.safeParse({ ...valid, type: 'variable' }).success, false);
    assert.equal(createProduct.inputSchema.safeParse({ regular_price: '5' }).success, false);
  });

  test('update_order_status does not accept refunded or an unknown status', () => {
    for (const status of ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'failed']) {
      assert.equal(updateOrderStatus.inputSchema.safeParse({ id: 13, status }).success, true, status);
    }
    for (const status of ['refunded', 'trash', 'shipped', '', 'Completed']) {
      assert.equal(updateOrderStatus.inputSchema.safeParse({ id: 13, status }).success, false, status);
    }
    assert.equal(updateOrderStatus.inputSchema.safeParse({ id: 13 }).success, false);
    assert.equal(updateOrderStatus.inputSchema.safeParse({ status: 'completed' }).success, false);
  });

  test('exactly the two write tools are marked as not read-only', () => {
    const writes = tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name);
    assert.deepEqual(writes, ['create_product', 'update_order_status']);
  });
});

describe('create_product', () => {
  test('posts a simple product and returns it with its permalink', async () => {
    const setup = stub([{ status: 201, data: { ...rawProduct, id: 21, name: 'MCP Test Product', price: '19.99' } }]);
    const { data } = await call(createProduct, { name: 'MCP Test Product', regular_price: '19.99' }, setup);

    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0]!.method, 'POST');
    assert.equal(setup.calls[0]!.path, '/wp-json/wc/v3/products');
    assert.deepEqual(setup.calls[0]!.query, []);
    assert.deepEqual(setup.calls[0]!.body, { name: 'MCP Test Product', type: 'simple', regular_price: '19.99', status: 'publish' });
    assert.equal(data.product.id, 21);
    assert.equal(data.product.permalink, 'http://store.urumi.test/product/test-mug/');
    assert.ok(!('description' in data.product) && !('meta_data' in data.product));
  });

  test('sends the description, the sku and the status when they are given', async () => {
    const setup = stub([{ status: 201, data: rawProduct }]);
    await call(createProduct, { name: 'Draft', regular_price: '1', description: 'About it', sku: 'D-1', status: 'draft' }, setup);
    assert.deepEqual(setup.calls[0]!.body, {
      name: 'Draft',
      type: 'simple',
      regular_price: '1',
      status: 'draft',
      description: 'About it',
      sku: 'D-1',
    });
  });

  test('a duplicate sku from WooCommerce comes back as a tool error and is not retried', async () => {
    const setup = stub([
      new WooApiError('http', 'WooCommerce answered with status 400 (product_invalid_sku: Invalid or duplicated SKU.)', {
        status: 400,
        code: 'product_invalid_sku',
      }),
    ]);
    const result = await call(createProduct, { name: 'Mug', regular_price: '5', sku: 'MUG-1' }, setup);
    assert.equal(result.isError, true);
    assert.match(result.text, /duplicated SKU/);
    assert.equal(setup.calls.length, 1);
  });

  test('an answer without a product id is reported and not shown as a success', async () => {
    const result = await call(createProduct, { name: 'Mug', regular_price: '5' }, stub([{ status: 201, data: {} }]));
    assert.equal(result.isError, true);
    assert.match(result.text, /did not return the created product/);
  });
});

describe('update_order_status', () => {
  test('reads the order, sets the new status with PUT and returns both statuses', async () => {
    const setup = stub([{ data: { ...rawOrder, status: 'processing' } }, { data: { ...rawOrder, status: 'completed' } }]);
    const { data } = await call(updateOrderStatus, { id: 13, status: 'completed' }, setup);

    assert.deepEqual(
      setup.calls.map((record) => [record.method, record.path, record.body]),
      [
        ['GET', '/wp-json/wc/v3/orders/13', undefined],
        ['PUT', '/wp-json/wc/v3/orders/13', { status: 'completed' }],
      ],
    );
    assert.deepEqual(data, { id: 13, previous_status: 'processing', new_status: 'completed', changed: true });
  });

  test('does nothing when the order already has the status', async () => {
    const setup = stub([{ data: { ...rawOrder, status: 'processing' } }]);
    const { data } = await call(updateOrderStatus, { id: 13, status: 'processing' }, setup);
    assert.equal(setup.calls.length, 1);
    assert.deepEqual(data, { id: 13, previous_status: 'processing', new_status: 'processing', changed: false });
  });

  test('reports the status that WooCommerce ended up with', async () => {
    const setup = stub([{ data: { ...rawOrder, status: 'processing' } }, { data: { ...rawOrder, status: 'on-hold' } }]);
    const { data } = await call(updateOrderStatus, { id: 13, status: 'completed' }, setup);
    assert.equal(data.new_status, 'on-hold');
  });

  test('an unknown order id stops before any change', async () => {
    const setup = stub([
      new WooApiError('http', 'WooCommerce answered with status 404 (woocommerce_rest_shop_order_invalid_id: Invalid ID.)', { status: 404 }),
    ]);
    const result = await call(updateOrderStatus, { id: 999999, status: 'completed' }, setup);
    assert.equal(result.isError, true);
    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0]!.method, 'GET');
  });

  test('a timeout on the change is a tool error and the change is not retried', async () => {
    const setup = stub([{ data: { ...rawOrder, status: 'processing' } }, new WooApiError('timeout', 'WooCommerce did not answer within 10000 ms')]);
    const result = await call(updateOrderStatus, { id: 13, status: 'completed' }, setup);
    assert.equal(result.isError, true);
    assert.match(result.text, /did not answer in time/);
    assert.equal(setup.calls.filter((record) => record.method === 'PUT').length, 1);
  });
});

describe('failures and logging', () => {
  const failures: Array<[string, WooApiError, RegExp]> = [
    ['timeout', new WooApiError('timeout', 'WooCommerce did not answer within 10000 ms'), /did not answer in time/],
    ['network', new WooApiError('network', 'could not reach WooCommerce (ECONNREFUSED)'), /cannot be reached/],
    ['redirect', new WooApiError('redirect', 'WooCommerce answered with a redirect (status 302), which is not followed', { status: 302 }), /unexpected answer/],
    ['invalid-response', new WooApiError('invalid-response', 'body is not JSON', { status: 200 }), /unexpected answer/],
    ['http 401', new WooApiError('http', 'WooCommerce answered with status 401', { status: 401 }), /refused the request \(status 401\)/],
    ['http 503', new WooApiError('http', 'WooCommerce answered with status 503', { status: 503 }), /internal error \(status 503\)/],
    ['http 400', new WooApiError('http', 'WooCommerce answered with status 400 (bad: Nope)', { status: 400 }), /status 400 \(bad: Nope\)/],
  ];
  for (const [name, error, pattern] of failures) {
    test(`${name} becomes a tool result with isError true`, async () => {
      const setup = stub([error]);
      const result = await call(listProducts, {}, setup);
      assert.equal(result.isError, true);
      assert.match(result.text, pattern);
      assert.ok(!/http:\/\/|Authorization|oauth_|ck_|cs_/.test(result.text));
    });
  }

  test('an unexpected exception also becomes a tool error and is logged by name only', async () => {
    const setup = stub([new Error('secret-looking detail ck_deadbeef')]);
    const result = await call(listProducts, {}, setup);
    assert.equal(result.isError, true);
    assert.ok(!result.text.includes('ck_deadbeef'));
    assert.ok(!setup.logLines.join('\n').includes('ck_deadbeef'));
  });

  test('a call writes one log line with the tool, the duration and the outcome and nothing else', async () => {
    const ok = stub([{ data: [rawProduct], total: 1, totalPages: 1 }]);
    await call(listProducts, { search: 'private-search-term' }, ok);
    assert.equal(ok.logLines.length, 1);
    const line = JSON.parse(ok.logLines[0]!);
    assert.deepEqual(Object.keys(line).sort(), ['durationMs', 'level', 'message', 'outcome', 'time', 'tool']);
    assert.equal(line.tool, 'list_products');
    assert.equal(line.outcome, 'ok');
    assert.equal(typeof line.durationMs, 'number');
    assert.ok(!ok.logLines[0]!.includes('private-search-term'));
    assert.ok(!ok.logLines[0]!.includes('Test Mug'));

    const failed = stub([new WooApiError('timeout', 'x')]);
    await call(getOrder, { id: 13 }, failed);
    const failedLine = JSON.parse(failed.logLines[0]!);
    assert.equal(failedLine.outcome, 'error');
    assert.equal(failedLine.errorKind, 'timeout');
  });
});
