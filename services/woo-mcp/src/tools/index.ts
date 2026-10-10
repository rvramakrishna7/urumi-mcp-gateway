import type { ToolDefinition } from './common.ts';
import { getOrder, listOrders, updateOrderStatus } from './orders.ts';
import { createProduct, listProducts } from './products.ts';
import type { z } from 'zod';

// The order of this list is the order of tools/list.
export const tools: ToolDefinition<z.ZodObject>[] = [listProducts, createProduct, listOrders, getOrder, updateOrderStatus];
