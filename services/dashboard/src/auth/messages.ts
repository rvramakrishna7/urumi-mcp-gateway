import { ApiError } from '../api/client';

// Every text that a person reads after a failed call is written here. The text of a server answer is never shown, and no
// text tells whether an email exists, whether an account is disabled, or why an invite is not usable.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const kindOf = (error: unknown): ApiError['kind'] => (error instanceof ApiError ? error.kind : 'server');

export function loginMessage(error: unknown): string {
  const kind = kindOf(error);
  if (kind === 'unauthorized') return 'Email or password is incorrect.';
  if (kind === 'throttled') {
    const seconds = error instanceof ApiError ? error.retryAfterSeconds : null;
    if (seconds === null) return 'Too many attempts. Try again in a few minutes.';
    const minutes = Math.ceil(seconds / 60);
    return `Too many attempts. Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  if (kind === 'network') return 'Cannot reach the server. Check your connection and try again.';
  return 'Sign-in is not available right now. Try again in a moment.';
}

export const WEAK_PASSWORD_MESSAGE = `Choose a password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters that is not your email address.`;
export const MISMATCH_MESSAGE = 'The two passwords do not match.';
export const INVITE_UNUSABLE_MESSAGE = 'This invite link cannot be used. Ask an admin for a new one.';

export function inviteMessage(error: unknown): string {
  const kind = kindOf(error);
  if (kind === 'weak') return WEAK_PASSWORD_MESSAGE;
  if (kind === 'invalid') return INVITE_UNUSABLE_MESSAGE;
  if (kind === 'network') return 'Cannot reach the server. Check your connection and try again.';
  return 'The password could not be saved right now. Try again in a moment.';
}

// The length of a password the way the gateway counts it: in characters, not in UTF-16 units.
export const passwordLength = (password: string): number => [...password].length;

export function keysMessage(error: unknown, action: 'load' | 'create' | 'revoke'): string {
  const kind = kindOf(error);
  if (kind === 'network') return 'Cannot reach the server. Check your connection and try again.';
  if (action === 'create') {
    if (kind === 'limit') return 'You have 10 active keys. Revoke one to create another.';
    if (kind === 'invalid') return 'Enter a name of 1 to 100 characters.';
    return 'The key could not be created right now. Try again in a moment.';
  }
  if (action === 'revoke') {
    if (kind === 'notfound') return 'That key is already gone. The list has been refreshed.';
    return 'The key could not be revoked right now. Try again in a moment.';
  }
  return 'Your keys could not be loaded right now. Try again in a moment.';
}

export function auditMessage(error: unknown): string {
  if (kindOf(error) === 'network') return 'Cannot reach the server. Check your connection and try again.';
  return 'The audit log could not be loaded right now. Try again in a moment.';
}

export function serversMessage(error: unknown, action: 'load' | 'create' | 'edit' | 'toggle' | 'delete'): string {
  const kind = kindOf(error);
  if (kind === 'network') return 'Cannot reach the server. Check your connection and try again.';
  if (kind === 'forbidden') return 'Only an admin can manage servers.';
  const gone = 'That server is already gone. The list has been refreshed.';
  const rejected = 'The gateway did not accept these values. Check the name, address, timeout and credential.';
  if (action === 'create') {
    if (kind === 'limit') return 'A server with this name already exists. Choose another name.';
    if (kind === 'invalid') return rejected;
    return 'The server could not be added right now. Try again in a moment.';
  }
  if (action === 'edit') {
    if (kind === 'notfound') return gone;
    if (kind === 'invalid') return rejected;
    return 'The server could not be saved right now. Try again in a moment.';
  }
  if (action === 'toggle') return kind === 'notfound' ? gone : 'The server could not be changed right now. Try again in a moment.';
  if (action === 'delete') return kind === 'notfound' ? gone : 'The server could not be removed right now. Try again in a moment.';
  return 'The servers could not be loaded right now. Try again in a moment.';
}

export function usersMessage(error: unknown, action: 'load' | 'invite' | 'reinvite' | 'status' | 'keys' | 'revoke'): string {
  const kind = kindOf(error);
  if (kind === 'network') return 'Cannot reach the server. Check your connection and try again.';
  if (kind === 'forbidden') return 'Only an admin can manage members.';
  const gone = 'That user or key is already gone. The list has been refreshed.';
  if (action === 'invite') {
    if (kind === 'limit') return 'A person with this email already has an account.';
    if (kind === 'invalid') return 'Enter a valid email address.';
    return 'The invite could not be created right now. Try again in a moment.';
  }
  if (action === 'reinvite') {
    if (kind === 'limit') return 'This user cannot be invited again here. Admins and disabled users are not re-invited from the dashboard.';
    if (kind === 'notfound') return gone;
    return 'The invite could not be created right now. Try again in a moment.';
  }
  if (action === 'status') {
    if (kind === 'limit') return 'That change is not allowed. You cannot disable yourself or the last active admin.';
    if (kind === 'notfound') return gone;
    return 'The user could not be changed right now. Try again in a moment.';
  }
  if (action === 'revoke') return kind === 'notfound' ? gone : 'The key could not be revoked right now. Try again in a moment.';
  if (action === 'keys') return 'The keys of this user could not be loaded right now. Try again in a moment.';
  return 'The members could not be loaded right now. Try again in a moment.';
}

// "45 s", "1 min 5 s", "2 min".
export function waitText(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export const CHAT_CHANGE_UNKNOWN = 'The change may or may not have run. Check the audit log or the store before you repeat it.';

// The sentence for a failed chat request, chosen by the status kind and the allowlisted reason. Nothing from the answer is shown.
// "confirming" is a Run press: a failure then must not let the person think that nothing happened unless that is certain.
export function chatMessage(error: unknown, confirming = false): string {
  const kind = kindOf(error);
  const reason = error instanceof ApiError ? error.reason : null;
  const unknown = confirming ? ` ${CHAT_CHANGE_UNKNOWN}` : '';
  if (kind === 'network') return confirming ? `Cannot reach the server.${unknown}` : 'Cannot reach the server. Check your connection and try again.';
  if (kind === 'unauthorized') return 'Your session has ended. Sign in again.';
  if (reason === 'invalid_confirmation') return 'This confirmation expired or is no longer valid. Nothing was run. Ask again to get a new one.';
  if (reason === 'not_configured') return 'The chat assistant is not set up on this gateway yet. Ask an admin.';
  if (reason === 'rate_limited') return 'You are sending messages too fast.';
  if (reason === 'model_rate_limited') return confirming ? `The model service is busy.${unknown}` : 'The model service is busy. Try again shortly.';
  if (reason === 'model_timeout') return confirming ? `The model service took too long.${unknown}` : 'The model service took too long. Try again with a shorter request.';
  if (reason === 'model_rejected') return confirming ? `The model service refused the request.${unknown}` : 'The model service refused this request. Start with a shorter message.';
  if (reason === 'model_unavailable') return confirming ? `The model service is not available.${unknown}` : 'The model service is not available right now. Try again in a moment.';
  if (reason === 'service_unavailable') return 'Chat is not available right now. Nothing was run. Try again in a moment.';
  if (reason === 'invalid_request') return 'This message could not be sent. Nothing was run. Start a shorter conversation.';
  return confirming ? `Something went wrong.${unknown}` : 'Something went wrong. Try again in a moment.';
}
