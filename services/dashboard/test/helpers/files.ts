import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The tests run with "npm test", so the working directory is the folder of the package (import.meta.url is not a file URL under jsdom).
export const ROOT = process.cwd();

export function listFiles(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...listFiles(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(path);
  }
  return found;
}

export const read = (path: string): string => readFileSync(path, 'utf8');
export const rel = (path: string): string => relative(ROOT, path).split('\\').join('/');

// Comments may name the things that the rules forbid (a comment can say "no localStorage"), so rules look at code only.
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

export const sourceFiles = (extensions: readonly string[]): string[] => listFiles(join(ROOT, 'src'), extensions);
