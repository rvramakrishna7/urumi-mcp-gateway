import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, empty, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noSession: Handler = () => json(401, { error: 'unauthorized' });
const PASSWORD = 'correct horse battery';

async function signIn(handler: Handler) {
  const fetched = stubFetch({ 'GET /api/auth/me': noSession, 'POST /api/auth/login': handler });
  const view = renderApp('/login');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'admin@urumi.test');
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return { ...fetched, ...view };
}

describe('login: success', () => {
  test('posts email and password as JSON on the same origin, then shows the app', async () => {
    const { calls } = await signIn(() => json(200, { user: ADMIN }, { 'Set-Cookie': 'ignored=1' }));
    await screen.findByRole('heading', { name: 'Signed in' });
    const login = calls.find((call) => call.key === 'POST /api/auth/login');
    expect(login?.init.credentials).toBe('same-origin');
    expect((login?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(login?.init.body))).toEqual({ email: 'admin@urumi.test', password: PASSWORD });
    expect(screen.getByText('admin@urumi.test')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
  });

  test('the password is not in the page after a failed attempt (the field is cleared at once)', async () => {
    await signIn(() => json(401, { error: 'invalid credentials' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  test('nothing is written to browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await signIn(() => json(200, { user: ADMIN }));
    await screen.findByRole('heading', { name: 'Signed in' });
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe('login: error states', () => {
  test('wrong credentials: one message (a disabled account and an unknown email get the same 401)', async () => {
    await signIn(() => json(401, { error: 'invalid credentials' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is incorrect.');
  });

  test('throttled: the wait is rounded up to whole minutes', async () => {
    await signIn(() => json(429, { error: 'too many attempts' }, { 'Retry-After': '125' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many attempts. Try again in about 3 minutes.');
  });

  test('throttled: one minute is singular, and a missing or unusable Retry-After has a generic text', async () => {
    cleanup();
    await signIn(() => json(429, { error: 'too many attempts' }, { 'Retry-After': '60' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many attempts. Try again in about 1 minute.');
    cleanup();
    await signIn(() => json(429, { error: 'too many attempts' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many attempts. Try again in a few minutes.');
    cleanup();
    await signIn(() => json(429, { error: 'too many attempts' }, { 'Retry-After': 'soon' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many attempts. Try again in a few minutes.');
  });

  test('server error: a fixed text, and the text of the answer is never shown', async () => {
    await signIn(() => json(500, { error: 'SECRET-INTERNAL-TEXT relation users does not exist' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Sign-in is not available right now. Try again in a moment.');
    expect(document.body.textContent).not.toContain('SECRET-INTERNAL-TEXT');
  });

  test('403 (a wrong origin) shows the same fixed text and not the answer', async () => {
    await signIn(() => json(403, { error: 'forbidden' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in is not available right now. Try again in a moment.');
  });

  test('network failure: its own text', async () => {
    await signIn(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot reach the server. Check your connection and try again.');
  });

  test('an answer that is not a user is a server error, not a session', async () => {
    await signIn(() => json(200, { user: { id: 1 } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in is not available right now. Try again in a moment.');
    expect(screen.queryByRole('heading', { name: 'Signed in' })).toBeNull();
  });

  test('none of the messages names the email, the account or its state', async () => {
    const texts: string[] = [];
    for (const handler of [() => json(401, {}), () => json(429, {}, { 'Retry-After': '900' }), () => json(500, {})] as Handler[]) {
      cleanup();
      await signIn(handler);
      texts.push((await screen.findByRole('alert')).textContent ?? '');
    }
    expect(texts).toHaveLength(3);
    for (const text of texts) expect(text).not.toMatch(/admin@|exist|disabled|unknown|no such|locked/i);
  });
});

describe('login: the form', () => {
  test('autocomplete attributes, and no "Preview build" note', async () => {
    stubFetch({ 'GET /api/auth/me': noSession });
    renderApp('/login');
    expect(((await screen.findByLabelText('Email')) as HTMLInputElement).autocomplete).toBe('username');
    expect((screen.getByLabelText('Password') as HTMLInputElement).autocomplete).toBe('current-password');
    expect(document.body.textContent).not.toMatch(/preview build/i);
  });

  test('the button is disabled while the request runs, so a double click sends one request', async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => (release = resolve));
    const { calls } = await signIn(() => pending);
    const button = await screen.findByRole('button', { name: 'Signing in...' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    release(json(401, {}));
    await screen.findByRole('alert');
    expect(calls.filter((call) => call.key === 'POST /api/auth/login')).toHaveLength(1);
  });
});

describe('logout', () => {
  test('Sign out posts to the gateway, clears the session and returns to the sign-in form', async () => {
    let signedIn = true;
    const { calls } = stubFetch({
      'GET /api/auth/me': () => (signedIn ? json(200, { user: ADMIN, session: { expiresAt: 'x' } }) : json(401, {})),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return empty(204);
      },
    });
    const { client } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(calls.some((call) => call.key === 'POST /api/auth/logout')).toBe(true);
    expect(client.getQueryCache().getAll().filter((query) => query.state.data !== undefined && query.state.data !== null)).toHaveLength(0);
  });

  test('a 401 on logout means the session is already gone: the same result as a success, and no error', async () => {
    let signedIn = true;
    stubFetch({
      'GET /api/auth/me': () => (signedIn ? json(200, { user: ADMIN, session: { expiresAt: 'x' } }) : json(401, {})),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return json(401, { error: 'unauthorized' });
      },
    });
    const { router, client } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.queryByText('Could not sign out. Try again.')).toBeNull();
    expect(client.getQueryCache().getAll().filter((query) => query.state.data !== undefined && query.state.data !== null)).toHaveLength(0);
  });

  test('a network failure on logout: the person stays signed in and is told', async () => {
    stubFetch({
      'GET /api/auth/me': () => json(200, { user: ADMIN, session: { expiresAt: 'x' } }),
      'POST /api/auth/logout': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not sign out. Try again.'));
    expect(screen.getByRole('heading', { name: 'Signed in' })).toBeTruthy();
  });

  test('when the gateway cannot end the session (5xx) the person stays signed in and is told', async () => {
    stubFetch({
      'GET /api/auth/me': () => json(200, { user: ADMIN, session: { expiresAt: 'x' } }),
      'POST /api/auth/logout': () => json(500, {}),
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not sign out. Try again.'));
    expect(screen.getByRole('heading', { name: 'Signed in' })).toBeTruthy();
  });
});
