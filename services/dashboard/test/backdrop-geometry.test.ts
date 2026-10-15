import { describe, expect, test } from 'vitest';
import { BOARD, BOARD_MEASURE, NODE_RADIUS, computeGeometry, sample } from '../src/topology/geometry';
import type { Box, Geometry, Line, Measure } from '../src/topology/geometry';

// A model of the login layout (the CSS of LoginPage): a header row, then a heading column and a card, centred in what is
// left. It gives the numbers that measurePage would read, so the lines can be checked for many window sizes without a
// browser. The real page is also measured in a browser (the screenshots of sub-step 13a).
function layout(width: number, height: number): Measure {
  const container = Math.min(1216, width - 48);
  const left = (width - container) / 2;
  const font = Math.min(Math.max(width * 0.076, 48), 108);
  const columns = (container - 48) / 2;
  const cardWidth = columns * 0.7;
  const headingWidth = 4.8 * font;
  const headingHeight = 2.82 * font;
  const blockHeight = 15 + 16 + headingHeight + 24 + 62;
  const cardHeight = 429;
  const total = Math.max(blockHeight, cardHeight);
  const pageHeight = Math.max(height, 64 + total + 24 + 40);
  const top = 64 + (pageHeight - 64 - 24 - total) / 2 + 12;
  const introTop = top + (total - blockHeight) / 2;
  const cardTop = top + (total - cardHeight) / 2;
  const eyebrow: Box = { left, top: introTop, right: left + 158, bottom: introTop + 15 };
  const words: Box = { left, top: introTop + 31, right: left + headingWidth, bottom: introTop + 31 + headingHeight };
  const lead: Box = { left, top: words.bottom + 24, right: left + 480, bottom: words.bottom + 24 + 62 };
  const card: Box = { left: left + container - cardWidth, top: cardTop, right: left + container, bottom: cardTop + cardHeight };
  return {
    width,
    height: pageHeight,
    header: { left, top: 24, right: left + container, bottom: 64 },
    textBoxes: [eyebrow, words, lead],
    card,
    headingRight: Math.max(eyebrow.right, words.right, lead.right),
  };
}

// The stacked layout (a window under 62rem): the heading, then the card under it, then a free band under the card.
function stackedLayout(width: number, height: number): Measure {
  const left = 24;
  const container = width - 48;
  const font = Math.min(Math.max(width * 0.076, 48), 108);
  const headingWidth = Math.min(4.8 * font, container);
  const eyebrow: Box = { left, top: 96, right: left + 158, bottom: 111 };
  const words: Box = { left, top: 127, right: left + headingWidth, bottom: 127 + 2.82 * font };
  const lead: Box = { left, top: words.bottom + 24, right: left + Math.min(480, container), bottom: words.bottom + 24 + 62 };
  const card: Box = { left, top: lead.bottom + 32, right: left + container, bottom: lead.bottom + 32 + 429 };
  return {
    width,
    height: Math.max(height, card.bottom + 112),
    header: { left, top: 24, right: left + container, bottom: 64 },
    textBoxes: [eyebrow, words, lead],
    card,
    headingRight: Math.max(eyebrow.right, words.right, lead.right),
    stacked: true,
  };
}

const inside = (x: number, y: number, box: Box, pad = 0) => x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad;
const distanceToBox = (x: number, y: number, box: Box) => Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
const allLines = (geometry: Geometry): Line[] => [...geometry.incoming, ...geometry.outgoing];

// Every point of every visible line must keep clear of the header row and of the text. A point under the card is not seen
// (the card is opaque), so the card text needs no clearance.
function violations(measure: Measure, geometry: Geometry, pad = 8): string[] {
  const found: string[] = [];
  for (const line of allLines(geometry)) {
    for (const [x, y] of sample(line.points)) {
      if (x < 0 || x > measure.width) continue;
      if (inside(x, y, measure.card)) continue;
      if (inside(x, y, measure.header, pad)) found.push(`${line.id} touches the header at ${Math.round(x)},${Math.round(y)}`);
      for (const box of measure.textBoxes) if (inside(x, y, box, pad)) found.push(`${line.id} touches text at ${Math.round(x)},${Math.round(y)}`);
    }
  }
  return found;
}

// Nothing runs near the card: a line keeps at least 28 units from it, and a slanted piece (a corner or the way into the
// node) at least 40. Under the card, a line is not seen at all, but none is drawn there on purpose.
function nearCard(measure: Measure, geometry: Geometry): string[] {
  const found: string[] = [];
  for (const line of allLines(geometry)) {
    for (let i = 1; i < line.points.length; i++) {
      const [ax, ay] = line.points[i - 1]!;
      const [bx, by] = line.points[i]!;
      const slanted = Math.abs(ax - bx) > 0.5 && Math.abs(ay - by) > 0.5;
      for (const [x, y] of sample([[ax, ay], [bx, by]])) {
        if (x < 0 || x > measure.width) continue;
        const distance = distanceToBox(x, y, measure.card);
        if (distance < (slanted ? 40 : 28)) found.push(`${line.id} is ${Math.round(distance)} from the card at ${Math.round(x)},${Math.round(y)}${slanted ? ' (slanted)' : ''}`);
      }
    }
  }
  return found;
}

const SIZES: Array<[number, number]> = [
  [1000, 700], [1100, 650], [1280, 720], [1366, 657], [1440, 900], [1536, 730], [1600, 900], [1680, 1050], [1920, 1080],
  [1920, 940], [2560, 1300], [2560, 1440], [1280, 1024], [1024, 768], [1100, 1200],
];
const NARROW: Array<[number, number]> = [[360, 740], [400, 860], [414, 896], [768, 1024], [900, 1100], [990, 800]];

