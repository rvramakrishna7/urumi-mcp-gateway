import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, DEFAULT_FX_BASE_URL, loadConfig } from '../src/config.ts';

const TOKEN = randomBytes(24).toString('hex');
let dir: string;
let tokenFile: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fx-mcp-config-'));
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({ MCP_AUTH_TOKEN_FILE: tokenFile });

describe('loadConfig', () => {
  test('defaults: port 8080, the public rate service, 8 s timeout, local hosts', () => {
    const config = loadConfig(base());
    assert.equal(config.port, 8080);
    assert.equal(config.fxBaseUrl, DEFAULT_FX_BASE_URL);
    assert.equal(config.fxRequestTimeoutMs, 8000);
    assert.deepEqual(config.allowedHosts, ['localhost', '127.0.0.1']);
  });

  test('reads the token from the file and trims the newline', () => {
    assert.equal(loadConfig(base()).mcpAuthToken, TOKEN);
  });

  test('accepts a base URL and removes trailing slashes', () => {
    assert.equal(loadConfig({ ...base(), FX_BASE_URL: 'http://127.0.0.1:9999//' }).fxBaseUrl, 'http://127.0.0.1:9999');
  });

  test('splits and trims ALLOWED_HOSTS', () => {
    assert.deepEqual(loadConfig({ ...base(), ALLOWED_HOSTS: ' fx-mcp , fx-mcp.mcp-servers.svc ' }).allowedHosts, ['fx-mcp', 'fx-mcp.mcp-servers.svc']);
  });

  test('refuses a bad configuration and names the variable, never a value', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /MCP_AUTH_TOKEN_FILE/],
      [{ ...base(), PORT: '0' }, /PORT/],
      [{ ...base(), PORT: 'abc' }, /PORT/],
      [{ ...base(), FX_BASE_URL: 'ftp://example.com' }, /FX_BASE_URL/],
      [{ ...base(), FX_BASE_URL: 'https://user:secretpw@example.com' }, /FX_BASE_URL/],
      [{ ...base(), FX_BASE_URL: 'https://example.com/?key=abc' }, /FX_BASE_URL/],
      [{ ...base(), FX_BASE_URL: 'not a url' }, /FX_BASE_URL/],
      [{ ...base(), FX_REQUEST_TIMEOUT_MS: '5' }, /FX_REQUEST_TIMEOUT_MS/],
      [{ ...base(), ALLOWED_HOSTS: ' , ' }, /ALLOWED_HOSTS/],
    ];
    for (const [env, pattern] of cases) {
      assert.throws(() => loadConfig(env), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /secretpw|abc|ftp:/);
        return true;
      });
    }
  });

  test('refuses a missing or short token file', () => {
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: join(dir, 'missing') }), /MCP_AUTH_TOKEN_FILE cannot be read/);
    const short = join(dir, 'short');
    writeFileSync(short, 'tooshort');
    assert.throws(
      () => loadConfig({ MCP_AUTH_TOKEN_FILE: short }),
      (error: unknown) => error instanceof ConfigError && /at least 32/.test(error.message) && !error.message.includes('tooshort'),
    );
  });
});
