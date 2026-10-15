import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateServerInput, CredentialInput, PatchServerInput, UpstreamServer } from '../api/client';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import styles from './ServerForm.module.css';

// The same rules as the gateway (services/gateway/src/registry/validation.ts). The gateway is the real check; these only
// save a request that would be refused.
const SLUG = /^[a-z][a-z0-9-]{0,19}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_URL = 2048;
const MAX_VALUE = 4096;

export function isValidUpstreamUrl(value: string): boolean {
  if (value.length > MAX_URL || /\s/.test(value) || value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
});

type CredentialChoice = 'keep' | 'none' | 'bearer' | 'header';

interface Props {
  // Present when editing. Without it the form creates a server.
  server?: UpstreamServer;
  onCreate?: (input: CreateServerInput) => Promise<void>;
  onSave?: (patch: PatchServerInput) => Promise<void>;
  onCancel: () => void;
  // The fixed message of the last failed call, from serversMessage.
  failure: string | null;
}

// Add or edit one server. The credential value lives in this component's state only: it is sent once in a request body, and
// the form is closed (unmounted) after a successful call, so nothing of it stays. It is never shown again, because the
// gateway never sends it back.
export function ServerForm({ server, onCreate, onSave, onCancel, failure }: Props) {
  const editing = server !== undefined;
  const [slug, setSlug] = useState('');
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [timeout, setTimeoutSeconds] = useState(String((server?.callTimeoutMs ?? 30_000) / 1000));
  const [choice, setChoice] = useState<CredentialChoice>(editing ? 'keep' : 'none');
  const [header, setHeader] = useState('');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const check = (): { problems: Record<string, string>; credential: CredentialInput | null | undefined; callTimeoutMs: number } => {
    const problems: Record<string, string> = {};
    if (!editing && !SLUG.test(slug)) problems.slug = 'Use lowercase letters, digits and dashes, starting with a letter (1 to 20 characters).';
    if (name.trim().length < 1 || name.trim().length > 100) problems.name = 'Enter a name of 1 to 100 characters.';
    if (!isValidUpstreamUrl(url.trim())) problems.url = 'Enter an http or https address without a query, a fragment, or a user name or password.';
    const seconds = Number(timeout);
    if (!/^[0-9]{1,3}$/.test(timeout) || seconds < 1 || seconds > 120) problems.timeout = 'Enter a whole number of seconds from 1 to 120.';
    let credential: CredentialInput | null | undefined;
    if (choice === 'bearer' || choice === 'header') {
      if (value.length < 1 || value.length > MAX_VALUE || hasControlCharacter(value)) problems.value = 'Enter the credential: one line of text, up to 4096 characters.';
      if (choice === 'header' && !HEADER_NAME.test(header)) problems.header = 'Enter a header name of letters, digits and dashes.';
      credential = choice === 'bearer' ? { kind: 'bearer', value } : { kind: 'header', header, value };
    } else if (choice === 'none' && editing) {
      credential = null;
    }
    return { problems, credential, callTimeoutMs: seconds * 1000 };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { problems, credential, callTimeoutMs } = check();
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      if (server && onSave) {
        const patch: PatchServerInput = {};
        if (name.trim() !== server.name) patch.name = name.trim();
        if (url.trim() !== server.url) patch.url = url.trim();
        if (callTimeoutMs !== server.callTimeoutMs) patch.callTimeoutMs = callTimeoutMs;
        if (credential !== undefined) patch.credential = credential;
        if (Object.keys(patch).length === 0) onCancel();
        else await onSave(patch);
      } else if (onCreate) {
        await onCreate({ slug, name: name.trim(), url: url.trim(), callTimeoutMs, ...(credential ? { credential } : {}) });
      }
    } catch {
      // The caller shows the fixed message through "failure". The values stay in the form for another try.
    } finally {
      setBusy(false);
    }
  };

  const choices: Array<[CredentialChoice, string]> = editing
    ? [['keep', server.credential.set ? 'Keep the current credential' : 'Keep (none is set)'], ['none', 'Remove the credential'], ['bearer', 'Replace with a bearer token'], ['header', 'Replace with a header']]
    : [['none', 'No credential'], ['bearer', 'Bearer token'], ['header', 'Custom header']];

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate aria-label={editing ? `Edit ${server.slug}` : 'Add a server'}>
      {editing ? (
        <p className={styles.fixed}>
          Name in tool names: <code>{server.slug}</code> (cannot be changed)
        </p>
      ) : (
        <Field label="Short name" hint="Becomes the prefix of its tools, for example woo gives woo__list_products" error={errors.slug} value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={20} autoComplete="off" />
      )}
      <Field label="Display name" error={errors.name} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="off" />
      <Field label="Address (URL)" hint="The gateway calls this address with the credential, from inside the cluster. Only add servers you trust." error={errors.url} value={url} onChange={(event) => setUrl(event.target.value)} maxLength={MAX_URL} autoComplete="off" inputMode="url" />
      <Field label="Call timeout (seconds)" error={errors.timeout} value={timeout} onChange={(event) => setTimeoutSeconds(event.target.value)} inputMode="numeric" maxLength={3} autoComplete="off" />

      <fieldset className={styles.choices}>
        <legend className={styles.legend}>Credential</legend>
        {choices.map(([id, label]) => (
          <label key={id} className={styles.choice}>
            <input type="radio" name="credential" checked={choice === id} onChange={() => setChoice(id)} />
            {label}
          </label>
        ))}
      </fieldset>
      {choice === 'header' ? <Field label="Header name" hint="For example X-Api-Key" error={errors.header} value={header} onChange={(event) => setHeader(event.target.value)} maxLength={64} autoComplete="off" /> : null}
      {choice === 'bearer' || choice === 'header' ? (
        <Field label="Credential value" hint="Stored encrypted. It is never shown again." error={errors.value} type="password" value={value} onChange={(event) => setValue(event.target.value)} maxLength={MAX_VALUE} autoComplete="off" />
      ) : null}

      {failure ? (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>
          {editing ? 'Save changes' : 'Add server'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
