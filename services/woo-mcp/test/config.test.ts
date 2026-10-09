import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  let dir: string;
  let tokenFile: string;
  let shortTokenFile: string;
  const token = 'config-test-token-0123456789abcdef0123456789';
  const shortToken = 'short-token-value';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'woo-mcp-config-'));
    tokenFile = join(dir, 'token');
    shortTokenFile = join(dir, 'short');
    writeFileSync(tokenFile, `${token}\n`);
    writeFileSync(shortTokenFile, shortToken);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads the token from the file, trims it and applies the defaults', () => {
    const config = loadConfig({ MCP_AUTH_TOKEN_FILE: tokenFile });
    assert.equal(config.mcpAuthToken, token);
    assert.equal(config.port, 8080);
    assert.deepEqual(config.allowedHosts, ['localhost', '127.0.0.1']);
  });

  test('reads PORT and ALLOWED_HOSTS', () => {
    const config = loadConfig({
      MCP_AUTH_TOKEN_FILE: tokenFile,
      PORT: '9090',
      ALLOWED_HOSTS: ' woo-mcp.mcp-servers.svc.cluster.local , localhost ,',
    });
    assert.equal(config.port, 9090);
    assert.deepEqual(config.allowedHosts, ['woo-mcp.mcp-servers.svc.cluster.local', 'localhost']);
  });

  test('fails when MCP_AUTH_TOKEN_FILE is not set', () => {
    assert.throws(() => loadConfig({}), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /MCP_AUTH_TOKEN_FILE/);
      return true;
    });
  });

  test('fails when the token file cannot be read', () => {
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: join(dir, 'missing') }), ConfigError);
  });

  test('rejects a token shorter than 32 characters without printing it', () => {
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: shortTokenFile }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /at least 32/);
      assert.ok(!error.message.includes(shortToken));
      return true;
    });
  });

  test('rejects an invalid PORT and names the variable, not the value', () => {
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: tokenFile, PORT: 'not-a-port' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /PORT/);
      assert.ok(!error.message.includes('not-a-port'));
      return true;
    });
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: tokenFile, PORT: '70000' }), ConfigError);
  });

  test('rejects an empty ALLOWED_HOSTS', () => {
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN_FILE: tokenFile, ALLOWED_HOSTS: ' , ' }), ConfigError);
  });
});
