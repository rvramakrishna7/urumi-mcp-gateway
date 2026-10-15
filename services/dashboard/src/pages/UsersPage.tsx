import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import type { AdminUser, ApiKey } from '../api/client';
import { usersMessage } from '../auth/messages';
import { useSession } from '../auth/session';
import { RevealKey } from '../keys/RevealKey';
import { useInviteMember, useReinvite, useRevokeUserKey, useSetUserStatus, useUserKeys, useUsers } from '../users/useUsers';
import { Badge } from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './UsersPage.module.css';

const STATUS_LABEL = { active: 'Active', invited: 'Invited', disabled: 'Disabled' } as const;
const STATUS_TONE: Record<AdminUser['status'], BadgeTone> = { active: 'ok', invited: 'accent', disabled: 'muted' };

const day = (iso: string): string => iso.slice(0, 10);
const moment = (iso: string | null): string => (iso === null ? 'Never' : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);

// Only a quick shape check, to save a request that would be refused. The gateway is the real check.
const looksLikeEmail = (value: string): boolean => value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);

// An admin can see and revoke the keys of another user; the gateway puts both ids in the SQL. Creating a key for someone
// else is not possible: members make their own keys.
function KeysOfUser({ user }: { user: AdminUser }) {
  const keys = useUserKeys(user.id);
  const revoke = useRevokeUserKey(user.id);
  const [confirming, setConfirming] = useState<string | null>(null);

  const onRevoke = async (keyId: string) => {
    setConfirming(null);
    try {
      await revoke.mutateAsync(keyId);
    } catch {
      // The message is read from revoke.error below.
    }
  };

  if (keys.isPending) return <p className={styles.note}>Loading the keys...</p>;
  if (keys.isError) {
    return (
      <div className={styles.block}>
        <p className={styles.error} role="alert">
          {usersMessage(keys.error, 'keys')}
        </p>
        <Button variant="ghost" onClick={() => void keys.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const list: ApiKey[] = keys.data;
  return (
    <div className={styles.keys}>
      {revoke.isError ? (
        <p className={styles.error} role="alert">
          {usersMessage(revoke.error, 'revoke')}
        </p>
      ) : null}
      {list.length === 0 ? <p className={styles.note}>This user has no keys.</p> : null}
      <ul className={styles.keyList}>
        {list.map((key) => (
          <li key={key.id} className={styles.keyItem}>
            <span className={styles.keyName}>{key.name}</span>
            <code className={styles.slug}>{key.keyPrefix}...</code>
            {key.status === 'revoked' ? <Badge tone="muted">Revoked</Badge> : null}
            <span className={styles.note}>
              Created {day(key.createdAt)}, last used {moment(key.lastUsedAt)}
            </span>
            {key.status === 'active' ? (
              confirming === key.id ? (
                <span className={styles.actions} role="group" aria-label={`Revoke ${key.name}`}>
                  <span className={styles.confirmText}>Revoke "{key.name}" of {user.email}? Anything that uses it stops at once.</span>
                  <Button onClick={() => void onRevoke(key.id)}>Confirm revoke</Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" onClick={() => setConfirming(key.id)} disabled={revoke.isPending} aria-label={`Revoke key ${key.name} of ${user.email}`}>
                  Revoke
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Pending = { id: string; action: 'disable' | 'invite' };

// The team members of the gateway, for an admin. The gateway checks the admin role on every call and the screen is reached
// only through RequireAdmin. The invite link is on the screen once, in component state, like a new API key.
export function UsersPage() {
  const session = useSession();
  const me = session.data?.id;
  const users = useUsers();
  const invite = useInviteMember();
  const reinvite = useReinvite();
  const setStatus = useSetUserStatus();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  // forUser is the row that asked for a new invite. A result for a row is shown inside that row, where the person is looking;
  // the invite of the form at the top is shown at the top (forUser null).
  const [revealed, setRevealed] = useState<{ link: string; email: string; forUser: string | null } | null>(null);
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [openKeys, setOpenKeys] = useState<string | null>(null);
  // The message of the last failed action of a row, shown inside that row.
  const [rowFailure, setRowFailure] = useState<{ userId: string; message: string } | null>(null);

  const list = users.data ?? [];
  const activeAdmins = list.filter((user) => user.role === 'admin' && user.status === 'active').length;

  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    setRevealed(null);
    setEmailError(null);
    const trimmed = email.trim();
    if (!looksLikeEmail(trimmed)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    try {
      const created = await invite.mutateAsync(trimmed);
      setRevealed({ link: created.link, email: trimmed, forUser: null });
      setEmail('');
    } catch (error) {
      setEmailError(usersMessage(error, 'invite'));
    } finally {
      // The finished mutation still holds the link: let it go now.
      invite.reset();
    }
  };

  const onReinvite = async (user: AdminUser) => {
    setConfirming(null);
    setRevealed(null);
    setRowFailure(null);
    try {
      const created = await reinvite.mutateAsync(user.id);
      setRevealed({ link: created.link, email: user.email, forUser: user.id });
    } catch (error) {
      setRowFailure({ userId: user.id, message: usersMessage(error, 'reinvite') });
    } finally {
      reinvite.reset();
    }
  };

  const onStatus = async (user: AdminUser, status: 'active' | 'disabled') => {
    setConfirming(null);
    setRowFailure(null);
    try {
      await setStatus.mutateAsync({ id: user.id, status });
    } catch (error) {
      setRowFailure({ userId: user.id, message: usersMessage(error, 'status') });
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
        <h1 className={styles.title}>Members</h1>
        <p className={styles.note}>
          Invite people and manage their access. New people join as members. An invite link works once, for 72 hours; whoever opens it sets the password.
        </p>

        <form className={styles.form} onSubmit={(event) => void onInvite(event)} noValidate aria-label="Invite a member">
          <Field label="Email" hint="The person joins as a member." error={emailError ?? undefined} value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="off" inputMode="email" />
          <Button type="submit" disabled={invite.isPending}>
            Invite member
          </Button>
        </form>

        {revealed && revealed.forUser === null ? <RevealKey kind="invite" secret={revealed.link} name={revealed.email} onDone={() => setRevealed(null)} /> : null}

        {users.isPending ? <p className={styles.note}>Loading the members...</p> : null}
        {users.isError ? (
          <div className={styles.block}>
            <p className={styles.error} role="alert">
              {usersMessage(users.error, 'load')}
            </p>
            <Button variant="ghost" onClick={() => void users.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}

        {users.isSuccess ? (
          <>
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => void users.refetch()} disabled={users.isFetching}>
                Refresh
              </Button>
            </div>
            {users.isRefetchError ? <p className={styles.note}>Could not refresh. The list below may be out of date.</p> : null}
            <ul className={styles.list}>
              {list.map((user) => {
                const isSelf = user.id === me;
                const isLastAdmin = user.role === 'admin' && user.status === 'active' && activeAdmins <= 1;
                const canDisable = !isSelf && !isLastAdmin;
                const canInvite = user.role === 'member' && user.status !== 'disabled';
                return (
                  <li key={user.id} className={styles.item}>
                    <div className={styles.head}>
                      <span className={styles.name}>{user.email}</span>
                      <Badge tone={user.role === 'admin' ? 'accent' : 'muted'}>{user.role === 'admin' ? 'Admin' : 'Member'}</Badge>
                      <Badge tone={STATUS_TONE[user.status]}>{STATUS_LABEL[user.status]}</Badge>
                      {isSelf ? <span className={styles.you}>You</span> : null}
                    </div>
                    <dl className={styles.meta}>
                      <dt>Last sign-in</dt>
                      <dd>{moment(user.lastLoginAt)}</dd>
                      <dt>Added</dt>
                      <dd>{day(user.createdAt)}</dd>
                    </dl>
                    {revealed && revealed.forUser === user.id ? <RevealKey kind="invite" secret={revealed.link} name={revealed.email} onDone={() => setRevealed(null)} /> : null}
                    {rowFailure && rowFailure.userId === user.id ? (
                      <p className={styles.error} role="alert">
                        {rowFailure.message}
                      </p>
                    ) : null}
                    {user.role === 'admin' ? <p className={styles.note}>An admin's password is reset with the command-line tool, not here.</p> : null}
                    {user.status !== 'disabled' && !canDisable ? (
                      <p className={styles.note}>{isSelf ? 'You cannot disable yourself.' : 'The last active admin cannot be disabled.'}</p>
                    ) : null}

                    {confirming?.id === user.id ? (
                      <div className={styles.confirm} role="group" aria-label={confirming.action === 'disable' ? `Disable ${user.email}` : `New invite for ${user.email}`}>
                        <p className={styles.confirmText}>
                          {confirming.action === 'disable'
                            ? `Disable ${user.email}? They are signed out at once and their keys stop working until they are enabled again.`
                            : `Create a new invite for ${user.email}? It also lets them set a new password, so use it for a reset too.`}
                        </p>
                        <div className={styles.actions}>
                          <Button onClick={() => void (confirming.action === 'disable' ? onStatus(user, 'disabled') : onReinvite(user))}>
                            {confirming.action === 'disable' ? 'Confirm disable' : 'Confirm new invite'}
                          </Button>
                          <Button variant="ghost" onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.actions}>
                        {user.status === 'disabled' ? (
                          <Button variant="ghost" onClick={() => void onStatus(user, 'active')} disabled={setStatus.isPending} aria-label={`Enable ${user.email}`}>
                            Enable
                          </Button>
                        ) : (
                          <Button variant="ghost" onClick={() => setConfirming({ id: user.id, action: 'disable' })} disabled={!canDisable || setStatus.isPending} aria-label={`Disable ${user.email}`}>
                            Disable
                          </Button>
                        )}
                        {canInvite ? (
                          <Button variant="ghost" onClick={() => setConfirming({ id: user.id, action: 'invite' })} disabled={reinvite.isPending} aria-label={`New invite for ${user.email}`}>
                            New invite
                          </Button>
                        ) : null}
                        <Button variant="ghost" onClick={() => setOpenKeys(openKeys === user.id ? null : user.id)} aria-expanded={openKeys === user.id} aria-label={`Keys of ${user.email}`}>
                          {openKeys === user.id ? 'Hide keys' : 'Keys'}
                        </Button>
                      </div>
                    )}
                    {openKeys === user.id ? <KeysOfUser user={user} /> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </main>
    </div>
  );
}
