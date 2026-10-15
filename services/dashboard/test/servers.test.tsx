import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, MEMBER, empty, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';
import { Topology } from '../src/topology/Topology';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRET = 'TYPED-SECRET-VALUE-0123456789';
const checked = () => new Date(Date.now() - 5000).toISOString();

const srv = (n: number, over: Record<string, unknown> = {}) => ({
  id: `s-${n}`,
  slug: `srv${n}`,
  name: `Server ${n}`,
  url: `http://srv${n}.test/mcp`,
  enabled: true,
  callTimeoutMs: 30_000,
  credential: { set: false, kind: null, header: null, updatedAt: null },
  status: 'connected',
  statusReason: null,
  statusCheckedAt: checked(),
  lastSuccessAt: checked(),
  seedManaged: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});
const toolsOf = (n: number, names: string[], over: Record<string, unknown> = {}) => ({
  serverId: `s-${n}`,
  slug: `srv${n}`,
  tools: names.map((name) => ({ name, exposedName: `srv${n}__${name}` })),
  skipped: [],
  fetchedAt: checked(),
  ...over,
});

const me = (user: typeof ADMIN | typeof MEMBER = ADMIN): Handler => () => json(200, { user });
const servers = (list: unknown[]): Handler => () => json(200, { servers: list });

const baseHandlers = (list: unknown[], tools: unknown[] = []): Record<string, Handler> => ({
  'GET /api/auth/me': me(ADMIN),
  'GET /api/admin/servers': servers(list),
  'GET /api/admin/tools': servers(tools),
});

async function open(handlers: Record<string, Handler>, path = '/servers') {
  const fetched = stubFetch(handlers);
  const view = renderApp(path);
  await screen.findByRole('heading', { name: 'Upstream servers' });
  return { ...fetched, ...view, user: userEvent.setup() };
}

const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));
const callsOf = (calls: Array<{ key: string; init: RequestInit }>, key: string) => calls.filter((call) => call.key === key);
const card = (slug: string) => screen.getByText(slug, { selector: 'code' }).closest('li') as HTMLElement;

