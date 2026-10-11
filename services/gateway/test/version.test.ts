import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.ts';

const chartFile = (name: string) => readFileSync(new URL(`../../../charts/gateway/${name}`, import.meta.url), 'utf8');

describe('version', () => {
  test('VERSION equals the version in package.json and in package-lock.json', () => {
    const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    const lock = read('../package-lock.json');
    assert.equal(read('../package.json').version, VERSION);
    assert.equal(lock.version, VERSION);
    assert.equal(lock.packages[''].version, VERSION);
  });

  test('the one VERSION constant equals the image tag in the chart values', () => {
    for (const file of ['values.yaml', 'values-prod.yaml']) {
      const tag = /^\s+tag:\s*"([^"]+)"/m.exec(chartFile(file))?.[1];
      assert.equal(tag, VERSION, file);
    }
    assert.ok(chartFile('values-local.yaml').includes(`gateway:${VERSION}`), 'values-local.yaml names the image to import');
  });

  test('no other source file hard-codes a version for the MCP server or client', () => {
    for (const file of ['../src/mcp/server.ts', '../src/upstream/client.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.ok(!/version:\s*'/.test(text), `${file} has a literal version`);
    }
  });
});
