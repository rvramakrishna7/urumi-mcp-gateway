import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { appRoutes } from '../../src/App';
import { ThemeProvider } from '../../src/theme/ThemeProvider';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export const empty = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers });

export type Handler = (init: RequestInit) => Response | Promise<Response>;

// A fetch that answers by "METHOD /path". A call that has no handler fails the test, so nothing leaves unnoticed.
export function stubFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ key: string; init: RequestInit }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(input)}`;
    calls.push({ key, init });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

export function stubColorScheme(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

export function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

export const ADMIN = { id: 'u1', email: 'admin@urumi.test', role: 'admin' as const };
export const MEMBER = { id: 'u2', email: 'member@urumi.test', role: 'member' as const };
