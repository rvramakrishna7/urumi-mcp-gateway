import type { Box, Measure } from './geometry';

// Reads where things are on the login page, relative to the page element. It uses offsetLeft and offsetTop (the layout
// position), not getBoundingClientRect, so a transform that is still running (the entrance animation) cannot move the
// numbers. It returns null when there is no layout to read (a test). In a narrow window the layout is stacked (the same
// 62rem as in LoginPage.module.css) and the measure says so.
const STACKED = '(max-width: 62rem)';

function boxOf(element: HTMLElement, page: HTMLElement): Box {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== page) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
}

// The box of the text itself: a paragraph is as wide as its column, but its words are not.
function textBoxOf(element: HTMLElement, page: HTMLElement): Box {
  const box = boxOf(element, page);
  const range = document.createRange();
  range.selectNodeContents(element);
  const width = range.getBoundingClientRect().width;
  return width > 0 ? { ...box, right: box.left + Math.min(width, element.offsetWidth) } : box;
}

export function measurePage(page: HTMLElement): Measure | null {
  const stacked = typeof window.matchMedia === 'function' && window.matchMedia(STACKED).matches;
  const header = page.querySelector<HTMLElement>('[data-anchor="header"]');
  const card = page.querySelector<HTMLElement>('[data-anchor="card"]');
  const texts = [...page.querySelectorAll<HTMLElement>('[data-anchor="eyebrow"], [data-anchor="lead"]')];
  const words = [...page.querySelectorAll<HTMLElement>('[data-anchor="word"]')];
  if (!header || !card || card.offsetWidth === 0 || words.length === 0 || page.offsetWidth === 0) return null;

  const textBoxes = [...texts.map((element) => textBoxOf(element, page)), ...words.map((element) => boxOf(element, page))];
  return {
    width: page.offsetWidth,
    height: page.offsetHeight,
    header: boxOf(header, page),
    textBoxes,
    card: boxOf(card, page),
    headingRight: Math.max(...textBoxes.map((box) => box.right)),
    stacked,
  };
}
