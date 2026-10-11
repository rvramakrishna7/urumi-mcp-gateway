import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { ROOT, read, rel, sourceFiles, stripComments } from './helpers/files';

// Rules that keep the dashboard inside its security and design contract. They read the source, so a rule is broken the
// moment a file breaks it, not when somebody notices in a browser.
const code = sourceFiles(['.ts', '.tsx']);
const styles = sourceFiles(['.css']);
const everything = [...code, ...styles];
const indexHtml = read(join(ROOT, 'index.html'));

const violations = (files: string[], pattern: RegExp, skip: (file: string) => boolean = () => false): string[] =>
  files.filter((file) => !skip(file)).flatMap((file) => (stripComments(read(file)).match(pattern) ?? []).map((hit) => `${rel(file)}: ${hit}`));

describe('source guard: the files that the rules read', () => {
  test('there is something to scan (a rule that scans nothing proves nothing)', () => {
    expect(code.length).toBeGreaterThanOrEqual(10);
    expect(styles.length).toBeGreaterThanOrEqual(10);
    expect(styles.some((file) => file.endsWith('tokens.css'))).toBe(true);
  });
});

describe('source guard: no browser storage (the session is the httpOnly cookie only)', () => {
  test('no storage API in the code', () => {
    expect(violations(code, /\b(localStorage|sessionStorage|indexedDB|openDatabase|StorageEvent)\b|document\s*\.\s*cookie|\bcaches\s*\.|cookieStore/g)).toEqual([]);
  });

  test('the rule does find a planted violation', () => {
    const planted = "const x = window.localStorage.getItem('a'); document.cookie = 'b';";
    expect(planted.match(/\b(localStorage|sessionStorage|indexedDB|openDatabase|StorageEvent)\b|document\s*\.\s*cookie/g)?.length).toBe(2);
  });
});

