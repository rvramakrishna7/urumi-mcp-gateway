import { z } from 'zod';
import { assertPlainText, expectArray, expectItem } from './common.ts';
import type { ToolDefinition } from './common.ts';

const PRODUCTS_PATH = '/wp-json/wc/v3/products';

// The fields of a WooCommerce product that this server reads. Everything else is dropped.
interface WooProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  status: string;
  stock_status: string;
  stock_quantity: number | null;
  permalink: string;
}

// An explicit list of fields, so that a field that WooCommerce adds later is not passed on by accident.
function toProduct(raw: WooProduct) {
  return {
    id: raw.id,
    name: raw.name,
    sku: raw.sku,
    price: raw.price,
    status: raw.status,
    stock: { status: raw.stock_status, quantity: raw.stock_quantity },
    permalink: raw.permalink,
  };
}

const productStatus = z.enum(['publish', 'draft', 'pending', 'private']);

const listProductsSchema = z.strictObject({
  search: z.string().trim().min(1).max(100).optional().describe('Text to look for in the product name, description and SKU.'),
  status: z.union([productStatus, z.literal('any')]).optional().describe('Only products with this status. The default is any.'),
  page: z.number().int().min(1).max(10_000).default(1).describe('Page number, starting at 1.'),
  per_page: z.number().int().min(1).max(50).default(20).describe('Products per page, 1 to 50.'),
});

export const listProducts: ToolDefinition<typeof listProductsSchema> = {
  name: 'list_products',
  title: 'List products',
  description:
    'Lists products of the WooCommerce store, one page at a time. Each product has id, name, sku, price, status, ' +
    'stock (status and quantity) and permalink. The answer also gives the total number of matching products and ' +
    'the number of pages. Prices are strings in the store currency.',
  inputSchema: listProductsSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, { woo }) => {
    const query: Array<[string, string]> = [
      ['page', String(args.page)],
      ['per_page', String(args.per_page)],
    ];
    if (args.search !== undefined) query.push(['search', args.search]);
    if (args.status !== undefined) query.push(['status', args.status]);
    const response = await woo.request<WooProduct[]>('GET', { path: PRODUCTS_PATH, query });
    return {
      products: expectArray<WooProduct>(response.data).map(toProduct),
      page: args.page,
      per_page: args.per_page,
      total: response.total,
      total_pages: response.totalPages,
    };
  },
};

const createProductSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).describe('Product name, 1 to 200 characters.'),
  regular_price: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'must be a decimal number with at most two decimals, for example 19.99')
    .describe('Regular price as a decimal string with at most two decimals, for example "19.99".'),
  description: z.string().max(5000).optional().describe('Product description, up to 5000 characters.'),
  sku: z.string().trim().min(1).max(100).optional().describe('Stock keeping unit. It must be unique in the store.'),
  status: productStatus.default('publish').describe('publish makes the product visible in the store. The default is publish.'),
});

export const createProduct: ToolDefinition<typeof createProductSchema> = {
  name: 'create_product',
  title: 'Create product',
  description:
    'Creates one simple product in the WooCommerce store and returns it with its permalink. The name, description ' +
    'and sku must be plain text: input that contains < or > is rejected. Each call creates a new ' +
    'product, so calling it twice with the same name creates two products. With status publish the product is ' +
    'visible in the store at once.',
  inputSchema: createProductSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async (args, { woo }) => {
    assertPlainText('name', args.name);
    if (args.description !== undefined) assertPlainText('description', args.description);
    if (args.sku !== undefined) assertPlainText('sku', args.sku);
    const body: Record<string, string> = {
      name: args.name,
      type: 'simple',
      regular_price: args.regular_price,
      status: args.status,
    };
    if (args.description !== undefined) body.description = args.description;
    if (args.sku !== undefined) body.sku = args.sku;
    const response = await woo.request<WooProduct>('POST', { path: PRODUCTS_PATH, body });
    return { product: toProduct(expectItem<WooProduct>(response.data)) };
  },
};
