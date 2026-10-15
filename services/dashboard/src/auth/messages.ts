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
