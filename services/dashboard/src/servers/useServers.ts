import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createServer, deleteServer, listServerTools, listServers, patchServer } from '../api/client';
import type { CreateServerInput, PatchServerInput } from '../api/client';

export const SERVERS_KEY = ['servers'] as const;
export const SERVER_TOOLS_KEY = ['server-tools'] as const;

// How often the screen asks again. The gateway's poller writes new state every 15 seconds, so this is cheap (a database
// read) and a dead upstream shows without a click. TanStack Query pauses the interval while the tab is hidden.
export const POLL_MS = 10_000;

export function useServers() {
  return useQuery({ queryKey: SERVERS_KEY, queryFn: listServers, retry: false, refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}

export function useServerTools() {
  return useQuery({ queryKey: SERVER_TOOLS_KEY, queryFn: listServerTools, retry: false, refetchInterval: POLL_MS, refetchIntervalInBackground: false });
}

// The variables of create and patch can hold a credential value, so no mutation entry is kept in the cache (gcTime 0), and
// the caller resets it after a call. After any change, or a failed change, both lists are read again.
function useRefreshBoth() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: SERVERS_KEY }), client.invalidateQueries({ queryKey: SERVER_TOOLS_KEY })]);
}

export function useCreateServer() {
  const refresh = useRefreshBoth();
  return useMutation({ mutationFn: (input: CreateServerInput) => createServer(input), gcTime: 0, onSettled: refresh });
}

export function usePatchServer() {
  const refresh = useRefreshBoth();
  return useMutation({ mutationFn: (input: { id: string; patch: PatchServerInput }) => patchServer(input.id, input.patch), gcTime: 0, onSettled: refresh });
}

export function useDeleteServer() {
  const refresh = useRefreshBoth();
  return useMutation({ mutationFn: (id: string) => deleteServer(id), onSettled: refresh });
}
