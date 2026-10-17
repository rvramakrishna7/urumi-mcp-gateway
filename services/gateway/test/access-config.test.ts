import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_MEMBER_RESTRICTED_TOOLS, loadAccessConfig } from '../src/config.ts';

describe('loadAccessConfig', () => {
  test('without the variable the default list applies, and it keeps the Step 18 member tools allowed', () => {
    assert.deepEqual(loadAccessConfig({}).memberRestrictedTools, ['woo__create_product', 'woo__update_order_status', 'fetch__fetch']);
    assert.deepEqual(DEFAULT_MEMBER_RESTRICTED_TOOLS, loadAccessConfig({}).memberRestrictedTools);
    for (const allowed of ['woo__list_orders', 'woo__get_order', 'woo__list_products', 'fx__convert_amounts']) {
      assert.ok(!DEFAULT_MEMBER_RESTRICTED_TOOLS.includes(allowed), allowed);
    }
  });

  test('a comma-separated list is trimmed and parsed', () => {
    assert.deepEqual(loadAccessConfig({ MEMBER_RESTRICTED_TOOLS: 'woo__create_product, other-1__delete_all' }).memberRestrictedTools, ['woo__create_product', 'other-1__delete_all']);
  });

  test('an empty, malformed or over-long entry stops the start, and the message names the variable and not the value', () => {
    const bad: [string, string][] = [
      ['empty value', ''],
      ['blank entry', 'woo__create_product,'],
      ['only a comma', ','],
      ['no separator', 'create_product'],
      ['empty tool part', 'woo__'],
      ['empty slug part', '__create_product'],
      ['slug in capitals', 'Woo__create_product'],
      ['slug that starts with a digit', '1woo__create_product'],
      ['slug longer than the registry allows', `${'a'.repeat(21)}__x`],
      ['a space inside a name', 'woo__create product'],
      ['a character outside the pattern', 'woo__create.product'],
      ['a tool part that is too long', `woo__${'x'.repeat(101)}`],
    ];
    for (const [label, value] of bad) {
      assert.throws(
        () => loadAccessConfig({ MEMBER_RESTRICTED_TOOLS: value }),
        (error: unknown) => error instanceof ConfigError && error.message.includes('MEMBER_RESTRICTED_TOOLS') && (value === '' || !error.message.includes(value)),
        label,
      );
    }
  });
});