describe('backdrop geometry: the lines keep clear of the text, the brand row and the card', () => {
  test.each(SIZES)('window %i x %i: no line touches the header or any text, and none runs near the card', (width, height) => {
    const measure = layout(width, height);
    const geometry = computeGeometry(measure);
    expect(violations(measure, geometry)).toEqual([]);
    expect(nearCard(measure, geometry)).toEqual([]);
  });

  test('the default (1440 x 900) picture is clean too', () => {
    expect(violations(BOARD_MEASURE, BOARD)).toEqual([]);
    expect(nearCard(BOARD_MEASURE, BOARD)).toEqual([]);
  });

  test('the checkers do find a line through the brand row, through text and near the card (planted)', () => {
    const measure = layout(1440, 900);
    const planted: Geometry = {
      ...computeGeometry(measure),
      incoming: [
        { id: 'planted-header', d: '', points: [[0, 44], [1440, 44]] },
        { id: 'planted-text', d: '', points: [[0, 450], [600, 450]] },
        { id: 'planted-card', d: '', points: [[700, 700], [900, 700]] },
        { id: 'planted-slant', d: '', points: [[820, 200], [900, 240]] },
      ],
      outgoing: [],
    };
    const found = violations(measure, planted);
    expect(found.some((text) => text.startsWith('planted-header touches the header'))).toBe(true);
    expect(found.some((text) => text.startsWith('planted-text touches text'))).toBe(true);
    const near = nearCard(measure, planted);
    expect(near.some((text) => text.startsWith('planted-card'))).toBe(true);
    expect(near.some((text) => text.includes('planted-slant') && text.includes('(slanted)'))).toBe(true);
  });
});

describe('backdrop geometry: a small picture', () => {
  test.each(SIZES)('window %i x %i: at most two lines each way, the node in the gap, lines reach the edges', (width, height) => {
    const measure = layout(width, height);
    const geometry = computeGeometry(measure);
    const { node } = geometry;

    expect(node.r).toBe(NODE_RADIUS);
    expect(node.x - node.r).toBeGreaterThan(measure.headingRight);
    expect(node.x + node.r).toBeLessThan(measure.card.left);
    expect(geometry.incoming.length).toBeGreaterThanOrEqual(1);
    expect(geometry.incoming.length).toBeLessThanOrEqual(2);
    expect(geometry.outgoing.length).toBe(geometry.incoming.length);

    for (const line of geometry.incoming) {
      expect(line.points[0]![0], `${line.id} starts left of the window edge`).toBeLessThanOrEqual(0);
      const last = line.points[line.points.length - 1]!;
      expect(Math.hypot(last[0] - node.x, last[1] - node.y), `${line.id} ends on the node`).toBeCloseTo(node.r, 5);
    }
    for (const line of geometry.outgoing) {
      const first = line.points[0]!;
      expect(Math.hypot(first[0] - node.x, first[1] - node.y), `${line.id} starts on the node`).toBeCloseTo(node.r, 5);
      expect(line.points[line.points.length - 1]![0], `${line.id} runs past the right edge`).toBeGreaterThanOrEqual(width);
    }
  });

  test.each(SIZES)('window %i x %i: no two lines cross', (width, height) => {
    const lines = allLines(computeGeometry(layout(width, height)));
    const segments = lines.map((line) => line.points.slice(1).map((point, index) => [line.points[index]!, point] as const));
    const orient = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const cross = (a: readonly [readonly [number, number], readonly [number, number]], b: readonly [readonly [number, number], readonly [number, number]]) =>
      orient(a[0], a[1], b[0]) * orient(a[0], a[1], b[1]) < -1e-6 && orient(b[0], b[1], a[0]) * orient(b[0], b[1], a[1]) < -1e-6;
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++)
        for (const a of segments[i]!) for (const b of segments[j]!) expect(cross(a, b), `${lines[i]!.id} crosses ${lines[j]!.id}`).toBe(false);
  });

  test('a tall window has a line above and below the text; a very short one only what fits', () => {
    expect(computeGeometry(layout(1920, 1080)).incoming.map((line) => line.id)).toEqual(['in-top', 'in-bottom']);
    const short = computeGeometry(layout(1366, 500));
    expect(short.incoming.length).toBeLessThanOrEqual(2);
  });

  test('nothing is drawn that says disabled: the lines carry no state at all', () => {
    for (const line of allLines(computeGeometry(layout(1440, 900)))) expect(Object.keys(line)).not.toContain('state');
  });
});

describe('backdrop geometry: the stacked layout (narrow window)', () => {
  test.each(NARROW)('window %i x %i: one short line through the node under the card, touching nothing', (width, height) => {
    const measure = stackedLayout(width, height);
    const geometry = computeGeometry(measure);
    expect(violations(measure, geometry)).toEqual([]);
    expect(geometry.incoming).toHaveLength(1);
    expect(geometry.outgoing).toHaveLength(1);
    expect(geometry.node.y - geometry.node.r).toBeGreaterThan(measure.card.bottom);
    expect(geometry.node.y + geometry.node.r).toBeLessThan(measure.height);
    expect(geometry.incoming[0]!.points[0]![0]).toBeLessThanOrEqual(0);
    expect(geometry.outgoing[0]!.points.at(-1)![0]).toBeGreaterThanOrEqual(width);
  });
});
