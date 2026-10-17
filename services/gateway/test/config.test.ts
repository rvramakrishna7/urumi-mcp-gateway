import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, loadDbConfig, loadSecurityConfig, loadUpstreamPolicyConfig } from '../src/config.ts';

describe('loadConfig and loadDbConfig', () => {
  let dir: string;
  let passwordFile: string;
  let shortFile: string;
  const password = 'db-test-password-0123456789abcdef';

  const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DB_HOST: 'postgres',
    DB_NAME: 'gateway',
    DB_USER: 'gateway',
    DB_PASSWORD_FILE: passwordFile,
    ...overrides,
  });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-config-'));
    passwordFile = join(dir, 'password');
    shortFile = join(dir, 'short');
    writeFileSync(passwordFile, `${password}\n`);
    writeFileSync(shortFile, 'too-short');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads the password from the file, trims it and applies the defaults', () => {
    const config = loadConfig(baseEnv());
    assert.deepEqual(config, {
      port: 8080,
      db: { host: 'postgres', port: 5432, database: 'gateway', user: 'gateway', password, poolMax: 10 },
    });
  });

  test('reads PORT, DB_PORT and DB_POOL_MAX', () => {
    const config = loadConfig(baseEnv({ PORT: '9090', DB_PORT: '6543', DB_POOL_MAX: '4' }));
    assert.equal(config.port, 9090);
    assert.equal(config.db.port, 6543);
    assert.equal(config.db.poolMax, 4);
  });

  test('loadDbConfig does not need PORT', () => {
    assert.equal(loadDbConfig(baseEnv({ PORT: 'not-a-port' })).host, 'postgres');
  });

  for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD_FILE']) {
    test(`fails when ${name} is not set`, () => {
      assert.throws(() => loadConfig(baseEnv({ [name]: undefined })), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(name));
        return true;
      });
    });
  }

  test('rejects values that are out of range or not plain identifiers, naming the variable and not the value', () => {
    const cases: Array<[string, string]> = [
      ['PORT', 'not-a-port'],
      ['PORT', '70000'],
      ['DB_PORT', '0'],
      ['DB_POOL_MAX', '0'],
      ['DB_POOL_MAX', '51'],
      ['DB_NAME', 'drop table; --'],
      ['DB_USER', 'a b'],
      ['DB_HOST', 'host name'],
    ];
    for (const [name, value] of cases) {
      assert.throws(() => loadConfig(baseEnv({ [name]: value })), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(name));
        assert.ok(!error.message.includes(value), `${name}=${value}`);
        return true;
      });
    }
  });

  test('fails when the password file cannot be read, without printing the path', () => {
    assert.throws(() => loadConfig(baseEnv({ DB_PASSWORD_FILE: join(dir, 'missing') })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message, 'DB_PASSWORD_FILE cannot be read');
      return true;
    });
  });

  test('rejects a password shorter than 16 characters without printing it', () => {
    assert.throws(() => loadConfig(baseEnv({ DB_PASSWORD_FILE: shortFile })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /at least 16/);
      assert.ok(!error.message.includes('too-short'));
      return true;
    });
  });

  test('never puts the password into an error message', () => {
    for (const env of [baseEnv({ DB_NAME: 'bad name' }), baseEnv({ PORT: 'x' }), baseEnv({ DB_POOL_MAX: '999' })]) {
      assert.throws(() => loadConfig(env), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes(password));
        return true;
      });
    }
  });
});

describe('loadSecurityConfig: PUBLIC_ORIGIN', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    MASTER_KEY_FILE: '/secrets/master/key',
    ALLOWED_HOSTS: 'gateway.urumi.test',
    PUBLIC_ORIGIN: 'http://gateway.urumi.test',
    ...overrides,
  });

  test('accepts an origin, with or without a trailing slash and with a port', () => {
    assert.equal(loadSecurityConfig(env()).publicOrigin, 'http://gateway.urumi.test');
    assert.equal(loadSecurityConfig(env({ PUBLIC_ORIGIN: 'https://gateway.example.com/' })).publicOrigin, 'https://gateway.example.com');
    assert.equal(loadSecurityConfig(env({ PUBLIC_ORIGIN: 'http://localhost:8080' })).publicOrigin, 'http://localhost:8080');
  });

  test('refuses a missing value and anything that is not exactly an origin', () => {
    const values = [undefined, '', 'gateway.urumi.test', 'ftp://gateway.urumi.test', 'http://gateway.urumi.test/app', 'http://gateway.urumi.test?x=1', 'http://gateway.urumi.test#top', 'http://user:pw@gateway.urumi.test', 'http://GATEWAY.urumi.test'];
    for (const value of values) {
      assert.throws(() => loadSecurityConfig(env({ PUBLIC_ORIGIN: value })), (error: unknown) => error instanceof ConfigError && error.message.includes('PUBLIC_ORIGIN') && !error.message.includes('pw'), String(value));
    }
  });
});

