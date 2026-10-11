import type { SyntheticEvent } from 'react';
import { Backdrop } from '../topology/Backdrop';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { PointerLight } from '../ui/PointerLight';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './LoginPage.module.css';

// 13a: the static screen. The form does not call the gateway yet (that is sub-step 13c).
// The heading is written word by word, so that the backdrop knows where each word is and "one door." can have its own colour.
// The data-anchor attributes tell the backdrop where the text is, so that its lines keep away from it (topology/measure.ts).
export function LoginPage() {
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => event.preventDefault();
  return (
    <div className={styles.page}>
      <Backdrop />
      <PointerLight />
      <a className="skip-link" href="#main">
        Skip to the sign-in form
      </a>
      <header className={styles.header} data-anchor="header">
        <Brand />
        <ThemeToggle />
      </header>

      <main id="main" className={styles.main} tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="login-title">
          <p className={styles.eyebrow} data-anchor="eyebrow">
            Team MCP gateway
          </p>
          <h1 id="login-title" className={styles.title}>
            <span className={styles.line}>
              <span className={styles.word} data-anchor="word">
                Every
              </span>{' '}
              <span className={styles.word} data-anchor="word">
                tool,
              </span>
            </span>{' '}
            <span className={styles.line}>
              <span className={styles.word} data-anchor="word">
                through
              </span>
            </span>{' '}
            <span className={`${styles.line} ${styles.accent}`}>
              <span className={styles.word} data-anchor="word">
                one
              </span>{' '}
              <span className={styles.word} data-anchor="word">
                door.
              </span>
            </span>
          </h1>
          <p className={styles.lead} data-anchor="lead">
            Sign in to manage upstream servers, API keys and the audit log.
          </p>
        </section>

        <section className={styles.card} aria-labelledby="signin-title" data-anchor="card">
          <h2 id="signin-title" className={styles.cardTitle}>
            Sign in
          </h2>
          <form className={styles.form} onSubmit={onSubmit}>
            <Field label="Email" type="email" name="email" autoComplete="username" placeholder="you@example.com" required />
            <Field label="Password" type="password" name="password" autoComplete="current-password" required />
            <Button type="submit">Sign in</Button>
          </form>
          <p className={styles.note}>Preview build. Sign-in is connected in the next step.</p>
        </section>
      </main>
    </div>
  );
}
