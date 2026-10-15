import { useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useLoaderData, useNavigate } from 'react-router';
import { ApiError } from '../api/client';
import { SESSION_KEY, useAcceptInvite, useLogout, useSession } from '../auth/session';
import { useQueryClient } from '@tanstack/react-query';
import { INVITE_UNUSABLE_MESSAGE, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, MISMATCH_MESSAGE, WEAK_PASSWORD_MESSAGE, inviteMessage, passwordLength } from '../auth/messages';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { AuthShell } from './AuthShell';
import styles from './LoginPage.module.css';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;

// The route loader. It runs before the page renders and before any request of the dashboard, so the token leaves the address
// bar (and with it the history entry, the screen and anything that reads the URL) before the first network call. The
// fragment is never sent to a server by the browser; this only keeps it from staying where it can be seen or copied.
export function acceptInviteLoader(): { token: string | null } {
  const { hash, pathname, search } = window.location;
  if (hash === '') return { token: null };
  const candidate = new URLSearchParams(hash.slice(1)).get('token');
  window.history.replaceState(window.history.state, '', pathname + search);
  return { token: candidate !== null && TOKEN_SHAPE.test(candidate) ? candidate : null };
}

// The token is kept in a ref (not in state, not in the URL, not in a query key) and is used for one call.
export function AcceptInvitePage() {
  const loaded = useLoaderData() as { token: string | null };
  const token = useRef(loaded.token);
  const accept = useAcceptInvite();
  const logout = useLogout();
  const client = useQueryClient();
  const navigate = useNavigate();
  // Asked only when there is a token to use, and only after the loader has taken it out of the address bar.
  const session = useSession({ enabled: loaded.token !== null });
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(loaded.token === null ? INVITE_UNUSABLE_MESSAGE : null);
  const unusable = token.current === null;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accept.isPending || token.current === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    const confirm = String(data.get('confirm') ?? '');
    for (const name of ['password', 'confirm']) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement) field.value = '';
    }
    const length = passwordLength(password);
    if (password !== confirm) {
      setMessage(MISMATCH_MESSAGE);
      return;
    }
    if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
      setMessage(WEAK_PASSWORD_MESSAGE);
      return;
    }
    setMessage(null);
    try {
      await accept.mutateAsync({ token: token.current, password });
      token.current = null;
      navigate('/', { replace: true });
    } catch (error) {
      // A wrong, expired or used invite will not work a second time, so the page stops offering the form.
      if (error instanceof ApiError && error.kind === 'invalid') token.current = null;
      setMessage(inviteMessage(error));
    }
  };

  // Somebody who is signed in must sign out first: accepting would replace their session with the invited person's.
  const signedInAs = token.current !== null && !accept.isPending && !accept.isSuccess ? (session.data ?? null) : null;
  const checking = token.current !== null && session.isPending;

  const onSignOut = async () => {
    setSignOutFailed(false);
    try {
      await logout.mutateAsync();
      client.setQueryData(SESSION_KEY, null);
    } catch {
      setSignOutFailed(true);
    }
  };

  return (
    <AuthShell
      skipLabel="Skip to the password form"
      eyebrow="Team MCP gateway"
      titleId="invite-title"
      lines={[{ words: ['Set', 'your'] }, { words: ['password.'], accent: true }]}
      lead="Choose a password to finish your account. You will be signed in at once."
      cardId="invite-card-title"
      cardTitle="Choose a password"
    >
      {checking ? (
        <p className={styles.formNote} role="status">
          Checking your session...
        </p>
      ) : signedInAs ? (
        <div className={styles.form}>
          <p className={styles.formNote} role="status">
            You are signed in as {signedInAs.email}. Sign out first to accept this invite.
          </p>
          {signOutFailed ? (
            <p className={styles.formError} role="alert">
              Could not sign out. Try again.
            </p>
          ) : null}
          <Button variant="ghost" onClick={onSignOut} disabled={logout.isPending}>
            Sign out
          </Button>
        </div>
      ) : (
        <form className={styles.form} onSubmit={onSubmit}>
          <Field
            label="New password"
            type="password"
            name="password"
            autoComplete="new-password"
            hint={`${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`}
            disabled={unusable}
            required
          />
          <Field label="Repeat the password" type="password" name="confirm" autoComplete="new-password" disabled={unusable} required />
          {message ? (
            <p className={styles.formError} role="alert">
              {message}
            </p>
          ) : null}
          <Button type="submit" disabled={unusable || accept.isPending}>
            {accept.isPending ? 'Saving...' : 'Save password'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
