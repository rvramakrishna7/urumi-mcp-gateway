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
  let keyFile: string;
  let secretFile: string;
  let emptyFile: string;
  const token = 'config-test-token-0123456789abcdef0123456789';
  const shortToken = 'short-token-value';
  const consumerKey = `ck_${'a'.repeat(40)}`;
  const consumerSecret = `cs_${'b'.repeat(40)}`;

  // A complete valid environment. Each test overrides only the variable it is about.
  const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    MCP_AUTH_TOKEN_FILE: tokenFile,
    WOO_BASE_URL: 'http://wordpress.store.svc.cluster.local',
    WOO_PUBLIC_URL: 'http://store.urumi.test',
    WOO_CONSUMER_KEY_FILE: keyFile,
    WOO_CONSUMER_SECRET_FILE: secretFile,
    STORE_TIMEZONE: 'Asia/Kolkata',
    ...overrides,
  });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'woo-mcp-config-'));
    tokenFile = join(dir, 'token');
    shortTokenFile = join(dir, 'short');
    writeFileSync(tokenFile, `${token}\n`);
    writeFileSync(shortTokenFile, shortToken);
    keyFile = join(dir, 'consumer-key');
    secretFile = join(dir, 'consumer-secret');
    emptyFile = join(dir, 'empty');
    writeFileSync(keyFile, `${consumerKey}\n`);
    writeFileSync(secretFile, `${consumerSecret}\n`);
    writeFileSync(emptyFile, '\n');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads the token from the file, trims it and applies the defaults', () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.mcpAuthToken, token);
    assert.equal(config.port, 8080);
    assert.deepEqual(config.allowedHosts, ['localhost', '127.0.0.1']);
  });

  test('reads PORT and ALLOWED_HOSTS', () => {
    const config = loadConfig(
      baseEnv({ PORT: '9090', ALLOWED_HOSTS: ' woo-mcp.mcp-servers.svc.cluster.local , localhost ,' }),
    );
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
    assert.throws(() => loadConfig(baseEnv({ MCP_AUTH_TOKEN_FILE: join(dir, 'missing') })), ConfigError);
  });

  test('rejects a token shorter than 32 characters without printing it', () => {
    assert.throws(() => loadConfig(baseEnv({ MCP_AUTH_TOKEN_FILE: shortTokenFile })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /at least 32/);
      assert.ok(!error.message.includes(shortToken));
      return true;
    });
  });

  test('rejects an invalid PORT and names the variable, not the value', () => {
    assert.throws(() => loadConfig(baseEnv({ PORT: 'not-a-port' })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /PORT/);
      assert.ok(!error.message.includes('not-a-port'));
      return true;
    });
    assert.throws(() => loadConfig(baseEnv({ PORT: '70000' })), ConfigError);
  });

  test('rejects an empty ALLOWED_HOSTS', () => {
    assert.throws(() => loadConfig(baseEnv({ ALLOWED_HOSTS: ' , ' })), ConfigError);
  });

  test('reads the WooCommerce settings and reads the key and the secret from their files', () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.wooConsumerKey, consumerKey);
    assert.equal(config.wooConsumerSecret, consumerSecret);
    assert.equal(config.wooBaseUrl, 'http://wordpress.store.svc.cluster.local');
    assert.equal(config.wooPublicUrl, 'http://store.urumi.test');
    assert.equal(config.storeTimezone, 'Asia/Kolkata');
    assert.equal(config.wooRequestTimeoutMs, 10_000);
  });

  test('removes trailing slashes from the two URLs and keeps a path and a port', () => {
    const config = loadConfig(
      baseEnv({ WOO_BASE_URL: 'http://wordpress.store.svc:8080/blog//', WOO_PUBLIC_URL: 'https://store.example.com/' }),
    );
    assert.equal(config.wooBaseUrl, 'http://wordpress.store.svc:8080/blog');
    assert.equal(config.wooPublicUrl, 'https://store.example.com');
  });

  test('reads WOO_REQUEST_TIMEOUT_MS and rejects a value out of range', () => {
    assert.equal(loadConfig(baseEnv({ WOO_REQUEST_TIMEOUT_MS: '2500' })).wooRequestTimeoutMs, 2500);
    for (const value of ['0', '99', '120001', 'soon', '1.5']) {
      assert.throws(() => loadConfig(baseEnv({ WOO_REQUEST_TIMEOUT_MS: value })), /WOO_REQUEST_TIMEOUT_MS/, value);
    }
  });

  for (const name of [
    'WOO_BASE_URL',
    'WOO_PUBLIC_URL',
    'WOO_CONSUMER_KEY_FILE',
    'WOO_CONSUMER_SECRET_FILE',
    'STORE_TIMEZONE',
  ]) {
    test(`fails when ${name} is not set`, () => {
      assert.throws(() => loadConfig(baseEnv({ [name]: undefined })), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(name));
        return true;
      });
    });
  }

  test('rejects a URL that is not plain http or https and does not print it', () => {
    const bad = [
      'store.urumi.test',
      'ftp://store.urumi.test',
      'http://user:pass-in-url@store.urumi.test',
      'http://store.urumi.test/?consumer_key=leak-me',
      'http://store.urumi.test/#fragment',
    ];
    for (const value of bad) {
      for (const name of ['WOO_BASE_URL', 'WOO_PUBLIC_URL']) {
        assert.throws(() => loadConfig(baseEnv({ [name]: value })), (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, new RegExp(name));
          assert.ok(!error.message.includes('pass-in-url') && !error.message.includes('leak-me'));
          return true;
        }, `${name}=${value}`);
      }
    }
  });

  test('rejects an invalid STORE_TIMEZONE', () => {
    for (const value of ['Not/AZone', '+05:30', '']) {
      assert.throws(() => loadConfig(baseEnv({ STORE_TIMEZONE: value })), /STORE_TIMEZONE/, value);
    }
  });

  test('fails when the key or the secret file cannot be read, naming the variable only', () => {
    assert.throws(() => loadConfig(baseEnv({ WOO_CONSUMER_KEY_FILE: join(dir, 'missing') })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /WOO_CONSUMER_KEY_FILE cannot be read/);
      assert.ok(!error.message.includes(dir));
      return true;
    });
    assert.throws(() => loadConfig(baseEnv({ WOO_CONSUMER_SECRET_FILE: join(dir, 'missing') })), /WOO_CONSUMER_SECRET_FILE cannot be read/);
  });

  test('rejects an empty key file or secret file', () => {
    assert.throws(() => loadConfig(baseEnv({ WOO_CONSUMER_KEY_FILE: emptyFile })), /WOO_CONSUMER_KEY_FILE must not be empty/);
    assert.throws(() => loadConfig(baseEnv({ WOO_CONSUMER_SECRET_FILE: emptyFile })), /WOO_CONSUMER_SECRET_FILE must not be empty/);
  });

  test('never puts the key or the secret into an error message', () => {
    const failures = [
      baseEnv({ STORE_TIMEZONE: 'Not/AZone' }),
      baseEnv({ WOO_BASE_URL: 'nope' }),
      baseEnv({ MCP_AUTH_TOKEN_FILE: shortTokenFile }),
      baseEnv({ WOO_REQUEST_TIMEOUT_MS: 'x' }),
    ];
    for (const env of failures) {
      assert.throws(() => loadConfig(env), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes(consumerKey) && !error.message.includes(consumerSecret));
        return true;
      });
    }
  });
});
