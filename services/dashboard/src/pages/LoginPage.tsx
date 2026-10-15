import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useLogin } from '../auth/session';
import { loginMessage } from '../auth/messages';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { AuthShell } from './AuthShell';
import styles from './LoginPage.module.css';

// The password is read from the form when it is submitted, passed to the call, and cleared from the field at once. It is
// never put in React state, in the query cache or anywhere else. On success the session query is set, and the guard of the
// route sends the person to the app.
export function LoginPage() {
  const login = useLogin();
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const field = form.elements.namedItem('password');
    if (field instanceof HTMLInputElement) field.value = '';
    setMessage(null);
    try {
      await login.mutateAsync({ email, password });
    } catch (error) {
      setMessage(loginMessage(error));
    }
  };

  return (
    <AuthShell
      skipLabel="Skip to the sign-in form"
      eyebrow="Team MCP gateway"
      titleId="login-title"
      lines={[{ words: ['Every', 'tool,'] }, { words: ['through'] }, { words: ['one', 'door.'], accent: true }]}
      lead="Sign in to manage upstream servers, API keys and the audit log."
      cardId="signin-title"
      cardTitle="Sign in"
    >
      <form className={styles.form} onSubmit={onSubmit}>
        <Field label="Email" type="email" name="email" autoComplete="username" placeholder="you@example.com" required />
        <Field label="Password" type="password" name="password" autoComplete="current-password" required />
        {message ? (
          <p className={styles.formError} role="alert">
            {message}
          </p>
        ) : null}
        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
