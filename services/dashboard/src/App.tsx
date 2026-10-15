import { useState } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { PublicOnly, RequireAdmin, RequireAuth } from './auth/guards';
import { AcceptInvitePage, acceptInviteLoader } from './pages/AcceptInvitePage';
import { AppHomePage } from './pages/AppHomePage';
import { AuditPage } from './pages/AuditPage';
import { KeysPage } from './pages/KeysPage';
import { LoginPage } from './pages/LoginPage';
import { ServersPage } from './pages/ServersPage';

// /login: for people without a session. /accept-invite is outside that guard on purpose: it does not ask the gateway
// anything before the token has left the address bar (the loader), and an invite link opened by somebody who is signed in
// simply replaces their session with the invited person's. Everything else needs a session. Admin-only screens sit
// inside RequireAdmin.
export const appRoutes: RouteObject[] = [
  { element: <PublicOnly />, children: [{ path: '/login', element: <LoginPage /> }] },
  { path: '/accept-invite', loader: acceptInviteLoader, element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <AppHomePage /> },
      { path: '/keys', element: <KeysPage /> },
      { path: '/audit', element: <AuditPage /> },
      { element: <RequireAdmin />, children: [{ path: '/servers', element: <ServersPage /> }] },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function App() {
  const [router] = useState(() => createBrowserRouter(appRoutes));
  return <RouterProvider router={router} />;
}
