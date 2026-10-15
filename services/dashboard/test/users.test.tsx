import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, MEMBER, empty, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = 'ONE-TIME-TOKEN-0123456789abcdef';
const LINK = `http://gateway.urumi.test/accept-invite#token=${TOKEN}`;

// The session is ADMIN (id u1). Users are built by hand so that each rule has its own data.
const usr = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id,
  email,
  role: 'member',
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastLoginAt: '2026-10-14T09:08:07.000Z',
  disabledAt: null,
  ...over,
});
const SELF = usr('u1', 'admin@urumi.test', { role: 'admin' });
const OTHER_ADMIN = usr('u3', 'second@urumi.test', { role: 'admin' });
const MEMBER_ROW = usr('u2', 'member@urumi.test');

const keyMeta = (n: number, over: Record<string, unknown> = {}) => ({
  id: `k-${n}`,
  name: `key ${n}`,
  keyPrefix: `mcpgw_ab${n}c`,
  createdAt: '2026-10-01T10:20:30.000Z',
  lastUsedAt: null,
  revokedAt: null,
  status: 'active',
  ...over,
});

const me = (user: typeof ADMIN | typeof MEMBER = ADMIN): Handler => () => json(200, { user });
const users = (list: unknown[]): Handler => () => json(200, { users: list });
const invite: Handler = () => json(201, { user: { id: 'n' }, invite: { token: TOKEN, link: LINK, expiresAt: '2026-10-18T10:00:00.000Z' } });
const reinviteAnswer: Handler = () => json(201, { invite: { token: TOKEN, link: LINK, expiresAt: '2026-10-18T10:00:00.000Z' } });

async function open(handlers: Record<string, Handler>) {
  const fetched = stubFetch({ 'GET /api/auth/me': me(ADMIN), ...handlers });
  const view = renderApp('/users');
  await screen.findByRole('heading', { name: 'Members' });
  return { ...fetched, ...view, user: userEvent.setup() };
}

const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));
const callsOf = (calls: Array<{ key: string; init: RequestInit }>, key: string) => calls.filter((call) => call.key === key);
const row = (email: string) => screen.getByText(email, { selector: 'span' }).closest('li') as HTMLElement;

describe('users: list states', () => {
  test('a failed list shows a fixed message, never the server text, and Try again reads it again', async () => {
    let n = 0;
    const { user } = await open({ 'GET /api/admin/users': () => (n++ === 0 ? json(500, { error: 'SECRET-DETAIL' }) : json(200, { users: [SELF] })) });
    expect(await screen.findByText('The members could not be loaded right now. Try again in a moment.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('SECRET-DETAIL');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('admin@urumi.test')).toBeTruthy();
  });

  test('an answer of the wrong shape is an error, not a half-drawn list', async () => {
    await open({ 'GET /api/admin/users': () => json(200, { users: [{ id: 'x' }] }) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  test('role and status are written as badges, your own row says "You", and no hash or secret field is shown', async () => {
    await open({
      'GET /api/admin/users': users([SELF, MEMBER_ROW, usr('u4', 'new@urumi.test', { status: 'invited', lastLoginAt: null }), usr('u5', 'off@urumi.test', { status: 'disabled' })]),
    });
    await screen.findByText('member@urumi.test');
    expect(within(row('admin@urumi.test')).getByText('Admin')).toBeTruthy();
    expect(within(row('admin@urumi.test')).getByText('You')).toBeTruthy();
    expect(within(row('member@urumi.test')).getByText('Member')).toBeTruthy();
    expect(within(row('new@urumi.test')).getByText('Invited')).toBeTruthy();
    expect(within(row('new@urumi.test')).getByText('Never')).toBeTruthy();
    expect(within(row('off@urumi.test')).getByText('Disabled')).toBeTruthy();
    expect(within(row('member@urumi.test')).queryByText('You')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/passwordHash|keyHash|inviteHash/);
  });

  test('Refresh reads the list again; it does not poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { calls, user } = await open({ 'GET /api/admin/users': users([SELF]) });
    vi.useRealTimers();
    await screen.findByText('admin@urumi.test');
    expect(callsOf(calls, 'GET /api/admin/users').length).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callsOf(calls, 'GET /api/admin/users').length).toBe(2));
  });
});

describe('users: admin only', () => {
  test('a member is sent home and no admin request is made', async () => {
    const fetched = stubFetch({ 'GET /api/auth/me': me(MEMBER) });
    const { router } = renderApp('/users');
    await screen.findByRole('heading', { name: 'Signed in' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(fetched.calls.some((call) => call.key.includes('/api/admin'))).toBe(false);
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
  });

  test('an admin sees the Members link on the home page', async () => {
    stubFetch({ 'GET /api/auth/me': me(ADMIN) });
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Members' })).toBeTruthy();
  });
});

describe('users: invite', () => {
  test('the body is the email and nothing else (members only, no role)', async () => {
    const { calls, user } = await open({ 'GET /api/admin/users': users([SELF]), 'POST /api/admin/users': invite });
    await user.type(screen.getByLabelText('Email'), 'proof@urumi.test');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await waitFor(() => expect(callsOf(calls, 'POST /api/admin/users').length).toBe(1));
    expect(bodyOf(callsOf(calls, 'POST /api/admin/users')[0]!.init)).toEqual({ email: 'proof@urumi.test' });
    expect(screen.queryByLabelText(/role/i)).toBeNull();
  });

  test('the link is shown once, copied only on the button press, and gone from the page and the cache after Done', async () => {
    const { user, client } = await open({ 'GET /api/admin/users': users([SELF]), 'POST /api/admin/users': invite });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.type(screen.getByLabelText('Email'), 'proof@urumi.test');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    const field = (await screen.findByLabelText('Invite link')) as HTMLInputElement;
    expect(field.value).toBe(LINK);
    expect(screen.getByText('Invite created: proof@urumi.test')).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables]))).not.toContain(TOKEN);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(TOKEN);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  test('a bad email is caught before any request', async () => {
    const { calls, user } = await open({ 'GET /api/admin/users': users([SELF]) });
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(callsOf(calls, 'POST /api/admin/users').length).toBe(0);
  });

  test('an email that already has an account (409) gets a fixed message and keeps what was typed', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF]), 'POST /api/admin/users': () => json(409, { error: 'conflict' }) });
    await user.type(screen.getByLabelText('Email'), 'member@urumi.test');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByText('A person with this email already has an account.')).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('member@urumi.test');
  });
});

