import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The tests run with "npm test" from the folder of the package.
const ROOT = process.cwd();

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...listFiles(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(path);
  }
  return found;
}

const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(ROOT, path).split('\\').join('/');
const sources = listFiles(join(ROOT, 'src'), ['.ts']);
const all = [...sources, ...listFiles(join(ROOT, 'test'), ['.ts']), join(ROOT, 'Dockerfile'), join(ROOT, 'package.json')];

// Comments may name what the rules forbid, so the rules look at code only.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('source hygiene', () => {
  test('there is something to scan (a rule that scans nothing proves nothing)', () => {
    assert.ok(sources.length >= 10, `only ${sources.length} source files`);
  });

  test('files are ASCII (a tool of this environment rewrote \\u escapes into literal characters)', () => {
    const bad = all.filter((file) => /[^\x00-\x7f]/.test(read(file)));
    assert.deepEqual(bad.map(rel), []);
  });

  test('the rate service address is configuration only: the only http(s) URL literal in src is the default in config.ts', () => {
    const hits = sources.flatMap((file) => (stripComments(read(file)).match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).map((hit) => `${rel(file)}: ${hit}`));
    assert.deepEqual(hits, ['src/config.ts: https://api.frankfurter.dev']);
  });

  test('the rule does find a planted second URL', () => {
    assert.equal('const a = "https://evil.example/x"; const b = "http://127.0.0.1";'.match(/https?:\/\/[a-z0-9.-]+/gi)?.length, 2);
  });

  test('no console output and no eval or Function in src (a value must never reach a console)', () => {
    const hits = sources.flatMap((file) => (stripComments(read(file)).match(/\bconsole\s*\.|\beval\s*\(|new\s+Function\b/g) ?? []).map((hit) => `${rel(file)}: ${hit}`));
    assert.deepEqual(hits, []);
  });

  test('the Dockerfile runs as a numeric non-root user and pins its base image', () => {
    const dockerfile = read(join(ROOT, 'Dockerfile'));
    assert.match(dockerfile, /^USER 10001:10001$/m);
    assert.match(dockerfile, /^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-alpine[\d.]+$/m);
    assert.doesNotMatch(dockerfile, /:latest/);
  });

  test('the package has exactly the dependencies of woo-mcp (no new package for this server)', () => {
    const own = JSON.parse(read(join(ROOT, 'package.json'))) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const woo = JSON.parse(read(join(ROOT, '..', 'woo-mcp', 'package.json'))) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    assert.deepEqual(own.dependencies, woo.dependencies);
    assert.deepEqual(own.devDependencies, woo.devDependencies);
  });
});
