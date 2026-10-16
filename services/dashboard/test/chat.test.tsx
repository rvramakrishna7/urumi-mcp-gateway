import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, MEMBER, json, renderApp, stubColorScheme, stubFetch } from './helpers/app';
import type { Handler } from './helpers/app';
import { buildHistory, MAX_MESSAGES, MAX_MESSAGE_CHARS, MAX_TOTAL_CHARS } from '../src/chat/useChat';
import type { ChatItem } from '../src/chat/useChat';

beforeEach(() => stubColorScheme());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const me = (user: typeof ADMIN | typeof MEMBER = MEMBER): Handler => () => json(200, { user });
const answer = (reply: string, toolCalls: unknown[] = [], pending?: unknown): Handler => () => json(200, { reply, toolCalls, ...(pending ? { pending } : {}) });
const bodyOf = (init: RequestInit): { messages: Array<{ role: string; content: string }>; confirm?: { token: string; name: string; args: unknown } } => JSON.parse(String(init.body));
const WRITE = { token: 'tok-1', name: 'woo__create_product', args: { name: 'Blue Mug', regular_price: '12.50' } };

async function open(chat: Handler, user: typeof ADMIN | typeof MEMBER = MEMBER) {
  const fetched = stubFetch({ 'GET /api/auth/me': me(user), 'POST /api/chat': chat });
  const view = renderApp('/chat');
  await screen.findByRole('heading', { name: 'Chat' });
  const typist = userEvent.setup();
  const chatCalls = () => fetched.calls.filter((call) => call.key === 'POST /api/chat');
  const say = async (text: string) => {
    await typist.type(screen.getByLabelText('Message'), text);
    await typist.click(screen.getByRole('button', { name: 'Send' }));
  };
  return { ...fetched, ...view, user: typist, chatCalls, say };
}