describe('users: new invite (reset)', () => {
  test('a member row asks first, then shows the new link once', async () => {
    const { calls, user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'POST /api/admin/users/u2/invite': reinviteAnswer });
    await user.click(await screen.findByRole('button', { name: 'New invite for member@urumi.test' }));
    expect(screen.getByText(/It also lets them set a new password/)).toBeTruthy();
    expect(callsOf(calls, 'POST /api/admin/users/u2/invite').length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Confirm new invite' }));
    const field = (await screen.findByLabelText('Invite link')) as HTMLInputElement;
    expect(field.value).toBe(LINK);
    // The result is where the person pressed the button: inside the row of that member, not above the list.
    expect(row('member@urumi.test').contains(field)).toBe(true);
    expect(screen.getAllByLabelText('Invite link').length).toBe(1);
  });

  test('the invite of the form at the top is shown at the top, not inside a row', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'POST /api/admin/users': invite });
    await screen.findByText('member@urumi.test');
    await user.type(screen.getByLabelText('Email'), 'proof@urumi.test');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    const field = await screen.findByLabelText('Invite link');
    expect(row('member@urumi.test').contains(field)).toBe(false);
    expect(row('admin@urumi.test').contains(field)).toBe(false);
  });

  test('there is no button for an admin or for a disabled user', async () => {
    await open({ 'GET /api/admin/users': users([SELF, OTHER_ADMIN, usr('u5', 'off@urumi.test', { status: 'disabled' })]) });
    await screen.findByText('second@urumi.test');
    expect(screen.queryByRole('button', { name: /New invite for/ })).toBeNull();
    expect(screen.getAllByText(/password is reset with the command-line tool/).length).toBe(2);
  });

  test('a 409 from the gateway gets a fixed message', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'POST /api/admin/users/u2/invite': () => json(409, { error: 'conflict', reason: 'x' }) });
    await user.click(await screen.findByRole('button', { name: 'New invite for member@urumi.test' }));
    await user.click(screen.getByRole('button', { name: 'Confirm new invite' }));
    const message = await screen.findByText(/cannot be invited again here/);
    expect(row('member@urumi.test').contains(message)).toBe(true);
  });
});

