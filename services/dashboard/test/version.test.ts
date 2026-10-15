import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { ROOT, read } from './helpers/files';

// The image tag of the dashboard in the gateway chart must equal the version of this package. The tag is read by its
// key path (dashboard.image.tag), not by its position in the file, so the order of the blocks in the chart does not matter.
const chartFile = (name: string) => read(join(ROOT, '..', '..', 'charts', 'gateway', name));

// Reads one scalar from a YAML file that uses plain nested mappings with two-space indentation (the chart values).
function valueAt(text: string, path: string[]): string | undefined {
  let depth = 0;
  let from = 0;
  const lines = text.split('\n');
  for (const key of path) {
    const indent = depth * 2;
    let found = -1;
    for (let i = from; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      const lead = line.length - line.trimStart().length;
      if (lead < indent) break;
      if (lead === indent && line.trimStart().startsWith(`${key}:`)) {
        found = i;
        break;
      }
    }
    if (found < 0) return undefined;
    if (depth === path.length - 1) return (lines[found] ?? '').trimStart().slice(key.length + 1).trim().replace(/^"|"$/g, '');
    from = found + 1;
    depth += 1;
  }
  return undefined;
}

describe('version: the dashboard image tag in the chart', () => {
  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { version: string };
  const lock = JSON.parse(read(join(ROOT, 'package-lock.json'))) as { version: string; packages: Record<string, { version: string }> };

  test('package.json and package-lock.json name the same version', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  test('dashboard.image.tag in values.yaml and values-prod.yaml equals that version', () => {
    for (const file of ['values.yaml', 'values-prod.yaml']) expect(valueAt(chartFile(file), ['dashboard', 'image', 'tag']), file).toBe(pkg.version);
  });

  test('values-local.yaml names the image to import', () => {
    expect(chartFile('values-local.yaml')).toContain(`dashboard:${pkg.version}`);
  });

  test('the reader finds a key by its path, wherever the block stands (planted control)', () => {
    const planted = 'gateway:\n  image:\n    tag: "9.9.9"\ndashboard:\n  # note\n  image:\n    repository: x\n    tag: "1.2.3"\n';
    expect(valueAt(planted, ['dashboard', 'image', 'tag'])).toBe('1.2.3');
    expect(valueAt(planted, ['gateway', 'image', 'tag'])).toBe('9.9.9');
    expect(valueAt(planted, ['dashboard', 'image', 'nothing'])).toBeUndefined();
  });
});