describe('source guard: nothing that runs or injects text as code or markup', () => {
  test('no innerHTML, eval, Function or document.write', () => {
    expect(violations(code, /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function\b|document\s*\.\s*write/g)).toEqual([]);
  });

  test('no console output (a value must never reach a console)', () => {
    expect(violations(code, /\bconsole\s*\./g)).toEqual([]);
  });

  test('no canvas, WebGL or 3D', () => {
    expect(violations(code, /getContext\s*\(|WebGL|<canvas|OffscreenCanvas/g)).toEqual([]);
    expect(violations(styles, /\bperspective\s*:|translateZ|translate3d|rotate3d|\bpreserve-3d\b/g)).toEqual([]);
  });
});

describe('source guard: styles come from classes and tokens, never from inline styles', () => {
  // The one exception: the pointer light writes its position into the custom property --spot of its own element with
  // element.style.setProperty (src/ui/PointerLight.tsx). The rule allows exactly that call, in exactly that file, once.
  const CSSOM_CALL = /\.style\.setProperty\('--spot', /g;

  test('the CSSOM is written in exactly one place: one setProperty("--spot") in PointerLight.tsx', () => {
    const hits = code.map((file) => [rel(file), (stripComments(read(file)).match(CSSOM_CALL) ?? []).length] as const).filter(([, count]) => count > 0);
    expect(hits).toEqual([['src/ui/PointerLight.tsx', 1]]);
  });

  test('no style attribute, style prop, other .style use or setAttribute("style") (the CSP has no inline styles)', () => {
    const bad = code.flatMap((file) => (stripComments(read(file)).replace(CSSOM_CALL, '').match(/\bstyle\s*=|\.style\b|setAttribute\(\s*['"]style|cssText/g) ?? []).map((hit) => `${rel(file)}: ${hit}`));
    expect(bad).toEqual([]);
  });

  test('the rule does find a planted second use of the CSSOM', () => {
    const planted = "el.style.setProperty('--spot', a); el.style.color = 'red'; el.style.setProperty('--other', b);";
    expect(planted.replace(CSSOM_CALL, '').match(/\bstyle\s*=|\.style\b/g)?.length).toBe(2);
  });

  test('colour values exist only in tokens.css', () => {
    const skip = (file: string) => file.endsWith('tokens.css');
    expect(violations(everything, /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/g, skip)).toEqual([]);
  });

  test('the rule does find a planted colour', () => {
    expect('a { color: #e89a5b; fill: rgb(1, 2, 3); }'.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl)\(/g)?.length).toBe(2);
  });
});

describe('source guard: nothing leaves the origin', () => {
  test('no absolute or protocol-relative URL, and no @import, in the code or the styles', () => {
    expect(violations(everything, /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+|@import/gi)).toEqual([]);
  });

  test('index.html: no inline script, no inline style, no event handler, only same-origin references', () => {
    expect(indexHtml.match(/<script(?![^>]*\bsrc=)/gi)).toBeNull();
    expect(indexHtml.match(/<style\b|\sstyle\s*=|\son[a-z]+\s*=/gi)).toBeNull();
    const references = [...indexHtml.matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/gi)].map((match) => match[1] ?? '');
    expect(references.length).toBeGreaterThanOrEqual(4);
    for (const reference of references) expect(reference.startsWith('/') && !reference.startsWith('//')).toBe(true);
  });
});

// Splits at commas that are not inside parentheses (cubic-bezier(...), var(...)).
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function keyframeBlocks(css: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (depth > 0 && index < css.length) {
      if (css[index] === '{') depth++;
      if (css[index] === '}') depth--;
      index++;
    }
    blocks.push({ name: match[1] ?? '', body: css.slice(start, index - 1) });
  }
  return blocks;
}

const ANIMATED = new Set(['transform', 'opacity', 'stroke-dashoffset']);

describe('source guard: motion', () => {
  test('transitions name only transform, opacity or stroke-dashoffset (never "all")', () => {
    const bad: string[] = [];
    for (const file of styles) {
      const css = stripComments(read(file));
      for (const match of css.matchAll(/(?<![\w-])transition(?:-property)?\s*:\s*([^;]+);/g)) {
        for (const item of splitTopLevel(match[1] ?? '')) {
          const property = item.split(/\s+/)[0] ?? '';
          if (property !== 'none' && !ANIMATED.has(property)) bad.push(`${rel(file)}: ${item}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('keyframes change only transform, opacity or stroke-dashoffset', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const file of styles) {
      for (const block of keyframeBlocks(stripComments(read(file)))) {
        seen++;
        for (const declaration of block.body.matchAll(/([a-z-]+)\s*:/g)) {
          const property = declaration[1] ?? '';
          if (!ANIMATED.has(property) && property !== 'animation-timing-function') bad.push(`${rel(file)} @keyframes ${block.name}: ${property}`);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(bad).toEqual([]);
  });

  test('the keyframes rule does find a planted violation', () => {
    const planted = keyframeBlocks('@keyframes x { from { width: 1px; opacity: 0 } to { height: 2px } }');
    const properties = planted.flatMap((block) => [...block.body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]));
    expect(properties.filter((property) => !ANIMATED.has(property ?? ''))).toEqual(['width', 'height']);
  });

  test('every file that animates or transitions also has a prefers-reduced-motion block', () => {
    const missing = styles.filter((file) => {
      const css = stripComments(read(file));
      return /(?<![\w-])(animation|transition)\s*:|@keyframes/.test(css) && !/prefers-reduced-motion:\s*reduce/.test(css);
    });
    expect(missing.map(rel)).toEqual([]);
  });
});

describe('source guard: files are ASCII (a tool of this environment rewrote \\u escapes into literal characters)', () => {
  test('src, test, index.html and the configs have no character above 127', () => {
    const files = [...everything, join(ROOT, 'index.html'), join(ROOT, 'vite.config.ts'), join(ROOT, 'vitest.config.ts')];
    const bad = files.filter((file) => /[^\x00-\x7f]/.test(read(file)));
    expect(bad.map(rel)).toEqual([]);
  });
});
