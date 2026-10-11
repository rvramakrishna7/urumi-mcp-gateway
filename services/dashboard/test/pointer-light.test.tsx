import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { PointerLight } from '../src/ui/PointerLight';

function stubMedia(options: { finePointer: boolean; reducedMotion: boolean }): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('hover: hover') ? options.finePointer : query.includes('reduce') ? options.reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const move = (init: PointerEventInit & { clientX: number; clientY: number }) => {
  const event = new Event('pointermove', { bubbles: true }) as Event & { clientX: number; clientY: number; pointerType: string };
  event.clientX = init.clientX;
  event.clientY = init.clientY;
  event.pointerType = init.pointerType ?? 'mouse';
  fireEvent(window, event);
};

describe('pointer light', () => {
  test('a mouse moves the spot: one custom property of one element, in the form "x y"', async () => {
    stubMedia({ finePointer: true, reducedMotion: false });
    const { container } = render(<PointerLight />);
    const spot = container.firstElementChild as HTMLElement;
    expect(spot).not.toBeNull();
    expect(spot.getAttribute('aria-hidden')).toBe('true');
    move({ clientX: 321, clientY: 123 });
    await waitFor(() => expect(spot.style.getPropertyValue('--spot')).toBe('321px 123px'));
    // Nothing else is written to the element.
    expect(spot.style.length).toBe(1);
    move({ clientX: 10, clientY: 20 });
    await waitFor(() => expect(spot.style.getPropertyValue('--spot')).toBe('10px 20px'));
  });

  test('a touch does not move the spot', async () => {
    stubMedia({ finePointer: true, reducedMotion: false });
    const { container } = render(<PointerLight />);
    const spot = container.firstElementChild as HTMLElement;
    move({ clientX: 50, clientY: 60, pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spot.style.getPropertyValue('--spot')).toBe('');
  });

  test('with reduced motion there is no spot at all', () => {
    stubMedia({ finePointer: true, reducedMotion: true });
    const { container } = render(<PointerLight />);
    expect(container.firstElementChild).toBeNull();
  });

  test('with a pointer that cannot hover (touch screens) there is no spot at all', () => {
    stubMedia({ finePointer: false, reducedMotion: false });
    const { container } = render(<PointerLight />);
    expect(container.firstElementChild).toBeNull();
  });

  test('it never writes to storage or to a cookie', async () => {
    stubMedia({ finePointer: true, reducedMotion: false });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<PointerLight />);
    move({ clientX: 5, clientY: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });
});
