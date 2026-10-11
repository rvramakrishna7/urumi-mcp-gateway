import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The usage check happens before the CLI reads the database settings or connects, so no environment is needed.
const run = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });

describe('cli usage', () => {
  for (const args of [['--help'], ['--bogus'], ['user', 'create', '--email'], ['user', '--unknown', 'x']]) {
    test(`"${args.join(' ')}" prints the usage and exits with 2, without a stack trace and without stdout`, () => {
      const result = run(...args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^usage: cli /);
      assert.ok(!/TypeError|at .*\.ts/.test(result.stderr), 'no stack trace');
      assert.equal(result.stdout, '', 'stdout stays empty (it is reserved for a new key)');
    });
  }
});