describe('chat: sending a message', () => {
  test('posts only the messages, shows the reply and the tool chips, and clears the box', async () => {
    const page = await open(answer('You have 2 orders today.', [{ name: 'woo__list_orders', ok: true, durationMs: 41.5 }]));
    await page.say('orders today?');
    expect(await screen.findByText('You have 2 orders today.')).toBeTruthy();
    expect(page.chatCalls().length).toBe(1);
    const sent = bodyOf(page.chatCalls()[0]!.init);
    expect(sent).toEqual({ messages: [{ role: 'user', content: 'orders today?' }] });
    expect(page.chatCalls()[0]!.init.credentials).toBe('same-origin');
    const chips = within(screen.getByRole('list', { name: 'Tools used' }));
    expect(chips.getByText('woo__list_orders ok 41.5 ms')).toBeTruthy();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });

  test('a failed tool shows as failed in text, not only in colour', async () => {
    const page = await open(answer('That did not work.', [{ name: 'woo__list_orders', ok: false, durationMs: 3 }]));
    await page.say('orders?');
    expect(await screen.findByText('woo__list_orders failed 3 ms')).toBeTruthy();
  });

  test('Enter sends, Shift+Enter makes a new line, a blank message sends nothing', async () => {
    const page = await open(answer('ok'));
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    await page.user.type(box, '   {Enter}');
    expect(page.chatCalls().length).toBe(0);
    await page.user.clear(box);
    await page.user.type(box, 'a{Shift>}{Enter}{/Shift}b');
    expect(box.value).toBe('a\nb');
    await page.user.keyboard('{Enter}');
    await screen.findByText('ok');
    expect(page.chatCalls().length).toBe(1);
    expect(bodyOf(page.chatCalls()[0]!.init).messages[0]!.content).toBe('a\nb');
  });

  test('the second request carries the first question and the answer as text, and no chips', async () => {
    const replies = [answer('first answer', [{ name: 'woo__list_orders', ok: true, durationMs: 5 }]), answer('second answer')];
    const page = await open((init) => replies.shift()!(init));
    await page.say('one');
    await screen.findByText('first answer');
    await page.say('two');
    await screen.findByText('second answer');
    const second = bodyOf(page.chatCalls()[1]!.init);
    expect(second).toEqual({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'two' },
      ],
    });
    // Mutation target: if chips leak into the history, a tool name or a toolCalls field shows up in the body.
    expect(String(page.chatCalls()[1]!.init.body)).not.toContain('woo__list_orders');
    expect(String(page.chatCalls()[1]!.init.body)).not.toContain('toolCalls');
  });

  test('the history is memory only: a new visit starts empty and nothing was stored', async () => {
    const page = await open(answer('remember me'));
    await page.say('hello');
    await screen.findByText('remember me');
    page.unmount();
    stubFetch({ 'GET /api/auth/me': me() });
    renderApp('/chat');
    await screen.findByRole('heading', { name: 'Chat' });
    expect(screen.queryByText('remember me')).toBeNull();
  });

  test('a model text with markup is shown as text and creates no element', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>window.pwned=1</script>**bold**';
    const page = await open(answer(hostile, [{ name: '<b>x</b>', ok: true, durationMs: 1 }]));
    await page.say('hi');
    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

const item = (id: number, role: ChatItem['role'], content: string, inHistory = true): ChatItem => ({ id, role, content, toolCalls: [], inHistory });

describe('chat: the history the gateway gets (buildHistory)', () => {
  test('keeps at most the gateway limit, newest first kept, and never starts with an assistant message', () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < 30; i += 1) items.push(item(i, i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    items.push(item(99, 'user', 'last'));
    const history = buildHistory(items);
    expect(history.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(history.at(-1)).toEqual({ role: 'user', content: 'last' });
    expect(history[0]?.role).toBe('user');
    // 31 items: the newest 20 are m11..m29 and 'last'; m11 is an assistant message, so it is dropped as well.
    expect(history.map((m) => m.content)).toEqual([...Array.from({ length: 18 }, (_, i) => `m${i + 12}`), 'last']);
    expect(history.length).toBe(19);
  });

  test('keeps the total under the character limit by dropping the oldest', () => {
    const big = 'x'.repeat(MAX_MESSAGE_CHARS);
    const items = [item(1, 'user', big), item(2, 'assistant', big), item(3, 'user', big), item(4, 'assistant', big), item(5, 'user', big), item(6, 'user', 'new')];
    const history = buildHistory(items);
    expect(history.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(history.at(-1)?.content).toBe('new');
    expect(history[0]?.role).toBe('user');
  });

  test('cuts an over-long assistant answer to the per-message limit', () => {
    const history = buildHistory([item(1, 'user', 'q'), item(2, 'assistant', 'y'.repeat(MAX_MESSAGE_CHARS + 500)), item(3, 'user', 'q2')]);
    expect(history[1]?.content.length).toBe(MAX_MESSAGE_CHARS);
  });

  test('notes, the text of a confirmation card and blank messages are not in it', () => {
    const history = buildHistory([item(1, 'user', 'q'), item(2, 'assistant', 'card text', false), item(3, 'note', 'Cancelled.', false), item(4, 'assistant', '   '), item(5, 'user', 'q2')]);
    expect(history).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'q2' },
    ]);
  });
});

