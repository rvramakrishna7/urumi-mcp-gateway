import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, loadDbConfig } from '../src/config.ts';

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