describe('servers: list states', () => {
  test('a failed list shows a fixed message, never the server text, and Try again reads it again', async () => {
    let n = 0;
    const { user } = await open({
      ...baseHandlers([]),
      'GET /api/admin/servers': () => (n++ === 0 ? json(500, { error: 'SECRET-DETAIL' }) : json(200, { servers: [srv(1)] })),
    });
    expect(await screen.findByText('The servers could not be loaded right now. Try again in a moment.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('SECRET-DETAIL');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Server 1')).toBeTruthy();
  });

  test('no servers: an empty note and an Add button', async () => {
    await open(baseHandlers([]));
    expect(await screen.findByText('No upstream servers yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add server' })).toBeTruthy();
  });

  test('an answer of the wrong shape is an error, not a half-drawn list', async () => {
    await open({ ...baseHandlers([]), 'GET /api/admin/servers': () => json(200, { servers: [{ id: 'x' }] }) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  test('each state is written as a badge; "Disabled" wins over the stored status', async () => {
    await open(
      baseHandlers([
        srv(1),
        srv(2, { status: 'unreachable', statusReason: 'timeout' }),
        srv(3, { status: 'connected', enabled: false }),
        srv(4, { status: 'unknown', statusCheckedAt: null }),
      ]),
    );
    await screen.findByText('Server 1');
    expect(within(card('srv1')).getByText('Connected')).toBeTruthy();
    expect(within(card('srv2')).getByText('Unreachable')).toBeTruthy();
    expect(within(card('srv2')).getByText('timeout')).toBeTruthy();
    expect(within(card('srv3')).getByText('Disabled')).toBeTruthy();
    expect(within(card('srv3')).queryByText('Connected')).toBeNull();
    expect(within(card('srv4')).getByText('Checking')).toBeTruthy();
  });

  test('the credential is described, never shown', async () => {
    await open(
      baseHandlers([
        srv(1, { credential: { set: true, kind: 'bearer', header: null, updatedAt: null } }),
        srv(2, { credential: { set: true, kind: 'header', header: 'X-Api-Key', updatedAt: null } }),
        srv(3),
      ]),
    );
    await screen.findByText('Server 1');
    expect(within(card('srv1')).getByText('bearer token set')).toBeTruthy();
    expect(within(card('srv2')).getByText('header X-Api-Key set')).toBeTruthy();
    expect(within(card('srv3')).getByText('none')).toBeTruthy();
  });
});

describe('servers: tools', () => {
  test('a connected server lists its tool names and the count, with no "last known" note', async () => {
    await open(baseHandlers([srv(1)], [toolsOf(1, ['list_products', 'create_product'])]));
    await screen.findByText('list_products');
    const box = card('srv1');
    expect(within(box).getByText('Tools (2)')).toBeTruthy();
    expect(within(box).getByText('create_product')).toBeTruthy();
    expect(within(box).queryByText(/Last known tools/)).toBeNull();
  });

  test('a disabled or an unreachable server says these are the last known tools', async () => {
    await open(
      baseHandlers(
        [srv(1, { enabled: false }), srv(2, { status: 'unreachable', statusReason: 'refused' })],
        [toolsOf(1, ['ping']), toolsOf(2, ['pong'])],
      ),
    );
    await screen.findByText('ping');
    expect(within(card('srv1')).getByText(/Last known tools, stored 5 s ago/)).toBeTruthy();
    expect(within(card('srv2')).getByText(/Last known tools/)).toBeTruthy();
    expect(within(card('srv2')).getByText('pong')).toBeTruthy();
  });

  test('a server that was never probed says so', async () => {
    await open(baseHandlers([srv(1, { status: 'unknown', statusCheckedAt: null })], [toolsOf(1, [], { fetchedAt: null })]));
    expect(await screen.findByText('Not checked yet. No tools are stored for this server.')).toBeTruthy();
    expect(screen.getByText('Tools (0)')).toBeTruthy();
  });

  test('skipped tools are listed apart, with the reason', async () => {
    await open(baseHandlers([srv(1)], [toolsOf(1, ['ok_tool'], { skipped: [{ name: 'bad.name', reason: 'invalid_name' }] })]));
    expect(await screen.findByText('bad.name')).toBeTruthy();
    expect(screen.getByText('invalid_name')).toBeTruthy();
    expect(screen.getByText('Not offered (1):')).toBeTruthy();
  });

  test('if only the tools call fails, the servers still show, with a short note', async () => {
    await open({ ...baseHandlers([srv(1)]), 'GET /api/admin/tools': () => json(500, { error: 'x' }) });
    expect(await screen.findByText('Server 1')).toBeTruthy();
    expect(await screen.findByText('The tools could not be loaded right now.')).toBeTruthy();
  });

  test('names from an upstream are text, never markup', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await open(baseHandlers([srv(1, { name: evil })], [toolsOf(1, [evil])]));
    await waitFor(() => expect(screen.getAllByText(evil).length).toBe(2));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('servers: admin only', () => {
  test('a member is sent home and no admin request is made', async () => {
    const { calls, router } = await openAsMember();
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.some((call) => call.key.includes('/api/admin'))).toBe(false);
    expect(screen.queryByRole('link', { name: 'Servers' })).toBeNull();
  });

  test('an admin sees the Servers link on the home page; a member does not', async () => {
    stubFetch({ 'GET /api/auth/me': me(ADMIN) });
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Servers' })).toBeTruthy();
  });
});

async function openAsMember() {
  const fetched = stubFetch({ 'GET /api/auth/me': me(MEMBER) });
  const view = renderApp('/servers');
  await screen.findByRole('heading', { name: 'Signed in' });
  return { ...fetched, ...view };
}

describe('servers: add', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, over: { slug?: string; name?: string; url?: string; timeout?: string } = {}) => {
    await user.type(screen.getByLabelText('Short name'), over.slug ?? 'docs');
    await user.type(screen.getByLabelText('Display name'), over.name ?? 'Docs');
    await user.type(screen.getByLabelText('Address (URL)'), over.url ?? 'http://docs.test/mcp');
    if (over.timeout) {
      await user.clear(screen.getByLabelText('Call timeout (seconds)'));
      await user.type(screen.getByLabelText('Call timeout (seconds)'), over.timeout);
    }
  };

  test('with no credential the body has no credential key, and the timeout is sent in milliseconds', async () => {
    const { calls, user } = await open({ ...baseHandlers([]), 'POST /api/admin/servers': () => json(201, { server: srv(1) }) });
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await fill(user, { timeout: '45' });
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(callsOf(calls, 'POST /api/admin/servers').length).toBe(1));
    expect(bodyOf(callsOf(calls, 'POST /api/admin/servers')[0]!.init)).toEqual({ slug: 'docs', name: 'Docs', url: 'http://docs.test/mcp', callTimeoutMs: 45_000 });
  });

  test('a bearer credential is sent as an object, then the form closes and the secret is nowhere in the page or the cache', async () => {
    const { calls, user, client } = await open({ ...baseHandlers([]), 'POST /api/admin/servers': () => json(201, { server: srv(1) }) });
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await fill(user);
    await user.click(screen.getByLabelText('Bearer token'));
    await user.type(screen.getByLabelText('Credential value'), SECRET);
    expect((screen.getByLabelText('Credential value') as HTMLInputElement).type).toBe('password');
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a server' })).toBeNull());
    expect(bodyOf(callsOf(calls, 'POST /api/admin/servers')[0]!.init)).toMatchObject({ credential: { kind: 'bearer', value: SECRET } });
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain(SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
  });

  test('a custom header is sent with its name', async () => {
    const { calls, user } = await open({ ...baseHandlers([]), 'POST /api/admin/servers': () => json(201, { server: srv(1) }) });
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await fill(user);
    await user.click(screen.getByLabelText('Custom header'));
    await user.type(screen.getByLabelText('Header name'), 'X-Api-Key');
    await user.type(screen.getByLabelText('Credential value'), SECRET);
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(callsOf(calls, 'POST /api/admin/servers').length).toBe(1));
    expect(bodyOf(callsOf(calls, 'POST /api/admin/servers')[0]!.init)).toMatchObject({ credential: { kind: 'header', header: 'X-Api-Key', value: SECRET } });
  });

  test('bad values are caught before any request', async () => {
    const { calls, user } = await open(baseHandlers([]));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await fill(user, { slug: 'Bad Name', url: 'http://u:p@docs.test/mcp?x=1', timeout: '500' });
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    expect(await screen.findByText(/lowercase letters, digits and dashes/)).toBeTruthy();
    expect(screen.getByText(/Enter an http or https address/)).toBeTruthy();
    expect(screen.getByText(/whole number of seconds from 1 to 120/)).toBeTruthy();
    expect(callsOf(calls, 'POST /api/admin/servers').length).toBe(0);
  });

  test('a used name (409) gives a fixed message and keeps what was typed', async () => {
    const { user } = await open({ ...baseHandlers([]), 'POST /api/admin/servers': () => json(409, { error: 'conflict' }) });
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await fill(user);
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    expect(await screen.findByText('A server with this name already exists. Choose another name.')).toBeTruthy();
    expect((screen.getByLabelText('Short name') as HTMLInputElement).value).toBe('docs');
  });

  test('the form warns that the gateway calls the address with the credential', async () => {
    const { user } = await open(baseHandlers([]));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    expect(screen.getByText(/Only add servers you trust/)).toBeTruthy();
  });
});

describe('servers: edit', () => {
  const withCredential = srv(1, { credential: { set: true, kind: 'bearer', header: null, updatedAt: null } });
  const patchHandler = (seen: unknown[]): Handler => (init) => {
    seen.push(bodyOf(init));
    return json(200, { server: withCredential });
  };

  test('changing the name only sends the name: the credential is kept by leaving it out', async () => {
    const seen: unknown[] = [];
    const { user } = await open({ ...baseHandlers([withCredential]), 'PATCH /api/admin/servers/s-1': patchHandler(seen) });
    await user.click(await screen.findByRole('button', { name: 'Edit srv1' }));
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Renamed');
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual({ name: 'Renamed' });
  });

  test('"Remove the credential" sends credential: null', async () => {
    const seen: unknown[] = [];
    const { user } = await open({ ...baseHandlers([withCredential]), 'PATCH /api/admin/servers/s-1': patchHandler(seen) });
    await user.click(await screen.findByRole('button', { name: 'Edit srv1' }));
    await user.click(screen.getByLabelText('Remove the credential'));
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual({ credential: null });
    expect(JSON.stringify(seen[0])).toContain('"credential":null');
  });

  test('replacing the credential sends a new object, and the old one is never shown in the form', async () => {
    const seen: unknown[] = [];
    const { user } = await open({ ...baseHandlers([withCredential]), 'PATCH /api/admin/servers/s-1': patchHandler(seen) });
    await user.click(await screen.findByRole('button', { name: 'Edit srv1' }));
    expect(screen.queryByLabelText('Credential value')).toBeNull();
    await user.click(screen.getByLabelText('Replace with a bearer token'));
    await user.type(screen.getByLabelText('Credential value'), SECRET);
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual({ credential: { kind: 'bearer', value: SECRET } });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit srv1' })).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  test('saving without a change closes the form and sends nothing', async () => {
    const { calls, user } = await open(baseHandlers([withCredential]));
    await user.click(await screen.findByRole('button', { name: 'Edit srv1' }));
    await user.click(document.querySelector('form button[type=submit]') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit srv1' })).toBeNull());
    expect(calls.some((call) => call.key.startsWith('PATCH'))).toBe(false);
  });

  test('the slug cannot be edited, and a server from the install carries a warning', async () => {
    const { user } = await open(baseHandlers([srv(1, { seedManaged: true })]));
    await user.click(await screen.findByRole('button', { name: 'Edit srv1' }));
    expect(screen.queryByLabelText('Short name')).toBeNull();
    expect(screen.getByText(/set up by the install/)).toBeTruthy();
  });
});

describe('servers: disable, enable and remove', () => {
  test('Disable sends { enabled: false }, and Enable sends { enabled: true }', async () => {
    const seen: unknown[] = [];
    const patch: Handler = (init) => {
      seen.push(bodyOf(init));
      return json(200, { server: srv(1) });
    };
    const { user } = await open({ ...baseHandlers([srv(1), srv(2, { enabled: false })]), 'PATCH /api/admin/servers/s-1': patch, 'PATCH /api/admin/servers/s-2': patch });
    await user.click(await screen.findByRole('button', { name: 'Disable srv1' }));
    await user.click(screen.getByRole('button', { name: 'Enable srv2' }));
    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen).toEqual([{ enabled: false }, { enabled: true }]);
  });

  test('Remove asks first; only the confirm sends the DELETE; Cancel sends nothing', async () => {
    const { calls, user } = await open({ ...baseHandlers([srv(1)]), 'DELETE /api/admin/servers/s-1': () => empty(204) });
    await user.click(await screen.findByRole('button', { name: 'Remove srv1' }));
    expect(screen.getByText(/Its tools disappear for everyone/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(callsOf(calls, 'DELETE /api/admin/servers/s-1').length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Remove srv1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(callsOf(calls, 'DELETE /api/admin/servers/s-1').length).toBe(1));
  });

  test('a server from the install gets the stronger text', async () => {
    const { user } = await open(baseHandlers([srv(1, { seedManaged: true })]));
    await user.click(await screen.findByRole('button', { name: 'Remove srv1' }));
    expect(screen.getByText(/registered by the install/)).toBeTruthy();
    expect(screen.getByText(/add it again by hand/)).toBeTruthy();
  });

  test('a failure belongs to the row it came from: it is shown inside that row and not in the other', async () => {
    const { user } = await open({
      ...baseHandlers([srv(1), srv(2)]),
      'PATCH /api/admin/servers/s-2': () => json(500, { error: 'x' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Disable srv2' }));
    const message = await screen.findByText('The server could not be changed right now. Try again in a moment.');
    expect(card('srv2').contains(message)).toBe(true);
    expect(card('srv1').contains(message)).toBe(false);
  });

  test('a failed removal is shown inside the row of the removed server', async () => {
    const { user } = await open({ ...baseHandlers([srv(1), srv(2)]), 'DELETE /api/admin/servers/s-2': () => json(500, { error: 'x' }) });
    await user.click(await screen.findByRole('button', { name: 'Remove srv2' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    const message = await screen.findByText('The server could not be removed right now. Try again in a moment.');
    expect(card('srv2').contains(message)).toBe(true);
  });

  test('removing a server that is already gone (404) says so and refreshes the list', async () => {
    const { calls, user } = await open({ ...baseHandlers([srv(1)]), 'DELETE /api/admin/servers/s-1': () => json(404, { error: 'not found' }) });
    await user.click(await screen.findByRole('button', { name: 'Remove srv1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(await screen.findByText('That server is already gone. The list has been refreshed.')).toBeTruthy();
    await waitFor(() => expect(callsOf(calls, 'GET /api/admin/servers').length).toBeGreaterThan(1));
  });
});

describe('servers: refresh', () => {
  test('the Refresh button reads both lists again', async () => {
    const { calls, user } = await open(baseHandlers([srv(1)]));
    await screen.findByText('Server 1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callsOf(calls, 'GET /api/admin/servers').length).toBe(2));
    expect(callsOf(calls, 'GET /api/admin/tools').length).toBe(2);
  });

  test('the list is read again every 10 seconds, and not while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const fetched = stubFetch(baseHandlers([srv(1)]));
    renderApp('/servers');
    const reads = () => callsOf(fetched.calls, 'GET /api/admin/servers').length;
    await vi.advanceTimersByTimeAsync(50);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(reads()).toBe(2);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(2);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});

describe('topology: a server that was not probed yet', () => {
  test('is written as "checking" and carries its own state class', () => {
    const { container } = render(<Topology servers={[{ id: '1', label: 'new', state: 'unknown' }]} />);
    expect(screen.getByText('checking')).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('new checking');
    expect(container.querySelector('svg > g:last-of-type > g')?.getAttribute('class')).toContain('unknown');
  });
});
