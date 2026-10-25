import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/* The real module, installed as on the phone: /app, a touch screen, Chrome's VirtualKeyboard. */
const vk = Object.assign(new EventTarget(), { overlaysContent: false, boundingRect: { height: 0 } as DOMRectReadOnly });
const activation = { hasBeenActive: true };
const kb = () => document.documentElement.style.getPropertyValue('--kb');
let field: HTMLTextAreaElement;
beforeAll(async () => {
  history.replaceState(null, '', '/app');
  Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: vk });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: activation });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  localStorage.setItem('aside.kbh', '320');
  Element.prototype.scrollIntoView = vi.fn();
  await import('../src/keyboard');
  field = document.createElement('textarea');
  document.body.append(field);
});
afterEach(() => { field.blur(); vi.useRealTimers(); document.documentElement.style.setProperty('--kb', '0px'); });

describe('the composer only rises when a keyboard is really coming', () => {
  it('opts into overlay mode on a touch phone', () => { expect(vk.overlaysContent).toBe(true); });
  it('a slid tap (pointerup, no focus) moves nothing', async () => {
    field.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(kb()).not.toBe('320px');
  });
  it('a real focus starts the lift with the cached height, and real geometry confirms it', () => {
    vi.useFakeTimers();
    field.focus();
    expect(kb()).toBe('320px');
    (vk as unknown as { boundingRect: { height: number } }).boundingRect = { height: 300 } as DOMRectReadOnly;
    vk.dispatchEvent(new Event('geometrychange'));
    vi.advanceTimersByTime(1000);
    expect(kb()).toBe('300px');
  });
  it('a script focus before the page was ever touched moves nothing (Chrome shows no keyboard then)', () => {
    activation.hasBeenActive = false;
    field.focus();
    expect(kb()).not.toBe('320px');
    activation.hasBeenActive = true;
  });
  it('a tap on the field that already has focus brings the lift back after the back gesture', () => {
    vi.useFakeTimers();
    field.focus();
    (vk as unknown as { boundingRect: { height: number } }).boundingRect = { height: 0 } as DOMRectReadOnly;
    vk.dispatchEvent(new Event('geometrychange'));
    expect(kb()).toBe('0px');
    field.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(kb()).not.toBe('0px');
  });
});

it('does not erase a real keyboard whose geometry event arrives late', () => {
  vi.useFakeTimers();
  (vk as unknown as { boundingRect: { height: number } }).boundingRect = { height: 0 } as DOMRectReadOnly;
  vk.dispatchEvent(new Event('geometrychange'));
  field.focus();
  (vk as unknown as { boundingRect: { height: number } }).boundingRect = { height: 300 } as DOMRectReadOnly;
  vi.advanceTimersByTime(800);
  expect(kb()).toBe('300px');
});
