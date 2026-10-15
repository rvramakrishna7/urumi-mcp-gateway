import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, MEMBER, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  ts: '2026-10-14T09:08:07.000Z',
  finishedAt: '2026-10-14T09:08:08.000Z',
  userId: 'u-1',
  userEmail: 'member@urumi.test',
  serverSlug: 'woo',
  tool: 'list_products',
  requestedName: `woo__list_products_${id}`,
  outcome: 'ok',
  errorKind: null,
  durationMs: 42,
  via: 'mcp',
  requestId: `r-${id}`,
  ...over,
});
const me = (user: typeof ADMIN | typeof MEMBER = MEMBER): Handler => () => json(200, { user });
const page = (items: unknown[], nextCursor: string | null = null): Handler => () => json(200, { items, nextCursor });

async function open(handlers: Record<string, Handler>, user: typeof ADMIN | typeof MEMBER = MEMBER) {
  const fetched = stubFetch({ 'GET /api/auth/me': me(user), ...handlers });
  const view = renderApp('/audit');
  await screen.findByRole('heading', { name: 'Audit log' });
  return { ...fetched, ...view, user: userEvent.setup() };
}

const auditCalls = (calls: Array<{ key: string }>) => calls.map((call) => call.key).filter((key) => key.startsWith('GET /api/audit'));

