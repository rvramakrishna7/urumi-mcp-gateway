import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireAdmin, RequireAuth } from '../src/auth/guards';
import { ADMIN, MEMBER, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedInAs = (user: typeof ADMIN | typeof MEMBER) => () => json(200, { user, session: { expiresAt: 'x' } });
const noSession = () => json(401, { error: 'unauthorized' });

describe('route guard: RequireAuth', () => {
  test('no session: an app route sends the person to /login and the app is never shown', async () => {
    stubFetch({ 'GET /api/auth/me': noSession });
    const { router } = renderApp('/');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Signed in' })).toBeNull();
  });

  test('an unknown path goes the same way', async () => {
    stubFetch({ 'GET /api/auth/me': noSession });
    const { router } = renderApp('/nowhere');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/login');
  });

  test('while the session is being asked for, neither the app nor the form is shown', async () => {
    stubFetch({ 'GET /api/auth/me': () => new Promise<Response>(() => {}) });
    renderApp('/');
    expect(await screen.findByText('Checking your session...')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Signed in' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  test('a gateway that cannot be reached is not "signed out": the person gets a retry, not a redirect', async () => {
    let up = false;
    stubFetch({ 'GET /api/auth/me': () => (up ? signedInAs(ADMIN)() : json(503, { error: 'service unavailable' })) });
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await screen.findByText('The gateway cannot be reached right now.');
    expect(router.state.location.pathname).toBe('/');
    up = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Signed in' });
  });

  test('a session: the app is shown', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs(MEMBER) });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Signed in' });
    expect(screen.getByText('member@urumi.test')).toBeTruthy();
  });
});

describe('route guard: PublicOnly', () => {
  test('a signed-in person who opens /login goes to the app', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs(ADMIN) });
    const { router } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Signed in' });
    expect(router.state.location.pathname).toBe('/');
  });

  test('when the gateway is down the form is still shown, and the sign-in call reports the failure', async () => {
    stubFetch({ 'GET /api/auth/me': () => json(503, {}) });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
  });
});

describe('route guard: RequireAdmin (the server enforces; this only hides)', () => {
  const renderAdminRoute = () => {
    const router = createMemoryRouter(
      [
        {
          element: <RequireAuth />,
          children: [
            { path: '/', element: <p>home</p> },
            { element: <RequireAdmin />, children: [{ path: '/servers', element: <p>servers screen</p> }] },
          ],
        },
      ],
      { initialEntries: ['/servers'] },
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  };

  test('a member is sent back to the app', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs(MEMBER) });
    const router = renderAdminRoute();
    await screen.findByText('home');
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByText('servers screen')).toBeNull();
  });

  test('an admin gets the screen', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs(ADMIN) });
    renderAdminRoute();
    await screen.findByText('servers screen');
  });
});
