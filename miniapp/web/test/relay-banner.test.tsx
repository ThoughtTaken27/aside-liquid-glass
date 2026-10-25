/**
 * The failover banner: silent on the primary, informative on a backup,
 * and a way back the moment the primary answers again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RelayBanner } from '../src/components/RelayBanner';
import { setRefreshedRelays } from '../src/relays';

function stubLocation(origin: string, assign: (...args: unknown[]) => void = () => {}) {
  vi.stubGlobal('location', {
    origin,
    pathname: '/app',
    search: '',
    hash: '',
    assign,
  });
}

beforeEach(() => {
  setRefreshedRelays([]);
  document.head.innerHTML =
    '<meta name="aside-relays" content="https://primary.example https://backup.example" />';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('RelayBanner', () => {
  it('renders nothing on the primary', () => {
    stubLocation('https://primary.example');
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<RelayBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('names the backup state while the primary is down', async () => {
    stubLocation('https://backup.example');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    render(<RelayBanner />);
    expect(await screen.findByText('On the backup address.')).toBeTruthy();
    expect(screen.queryByText('Switch')).toBeNull();
  });

  it('offers the way back once the primary answers', async () => {
    const assign = vi.fn();
    stubLocation('https://backup.example', assign);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(undefined));
    render(<RelayBanner />);
    expect(await screen.findByText('Primary address is back.')).toBeTruthy();
    fireEvent.click(screen.getByText('Switch'));
    expect(assign).toHaveBeenCalledWith('https://primary.example/app');
  });

  it('dismisses for the session', async () => {
    stubLocation('https://backup.example');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const { container } = render(<RelayBanner />);
    expect(await screen.findByText('On the backup address.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(container.innerHTML).toBe('');
  });
});
