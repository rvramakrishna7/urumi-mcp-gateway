import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source files must be plain ASCII. A tool or an editor that rewrites an escape sequence into the literal character
// would change what the code means (a literal line separator even ends a line inside a regular expression) and
// would hide invisible characters from review. Write such characters with String.fromCharCode, or use property escapes.
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('source files are ASCII only', () => {
  for (const root of ['src']) {
    test(`every file under ${root}/ has only ASCII bytes`, () => {
      const offenders: string[] = [];
      for (const file of filesUnder(new URL(`../${root}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
        const bytes = readFileSync(file);
        const index = bytes.findIndex((byte) => byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d));
        if (index >= 0) offenders.push(`${file} (byte ${index})`);
      }
      assert.deepEqual(offenders, []);
    });
  }
});
