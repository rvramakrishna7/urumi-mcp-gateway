import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, DEFAULT_CHAT_MODEL, DEFAULT_CONFIRM_TOOLS, loadChatConfig } from '../src/config.ts';

describe('loadChatConfig', () => {
  let dir: string;
  const KEY = 'gsk_config_test_key_0123456789abcdef';
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-chat-config-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('with nothing set: no key, the default model, the two write tools, ten requests per minute', () => {
    assert.deepEqual(loadChatConfig({}), { groqApiKey: undefined, model: 'openai/gpt-oss-120b', confirmTools: ['woo__create_product', 'woo__update_order_status'], ratePerMinute: 10 });
    assert.equal(DEFAULT_CHAT_MODEL, 'openai/gpt-oss-120b');
    assert.deepEqual(DEFAULT_CONFIRM_TOOLS, ['woo__create_product', 'woo__update_order_status']);
  });

  test('the key is read from the file and trimmed', () => {
    assert.equal(loadChatConfig({ GROQ_API_KEY_FILE: file('k1', `${KEY}\n`) }).groqApiKey, KEY);
    assert.equal(loadChatConfig({ GROQ_API_KEY_FILE: file('k2', `  ${KEY}\r\n`) }).groqApiKey, KEY);
  });

  test('a file that does not exist means chat is not configured, and does not stop the start', () => {
    assert.equal(loadChatConfig({ GROQ_API_KEY_FILE: join(dir, 'missing') }).groqApiKey, undefined);
  });

  test('a file that exists but is empty, has spaces inside, is too short, too long or has control characters stops the start, without the value in the message', () => {
    const cases: [string, string][] = [['empty', ''], ['blank', ' \n'], ['inner space', 'gsk abc def ghi'], ['short', 'gsk_1'], ['long', 'g'.repeat(201)], ['control', `gsk_abcdefgh${String.fromCharCode(7)}ijk`], ['two lines', `${KEY}\nsecond-line-abcdef`]];
    for (const [label, text] of cases) {
      assert.throws(
        () => loadChatConfig({ GROQ_API_KEY_FILE: file(`bad-${label.replace(' ', '-')}`, text) }),
        (error: unknown) => error instanceof ConfigError && /GROQ_API_KEY_FILE/.test(error.message) && !error.message.includes('abcdef') && !error.message.includes('second-line'),
        label,
      );
    }
  });

  test('a path that cannot be read for another reason than "missing" stops the start', () => {
    assert.throws(() => loadChatConfig({ GROQ_API_KEY_FILE: dir }), (error: unknown) => error instanceof ConfigError && error.message === 'GROQ_API_KEY_FILE cannot be read');
    assert.throws(() => loadChatConfig({ GROQ_API_KEY_FILE: '' }), ConfigError);
  });

  test('the model and the rate come from the environment, and bad values name the variable only', () => {
    const config = loadChatConfig({ CHAT_MODEL: 'openai/gpt-oss-20b', CHAT_RATE_PER_MINUTE: '3' });
    assert.deepEqual([config.model, config.ratePerMinute], ['openai/gpt-oss-20b', 3]);
    for (const [name, value] of [['CHAT_MODEL', 'bad model'], ['CHAT_MODEL', ''], ['CHAT_MODEL', 'x'.repeat(101)], ['CHAT_RATE_PER_MINUTE', '0'], ['CHAT_RATE_PER_MINUTE', '-1'], ['CHAT_RATE_PER_MINUTE', '601'], ['CHAT_RATE_PER_MINUTE', '1.5'], ['CHAT_RATE_PER_MINUTE', 'ten']] as const) {
      assert.throws(
        () => loadChatConfig({ [name]: value }),
        (error: unknown) => error instanceof ConfigError && error.message.includes(name) && (value === '' || !error.message.includes(value)),
        `${name}=${value}`,
      );
    }
  });

  test('the confirm list can be replaced, but never made empty', () => {
    assert.deepEqual(loadChatConfig({ CHAT_CONFIRM_TOOLS: 'woo__create_product, other__delete_all' }).confirmTools, ['woo__create_product', 'other__delete_all']);
    for (const value of ['', ' ', ',', 'woo__create_product,', 'a b', 'woo__create_product;rm', 'x'.repeat(101)]) {
      assert.throws(() => loadChatConfig({ CHAT_CONFIRM_TOOLS: value }), (error: unknown) => error instanceof ConfigError && error.message.includes('CHAT_CONFIRM_TOOLS'), JSON.stringify(value));
    }
  });
});
