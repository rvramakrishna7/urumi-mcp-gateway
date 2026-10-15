// The lines of the login backdrop, worked out from the real layout of the page, so that no line runs through the brand row,
// the theme button, any text, or near the card. This file is plain arithmetic: it has no DOM access, so it is tested on
// its own for many window sizes (test/backdrop-geometry.test.ts).
//
// The picture is small on purpose: one client line and one server line in the free band above the text, the same below it,
// and one round node (the gateway) between the heading and the card, where the lines meet.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Measure {
  width: number;
  height: number;
  // The row with the brand and the theme button.
  header: Box;
  // Where text is: the eyebrow, every word of the heading, the lead. A line must keep away from these.
  textBoxes: Box[];
  // The sign-in card. It is opaque, so a line under it is not seen; the card text needs no clearance.
  card: Box;
  // The right edge of the heading column text, and so the left edge of the gap in which the gateway sits.
  headingRight: number;
  // A narrow window: the card is under the heading, so there is no gap beside the text. The picture is then a short
  // line through the node in the free band under the card.
  stacked?: boolean;
}

export interface Line {
  id: string;
  d: string;
  points: ReadonlyArray<readonly [number, number]>;
}

export interface Outgoing extends Line {
  end: { x: number; y: number };
}

export interface Geometry {
  width: number;
  height: number;
  node: { x: number; y: number; r: number };
  incoming: Line[];
  outgoing: Outgoing[];
}

const MARGIN = 18;
const CHAMFER = 16;
const OVERSHOOT = 40;
const START = -10;
export const NODE_RADIUS = 9;
const DIAGONAL = Math.SQRT1_2;

// What the page looks like at 1440 x 900. It is used when the layout cannot be measured (a test without layout).
export const BOARD_MEASURE: Measure = {
  width: 1440,
  height: 900,
  header: { left: 112, top: 24, right: 1328, bottom: 64 },
  textBoxes: [
    { left: 112, top: 255, right: 270, bottom: 270 },
    { left: 112, top: 288, right: 630, bottom: 593 },
    { left: 112, top: 615, right: 430, bottom: 680 },
  ],
  card: { left: 919, top: 252, right: 1328, bottom: 681 },
  headingRight: 630,
};

const toPath = (points: ReadonlyArray<readonly [number, number]>): string =>
  points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`).join('');

// The row of a free band: the middle of it when it is at least 24 high, else none.
function row(from: number, to: number): number | null {
  return to - from >= 24 ? (from + to) / 2 : null;
}

// A narrow window: a short line comes in from the left edge, passes through the node, and leaves to the right edge.
function computeStacked(measure: Measure): Geometry {
  const { width, height, textBoxes, card } = measure;
  const bottom = Math.max(card.bottom, ...textBoxes.map((box) => box.bottom));
  const from = bottom + MARGIN;
  const to = height - MARGIN;
  const y = from + Math.max(to - from, 0) / 2;
  const node = { x: width / 2, y, r: NODE_RADIUS };
  const into: Array<readonly [number, number]> = [[START, y], [node.x - node.r, y]];
  const out: Array<readonly [number, number]> = [[node.x + node.r, y], [width + OVERSHOOT, y]];
  return {
    width,
    height,
    node,
    incoming: [{ id: 'in-0', d: toPath(into), points: into }],
    outgoing: [{ id: 'out-0', d: toPath(out), points: out, end: { x: width - 22, y } }],
  };
}

export function computeGeometry(measure: Measure): Geometry {
  if (measure.stacked) return computeStacked(measure);
  const { width, height, header, textBoxes, card, headingRight } = measure;
  const allTop = Math.min(card.top, ...textBoxes.map((box) => box.top));
  const allBottom = Math.max(card.bottom, ...textBoxes.map((box) => box.bottom));
  const gapLeft = headingRight + 24;
  const gapRight = card.left - 24;
  const gap = Math.max(gapRight - gapLeft, 0);

  const node = { x: (gapLeft + gapRight) / 2, y: (allTop + allBottom) / 2, r: NODE_RADIUS };
  // How far the vertical lines are from the node's axis. They stay in the middle of the gap, away from the text and the card.
  const spread = Math.min(34, Math.max(gap / 2 - 16, 14));
  const leftX = node.x - spread;
  const rightX = node.x + spread;

  const bands = [
    { side: 'top' as const, y: row(header.bottom + MARGIN, allTop - MARGIN) },
    { side: 'bottom' as const, y: row(allBottom + MARGIN, height - MARGIN) },
  ].filter((band): band is { side: 'top' | 'bottom'; y: number } => band.y !== null);

  const incoming: Line[] = [];
  const outgoing: Outgoing[] = [];
  for (const { side, y } of bands) {
    const sign = side === 'top' ? -1 : 1; // the node is below the top row and above the bottom row
    const toward = (distance: number) => node.y + sign * distance; // a y that is `distance` from the node, on this side
    const turn = Math.min(spread, Math.abs(node.y - y) - CHAMFER - 4);
    const nodeEdge = NODE_RADIUS * DIAGONAL;

    // The client line: from the left edge along the row, down (or up) the left side of the gap, into the node.
    const inPoints: Array<readonly [number, number]> = [
      [START, y],
      [leftX - CHAMFER, y],
      [leftX, y - sign * CHAMFER],
      [leftX, toward(turn)],
      [node.x - nodeEdge, node.y + sign * nodeEdge],
    ];
    incoming.push({ id: `in-${side}`, d: toPath(inPoints), points: inPoints });

    // The server line: out of the node, up (or down) the right side of the gap, along the same row to the right edge.
    const outPoints: Array<readonly [number, number]> = [
      [node.x + nodeEdge, node.y + sign * nodeEdge],
      [rightX, toward(turn)],
      [rightX, y - sign * CHAMFER],
      [rightX + CHAMFER, y],
      [width + OVERSHOOT, y],
    ];
    outgoing.push({ id: `out-${side}`, d: toPath(outPoints), points: outPoints, end: { x: width - 22, y } });
  }
  return { width, height, node, incoming, outgoing };
}

// The default picture, for when nothing is measured.
export const BOARD: Geometry = computeGeometry(BOARD_MEASURE);

// Points along a line, for the overlap test and nothing else.
export function sample(points: ReadonlyArray<readonly [number, number]>, step = 4): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const count = Math.max(Math.ceil(Math.hypot(bx - ax, by - ay) / step), 1);
    for (let k = 0; k <= count; k++) out.push([ax + ((bx - ax) * k) / count, ay + ((by - ay) * k) / count]);
  }
  return out;
}
