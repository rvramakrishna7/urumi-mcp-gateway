import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { listAudit, listUserOptions } from '../api/client';
import type { AuditFilter } from '../api/client';

export const AUDIT_KEY = ['audit'] as const;

// The filter is part of the key, so a new filter is a new list that starts at the first page. The cursor is the page
// parameter and is never reused across filters.
export function useAudit(filter: AuditFilter) {
  return useInfiniteQuery({
    queryKey: [...AUDIT_KEY, filter],
    queryFn: ({ pageParam }) => listAudit(filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

export function useUserOptions(enabled: boolean) {
  return useQuery({ queryKey: ['audit-users'], queryFn: listUserOptions, enabled, retry: false });
}