describe('users: disable and enable', () => {
  test('Disable asks first; Cancel sends nothing; the confirm sends { status: "disabled" }', async () => {
    const seen: unknown[] = [];
    const { calls, user } = await open({
      'GET /api/admin/users': users([SELF, MEMBER_ROW]),
      'PATCH /api/admin/users/u2': (init) => {
        seen.push(bodyOf(init));
        return json(200, { user: MEMBER_ROW });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Disable member@urumi.test' }));
    expect(screen.getByText(/signed out at once/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.key.startsWith('PATCH'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Disable member@urumi.test' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));
    await waitFor(() => expect(seen).toEqual([{ status: 'disabled' }]));
  });

  test('Enable needs no confirm and sends { status: "active" }', async () => {
    const seen: unknown[] = [];
    const { user } = await open({
      'GET /api/admin/users': users([SELF, usr('u5', 'off@urumi.test', { status: 'disabled' })]),
      'PATCH /api/admin/users/u5': (init) => {
        seen.push(bodyOf(init));
        return json(200, { user: MEMBER_ROW });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Enable off@urumi.test' }));
    await waitFor(() => expect(seen).toEqual([{ status: 'active' }]));
  });
});

describe('users: the three guards', () => {
  test('your own row has no working Disable (self rule), even when another admin exists', async () => {
    await open({ 'GET /api/admin/users': users([SELF, OTHER_ADMIN]) });
    await screen.findByText('second@urumi.test');
    expect((screen.getByRole('button', { name: 'Disable admin@urumi.test' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You cannot disable yourself.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Disable second@urumi.test' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('the last active admin cannot be disabled (last-admin rule)', async () => {
    // The session is u1; the only active admin in this list is u3 (a stale or partial view, or a second window).
    await open({ 'GET /api/admin/users': users([OTHER_ADMIN, MEMBER_ROW, usr('u6', 'old-admin@urumi.test', { role: 'admin', status: 'disabled' })]) });
    await screen.findByText('second@urumi.test');
    expect((screen.getByRole('button', { name: 'Disable second@urumi.test' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The last active admin cannot be disabled.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Disable member@urumi.test' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a 409 from the gateway on a disable (a race the screen could not see) gets the fixed message', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'PATCH /api/admin/users/u2': () => json(409, { error: 'conflict', reason: 'the last active admin cannot be disabled' }) });
    await user.click(await screen.findByRole('button', { name: 'Disable member@urumi.test' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));
    const message = await screen.findByText('That change is not allowed. You cannot disable yourself or the last active admin.');
    expect(row('member@urumi.test').contains(message)).toBe(true);
    expect(row('admin@urumi.test').contains(message)).toBe(false);
  });
});

describe('users: the keys of a user', () => {
  test('the keys are not asked for until the section is opened', async () => {
    const { calls, user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'GET /api/admin/users/u2/keys': () => json(200, { keys: [keyMeta(1), keyMeta(2, { status: 'revoked', revokedAt: '2026-10-02T00:00:00.000Z' })] }) });
    await screen.findByText('member@urumi.test');
    expect(calls.some((call) => call.key.includes('/keys'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Keys of member@urumi.test' }));
    expect(await screen.findByText('key 1')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Revoke key/ }).length).toBe(1);
    expect(document.body.innerHTML).not.toContain('keyHash');
  });

  test('a user with no keys says so', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'GET /api/admin/users/u2/keys': () => json(200, { keys: [] }) });
    await user.click(await screen.findByRole('button', { name: 'Keys of member@urumi.test' }));
    expect(await screen.findByText('This user has no keys.')).toBeTruthy();
  });

  test('Revoke asks first and then sends the DELETE with both ids; a 404 says it is gone', async () => {
    let gone = false;
    const { calls, user } = await open({
      'GET /api/admin/users': users([SELF, MEMBER_ROW]),
      'GET /api/admin/users/u2/keys': () => json(200, { keys: [keyMeta(1)] }),
      'DELETE /api/admin/users/u2/keys/k-1': () => (gone ? json(404, { error: 'not found' }) : empty(204)),
    });
    await user.click(await screen.findByRole('button', { name: 'Keys of member@urumi.test' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke key key 1 of member@urumi.test' }));
    expect(callsOf(calls, 'DELETE /api/admin/users/u2/keys/k-1').length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(callsOf(calls, 'DELETE /api/admin/users/u2/keys/k-1').length).toBe(1));
    gone = true;
    await user.click(await screen.findByRole('button', { name: 'Revoke key key 1 of member@urumi.test' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByText('That user or key is already gone. The list has been refreshed.')).toBeTruthy();
  });

  test('a failed keys call has a fixed message and a retry', async () => {
    const { user } = await open({ 'GET /api/admin/users': users([SELF, MEMBER_ROW]), 'GET /api/admin/users/u2/keys': () => json(500, { error: 'SECRET-DETAIL' }) });
    await user.click(await screen.findByRole('button', { name: 'Keys of member@urumi.test' }));
    expect(await screen.findByText('The keys of this user could not be loaded right now. Try again in a moment.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('SECRET-DETAIL');
  });
});
