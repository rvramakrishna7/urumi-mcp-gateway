import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, empty, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';

const TOKEN = 'tok_ABC-123_def';
const PASSWORD = 'a long enough password';
const INVITE_REFUSED = 'This invite link cannot be used. Ask an admin for a new one.';
const WEAK_TEXT = 'Choose a password of 12 to 128 characters that is not your email address.';

// The sequence of events, so that a test can tell what happened first.
let events: string[];

beforeEach(() => {
  stubColorScheme();
  events = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function openInvite(hash: string, accept?: Handler, options: { signedIn?: boolean } = {}) {
  let signedIn = options.signedIn ?? false;
  window.history.replaceState(null, '', `/accept-invite${hash}`);
  const replaceState = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    events.push('replaceState');
    replaceState(...args);
  });
  const fetched = stubFetch({
    'POST /api/auth/accept-invite': (init) => {
      events.push('fetch');
      const answer = accept ? accept(init) : json(200, { user: ADMIN });
      signedIn = true;
      return answer;
    },
    'GET /api/auth/me': () => {
      events.push('me');
      return signedIn ? json(200, { user: ADMIN, session: { expiresAt: 'x' } }) : json(401, { error: 'unauthorized' });
    },
    'POST /api/auth/logout': () => {
      events.push('logout');
      signedIn = false;
      return empty(204);
    },
  });
  return { ...fetched, view: renderApp('/accept-invite') };
}

async function fill(password: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Repeat the password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Save password' }));
}

describe('accept-invite: the token and the address bar', () => {
  test('the token leaves the address bar before any network call, and is nowhere in the page', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`);
    await screen.findByLabelText('New password');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    // The only request before the form is the question "is somebody signed in", and it comes after the replaceState.
    expect(events).toEqual(['replaceState', 'me']);
    expect(calls.map((call) => call.key)).toEqual(['GET /api/auth/me']);
    expect(calls.every((call) => !String(call.init.body ?? '').includes(TOKEN))).toBe(true);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  test('the first request of the call is the one with the token, after the replaceState', async () => {
    openInvite(`#token=${TOKEN}`);
    await fill(PASSWORD, PASSWORD);
    await screen.findByRole('heading', { name: 'Signed in' });
    expect(events.slice(0, 3)).toEqual(['replaceState', 'me', 'fetch']);
  });

  test('no token: a clear message, no form to use, and no network call at all', async () => {
    const { calls } = openInvite('');
    expect((await screen.findByRole('alert')).textContent).toBe(INVITE_REFUSED);
    expect((screen.getByLabelText('New password') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save password' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a fragment without a usable token is removed too, and treated as no token', async () => {
    openInvite('#token=bad token!&x=1');
    expect((await screen.findByRole('alert')).textContent).toBe(INVITE_REFUSED);
    expect(window.location.hash).toBe('');
  });
});

describe('accept-invite while signed in', () => {
  const NOTICE = 'You are signed in as admin@urumi.test. Sign out first to accept this invite.';

  test('the token has left the address bar first, then the form is replaced by the notice and a Sign out button', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`, undefined, { signedIn: true });
    expect((await screen.findByText(NOTICE)).getAttribute('role')).toBe('status');
    expect(events).toEqual(['replaceState', 'me']);
    expect(window.location.href).not.toContain(TOKEN);
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(calls.map((call) => call.key)).toEqual(['GET /api/auth/me']);
  });

  test('after Sign out the form appears and the invite is accepted with the token that was kept', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`, undefined, { signedIn: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('New password');
    expect(events).toContain('logout');
    await fill(PASSWORD, PASSWORD);
    await screen.findByRole('heading', { name: 'Signed in' });
    const accept = calls.find((call) => call.key === 'POST /api/auth/accept-invite');
    expect(JSON.parse(String(accept?.init.body))).toEqual({ token: TOKEN, password: PASSWORD });
  });
});

describe('accept-invite: setting the password', () => {
  test('posts the token and the password once, then shows the app (signed in)', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`);
    await fill(PASSWORD, PASSWORD);
    await screen.findByRole('heading', { name: 'Signed in' });
    const accept = calls.filter((call) => call.key === 'POST /api/auth/accept-invite');
    expect(accept).toHaveLength(1);
    expect(JSON.parse(String(accept[0]?.init.body))).toEqual({ token: TOKEN, password: PASSWORD });
    expect(accept[0]?.init.credentials).toBe('same-origin');
  });

  test('two different passwords: a message, and nothing is sent', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`);
    await fill(PASSWORD, `${PASSWORD}x`);
    expect((await screen.findByRole('alert')).textContent).toBe('The two passwords do not match.');
    expect(calls.filter((call) => call.key.startsWith('POST'))).toHaveLength(0);
  });

  test('a password that is too short: the length rule, and nothing is sent', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`);
    await fill('short', 'short');
    expect((await screen.findByRole('alert')).textContent).toBe(WEAK_TEXT);
    expect(calls.filter((call) => call.key.startsWith('POST'))).toHaveLength(0);
  });

  test('the gateway says the password is weak: the fixed text, the reason of the gateway is not shown, the form stays usable', async () => {
    openInvite(`#token=${TOKEN}`, () => json(400, { error: 'weak password', reason: 'SERVER-REASON the password must not be the email' }));
    await fill(PASSWORD, PASSWORD);
    expect((await screen.findByRole('alert')).textContent).toBe(WEAK_TEXT);
    expect(document.body.textContent).not.toContain('SERVER-REASON');
    expect((screen.getByLabelText('New password') as HTMLInputElement).disabled).toBe(false);
  });

  test('a wrong, expired or used invite (one answer): one message, and the form is closed', async () => {
    openInvite(`#token=${TOKEN}`, () => json(400, { error: 'invalid or expired invite' }));
    await fill(PASSWORD, PASSWORD);
    expect((await screen.findByRole('alert')).textContent).toBe(INVITE_REFUSED);
    expect((screen.getByLabelText('New password') as HTMLInputElement).disabled).toBe(true);
  });

  test('a server error: a fixed text, no raw text, the token is kept so a retry is possible', async () => {
    const { calls } = openInvite(`#token=${TOKEN}`, () => json(500, { error: 'SECRET-INTERNAL-TEXT' }));
    await fill(PASSWORD, PASSWORD);
    expect((await screen.findByRole('alert')).textContent).toBe('The password could not be saved right now. Try again in a moment.');
    expect(document.body.textContent).not.toContain('SECRET-INTERNAL-TEXT');
    expect((screen.getByLabelText('New password') as HTMLInputElement).disabled).toBe(false);
    expect(calls.filter((call) => call.key.startsWith('POST'))).toHaveLength(1);
  });

  test('the passwords are cleared from the fields after a submit', async () => {
    openInvite(`#token=${TOKEN}`, () => json(500, {}));
    await fill(PASSWORD, PASSWORD);
    await screen.findByRole('alert');
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Repeat the password') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  test('autocomplete is new-password on both fields, and nothing is written to browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    openInvite(`#token=${TOKEN}`);
    expect(((await screen.findByLabelText('New password')) as HTMLInputElement).autocomplete).toBe('new-password');
    expect((screen.getByLabelText('Repeat the password') as HTMLInputElement).autocomplete).toBe('new-password');
    await fill(PASSWORD, PASSWORD);
    await screen.findByRole('heading', { name: 'Signed in' });
    expect(setItem).not.toHaveBeenCalled();
  });
});
