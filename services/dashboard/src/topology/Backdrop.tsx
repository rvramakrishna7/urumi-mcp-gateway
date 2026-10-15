import { useLayoutEffect, useRef, useState } from 'react';
import { BOARD, computeGeometry } from './geometry';
import type { Geometry, Line } from './geometry';
import { measurePage } from './measure';
import styles from './Backdrop.module.css';

// The quiet picture behind the login screen: a client line and a server line in the free band above the text and the same
// below it, meeting at one round node between the heading and the card. It is decoration: it carries no real server and no
// real status, so it is hidden from assistive technology. The real topology (with live status) is on the Servers screen.
//
// The lines are worked out from where the text really is (geometry.ts), so they keep to the free bands and to the middle of
// the gap whatever the window size. Where the layout cannot be measured, the picture of a 1440 x 900 window is drawn and
// scaled to cover ("slice").

// A line, and one dot that travels along it. pathLength makes the dash pattern one "line long", so there is exactly one dot
// on the line at a time, whatever its length (the dash and its run are in the CSS).
function Flow({ line }: { line: Line }) {
  return (
    <g>
      <path className={styles.base} d={line.d} />
      <path className={styles.dot} d={line.d} pathLength="1000" />
    </g>
  );
}

export function Backdrop() {
  const root = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry>(BOARD);
  const [measured, setMeasured] = useState(false);

  // Before the first paint, and again when the window, the page size or the loaded fonts change the layout.
  useLayoutEffect(() => {
    const page = root.current?.parentElement;
    if (!page) return;
    const update = () => {
      const measure = measurePage(page);
      setMeasured(measure !== null);
      setGeometry(measure ? computeGeometry(measure) : BOARD);
    };
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(page);
    void document.fonts?.ready.then(update);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, []);

  const { node, incoming, outgoing, width, height } = geometry;
  return (
    <div ref={root} className={styles.backdrop} aria-hidden="true">
      <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={measured ? 'none' : 'xMidYMid slice'} focusable="false">
        <g className={styles.incoming}>
          {incoming.map((line) => (
            <Flow key={line.id} line={line} />
          ))}
        </g>
        <g className={styles.outgoing}>
          {outgoing.map((line) => (
            <g key={line.id}>
              <Flow line={line} />
              <circle className={styles.end} cx={line.end.x} cy={line.end.y} r="5" />
            </g>
          ))}
        </g>
        {/* The heartbeat: one slow, faint ring, started at the moment the first client dot arrives (see the CSS). */}
        <circle className={styles.beat} cx={node.x} cy={node.y} r={node.r} />
        <circle className={styles.node} cx={node.x} cy={node.y} r={node.r} />
      </svg>
    </div>
  );
}
