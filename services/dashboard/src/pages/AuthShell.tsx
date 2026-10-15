import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Backdrop } from '../topology/Backdrop';
import { Brand } from '../ui/Brand';
import { PointerLight } from '../ui/PointerLight';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './LoginPage.module.css';

export interface HeadlineLine {
  words: string[];
  accent?: boolean;
}

interface AuthShellProps {
  skipLabel: string;
  eyebrow: string;
  titleId: string;
  lines: HeadlineLine[];
  lead: string;
  cardId: string;
  cardTitle: string;
  children: ReactNode;
}

// The frame of the two public screens (sign in, accept an invite): the backdrop, the heading written word by word, and the card.
// The heading is written word by word, so that the backdrop knows where each word is and the last line can have its own colour.
// The data-anchor attributes tell the backdrop where the text is, so that its lines keep away from it (topology/measure.ts).
export function AuthShell({ skipLabel, eyebrow, titleId, lines, lead, cardId, cardTitle, children }: AuthShellProps) {
  return (
    <div className={styles.page}>
      <Backdrop />
      <PointerLight />
      <a className="skip-link" href="#main">
        {skipLabel}
      </a>
      <header className={styles.header} data-anchor="header">
        <Brand />
        <ThemeToggle />
      </header>

      <main id="main" className={styles.main} tabIndex={-1}>
        <section className={styles.intro} aria-labelledby={titleId}>
          <p className={styles.eyebrow} data-anchor="eyebrow">
            {eyebrow}
          </p>
          <h1 id={titleId} className={styles.title}>
            {lines.map((line, index) => (
              <Fragment key={line.words.join(' ')}>
                {index > 0 ? ' ' : null}
                <span className={line.accent ? `${styles.line} ${styles.accent}` : styles.line}>
                  {line.words.map((word, position) => (
                    <Fragment key={word}>
                      {position > 0 ? ' ' : null}
                      <span className={styles.word} data-anchor="word">
                        {word}
                      </span>
                    </Fragment>
                  ))}
                </span>
              </Fragment>
            ))}
          </h1>
          <p className={styles.lead} data-anchor="lead">
            {lead}
          </p>
        </section>

        <section className={styles.card} aria-labelledby={cardId} data-anchor="card">
          <h2 id={cardId} className={styles.cardTitle}>
            {cardTitle}
          </h2>
          {children}
        </section>
      </main>
    </div>
  );
}
