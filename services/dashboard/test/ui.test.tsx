import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../src/pages/LoginPage';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { Topology } from '../src/topology/Topology';
import { Badge } from '../src/ui/Badge';
import { Field } from '../src/ui/Field';
import { ThemeToggle } from '../src/ui/ThemeToggle';

function stubColorScheme(light: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('light') ? light : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => stubColorScheme(false));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('theme: follows the browser, the toggle is kept in memory only', () => {
  test('dark browser: the toggle offers light, and a click sets data-theme on <html>', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Switch to the light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to the dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('light browser: the first offer is dark', () => {
    stubColorScheme(true);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button', { name: 'Switch to the dark theme' })).toBeTruthy();
  });

  test('no storage is written when the theme changes', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });

  test('a reload (a new provider) starts from the browser again, not from the earlier choice', async () => {
    const first = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('light');
    first.unmount();
    expect(document.documentElement.dataset.theme).toBe('light');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe('Field and Badge', () => {
  test('a field has a visible label, a hint and an error that are tied to the input', () => {
    render(<Field label="Email" hint="Your work address" error="Enter an email" />);
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('Enter an email');
  });

  test('a badge carries its meaning as text', () => {
    render(<Badge tone="bad">unreachable</Badge>);
    expect(screen.getByText('unreachable')).toBeTruthy();
  });
});

describe('topology: the state is written, not only coloured', () => {
  const servers = [
    { id: '1', label: 'woo', state: 'connected' as const },
    { id: '2', label: 'docs', state: 'unreachable' as const },
    { id: '3', label: 'files', state: 'disabled' as const },
  ];

  test('every state is in the text, and the state class is on its server', () => {
    const { container } = render(<Topology servers={servers} />);
    for (const word of ['connected', 'unreachable', 'disabled']) expect(screen.getByText(word)).toBeTruthy();
    const groups = [...container.querySelectorAll('svg > g:last-of-type > g')];
    expect(groups.map((group) => group.getAttribute('class')?.split(' ').pop())).toEqual(['connected', 'unreachable', 'disabled']);
  });

  test('with real data the drawing has a text summary; the decorative one is hidden from assistive technology', () => {
    const real = render(<Topology servers={servers} />);
    const label = real.container.querySelector('svg')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('docs unreachable');
    real.unmount();
    const decorative = render(<Topology servers={servers} decorative />);
    expect(decorative.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(decorative.container.querySelector('svg')?.getAttribute('role')).toBeNull();
  });

  test('no server draws a line and a node at all', () => {
    const { container } = render(<Topology servers={[]} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('no upstream servers');
  });
});

describe('login screen (13a, static)', () => {
  const renderLogin = () =>
    render(
      <ThemeProvider>
        <LoginPage />
      </ThemeProvider>,
    );

  test('one h1, the two fields with labels, and the sign-in button', () => {
    renderLogin();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect((screen.getByLabelText('Email') as HTMLInputElement).autocomplete).toBe('username');
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  test('submitting does not call the network yet', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the backdrop is decoration: hidden from assistive technology, with no text, no server name and no status', () => {
    const { container } = renderLogin();
    const backdrop = container.querySelector('[aria-hidden="true"] > svg[viewBox="0 0 1440 900"]');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    // No label on the node, no server, no state: a round node and lines only.
    expect(backdrop?.textContent).toBe('');
    expect(backdrop?.querySelectorAll('circle').length).toBeGreaterThanOrEqual(3);
  });

  test('the backdrop has at most four lines with a dot, and no disabled (dashed) line', () => {
    const { container } = renderLogin();
    const dots = container.querySelectorAll('svg[viewBox="0 0 1440 900"] path[pathLength="1000"]');
    expect(dots.length).toBeGreaterThanOrEqual(2);
    expect(dots.length).toBeLessThanOrEqual(4);
  });

  test('the page tells the backdrop where the text is (anchors), and the heading has no underline or drawing', () => {
    const { container } = renderLogin();
    for (const anchor of ['header', 'eyebrow', 'lead', 'card']) expect(container.querySelectorAll(`[data-anchor="${anchor}"]`)).toHaveLength(1);
    expect(container.querySelectorAll('[data-anchor="word"]')).toHaveLength(5);
    expect(container.querySelector('h1 svg')).toBeNull();
    expect(container.querySelector('h1 path')).toBeNull();
  });

  test('the heading reads as one sentence although its words are separate elements', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1 }).textContent?.replace(/\s+/g, ' ').trim()).toBe('Every tool, through one door.');
  });
});
