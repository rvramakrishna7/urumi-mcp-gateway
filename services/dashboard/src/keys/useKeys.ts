import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createKey, listKeys, revokeKey } from '../api/client';

export const KEYS_KEY = ['keys'] as const;

// Must match MAX_ACTIVE_KEYS_PER_USER in services/gateway/src/identity/repository.ts. The gateway enforces it (409); this copy
// only lets the screen disable the form before a request that would be refused.
export const MAX_ACTIVE_KEYS = 10;

export function useKeys() {
  return useQuery({ queryKey: KEYS_KEY, queryFn: listKeys, retry: false });
}

// The mutation result holds the plain key, so the cache must not keep it: the caller reads it from mutateAsync and puts it
// in component state, and gcTime 0 drops the mutation entry as soon as nothing observes it.
export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createKey(name),
    gcTime: 0,
    onSettled: () => client.invalidateQueries({ queryKey: KEYS_KEY }),
  });
}

export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeKey(id),
    // A 404 means the key is already gone or not ours: the list is refreshed either way.
    onSettled: () => client.invalidateQueries({ queryKey: KEYS_KEY }),
  });
}
