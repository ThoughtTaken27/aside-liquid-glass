/**
 * Round 6, web side: local image paths in answers, and creature colours.
 *
 * The bug this closes was visible rather than theoretical -- an answer
 * containing `![shot](/Users/…/shot.png)` drew the browser's broken-image
 * icon, while the same screenshot rendered fine in the work timeline
 * below it (those are transcript data URIs). So the tests are about what
 * ends up in the DOM: a rewritten src for a local path, an untouched one
 * for anything remote, and a caption instead of a broken icon when the
 * route says no.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';
import { ImageLightbox } from '../src/components/ImageLightbox';
import { Creature, HUES, creatureHue } from '../src/components/Creature';
import { localImagePath } from '../src/utils/images';
import { setAuthToken } from '../src/api';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      blob: async () => new Blob(['image'], { type: 'image/png' }),
    })),
  );
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:local-image'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  setAuthToken('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  } else {
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  } else {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
});

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

const SHOT = '/Users/owner/.aside/u/0/sessions/2026-01-07_abc/artifacts/shot.png';

describe('telling a local path apart from a URL', () => {
  it('accepts an absolute filesystem path', () => {
    expect(localImagePath(SHOT)).toBe(SHOT);
    expect(localImagePath('/tmp/a b.png')).toBe('/tmp/a b.png');
  });

  it('unwraps a file:// URL to the path it names', () => {
    expect(localImagePath('file:///Users/owner/shot.png')).toBe(
      '/Users/owner/shot.png',
    );
    expect(localImagePath('file://localhost/Users/owner/shot.png')).toBe(
      '/Users/owner/shot.png',
    );
    expect(localImagePath('file:///Users/owner/a%20b.png')).toBe(
      '/Users/owner/a b.png',
    );
  });

  it('leaves every real URL alone', () => {
    for (const url of [
      'https://example.com/logo.png',
      'http://example.com/logo.png',
      'data:image/png;base64,AAAA',
      'blob:https://example.com/1234',
      '//cdn.example.com/logo.png',
      'shot.png',
      'artifacts/shot.png',
      './shot.png',
      '',
    ]) {
      expect(localImagePath(url), url).toBeNull();
    }
  });
});

describe('images inside an answer', () => {
  it('fetches a local path with a header and renders only a blob URL', async () => {
    setAuthToken('tok-123');
    render(<Markdown text={`![a shot](${SHOT})`} sessionId="abc" />);
    const img = (await screen.findByAltText('a shot')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:local-image');
    expect(img.getAttribute('src')).not.toContain('token');
    expect(img.getAttribute('loading')).toBe('lazy');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(
      `/api/sessions/abc/file?path=${encodeURIComponent(SHOT)}`,
    );
    expect((init?.headers as Headers).get('authorization')).toBe('Bearer tok-123');
    expect(init?.credentials).toBe('same-origin');
  });

  it('leaves an https image exactly as written', () => {
    render(
      <Markdown text="![logo](https://example.com/logo.png)" sessionId="abc" />,
    );
    expect(screen.getByAltText('logo').getAttribute('src')).toBe(
      'https://example.com/logo.png',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a file:// src through the same protected route', async () => {
    setAuthToken('tok-123');
    render(
      <Markdown text="![f](file:///Users/owner/shot.png)" sessionId="abc" />,
    );
    await screen.findByAltText('f');
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      encodeURIComponent('/Users/owner/shot.png'),
    );
  });

  it('shows a caption, not a broken icon, when image decoding fails', async () => {
    setAuthToken('tok-123');
    render(<Markdown text={`![a shot](${SHOT})`} sessionId="abc" />);
    fireEvent.error(await screen.findByAltText('a shot'));
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
  });

  it('shows a caption when the authenticated fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    render(<Markdown text={`![a shot](${SHOT})`} sessionId="abc" />);
    expect(await screen.findByText('Image unavailable: a shot')).toBeTruthy();
  });

  it('keeps an image failure across a re-render instead of re-requesting', async () => {
    setAuthToken('tok-123');
    const draw = () => (
      <Markdown text={`![a shot](${SHOT})`} sessionId="abc" sources={{}} />
    );
    const { rerender } = render(draw());
    fireEvent.error(await screen.findByAltText('a shot'));
    rerender(draw());
    rerender(draw());
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a blob alive if virtualization unmounts its row while the lightbox is open', async () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          {show ? <Markdown key="row" text={`![a shot](${SHOT})`} sessionId="abc" /> : null}
          <ImageLightbox key="viewer" />
        </>
      );
    }
    const view = render(<Harness show />);
    fireEvent.click(await screen.findByRole('button', { name: 'View image: a shot' }));
    view.rerender(<Harness show={false} />);
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
      'blob:local-image',
    );
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-image');
  });

  it('revokes its object URL on unmount', async () => {
    const { unmount } = render(
      <Markdown text={`![a shot](${SHOT})`} sessionId="abc" />,
    );
    await screen.findByAltText('a shot');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-image');
  });

  it('shows the caption when there is no session to resolve against', () => {
    render(<Markdown text={`![a shot](${SHOT})`} />);
    expect(screen.queryByAltText('a shot')).toBeNull();
    expect(screen.getByText('Image unavailable: a shot')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still refuses javascript: in an ordinary link', () => {
    render(<Markdown text="[x](javascript:alert(1))" sessionId="abc" />);
    const link = document.querySelector('a');
    expect(link?.getAttribute('href') || '').not.toContain('javascript:');
  });
});

describe('creature colours', () => {
  it('maps each palette slot to its own hue, and wraps', () => {
    const slots = HUES.map((_, index) => creatureHue(index));
    expect(new Set(slots).size).toBe(HUES.length);
    expect(creatureHue(HUES.length)).toBe(creatureHue(0));
    // A child with no slot yet must still draw something.
    expect(creatureHue(undefined)).toBe(HUES[0]);
  });

  it('draws two different slots in two different colours', () => {
    const { container } = render(
      <>
        <Creature slot={0} />
        <Creature slot={1} />
      </>,
    );
    const fills = Array.from(container.querySelectorAll('path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(fills).toHaveLength(2);
    expect(fills[0]).not.toBe(fills[1]);
  });
});
