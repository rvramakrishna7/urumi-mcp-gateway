import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { AUDIT_OUTCOMES } from '../api/client';
import type { AuditFilter, AuditItem, AuditOutcome } from '../api/client';
import { useAudit, useUserOptions } from '../audit/useAudit';
import { auditMessage } from '../auth/messages';
import { useSession } from '../auth/session';
import { Badge } from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './AuditPage.module.css';

const SLUG = /^[a-z][a-z0-9-]{0,19}$/;
const STALE_START_MS = 5 * 60 * 1000;
const NO_FILTER: AuditFilter = { outcomes: [], server: '', userId: '' };

const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  ok: 'OK',
  error: 'Tool error',
  timeout: 'Timed out',
  unreachable: 'Unreachable',
  unknown_tool: 'Unknown tool',
  denied: 'Denied',
  interrupted: 'Interrupted',
  started: 'In progress',
};

const OUTCOME_TONE: Record<AuditOutcome, BadgeTone> = {
  ok: 'ok',
  error: 'bad',
  timeout: 'bad',
  unreachable: 'bad',
  unknown_tool: 'bad',
  denied: 'bad',
  interrupted: 'muted',
  started: 'accent',
};

const moment = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
const duration = (ms: number | null): string => (ms === null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// A call that never ended (the gateway stopped during it) stays "started": the sweeper is not built, so the screen says so.
function outcomeLabel(item: AuditItem, now: number): string {
  if (item.outcome === 'started' && now - Date.parse(item.ts) > STALE_START_MS) return 'No result recorded';
  return OUTCOME_LABEL[item.outcome];
}

// The tool calls of the signed-in person (a member) or of everybody (an admin). The gateway decides the scope from the
// session; this screen only sends the filters. Every value from a row is shown as plain text.
export function AuditPage() {
  const session = useSession();
  const isAdmin = session.data?.role === 'admin';
  const [filter, setFilter] = useState<AuditFilter>(NO_FILTER);
  const [serverDraft, setServerDraft] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const audit = useAudit(filter);
  const users = useUserOptions(isAdmin);

  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = filter.outcomes.length > 0 || filter.server !== '' || filter.userId !== '';
  const now = Date.now();

  const toggleOutcome = (outcome: AuditOutcome) =>
    setFilter((current) => ({
      ...current,
      outcomes: current.outcomes.includes(outcome) ? current.outcomes.filter((o) => o !== outcome) : [...current.outcomes, outcome],
    }));

  const onApplyServer = (event: FormEvent) => {
    event.preventDefault();
    const value = serverDraft.trim();
    if (value !== '' && !SLUG.test(value)) {
      setServerError('Use a server name such as woo: lowercase letters, digits and dashes.');
      return;
    }
    setServerError(null);
    setFilter((current) => ({ ...current, server: value }));
  };

  const onClear = () => {
    setFilter(NO_FILTER);
    setServerDraft('');
    setServerError(null);
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
        <h1 className={styles.title}>Audit log</h1>
        <p className={styles.note}>
          {isAdmin ? 'All tool calls through the gateway, newest first.' : 'Your tool calls through the gateway, newest first.'} Arguments and results are not
          recorded.
        </p>

        <section className={styles.filters} aria-label="Filters">
          <fieldset className={styles.outcomes}>
            <legend className={styles.legend}>Outcome</legend>
            {AUDIT_OUTCOMES.map((outcome) => (
              <label key={outcome} className={styles.check}>
                <input type="checkbox" checked={filter.outcomes.includes(outcome)} onChange={() => toggleOutcome(outcome)} />
                {OUTCOME_LABEL[outcome]}
              </label>
            ))}
          </fieldset>
          <form className={styles.serverForm} onSubmit={onApplyServer} noValidate>
            <Field label="Server" hint="For example: woo" error={serverError ?? undefined} value={serverDraft} onChange={(event) => setServerDraft(event.target.value)} maxLength={20} autoComplete="off" />
            <Button type="submit" variant="ghost">
              Apply
            </Button>
          </form>
          {isAdmin ? (
            <div className={styles.userFilter}>
              <label htmlFor="audit-user" className={styles.legend}>
                User
              </label>
              <select id="audit-user" className={styles.select} value={filter.userId} onChange={(event) => setFilter((current) => ({ ...current, userId: event.target.value }))}>
                <option value="">All users</option>
                {(users.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
              Refresh
            </Button>
            {filtered ? (
              <Button variant="ghost" onClick={onClear}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </section>

        {audit.isPending ? <p className={styles.note}>Loading the audit log...</p> : null}
        {audit.isError ? (
          <div className={styles.block}>
            <p className={styles.error} role="alert">
              {auditMessage(audit.error)}
            </p>
            <Button variant="ghost" onClick={() => void audit.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {audit.isSuccess && items.length === 0 ? <p className={styles.note}>{filtered ? 'No calls match these filters.' : 'No tool calls yet.'}</p> : null}

        {items.length > 0 ? (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id} className={styles.item}>
                <div className={styles.what}>
                  <span className={styles.tool}>{item.requestedName}</span>
                  <Badge tone={OUTCOME_TONE[item.outcome]}>{outcomeLabel(item, now)}</Badge>
                </div>
                <dl className={styles.meta}>
                  <dt>When</dt>
                  <dd>{moment(item.ts)}</dd>
                  <dt>Took</dt>
                  <dd>{duration(item.durationMs)}</dd>
                  {isAdmin ? (
                    <>
                      <dt>User</dt>
                      <dd>{item.userEmail}</dd>
                    </>
                  ) : null}
                  <dt>Server</dt>
                  <dd>{item.serverSlug ?? '-'}</dd>
                  <dt>Via</dt>
                  <dd>{item.via === 'chat' ? 'Chat agent' : 'MCP client'}</dd>
                  {item.errorKind ? (
                    <>
                      <dt>Reason</dt>
                      <dd>{item.errorKind}</dd>
                    </>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        ) : null}

        {audit.hasNextPage ? (
          <Button variant="ghost" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
            {audit.isFetchingNextPage ? 'Loading...' : 'Load more'}
          </Button>
        ) : null}
      </main>
    </div>
  );
}
