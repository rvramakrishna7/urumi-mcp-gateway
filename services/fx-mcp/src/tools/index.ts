import type { z } from 'zod';
import type { ToolDefinition } from './common.ts';
import { convertAmounts, getRate, listCurrencies } from './fx.ts';

// The order of this list is the order of tools/list.
export const tools: ToolDefinition<z.ZodObject>[] = [listCurrencies, getRate, convertAmounts];
