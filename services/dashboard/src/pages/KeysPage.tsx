import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { keysMessage } from '../auth/messages';
import { RevealKey } from '../keys/RevealKey';
import { MAX_ACTIVE_KEYS, useCreateKey, useKeys, useRevokeKey } from '../keys/useKeys';
import { Badge } from '../ui/Badge';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ThemeToggle } from '../ui/ThemeToggle';
import type { ApiKey } from '../api/client';
import styles from './KeysPage.module.css';

const day = (iso: string): string => iso.slice(0, 10);
const moment = (iso: string | null): string => (iso === null ? 'Never' : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);

// The keys of the signed-in person, for any role. The gateway scopes every call by the session, so this screen never sends a user id.
export function KeysPage() {
  const keys = useKeys();
  const create = useCreateKey();
  const revoke = useRevokeKey();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  // The plain key of the last create. Component state only: never in the query cache, never in storage.
  const [revealed, setRevealed] = useState<{ secret: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const all: ApiKey[] = keys.data ?? [];
  const active = all.filter((key) => key.status === 'active');
  const revoked = all.filter((key) => key.status === 'revoked');
  const atLimit = active.length >= MAX_ACTIVE_KEYS;

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setRevealed(null);
    setNameError(null);
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      setNameError('Enter a name of 1 to 100 characters.');
      return;
    }
    try {
      const created = await create.mutateAsync(trimmed);
      setRevealed({ secret: created.key, name: created.meta.name });
      // The mounted observer still points at the finished mutation, which holds the plain key: let it go now.
      create.reset();
      setName('');
    } catch (error) {
      setNameError(keysMessage(error, 'create'));
    }
  };

  const onRevoke = async (id: string) => {
    setConfirming(null);
    try {
      await revoke.mutateAsync(id);
    } catch {
      // The message is read from revoke.error below.
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <nav className={styles.nav} aria-label="Account">
          <Link to="/" className={styles.back}>
            Back
          </Link>
          <ThemeToggle />
        </nav>
      </header>
      <main id="main" className={styles.main}>
        <h1 className={styles.title}>API keys</h1>
        <p className={styles.note}>Keys let a tool such as Claude Code or Cursor use the gateway as you. Only the first characters of a key are kept for display.</p>

        <form className={styles.form} onSubmit={(event) => void onCreate(event)} noValidate>
          <Field
            label="Key name"
            hint={atLimit ? 'You have 10 active keys. Revoke one to create another.' : 'For example: laptop, or cursor'}
            error={nameError ?? undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            autoComplete="off"
            disabled={atLimit}
          />
          <Button type="submit" disabled={atLimit || create.isPending}>
            Create key
          </Button>
        </form>

        {revealed ? <RevealKey secret={revealed.secret} name={revealed.name} onDone={() => setRevealed(null)} /> : null}

        {keys.isPending ? <p className={styles.note}>Loading your keys...</p> : null}
        {keys.isError ? (
          <div className={styles.block}>
            <p className={styles.error} role="alert">
              {keysMessage(keys.error, 'load')}
            </p>
            <Button variant="ghost" onClick={() => void keys.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {revoke.isError ? (
          <p className={styles.error} role="alert">
            {keysMessage(revoke.error, 'revoke')}
          </p>
        ) : null}

        {keys.isSuccess ? (
          <section aria-labelledby="active-title" className={styles.block}>
            <h2 id="active-title" className={styles.sectionTitle}>
              Active ({active.length} of {MAX_ACTIVE_KEYS})
            </h2>
            {active.length === 0 ? <p className={styles.note}>You have no active keys.</p> : null}
            <ul className={styles.list}>
              {active.map((key) => (
                <li key={key.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <span className={styles.itemName}>{key.name}</span>
                    <code className={styles.prefix}>{key.keyPrefix}...</code>
                  </div>
                  <dl className={styles.meta}>
                    <dt>Created</dt>
                    <dd>{day(key.createdAt)}</dd>
                    <dt>Last used</dt>
                    <dd>{moment(key.lastUsedAt)}</dd>
                  </dl>
                  {confirming === key.id ? (
                    <div className={styles.confirm} role="group" aria-label={`Revoke ${key.name}`}>
                      <p className={styles.confirmText}>Revoke "{key.name}"? Anything that uses it stops at once.</p>
                      <div className={styles.actions}>
                        <Button onClick={() => void onRevoke(key.id)}>Confirm revoke</Button>
                        <Button variant="ghost" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirming(key.id)} disabled={revoke.isPending} aria-label={`Revoke ${key.name}`}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {keys.isSuccess && revoked.length > 0 ? (
          <section aria-labelledby="revoked-title" className={`${styles.block} ${styles.revokedBlock}`}>
            <h2 id="revoked-title" className={styles.sectionTitle}>
              Revoked ({revoked.length})
            </h2>
            <ul className={styles.list}>
              {revoked.map((key) => (
                <li key={key.id} className={`${styles.item} ${styles.revokedItem}`}>
                  <div className={styles.itemMain}>
                    <span className={styles.itemName}>{key.name}</span>
                    <code className={styles.prefix}>{key.keyPrefix}...</code>
                    <Badge tone="muted">Revoked</Badge>
                  </div>
                  <dl className={styles.meta}>
                    <dt>Created</dt>
                    <dd>{day(key.createdAt)}</dd>
                    <dt>Revoked</dt>
                    <dd>{moment(key.revokedAt)}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