describe('chat: confirmation of a write', () => {
  const pendingAnswer = answer('I will create the mug.', [{ name: 'woo__list_products', ok: true, durationMs: 9 }], WRITE);

  test('a write tool shows a card with the tool and the arguments, and sends nothing to run until Run', async () => {
    const page = await open(pendingAnswer);
    await page.say('create a blue mug');
    const card = (await screen.findByRole('heading', { name: 'Confirm this change' })).closest('section') as HTMLElement;
    expect(within(card).getByText('woo__create_product')).toBeTruthy();
    expect(card.textContent).toContain('"regular_price": "12.50"');
    expect(within(card).getByRole('button', { name: 'Run' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(page.chatCalls().length).toBe(1);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText('woo__list_products ok 9 ms')).toBeTruthy();
  });

  test('Run sends the same history plus the confirm object of the card, and shows the result', async () => {
    const replies = [pendingAnswer, answer('Created Blue Mug.', [{ name: 'woo__create_product', ok: true, durationMs: 80 }])];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Created Blue Mug.')).toBeTruthy();
    expect(page.chatCalls().length).toBe(2);
    const run = bodyOf(page.chatCalls()[1]!.init);
    // The text that came with the card ("I will create the mug.") is not in the history: the last message is still the person's.
    expect(run.messages).toEqual([{ role: 'user', content: 'create a blue mug' }]);
    expect(run.confirm).toEqual(WRITE);
    expect(screen.queryByRole('heading', { name: 'Confirm this change' })).toBeNull();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false);
  });

  test('Cancel sends no request, says so, and the note is not in the next history', async () => {
    const replies = [pendingAnswer, answer('Fine, a new answer.')];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(page.chatCalls().length).toBe(1);
    expect(screen.getByText('Cancelled. Nothing was changed.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Confirm this change' })).toBeNull();
    await page.say('something else');
    await screen.findByText('Fine, a new answer.');
    const next = bodyOf(page.chatCalls()[1]!.init);
    expect(next.confirm).toBeUndefined();
    expect(next.messages.map((m) => m.content)).toEqual(['create a blue mug', 'something else']);
    expect(String(page.chatCalls()[1]!.init.body)).not.toContain('Cancelled');
  });

  test('the arguments are shown as text: markup in them creates no element and runs nothing', async () => {
    const hostile = { name: '<img src=x onerror=alert(1)>', description: '<script>window.pwned2=1</script>' };
    const page = await open(answer('', [], { token: 't', name: 'woo__create_product', args: hostile }));
    await page.say('create it');
    const card = (await screen.findByRole('heading', { name: 'Confirm this change' })).closest('section') as HTMLElement;
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.textContent).toContain('<script>window.pwned2=1</script>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { pwned2?: number }).pwned2).toBeUndefined();
  });

  test('an expired or invalid token: fixed text, the card is gone, nothing is retried', async () => {
    const replies: Handler[] = [pendingAnswer, () => json(400, { error: 'invalid confirmation', detail: 'token expired at 12:00 SECRET-DETAIL' })];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Run' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This confirmation expired or is no longer valid. Nothing was run. Ask again to get a new one.');
    expect(document.body.textContent).not.toContain('SECRET-DETAIL');
    expect(screen.queryByRole('heading', { name: 'Confirm this change' })).toBeNull();
    expect(page.chatCalls().length).toBe(2);
  });

  test('Run refused by the rate limit: the card stays (nothing ran), Run waits for the countdown and then works', async () => {
    const replies: Handler[] = [
      pendingAnswer,
      () => json(429, { error: 'too many requests' }, { 'Retry-After': '2' }),
      answer('Created Blue Mug.'),
    ];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You are sending messages too fast. Try again in 2 s.');
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
    expect(screen.queryByText(/Try again in/)).toBeNull();
    await page.user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Created Blue Mug.')).toBeTruthy();
    expect(bodyOf(page.chatCalls()[2]!.init).confirm).toEqual(WRITE);
  });

  test('Run lost on the network: the card is gone and the text says the change may have run (no blind retry)', async () => {
    const replies: Handler[] = [
      pendingAnswer,
      () => {
        throw new TypeError('offline');
      },
    ];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Run' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('may or may not have run');
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  test('a 500 on Run is also "unknown", not "nothing ran"', async () => {
    const replies: Handler[] = [pendingAnswer, () => json(500, { error: 'internal error' })];
    const page = await open((init) => replies.shift()!(init));
    await page.say('create a blue mug');
    await page.user.click(await screen.findByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toContain('may or may not have run');
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });
});

describe('chat: errors have fixed text per reason', () => {
  const cases: Array<[string, number, string, string]> = [
    ['not configured', 503, 'chat not configured', 'The chat assistant is not set up on this gateway yet. Ask an admin.'],
    ['database unavailable', 503, 'service unavailable', 'Chat is not available right now. Nothing was run. Try again in a moment.'],
    ['invalid request', 400, 'invalid request', 'This message could not be sent. Nothing was run. Start a shorter conversation.'],
    ['model rate limited', 429, 'model rate limited', 'The model service is busy. Try again shortly.'],
    ['model timeout', 504, 'model timeout', 'The model service took too long. Try again with a shorter request.'],
    ['model rejected', 502, 'model rejected the request', 'The model service refused this request. Start with a shorter message.'],
    ['model unavailable', 502, 'model unavailable', 'The model service is not available right now. Try again in a moment.'],
    ['internal', 500, 'internal error', 'Something went wrong. Try again in a moment.'],
  ];

  test.each(cases)('%s', async (_name, status, marker, text) => {
    const page = await open(() => json(status, { error: marker, detail: 'LEAK-gsk_secret https://api.groq.com' }));
    await page.say('hello');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(document.body.textContent).not.toContain('LEAK-gsk_secret');
    // The failed message is taken out of the log and the text is back in the box, so nothing is lost.
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('hello');
    expect(screen.queryByText('hello', { selector: 'p' })).toBeNull();
  });

  test('a marker that is not on the list gets the generic text, never its own', async () => {
    const page = await open(() => json(502, { error: 'Bearer gsk_LEAKED value from upstream' }));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again in a moment.');
    expect(document.body.textContent).not.toContain('gsk_LEAKED');
  });

  test('an answer that is not the contract is a generic error', async () => {
    const page = await open(() => json(200, { reply: 5 }));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again in a moment.');
  });

  test('network error', async () => {
    const page = await open(() => {
      throw new TypeError('offline');
    });
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot reach the server. Check your connection and try again.');
  });

  test('401: the session has ended', async () => {
    const page = await open(() => json(401, { error: 'unauthorized' }));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('Your session has ended. Sign in again.');
  });

  test('the rate limit shows a countdown, blocks Send until it ends, then sending works again', async () => {
    const replies: Handler[] = [() => json(429, { error: 'too many requests' }, { 'Retry-After': '2' }), answer('back again')];
    const page = await open((init) => replies.shift()!(init));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('You are sending messages too fast. Try again in 2 s.');
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Try again in 1 s.'), { timeout: 3000 });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    await page.user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('back again')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a 429 without a usable Retry-After still blocks for a default time', async () => {
    const page = await open(() => json(429, { error: 'too many requests' }));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toBe('You are sending messages too fast. Try again in 30 s.');
  });

  test('a long wait is shown in minutes', async () => {
    const page = await open(() => json(429, { error: 'too many requests' }, { 'Retry-After': '125' }));
    await page.say('hello');
    expect((await screen.findByRole('alert')).textContent).toContain('Try again in 2 min 5 s.');
  });
});

describe('chat: who can open it', () => {
  test('a member and an admin both get the same screen', async () => {
    for (const user of [MEMBER, ADMIN]) {
      const page = await open(answer('x'), user);
      expect(screen.getByLabelText('Message')).toBeTruthy();
      page.unmount();
    }
  });

  test('without a session the chat is not shown: the person is sent to sign in', async () => {
    stubFetch({ 'GET /api/auth/me': () => json(401, { error: 'unauthorized' }) });
    renderApp('/chat');
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  test('the home page has the Chat link first in the list, for both roles', async () => {
    for (const user of [MEMBER, ADMIN]) {
      stubFetch({ 'GET /api/auth/me': me(user) });
      const view = renderApp('/');
      await screen.findByText(user.email);
      const links = screen.getAllByRole('link').map((link) => link.textContent);
      expect(links[0]).toBe('Chat');
      expect(links.indexOf('Chat')).toBeLessThan(links.indexOf('API keys'));
      view.unmount();
    }
  });

  test('the chat sends no user id, role or via: the body has the messages only', async () => {
    const page = await open(answer('ok'), ADMIN);
    await page.say('hi');
    await screen.findByText('ok');
    expect(Object.keys(bodyOf(page.chatCalls()[0]!.init))).toEqual(['messages']);
    expect(String(page.chatCalls()[0]!.init.body)).not.toMatch(/userId|via|email|role":"admin/);
  });
});
