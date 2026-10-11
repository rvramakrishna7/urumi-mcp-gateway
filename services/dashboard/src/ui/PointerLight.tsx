import { useEffect, useRef, useState } from 'react';
import styles from './PointerLight.module.css';

// A soft spot of light that follows the cursor, behind the content. It only makes the grid and the lines near the cursor a
// little brighter, and it is not needed for anything.
//
// The one place where the dashboard writes to the CSSOM: the position goes into the custom property --spot of this one
// element with element.style.setProperty, and the CSS moves the spot with the "translate" property (a transform) only.
// The source guard allows exactly this one call (test/source-guard.test.ts). Setting a custom property through the CSSOM
// is not an inline style attribute, so the CSP (style-src 'self', no inline styles) is not involved; 13b checks that in a
// real browser.
//
// Not used for touch, for a pointer that cannot hover, or when the user asks for less motion.
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function allowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(FINE_POINTER).matches && !window.matchMedia(REDUCED_MOTION).matches;
}

export function PointerLight() {
  const spot = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(allowed);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const lists = [window.matchMedia(FINE_POINTER), window.matchMedia(REDUCED_MOTION)];
    const update = () => setEnabled(allowed());
    for (const list of lists) list.addEventListener('change', update);
    return () => {
      for (const list of lists) list.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const flush = () => {
      frame = 0;
      spot.current?.style.setProperty('--spot', `${x}px ${y}px`);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      x = event.clientX;
      y = event.clientY;
      setNear(true);
      if (frame === 0) frame = requestAnimationFrame(flush);
    };
    const onLeave = () => setNear(false);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  if (!enabled) return null;
  return <div ref={spot} className={near ? `${styles.spot} ${styles.near}` : styles.spot} aria-hidden="true" />;
}
