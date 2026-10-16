import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { waitText } from '../auth/messages';
import { MAX_MESSAGE_CHARS, useChat } from '../chat/useChat';
import { Badge } from '../ui/Badge';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';
import styles from './ChatPage.module.css';

// The assistant of the signed-in person, for any role. It runs in the gateway as that person (decision 40). Every text from the
// model, from a tool or from the arguments of a call is rendered as plain text by React: nothing here sets markup.
export function ChatPage() {
  const chat = useChat();
  const [draft, setDraft] = useState('');

  const waiting = chat.waitSeconds > 0;
  const blocked = chat.busy || chat.pending !== null || waiting;

  const submit = async () => {
    const text = draft;
    if (text.trim() === '' || blocked) return;
    setDraft('');
    const sent = await chat.send(text);
    if (!sent) setDraft(text);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <nav className={styles.nav} aria-label="Account">
          <Link to="/" className={styles.back}>
            Back
          </Link>
          <ThemeToggle />
        </nav>
      </header>
      <main id="main" className={styles.main}>
        <h1 className={styles.title}>Chat</h1>
        <p className={styles.note}>The assistant uses the store tools as you, and every call is in the audit log. This conversation is kept in this page only.</p>

        <div className={styles.log} role="log" aria-label="Conversation" aria-live="polite">
          {chat.items.length === 0 ? <p className={styles.note}>Ask about products or orders, or ask for a change. A change always waits for your confirmation.</p> : null}
          {chat.items.map((item) => (
            <div key={item.id} className={`${styles.message} ${item.role === 'user' ? styles.user : item.role === 'note' ? styles.noteItem : styles.assistant}`}>
              <span className={styles.who}>{item.role === 'user' ? 'You' : item.role === 'note' ? 'Note' : 'Assistant'}</span>
              {item.content !== '' ? <p className={styles.text}>{item.content}</p> : null}
              {item.toolCalls.length > 0 ? (
                <ul className={styles.chips} aria-label="Tools used">
                  {item.toolCalls.map((call, index) => (
                    <li key={index}>
                      <Badge tone={call.ok ? 'ok' : 'bad'}>
                        {call.name} {call.ok ? 'ok' : 'failed'} {call.durationMs} ms
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>

        {chat.busy ? (
          <p className={styles.note} role="status">
            Working on it...
          </p>
        ) : null}

        {chat.pending ? (
          <section className={styles.card} aria-labelledby="confirm-title">
            <h2 id="confirm-title" className={styles.cardTitle}>
              Confirm this change
            </h2>
            <p className={styles.note}>The assistant wants to run this tool. Nothing has changed yet.</p>
            <dl className={styles.facts}>
              <dt>Tool</dt>
              <dd className={styles.mono}>{chat.pending.name}</dd>
              <dt>Arguments</dt>
              <dd>
                <pre className={styles.args}>{JSON.stringify(chat.pending.args, null, 2)}</pre>
              </dd>
            </dl>
            <div className={styles.actions}>
              <Button onClick={() => void chat.confirmPending()} disabled={chat.busy || waiting}>
                Run
              </Button>
              <Button variant="ghost" onClick={chat.cancelPending} disabled={chat.busy}>
                Cancel
              </Button>
            </div>
          </section>
        ) : null}

        {chat.error ? (
          <p className={styles.error} role="alert">
            {chat.error}
            {waiting ? ` Try again in ${waitText(chat.waitSeconds)}.` : ''}
          </p>
        ) : null}

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <label htmlFor="chat-input" className={styles.label}>
            Message
          </label>
          <textarea
            id="chat-input"
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_MESSAGE_CHARS}
            rows={3}
            disabled={chat.pending !== null}
          />
          <div className={styles.actions}>
            <Button type="submit" disabled={blocked || draft.trim() === ''}>
              Send
            </Button>
            {chat.pending ? <span className={styles.note}>Answer the confirmation above first.</span> : null}
          </div>
        </form>
      </main>
    </div>
  );
}
