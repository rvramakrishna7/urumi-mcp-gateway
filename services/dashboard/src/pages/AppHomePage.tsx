import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLogout, useSession } from '../auth/session';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './AppHomePage.module.css';

// A placeholder until the screens of the next sub-steps exist: who is signed in, and the way out.
export function AppHomePage() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  const onSignOut = async () => {
    setFailed(false);
    try {
      await logout.mutateAsync();
      navigate('/login', { replace: true });
    } catch {
      setFailed(true);
    }
  };

  const user = session.data;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <ThemeToggle />
      </header>
      <main id="main" className={styles.main}>
        <h1 className={styles.title}>Signed in</h1>
        {user ? (
          <dl className={styles.facts}>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>{user.role}</dd>
          </dl>
        ) : null}
        {failed ? (
          <p className={styles.error} role="alert">
            Could not sign out. Try again.
          </p>
        ) : null}
        <Button variant="ghost" onClick={onSignOut} disabled={logout.isPending}>
          Sign out
        </Button>
      </main>
    </div>
  );
}
