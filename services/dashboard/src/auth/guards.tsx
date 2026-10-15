import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import { Button } from '../ui/Button';
import { useSession } from './session';
import styles from './guards.module.css';

function Status({ children }: { children: ReactNode }) {
  return (
    <main className={styles.status} aria-live="polite">
      {children}
    </main>
  );
}

// The guards decide what the person sees. They are a convenience: every route of the gateway checks the session itself.

// App routes: no session goes to /login. While the session is being asked for, nothing of the app is shown.
export function RequireAuth() {
  const session = useSession();
  if (session.isPending) return <Status>Checking your session...</Status>;
  if (session.isError) {
    return (
      <Status>
        <p>The gateway cannot be reached right now.</p>
        <Button onClick={() => void session.refetch()}>Try again</Button>
      </Status>
    );
  }
  if (session.data === null) return <Navigate to="/login" replace />;
  return <Outlet />;
}

// /login and /accept-invite: somebody who is already signed in goes to the app.
export function PublicOnly() {
  const session = useSession();
  if (session.isPending) return <Status>Checking your session...</Status>;
  if (session.data) return <Navigate to="/" replace />;
  // An error here (the gateway is down) still shows the form: the sign-in call will report the failure itself.
  return <Outlet />;
}

// Inside RequireAuth: a member goes back to the app. The server refuses the admin routes to a member in any case.
export function RequireAdmin() {
  const session = useSession();
  if (session.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}
