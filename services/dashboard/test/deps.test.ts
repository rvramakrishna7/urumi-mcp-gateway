import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { ROOT, read } from './helpers/files';

const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const lock = JSON.parse(read(join(ROOT, 'package-lock.json'))) as { packages: Record<string, { dev?: boolean; hasInstallScript?: boolean }> };

describe('dependencies: a short list, exact versions, no UI kit', () => {
  test('every version is exact (no ^, ~ or range)', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the runtime dependencies are exactly the approved four', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@tanstack/react-query', 'react', 'react-dom', 'react-router']);
  });

  test('the production tree is the four and their own dependencies, nothing else (8 packages)', () => {
    const production = Object.entries(lock.packages)
      .filter(([path, entry]) => path !== '' && !entry.dev)
      .map(([path]) => path.replace('node_modules/', ''))
      .sort();
    expect(production).toEqual(['@remix-run/route-pattern', '@tanstack/query-core', '@tanstack/react-query', 'cookie-es', 'react', 'react-dom', 'react-router', 'scheduler']);
  });

  test('no styling or animation library is installed, not even as a dev dependency', () => {
    const forbidden = /^(tailwindcss|bootstrap|@mui\/|@chakra-ui|antd|@mantine|styled-components|@emotion|framer-motion|motion|gsap|three|lottie|@radix-ui|daisyui)/;
    const names = Object.keys(lock.packages).map((path) => path.replace('node_modules/', ''));
    expect(names.filter((name) => forbidden.test(name))).toEqual([]);
  });

  test('install scripts are off (.npmrc), and only fsevents (macOS only) has one', () => {
    expect(read(join(ROOT, '.npmrc'))).toMatch(/^ignore-scripts=true$/m);
    expect(Object.entries(lock.packages).filter(([, entry]) => entry.hasInstallScript).map(([path]) => path)).toEqual(['node_modules/fsevents']);
  });
});
