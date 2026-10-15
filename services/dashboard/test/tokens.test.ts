import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { ROOT, read } from './helpers/files';

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
export function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}
function mix(a: string, b: string, percent: number): string {
  const part = (index: number) => Math.round(parseInt(a.slice(index, index + 2), 16) * (percent / 100) + parseInt(b.slice(index, index + 2), 16) * (1 - percent / 100));
  return `#${[1, 3, 5].map((index) => part(index).toString(16).padStart(2, '0')).join('')}`;
}

const css = read(join(ROOT, 'src/styles/tokens.css'));
function block(opening: string): Record<string, string> {
  const start = css.indexOf(opening);
  expect(start, `block ${opening}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  const values: Record<string, string> = {};
  for (const match of css.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) values[match[1] ?? ''] = (match[2] ?? '').trim();
  return values;
}

const dark = block(":root[data-theme='dark'] {") ;
const light = block(":root[data-theme='light'] {");
const preferred = block(':root:not([data-theme]) {');

const KEYS = ['bg', 'fg', 'muted', 'panel', 'line', 'line-strong', 'field', 'accent', 'on-accent', 'ok', 'bad', 'tint'];

describe('tokens', () => {
  test('both themes define the same tokens, and the "prefers light" copy equals the light theme', () => {
    expect(Object.keys(dark).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(light).sort()).toEqual([...KEYS].sort());
    expect(preferred).toEqual(light);
  });

  test('the radius is 10px', () => {
    expect(css).toMatch(/--radius:\s*10px;/);
  });

  for (const [name, theme] of [['dark', dark], ['light', light]] as const) {
    describe(`${name} theme contrast`, () => {
      const text = (foreground: string, background: string) => ratio(theme[foreground] ?? '', theme[background] ?? '');
      test.each([
        ['fg', 'bg'], ['fg', 'panel'], ['fg', 'field'],
        ['muted', 'bg'], ['muted', 'panel'], ['muted', 'field'],
        ['accent', 'bg'], ['accent', 'panel'],
        ['on-accent', 'accent'],
        ['ok', 'bg'], ['ok', 'panel'], ['bad', 'bg'], ['bad', 'panel'],
      ])('%s on %s is at least 4.5:1', (foreground, background) => {
        expect(text(foreground, background)).toBeGreaterThanOrEqual(4.5);
      });

      test.each([['bg'], ['panel'], ['field']])('the border of a control (line-strong) on %s is at least 3:1', (background) => {
        expect(text('line-strong', background)).toBeGreaterThanOrEqual(3);
      });

      test.each([['ok'], ['bad'], ['accent'], ['muted']])('a %s badge text on its own tint over the panel is at least 4.5:1', (tone) => {
        const percent = Number.parseInt(theme.tint ?? '0', 10);
        const background = mix(theme[tone] ?? '', theme.panel ?? '', percent);
        expect(ratio(theme[tone] ?? '', background)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  test('the contrast function is right on known values', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(ratio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});
