import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, read } from './helpers/files';

const FONTS = join(ROOT, 'public/fonts');
const files = readdirSync(FONTS).filter((name) => name.endsWith('.woff2')).sort();
const notes = read(join(FONTS, 'FONTS.md'));

describe('fonts: self-hosted files and their licences', () => {
  test('seven latin woff2 files are present', () => {
    expect(files).toHaveLength(7);
  });

  test('FONTS.md lists the SHA-256 of every file, and every hash is right', () => {
    const listed = new Map([...notes.matchAll(/^([0-9a-f]{64})\s+(\S+\.woff2)$/gm)].map((match) => [match[2] ?? '', match[1] ?? '']));
    expect([...listed.keys()].sort()).toEqual(files);
    for (const name of files) expect(createHash('sha256').update(readFileSync(join(FONTS, name))).digest('hex'), name).toBe(listed.get(name));
  });

  test('fonts.css loads exactly these files from /fonts/ and nothing else', () => {
    const css = read(join(ROOT, 'src/styles/fonts.css'));
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1] ?? '');
    expect(urls.map((url) => url.replace('/fonts/', '')).sort()).toEqual(files);
    for (const url of urls) expect(url).toMatch(/^\/fonts\/[\w-]+\.woff2$/);
  });

  test.each([
    ['bricolage-grotesque', 'Bricolage Grotesque Project Authors'],
    ['ibm-plex-sans', 'IBM Corp.'],
    ['ibm-plex-mono', 'IBM Corp.'],
  ])('the licence of %s is committed, with its copyright line', (family, copyright) => {
    const text = read(join(FONTS, 'LICENSES', `${family}-OFL.txt`));
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(text).toContain(copyright);
    expect(files.some((name) => name.startsWith(family))).toBe(true);
  });
});