describe('audit: list', () => {
  test('rows show the name, outcome, time, duration, server and how it came in', async () => {
    await open({
      'GET /api/audit': page([row(2), row(1, { outcome: 'timeout', errorKind: 'call_timeout', durationMs: 5200, via: 'chat' })]),
    });
    await screen.findByText('woo__list_products_2');
    expect(screen.getByText('OK', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Timed out', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText('2026-10-14 09:08:07 UTC').length).toBe(2);
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('5.2 s')).toBeTruthy();
    expect(screen.getByText('call_timeout')).toBeTruthy();
    expect(screen.getByText('Chat agent')).toBeTruthy();
    expect(screen.getByText('MCP client')).toBeTruthy();
  });

  test('a member sees "Your tool calls", no user column and no user filter; no admin request is made', async () => {
    const { calls } = await open({ 'GET /api/audit': page([row(1)]) });
    await screen.findByText('woo__list_products_1');
    expect(screen.getByText(/Your tool calls/)).toBeTruthy();
    expect(screen.queryByText('member@urumi.test')).toBeNull();
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(calls.some((call) => call.key.includes('/api/admin'))).toBe(false);
  });

  test('an admin sees all calls, the user of each row and a user filter filled from the admin API', async () => {
    await open(
      {
        'GET /api/audit': page([row(1)]),
        'GET /api/admin/users': () => json(200, { users: [{ id: 'u-1', email: 'member@urumi.test', role: 'member', status: 'active' }] }),
      },
      ADMIN,
    );
    await screen.findByText('woo__list_products_1');
    expect(screen.getByText(/All tool calls/)).toBeTruthy();
    expect(screen.getAllByText('member@urumi.test').length).toBeGreaterThan(0);
    expect(await screen.findByRole('option', { name: 'member@urumi.test' })).toBeTruthy();
  });

  test('empty, with and without a filter', async () => {
    const { user } = await open({ 'GET /api/audit': page([]), 'GET /api/audit?outcome=error': page([]) });
    expect(await screen.findByText('No tool calls yet.')).toBeTruthy();
    await user.click(screen.getByLabelText('Tool error'));
    expect(await screen.findByText('No calls match these filters.')).toBeTruthy();
  });

  test('an error shows a fixed message, never the server text, and Try again fetches again', async () => {
    let n = 0;
    const { user } = await open({
      'GET /api/audit': () => (n++ === 0 ? json(500, { error: 'SECRET-DETAIL' }) : json(200, { items: [row(1)], nextCursor: null })),
    });
    expect(await screen.findByText('The audit log could not be loaded right now. Try again in a moment.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('SECRET-DETAIL');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('woo__list_products_1')).toBeTruthy();
  });

  test('an answer of the wrong shape is an error, not a half-drawn list', async () => {
    await open({ 'GET /api/audit': () => json(200, { items: [{ id: 'x' }], nextCursor: null }) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  test('a started row older than 5 minutes says no result was recorded; a young one says in progress', async () => {
    const young = new Date(Date.now() - 1000).toISOString();
    await open({
      'GET /api/audit': page([
        row(2, { outcome: 'started', ts: young, finishedAt: null, durationMs: null }),
        row(1, { outcome: 'started', ts: '2026-01-01T00:00:00.000Z', finishedAt: null, durationMs: null }),
      ]),
    });
    expect(await screen.findByText('No result recorded')).toBeTruthy();
    expect(screen.getByText('In progress', { selector: 'span' })).toBeTruthy();
  });

  test('values from a row are text, never markup', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await open({ 'GET /api/audit': page([row(1, { requestedName: evil })]) });
    await screen.findByText(evil);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('audit: paging and filters', () => {
  test('Load more sends the cursor, appends the rows and disappears on the last page', async () => {
    const { calls, user } = await open({
      'GET /api/audit': page([row(3), row(2)], '2'),
      'GET /api/audit?cursor=2': page([row(1)], null),
    });
    await screen.findByText('woo__list_products_3');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('woo__list_products_1');
    expect(screen.getByText('woo__list_products_3')).toBeTruthy();
    expect(auditCalls(calls)).toEqual(['GET /api/audit', 'GET /api/audit?cursor=2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('an outcome filter is sent, starts at the first page again and never reuses the old cursor', async () => {
    const { calls, user } = await open({
      'GET /api/audit': page([row(3), row(2)], '2'),
      'GET /api/audit?cursor=2': page([row(1)], '1'),
      'GET /api/audit?outcome=error': page([row(9, { outcome: 'error', errorKind: 'tool_error' })], null),
    });
    await screen.findByText('woo__list_products_3');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('woo__list_products_1');
    await user.click(screen.getByLabelText('Tool error'));
    await screen.findByText('woo__list_products_9');
    expect(screen.queryByText('woo__list_products_3')).toBeNull();
    expect(auditCalls(calls).at(-1)).toBe('GET /api/audit?outcome=error');
  });

  test('two outcomes are sent as a repeated parameter', async () => {
    const { calls, user } = await open({
      'GET /api/audit': page([row(1)]),
      'GET /api/audit?outcome=error': page([row(1)]),
      'GET /api/audit?outcome=error&outcome=timeout': page([row(1)]),
    });
    await screen.findByText('woo__list_products_1');
    await user.click(screen.getByLabelText('Tool error'));
    await user.click(screen.getByLabelText('Timed out'));
    await waitFor(() => expect(auditCalls(calls)).toContain('GET /api/audit?outcome=error&outcome=timeout'));
  });

  test('the server filter is checked before it is sent, then applied, then cleared', async () => {
    const { calls, user } = await open({
      'GET /api/audit': page([row(1)]),
      'GET /api/audit?server=woo': page([row(1)]),
    });
    await screen.findByText('woo__list_products_1');
    await user.type(screen.getByLabelText('Server'), 'Bad Name!');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
    expect(auditCalls(calls)).toEqual(['GET /api/audit']);
    await user.clear(screen.getByLabelText('Server'));
    await user.type(screen.getByLabelText('Server'), 'woo');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(auditCalls(calls)).toContain('GET /api/audit?server=woo'));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(auditCalls(calls).at(-1)).toBe('GET /api/audit'));
    expect((screen.getByLabelText('Server') as HTMLInputElement).value).toBe('');
  });

  test('an admin can filter by user (userId is sent); a member never sends it', async () => {
    const { calls, user } = await open(
      {
        'GET /api/audit': page([row(1)]),
        'GET /api/audit?userId=u-1': page([row(1)]),
        'GET /api/admin/users': () => json(200, { users: [{ id: 'u-1', email: 'member@urumi.test', role: 'member', status: 'active' }] }),
      },
      ADMIN,
    );
    await screen.findByRole('option', { name: 'member@urumi.test' });
    await user.selectOptions(screen.getByLabelText('User'), 'u-1');
    await waitFor(() => expect(auditCalls(calls)).toContain('GET /api/audit?userId=u-1'));
  });

  test('Refresh fetches the first page again', async () => {
    const { calls, user } = await open({ 'GET /api/audit': page([row(1)]) });
    await screen.findByText('woo__list_products_1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(auditCalls(calls).length).toBe(2));
  });
});

describe('audit: reachable', () => {
  test('the home page links to the audit log for any role', async () => {
    stubFetch({ 'GET /api/auth/me': me(MEMBER) });
    renderApp('/');
    const link = await screen.findByRole('link', { name: 'Audit log' });
    expect(within(link.parentElement as HTMLElement).getByRole('link', { name: 'API keys' })).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/audit');
  });
});
