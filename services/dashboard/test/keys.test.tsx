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

const RAW = 'mcpgw_RAWKEYVALUE0123456789abcdefghijklmnopqrst';
const meta = (n: number, over: Record<string, unknown> = {}) => ({
  id: `id-${n}`,
  name: `key ${n}`,
  keyPrefix: `mcpgw_ab${n % 10}c`,
  createdAt: '2026-10-01T10:20:30.000Z',
  lastUsedAt: null,
  revokedAt: null,
  status: 'active',
  ...over,
});
const me = (user: typeof ADMIN | typeof MEMBER = MEMBER): Handler => () => json(200, { user });
const list = (keys: unknown[]): Handler => () => json(200, { keys });

async function open(handlers: Record<string, Handler>, user: typeof ADMIN | typeof MEMBER = MEMBER) {
  const fetched = stubFetch({ 'GET /api/auth/me': me(user), ...handlers });
  const view = renderApp('/keys');
  await screen.findByRole('heading', { name: 'API keys' });
  return { ...fetched, ...view, user: userEvent.setup() };
}

describe('keys: list', () => {
  test('a member sees active keys with the prefix, created date and "Never" for last used; no secret and no hash', async () => {
    await open({ 'GET /api/me/keys': list([meta(1), meta(2, { lastUsedAt: '2026-10-02T08:09:00.000Z' })]) });
    await screen.findByText('key 1');
    expect(screen.getByText('Active (2 of 10)')).toBeTruthy();
    expect(screen.getByText('mcpgw_ab1c...')).toBeTruthy();
    expect(screen.getAllByText('2026-10-01').length).toBe(2);
    expect(screen.getByText('Never')).toBeTruthy();
    expect(screen.getByText('2026-10-02 08:09 UTC')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('keyHash');
  });

  test('an admin gets the same screen (any role)', async () => {
    await open({ 'GET /api/me/keys': list([meta(1)]) }, ADMIN);
    expect(await screen.findByText('key 1')).toBeTruthy();
  });

  test('empty list', async () => {
    await open({ 'GET /api/me/keys': list([]) });
    expect(await screen.findByText('You have no active keys.')).toBeTruthy();
  });

  test('revoked keys are in a separate section, marked in text, with no revoke button', async () => {
    await open({ 'GET /api/me/keys': list([meta(1), meta(2, { status: 'revoked', revokedAt: '2026-10-03T01:02:00.000Z' })]) });
    const section = (await screen.findByRole('heading', { name: 'Revoked (1)' })).closest('section') as HTMLElement;
    expect(within(section).getByText('key 2')).toBeTruthy();
    expect(within(section).getByText('Revoked', { selector: 'span' })).toBeTruthy();
    expect(within(section).queryByRole('button')).toBeNull();
    expect(screen.getByText('Active (1 of 10)')).toBeTruthy();
  });

  test('a failed load shows one message and a retry', async () => {
    await open({ 'GET /api/me/keys': () => json(500, { error: 'internal error', detail: 'SECRET-DB-TEXT' }) });
    expect((await screen.findByRole('alert')).textContent).toBe('Your keys could not be loaded right now. Try again in a moment.');
    expect(document.body.innerHTML).not.toContain('SECRET-DB-TEXT');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('requests are same-origin and never carry a user id', async () => {
    const { calls } = await open({ 'GET /api/me/keys': list([]) });
    await screen.findByText('You have no active keys.');
    const get = calls.find((call) => call.key === 'GET /api/me/keys');
    expect(get?.init.credentials).toBe('same-origin');
    expect(get?.init.body).toBeUndefined();
  });
});

describe('keys: create and one-time reveal', () => {
  const created = () => json(201, { key: RAW, meta: meta(3, { name: 'laptop' }) });

  async function create(handlers: Record<string, Handler>, keysAfter: unknown[] = [meta(3, { name: 'laptop' })]) {
    let count = 0;
    const view = await open({
      'GET /api/me/keys': () => json(200, { keys: count++ === 0 ? [] : keysAfter }),
      ...handlers,
    });
    await screen.findByText('You have no active keys.');
    await view.user.type(screen.getByLabelText('Key name'), '  laptop  ');
    await view.user.click(screen.getByRole('button', { name: 'Create key' }));
    return view;
  }

  test('posts the trimmed name as JSON, shows the key once, then the list refreshes with the prefix only', async () => {
    const { calls } = await create({ 'POST /api/me/keys': created });
    const field = (await screen.findByLabelText('New API key')) as HTMLInputElement;
    expect(field.value).toBe(RAW);
    expect(field.readOnly).toBe(true);
    const post = calls.find((call) => call.key === 'POST /api/me/keys');
    expect(JSON.parse(String(post?.init.body))).toEqual({ name: 'laptop' });
    await screen.findByText('Active (1 of 10)');
    expect(screen.getByText('mcpgw_ab3c...')).toBeTruthy();
  });

  test('Done removes the key from the page for good, and a fresh load of the list does not bring it back', async () => {
    const view = await create({ 'POST /api/me/keys': created });
    await screen.findByLabelText('New API key');
    await view.user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('New API key')).toBeNull();
    expect(document.body.innerHTML).not.toContain(RAW);
    await view.client.invalidateQueries({ queryKey: ['keys'] });
    expect(document.body.innerHTML).not.toContain(RAW);
  });

  test('the plain key is not kept in the query cache or in storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = await create({ 'POST /api/me/keys': created });
    await screen.findByLabelText('New API key');
    await waitFor(() => expect(view.client.getMutationCache().getAll().length).toBe(0));
    expect(JSON.stringify(view.client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(RAW);
    expect(setItem).not.toHaveBeenCalled();
  });

  test('leaving the page drops the key', async () => {
    const view = await create({ 'POST /api/me/keys': created });
    await screen.findByLabelText('New API key');
    await view.router.navigate('/');
    await screen.findByRole('heading', { name: 'Signed in' });
    await view.router.navigate('/keys');
    await screen.findByText('Active (1 of 10)');
    expect(document.body.innerHTML).not.toContain(RAW);
  });

  test('copy writes the key to the clipboard on the button press only', async () => {
    const view = await create({ 'POST /api/me/keys': created });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await screen.findByLabelText('New API key');
    expect(writeText).not.toHaveBeenCalled();
    await view.user.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(writeText).toHaveBeenCalledWith(RAW);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  test('copy that fails tells the person to select the key by hand', async () => {
    const view = await create({ 'POST /api/me/keys': created });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await screen.findByLabelText('New API key');
    await view.user.click(screen.getByRole('button', { name: 'Copy key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Ctrl+C');
  });

  test('starting a second create removes the first key at once, even when the second create fails', async () => {
    let posts = 0;
    const view = await create({ 'POST /api/me/keys': () => (posts++ === 0 ? created() : json(500, { error: 'internal error' })) });
    await screen.findByLabelText('New API key');
    await view.user.type(screen.getByLabelText('Key name'), 'second');
    await view.user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('New API key')).toBeNull();
    expect(document.body.innerHTML).not.toContain(RAW);
  });

  test('an empty name is refused on the screen with no request', async () => {
    const { calls, user } = await open({ 'GET /api/me/keys': list([]) });
    await screen.findByText('You have no active keys.');
    await user.type(screen.getByLabelText('Key name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name of 1 to 100 characters.');
    expect(calls.some((call) => call.key === 'POST /api/me/keys')).toBe(false);
  });

  test('a 400 from the gateway shows the name message', async () => {
    await create({ 'POST /api/me/keys': () => json(400, { error: 'invalid request' }) });
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name of 1 to 100 characters.');
  });

  test('a 500 shows one message and no key', async () => {
    await create({ 'POST /api/me/keys': () => json(500, { error: 'internal error' }) });
    expect((await screen.findByRole('alert')).textContent).toBe('The key could not be created right now. Try again in a moment.');
    expect(screen.queryByLabelText('New API key')).toBeNull();
  });
});

describe('keys: the limit of 10 active keys', () => {
  const ten = Array.from({ length: 10 }, (_, index) => meta(index));

  test('at 10 active keys the form is disabled and says why; revoked keys do not count', async () => {
    await open({ 'GET /api/me/keys': list([...ten, meta(11, { status: 'revoked', revokedAt: '2026-10-03T01:02:00.000Z' })]) });
    await screen.findByText('Active (10 of 10)');
    expect((screen.getByLabelText('Key name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You have 10 active keys. Revoke one to create another.')).toBeTruthy();
  });

  test('9 active keys: the form works', async () => {
    await open({ 'GET /api/me/keys': list(ten.slice(0, 9)) });
    await screen.findByText('Active (9 of 10)');
    expect((screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a 409 from a stale screen shows the limit message and no key', async () => {
    const { user } = await open({ 'GET /api/me/keys': list([]), 'POST /api/me/keys': () => json(409, { error: 'key limit reached' }) });
    await screen.findByText('You have no active keys.');
    await user.type(screen.getByLabelText('Key name'), 'one more');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You have 10 active keys. Revoke one to create another.');
    expect(screen.queryByLabelText('New API key')).toBeNull();
  });
});

describe('keys: revoke', () => {
  test('needs a confirm; Cancel sends nothing', async () => {
    const { calls, user } = await open({ 'GET /api/me/keys': list([meta(1)]) });
    await user.click(await screen.findByRole('button', { name: 'Revoke key 1' }));
    expect(screen.getByText(/Anything that uses it stops at once/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.key.startsWith('DELETE'))).toBe(false);
    expect(screen.queryByText(/stops at once/)).toBeNull();
  });

  test('confirm sends DELETE for that id only, then the list is read again', async () => {
    let revoked = false;
    const { calls, user } = await open({
      'GET /api/me/keys': () => json(200, { keys: [meta(1, revoked ? { status: 'revoked', revokedAt: '2026-10-03T01:02:00.000Z' } : {}), meta(2)] }),
      'DELETE /api/me/keys/id-1': () => {
        revoked = true;
        return empty(204);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke key 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await screen.findByRole('heading', { name: 'Revoked (1)' });
    expect(screen.getByText('Active (1 of 10)')).toBeTruthy();
    const del = calls.find((call) => call.key === 'DELETE /api/me/keys/id-1');
    expect(del?.init.credentials).toBe('same-origin');
    expect(del?.init.body).toBeUndefined();
  });

  test('a key of somebody else or a missing key (404): one message and the list is refreshed', async () => {
    let reads = 0;
    const { user } = await open({
      'GET /api/me/keys': () => json(200, { keys: reads++ === 0 ? [meta(1)] : [] }),
      'DELETE /api/me/keys/id-1': () => json(404, { error: 'not found' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke key 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That key is already gone. The list has been refreshed.');
    await screen.findByText('You have no active keys.');
  });

  test('a 500 shows one message and keeps the key in the list', async () => {
    const { user } = await open({ 'GET /api/me/keys': list([meta(1)]), 'DELETE /api/me/keys/id-1': () => json(500, { error: 'internal error' }) });
    await user.click(await screen.findByRole('button', { name: 'Revoke key 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The key could not be revoked right now. Try again in a moment.');
    expect(screen.getByText('key 1')).toBeTruthy();
  });
});

describe('keys: session', () => {
  test('without a session the keys page sends the person to the sign-in page and asks for no keys', async () => {
    const { calls } = stubFetch({ 'GET /api/auth/me': () => json(401, { error: 'unauthorized' }) });
    renderApp('/keys');
    await screen.findByRole('button', { name: 'Sign in' });
    expect(calls.some((call) => call.key === 'GET /api/me/keys')).toBe(false);
  });

  test('the home page links to the keys page', async () => {
    stubFetch({ 'GET /api/auth/me': me(), 'GET /api/me/keys': list([]) });
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'API keys' }));
    expect(await screen.findByRole('heading', { name: 'API keys' })).toBeTruthy();
  });
});