describe('loadSecurityConfig: the bootstrap admin', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    MASTER_KEY_FILE: '/secrets/master/key',
    ALLOWED_HOSTS: 'gateway.urumi.test',
    PUBLIC_ORIGIN: 'http://gateway.urumi.test',
    ...overrides,
  });

  test('is off when neither variable is set', () => {
    assert.equal(loadSecurityConfig(env()).bootstrap, undefined);
  });

  test('takes both, and normalises the email', () => {
    assert.deepEqual(loadSecurityConfig(env({ BOOTSTRAP_ADMIN_EMAIL: ' Admin@Urumi.test ', BOOTSTRAP_TOKEN_FILE: '/secrets/bootstrap/inviteToken' })).bootstrap, {
      adminEmail: 'admin@urumi.test',
      tokenFile: '/secrets/bootstrap/inviteToken',
    });
  });

  test('one without the other, or a bad email, is refused and the message names the variables only', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { BOOTSTRAP_ADMIN_EMAIL: 'admin@urumi.test' },
      { BOOTSTRAP_TOKEN_FILE: '/secrets/bootstrap/inviteToken' },
      { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_TOKEN_FILE: '/x' },
      { BOOTSTRAP_ADMIN_EMAIL: 'a@b@c', BOOTSTRAP_TOKEN_FILE: '/x' },
    ];
    for (const overrides of cases) {
      assert.throws(() => loadSecurityConfig(env(overrides)), (error: unknown) => error instanceof ConfigError && error.message.includes('BOOTSTRAP_ADMIN_EMAIL') && !error.message.includes('not-an-email'));
    }
  });
});

describe('loadSecurityConfig: ALLOWED_HOSTS', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ MASTER_KEY_FILE: '/secrets/master/key', ALLOWED_HOSTS: 'gateway.urumi.test', PUBLIC_ORIGIN: 'http://gateway.urumi.test', ...overrides });

  test('is split on commas and trimmed', () => {
    assert.deepEqual(loadSecurityConfig(env({ ALLOWED_HOSTS: ' gateway.urumi.test , localhost ,' })).allowedHosts, ['gateway.urumi.test', 'localhost']);
  });

  test('is required: a missing, empty or blank list stops the start instead of turning the Host check off', () => {
    for (const value of [undefined, '', ' , ']) {
      assert.throws(() => loadSecurityConfig(env({ ALLOWED_HOSTS: value })), (error: unknown) => error instanceof ConfigError && error.message.includes('ALLOWED_HOSTS'));
    }
  });
});

describe('loadUpstreamPolicyConfig', () => {
  const THREE = 'woo-mcp.mcp-servers.svc.cluster.local:8080,fx-mcp.mcp-servers.svc.cluster.local:8080,fetch-mcp.mcp-servers.svc.cluster.local:8080';
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UPSTREAM_ALLOWED_HOSTS: THREE, POD_NAMESPACE: 'gateway', ...overrides });

  test('the three real entries give a policy of 3 and the own namespace', () => {
    const config = loadUpstreamPolicyConfig(env());
    assert.equal(config.policy.allowed.size, 3);
    assert.equal(config.policy.allowed.has('woo-mcp.mcp-servers.svc.cluster.local:8080'), true);
    assert.equal(config.ownNamespace, 'gateway');
  });

  test('a missing or empty UPSTREAM_ALLOWED_HOSTS stops the start and names the variable', () => {
    for (const value of [undefined, '', ' , ']) {
      assert.throws(() => loadUpstreamPolicyConfig(env({ UPSTREAM_ALLOWED_HOSTS: value })), (error: unknown) => error instanceof ConfigError && error.message.includes('UPSTREAM_ALLOWED_HOSTS'), String(value));
    }
  });

  test('a bad entry stops the start, and the message holds the position and not the value', () => {
    const value = `${THREE},10.43.0.1:8080`;
    assert.throws(() => loadUpstreamPolicyConfig(env({ UPSTREAM_ALLOWED_HOSTS: value })), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes('UPSTREAM_ALLOWED_HOSTS'));
      assert.ok(error.message.includes('entry 4'));
      assert.ok(!error.message.includes('10.43.0.1'));
      assert.ok(!error.message.includes(value));
      return true;
    });
  });

  test('a missing, empty or malformed POD_NAMESPACE stops the start and names the variable', () => {
    for (const value of [undefined, '', 'Gate way', '-gateway', 'a'.repeat(64)]) {
      assert.throws(() => loadUpstreamPolicyConfig(env({ POD_NAMESPACE: value })), (error: unknown) => error instanceof ConfigError && error.message.includes('POD_NAMESPACE'), String(value));
    }
  });

  test('an entry inside the own namespace is refused, so POD_NAMESPACE really is used', () => {
    assert.throws(() => loadUpstreamPolicyConfig(env({ UPSTREAM_ALLOWED_HOSTS: 'postgres.gateway.svc.cluster.local:5432' })), ConfigError);
    assert.equal(loadUpstreamPolicyConfig(env({ UPSTREAM_ALLOWED_HOSTS: 'postgres.gateway.svc.cluster.local:5432', POD_NAMESPACE: 'other' })).policy.allowed.size, 1);
  });

  test('no message contains the raw value', () => {
    const secretish = 'marker-9f3a.example.com:99999';
    for (const overrides of [{ UPSTREAM_ALLOWED_HOSTS: secretish }, { UPSTREAM_ALLOWED_HOSTS: `${THREE},${secretish}` }, { POD_NAMESPACE: 'marker_9f3a' }]) {
      assert.throws(() => loadUpstreamPolicyConfig(env(overrides)), (error: unknown) => error instanceof ConfigError && !error.message.includes('marker') && !error.message.includes('9f3a'));
    }
  });
});
