import { useEffect, useRef, useState } from 'react';
import { ApiError, sendChat } from '../api/client';
import type { ChatMessage, ChatPending, ChatToolCall } from '../api/client';
import { chatMessage } from '../auth/messages';

// The limits of POST /api/chat (services/gateway/src/routes/chat.ts). The gateway enforces them (400); these copies only let the
// screen trim the history before a request that would be refused.
export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TOTAL_CHARS = 16_000;
const DEFAULT_WAIT_SECONDS = 30;

export interface ChatItem {
  id: number;
  role: 'user' | 'assistant' | 'note';
  content: string;
  // Chips of the tools that ran in this turn. They are display only and never go back to the gateway.
  toolCalls: ChatToolCall[];
  // False for a note and for the text that came with a confirmation card: the gateway never sees them again.
  inHistory: boolean;
}

// The history the gateway gets: only the messages of the person and the answers of the assistant, as text. Chips, notes and the
// card are display state. Trimmed from the old end to the gateway's limits, and it never starts with an assistant message.
export function buildHistory(items: readonly ChatItem[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const item of items) {
    if (item.inHistory && item.role !== 'note' && item.content.trim() !== '') history.push({ role: item.role, content: item.content.slice(0, MAX_MESSAGE_CHARS) });
  }
  let total = history.reduce((sum, message) => sum + message.content.length, 0);
  while (history.length > 0 && (history.length > MAX_MESSAGES || total > MAX_TOTAL_CHARS || history[0]?.role === 'assistant')) {
    total -= history[0]?.content.length ?? 0;
    history.shift();
  }
  return history;
}

// Answers that the gateway gives before it runs anything: after these the write has certainly not run, so the card may stay.
const NOT_RUN = new Set(['rate_limited', 'not_configured', 'invalid_request', 'service_unavailable']);

// The conversation lives in this hook's state only: nothing is stored, and a reload starts empty (decision 40).
export function useChat() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [pending, setPending] = useState<ChatPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const nextId = useRef(1);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = setTimeout(() => setWaitSeconds((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [waitSeconds]);

  const make = (role: ChatItem['role'], content: string, toolCalls: ChatToolCall[] = [], inHistory = true): ChatItem => ({ id: nextId.current++, role, content, toolCalls, inHistory });

  const run = async (current: ChatItem[], confirm?: ChatPending): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await sendChat(buildHistory(current), confirm);
      if (answer.pending) {
        // The text that comes with a card is shown but not kept in the history: the next request must end at the person's message.
        const shown = answer.reply !== '' || answer.toolCalls.length > 0 ? [make('assistant', answer.reply, answer.toolCalls, false)] : [];
        setItems([...current, ...shown]);
        setPending(answer.pending);
      } else {
        setItems([...current, make('assistant', answer.reply, answer.toolCalls)]);
        setPending(null);
      }
      return true;
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(chatMessage(caught, confirm !== undefined));
      // The quota of the person always waits (30 s if the header is missing). A busy model service waits only when it said how long.
      if (failure?.kind === 'throttled') setWaitSeconds(failure.retryAfterSeconds ?? (failure.reason === 'model_rate_limited' ? 0 : DEFAULT_WAIT_SECONDS));
      // The card stays only when it is certain that nothing ran. Otherwise a retry could create a product twice.
      if (confirm && !(failure?.reason && NOT_RUN.has(failure.reason))) setPending(null);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (trimmed === '' || busy || pending !== null || waitSeconds > 0) return false;
    const next = [...items, make('user', trimmed)];
    setItems(next);
    const ok = await run(next);
    // A failed message is taken out again and the caller gets false, so the screen can put the text back in the box.
    if (!ok) setItems(items);
    return ok;
  };

  const confirmPending = async () => {
    if (!pending || busy || waitSeconds > 0) return;
    await run(items, pending);
  };

  const cancelPending = () => {
    if (!pending || busy) return;
    setPending(null);
    setError(null);
    setItems([...items, make('note', 'Cancelled. Nothing was changed.', [], false)]);
  };

  return { items, pending, busy, error, waitSeconds, send, confirmPending, cancelPending };
}
