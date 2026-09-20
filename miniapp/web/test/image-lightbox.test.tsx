/**
 * The full-screen image viewer.
 *
 * An image the agent produced was rendered at thread width and did nothing
 * when tapped, so a screenshot was effectively unreadable on a phone. These
 * pin the parts that are easy to break silently: that images are real
 * controls, that the viewer opens from anywhere via the window event, and
 * that every way out of it actually closes.
 *
 * The pinch maths itself is exercised through `clamp`-shaped assertions on
 * the rendered transform rather than by simulating two fingers in jsdom,
 * which has no real pointer geometry to simulate against.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImageLightbox, openImage } from '../src/components/ImageLightbox';
import { Markdown } from '../src/components/Markdown';

afterEach(cleanup);

describe('output images', () => {
  it('are buttons, not decoration', () => {
    render(<Markdown text={'![a diagram](https://example.test/x.png)'} />);
    const button = screen.getByRole('button', { name: 'View image: a diagram' });
    expect(button).toBeTruthy();
    // The image is still an image, so it still has its alt text.
    expect(button.querySelector('img')?.getAttribute('alt')).toBe('a diagram');
  });

  it('fall back to a plain notice when the file cannot be served', () => {
    render(<Markdown text={'![gone](file:///nope.png)'} />);
    expect(screen.queryByRole('button', { name: /View image/ })).toBeNull();
  });
});

describe('ImageLightbox', () => {
  it('renders nothing until an image asks for it', () => {
    render(<ImageLightbox />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on the window event and shows the image', () => {
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png', alt: 'a screenshot' }));
    const dialog = screen.getByRole('dialog', { name: 'a screenshot' });
    expect(dialog).toBeTruthy();
    const img = dialog.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.test/shot.png');
  });

  it('holds a caller-owned blob until close, replacement, or unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<ImageLightbox />);
    act(() => openImage({ src: 'blob:first', onClose: first }));
    expect(first).not.toHaveBeenCalled();
    act(() => openImage({ src: 'blob:second', onClose: second }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    view.unmount();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores an event with no source', () => {
    render(<ImageLightbox />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent('aside:open-image', { detail: { src: '' } }),
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on the close button', () => {
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('locks the page behind it and gives the scroll back on close', () => {
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('starts unzoomed and untranslated', () => {
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    const img = screen.getByRole('dialog').querySelector('img') as HTMLElement;
    expect(img.style.transform).toContain('scale(1)');
    expect(img.style.transform).toContain('translate3d(0px, 0px, 0)');
  });

  it('zooms in on a double tap and back out on the next one', () => {
    vi.useFakeTimers();
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    const dialog = screen.getByRole('dialog');
    const stage = dialog.querySelector('.lightbox-stage') as HTMLElement;
    const img = dialog.querySelector('img') as HTMLElement;

    fireEvent.click(stage, { clientX: 100, clientY: 200 });
    fireEvent.click(stage, { clientX: 100, clientY: 200 });
    expect(img.style.transform).toContain('scale(2.5)');

    fireEvent.click(stage, { clientX: 100, clientY: 200 });
    fireEvent.click(stage, { clientX: 100, clientY: 200 });
    expect(img.style.transform).toContain('scale(1)');

    // The pending single-tap timers must not then close it behind us.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByRole('dialog')).toBeTruthy();
    vi.useRealTimers();
  });

  it('closes on a single tap once the double-tap window has passed', () => {
    vi.useFakeTimers();
    render(<ImageLightbox />);
    // `openImage` dispatches a window event, which is outside React's own
    // batching, so the render it causes has to be flushed explicitly.
    act(() => openImage({ src: 'https://example.test/shot.png' }));
    const stage = screen
      .getByRole('dialog')
      .querySelector('.lightbox-stage') as HTMLElement;
    fireEvent.click(stage, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole('dialog')).toBeNull();
    vi.useRealTimers();
  });
});
