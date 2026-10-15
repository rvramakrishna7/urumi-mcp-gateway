import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inviteMember, listUserKeys, listUsers, reinviteUser, revokeUserKey, setUserStatus } from '../api/client';

export const USERS_KEY = ['users'] as const;
export const userKeysKey = (id: string) => ['user-keys', id] as const;

// No polling: members change rarely, and a refetch must not disturb an open invite or confirm. The Refresh button reads again.
export function useUsers() {
  return useQuery({ queryKey: USERS_KEY, queryFn: listUsers, retry: false });
}

export function useUserKeys(id: string) {
  return useQuery({ queryKey: userKeysKey(id), queryFn: () => listUserKeys(id), retry: false });
}

// The result of an invite holds the link with its one-time token, so the mutation entry is dropped as soon as nothing
// observes it (gcTime 0) and the caller resets it after reading the link.
export function useInviteMember() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (email: string) => inviteMember(email), gcTime: 0, onSettled: () => client.invalidateQueries({ queryKey: USERS_KEY }) });
}

export function useReinvite() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => reinviteUser(id), gcTime: 0, onSettled: () => client.invalidateQueries({ queryKey: USERS_KEY }) });
}

export function useSetUserStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'disabled' }) => setUserStatus(input.id, input.status),
    onSettled: () => client.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useRevokeUserKey(userId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (keyId: string) => revokeUserKey(userId, keyId), onSettled: () => client.invalidateQueries({ queryKey: userKeysKey(userId) }) });
}
