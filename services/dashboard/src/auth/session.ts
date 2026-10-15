import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { acceptInvite, fetchSession, login, logout } from '../api/client';
import type { User } from '../api/client';

// The session lives in the react-query cache (memory) and nowhere else. The cookie is httpOnly, so no script can read it.
export const SESSION_KEY = ['session'] as const;

// data is the user, or null when nobody is signed in. An error is a failure to find out (the server or the network).
export function useSession(options: { enabled?: boolean } = {}) {
  return useQuery<User | null>({ queryKey: SESSION_KEY, queryFn: fetchSession, retry: false, refetchOnWindowFocus: true, enabled: options.enabled ?? true });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => login(input.email, input.password),
    onSuccess: (user) => client.setQueryData(SESSION_KEY, user),
  });
}

export function useAcceptInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string; password: string }) => acceptInvite(input.token, input.password),
    onSuccess: (user) => client.setQueryData(SESSION_KEY, user),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: logout,
    // Only when the server has ended the session: nothing of the signed-in user stays in memory.
    onSuccess: () => client.clear(),
  });
}
