import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import styles from '../pages/KeysPage.module.css';

interface RevealKeyProps {
  secret: string;
  // For a key: its name. For an invite: the email of the person.
  name: string;
  onDone: () => void;
  // What is on the screen: an API key (the default) or an invite link. Only the words change.
  kind?: 'key' | 'invite';
}

// The one place where a plain key is on the screen. The parent keeps it in state and drops it on "Done", on a new create and
// when the page unmounts. Nothing here stores, logs or sends it: copying goes to the clipboard only when the person presses the button.
export function RevealKey({ secret, name, onDone, kind = 'key' }: RevealKeyProps) {
  const invite = kind === 'invite';
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
    } catch {
      // No clipboard (an insecure page, or a refusal): the key stays selectable in the field.
      setCopy('failed');
    }
  };

  return (
    <section className={styles.reveal} aria-labelledby="reveal-title">
      <h2 id="reveal-title" className={styles.revealTitle}>
        {invite ? 'Invite created' : 'Key created'}: {name}
      </h2>
      <p className={styles.note}>
        {invite ? 'Copy the link now and send it to the person. It is shown this one time, works once and expires in 72 hours.' : 'Copy it now. It is shown this one time and cannot be shown again.'}
      </p>
      <Field label={invite ? 'Invite link' : 'New API key'} readOnly autoComplete="off" spellCheck={false} value={secret} onFocus={(event) => event.currentTarget.select()} />
      <div className={styles.actions}>
        <Button onClick={() => void onCopy()}>{copy === 'copied' ? 'Copied' : invite ? 'Copy link' : 'Copy key'}</Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      {copy === 'failed' ? (
        <p className={styles.error} role="alert">
          Copy did not work here. Select the {invite ? 'link' : 'key'} above and press Ctrl+C.
        </p>
      ) : null}
    </section>
  );
}
