import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'ok' | 'bad' | 'accent' | 'muted';

// The meaning is in the text. The colour only supports it, so it is never the only signal.
export function Badge({ tone = 'muted', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
