/**
 * Thin wrapper over Telegram's WebApp bridge.
 *
 * Every call is a no-op (or a sane browser fallback) outside Telegram so the
 * exact same build runs in a plain desktop browser, where initData comes
 * from a `#initData=` hash param produced by scripts/dev-initdata.mjs.
 *
 * This talks to `window.Telegram.WebApp` directly rather than through a
 * third-party SDK package. Telegram ships and versions that object itself
 * (`telegram-web-app.js`), so it is the actual source of truth for Bot API
 * 8.0/9.x features -- fullscreen, safe areas, the second button, native
 * dialogs, cloud/secure storage, biometrics. A wrapper library only adds a
 * translation layer on top of the same surface. Every new call below is
 * capability-checked with a no-op fallback, because `requestFullscreen` and
 * friends return `UNSUPPORTED` on some clients -- see the Day 1 plan.
 */
import { readLocal, removeLocal, writeLocal } from './utils/storage';


interface WebAppUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface SafeAreaInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface WebAppInitDataUnsafe {
  user?: WebAppUser;
  start_param?: string;
}

interface WebAppBottomButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  hasShineEffect?: boolean;
  setText(text: string): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  setParams(params: Partial<{
    text: string;
    color: string;
    text_color: string;
    is_active: boolean;
    is_visible: boolean;
    has_shine_effect: boolean;
  }>): void;
}

interface WebAppSettingsButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

type StorageCallback<T = void> = (error: string | null, result?: T) => void;

interface WebAppCloudStorage {
  setItem(key: string, value: string, cb?: StorageCallback<boolean>): void;
  getItem(key: string, cb: StorageCallback<string>): void;
  getItems(keys: string[], cb: StorageCallback<Record<string, string>>): void;
  removeItem(key: string, cb?: StorageCallback<boolean>): void;
  removeItems(keys: string[], cb?: StorageCallback<boolean>): void;
  getKeys(cb: StorageCallback<string[]>): void;
}

interface WebAppPopupButton {
  id?: string;
  type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
  text?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: WebAppInitDataUnsafe;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  isExpanded?: boolean;
  isFullscreen?: boolean;
  platform?: string;
  version?: string;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent(event: string, handler: (...args: unknown[]) => void): void;
  offEvent(event: string, handler: (...args: unknown[]) => void): void;
  disableVerticalSwipes?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  isVersionAtLeast?: (version: string) => boolean;

  // --- Bot API 8.0: fullscreen and safe areas ---------------------------
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  lockOrientation?: () => void;
  unlockOrientation?: () => void;
  safeAreaInset?: SafeAreaInset;
  contentSafeAreaInset?: SafeAreaInset;

  // --- chrome sync -------------------------------------------------------
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;

  // --- native dialogs ------------------------------------------------------
  showPopup?: (
    params: { title?: string; message: string; buttons?: WebAppPopupButton[] },
    cb?: (buttonId?: string) => void,
  ) => void;
  showAlert?: (message: string, cb?: () => void) => void;
  showConfirm?: (message: string, cb?: (ok: boolean) => void) => void;

  // --- lifecycle -----------------------------------------------------------
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;

  BackButton?: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  MainButton?: WebAppBottomButton;
  SecondaryButton?: WebAppBottomButton;
  SettingsButton?: WebAppSettingsButton;
  CloudStorage?: WebAppCloudStorage;
  BiometricManager?: {
    isInited: boolean;
    isBiometryAvailable: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    biometryType: 'finger' | 'face' | 'unknown';
    init(callback?: () => void): void;
    requestAccess(
      params: { reason?: string },
      callback?: (granted: boolean) => void,
    ): void;
    authenticate(
      params: { reason?: string },
      callback?: (success: boolean) => void,
    ): void;
  };
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp = (): TelegramWebApp | undefined => window.Telegram?.WebApp;

export const inTelegram = (): boolean => Boolean(webApp()?.initData);

/** Signed launch payload: Telegram first, then the dev hash param. */
export function readInitData(): string | null {
  const fromTelegram = webApp()?.initData;
  if (fromTelegram) return fromTelegram;

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromHash = hash.get('initData');
  if (fromHash) return fromHash;

  const stored = sessionStorage.getItem('miniapp.initData');
  return stored || null;
}

/**
 * Deep-link launch parameter. Push notifications carry
 * `startapp=session_<id>`, and this lets the app open directly into that
 * thread on boot -- one tap from the notification shade to the conversation.
 *
 * In Telegram it lives on `initDataUnsafe.start_param`. In the dev tunnel
 * it is parsed from the raw initData query string's `tgWebAppStartParam`,
 * which is where Telegram puts it before signing.
 */
export function readStartParam(): string | null {
  const fromTelegram = webApp()?.initDataUnsafe?.start_param;
  if (fromTelegram) return fromTelegram;

  const raw = readInitData();
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  return params.get('tgWebAppStartParam');
}

/**
 * Keep the dev payload across reloads, but get it out of the URL bar.
 *
 * `raw` is the whole `#initData=…` fragment, so the value has to be parsed
 * out before it is stored -- stashing the fragment itself would hand the
 * server a string with no `hash=` field on the next read.
 */
export function stashDevInitData(raw: string): void {
  if (inTelegram()) return;

  const value = new URLSearchParams(raw.replace(/^#/, '')).get('initData');
  if (!value) return;

  try {
    sessionStorage.setItem('miniapp.initData', value);
  } catch {
    // private mode: the hash param still works for this load
  }
  history.replaceState(null, '', location.pathname + location.search);
}

/**
 * Boot sequence: signal ready before first paint, expand, go fullscreen,
 * lock down the vertical swipe-to-close gesture, and start mirroring the
 * safe-area insets onto CSS custom properties.
 *
 * `requestFullscreen` is wrapped because it throws `UNSUPPORTED` synchronously
 * on some older clients rather than just being absent -- see the Day 1 plan's
 * note on capability checks.
 */
export function initTelegram(): void {
  const app = webApp();
  if (!app) return;
  app.ready();
  app.expand();
  app.disableVerticalSwipes?.();
  try {
    app.requestFullscreen?.();
  } catch {
    // Falls back to plain `expand()`, already called above.
  }
  bindSafeAreaVars();
}

/** True once the client has actually granted fullscreen (not just asked). */
export function isFullscreen(): boolean {
  return Boolean(webApp()?.isFullscreen);
}

export function exitFullscreen(): void {
  try {
    webApp()?.exitFullscreen?.();
  } catch {
    // no-op: nothing to fall back to, the app just stays as-is.
  }
}

/**
 * Mirror Telegram's safe-area insets onto CSS variables so fullscreen mode
 * doesn't put the header under the status bar or the composer under the
 * home indicator / gesture bar.
 *
 * `--shell-safe-*` is the OS chrome (notch, status bar, home indicator).
 * `--shell-content-*` additionally clears Telegram's own floating chrome
 * (the mini app header pill in some clients), which is what the in-app
 * header should actually sit below. Both update live on `safeAreaChanged`
 * and `contentSafeAreaChanged` -- rotation and multitasking resize these.
 */
function applySafeAreaVars(): void {
  const app = webApp();
  const root = document.documentElement.style;
  const safe = app?.safeAreaInset;
  const content = app?.contentSafeAreaInset;
  root.setProperty('--shell-safe-top', `${safe?.top ?? 0}px`);
  root.setProperty('--shell-safe-bottom', `${safe?.bottom ?? 0}px`);
  root.setProperty('--shell-safe-left', `${safe?.left ?? 0}px`);
  root.setProperty('--shell-safe-right', `${safe?.right ?? 0}px`);
  root.setProperty('--shell-content-top', `${content?.top ?? 0}px`);
  root.setProperty('--shell-content-bottom', `${content?.bottom ?? 0}px`);
  root.setProperty('--shell-content-left', `${content?.left ?? 0}px`);
  root.setProperty('--shell-content-right', `${content?.right ?? 0}px`);

  /*
   * The inset our OWN header must clear.
   *
   * `contentSafeAreaInset` is supposed to describe exactly this -- the
   * floating Back pill and the collapse/menu cluster Telegram draws over
   * the page in fullscreen -- but several Android clients report it as 0
   * while those buttons are still on screen. The result shipped: the
   * app's own title row and back button sitting directly underneath
   * Telegram's, both partially covering each other (verified from a
   * screenshot: "Hello" as a session title rendered half behind the
   * native Back pill).
   *
   * So in fullscreen we take whichever is larger -- what the client
   * claims, or the status-bar inset plus the ~46px the floating cluster
   * actually occupies on the clients that under-report. Outside
   * fullscreen Telegram's header is a real bar that reserves its own
   * space in the viewport, so the reported content inset is trusted as-is
   * (adding the 46px buffer there would push our header down twice).
   */
  const fullscreen = Boolean(app?.isFullscreen);
  const contentTop = content?.top ?? 0;
  const chromeTop = fullscreen
    ? Math.max(contentTop, (safe?.top ?? 0) + 46)
    : contentTop;
  root.setProperty('--tg-chrome-top', `${chromeTop}px`);
  document.documentElement.dataset.fullscreen = fullscreen ? 'true' : 'false';
}

let safeAreaBound = false;
function bindSafeAreaVars(): void {
  applySafeAreaVars();
  if (safeAreaBound) return;
  safeAreaBound = true;
  const app = webApp();
  app?.onEvent('safeAreaChanged', applySafeAreaVars);
  app?.onEvent('contentSafeAreaChanged', applySafeAreaVars);
  app?.onEvent('fullscreenChanged', applySafeAreaVars);
}

export function colorScheme(): 'light' | 'dark' {
  const app = webApp();
  if (app?.colorScheme) return app.colorScheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Resolve a CSS colour expression (oklch, var(), hex, anything the engine
 * accepts) to the `#rrggbb` hex string Telegram's colour-setting methods
 * require. Done by letting the browser itself do the colour-space
 * conversion: set it as a computed style on a detached element and read
 * back what the engine normalizes it to.
 */
function resolveToHex(value: string): string | null {
  if (!value) return null;
  const probe = document.createElement('div');
  probe.style.color = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const rgb = computed.match(/(\d+(\.\d+)?)/g);
  if (!rgb || rgb.length < 3) return null;
  const [r, g, b] = rgb.map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Telegram's themeParams override only the page backdrop, so the app still
 * reads as Aside inside a heavily themed client instead of inheriting a
 * stranger's palette wholesale. On top of that, push the app's OWN resolved
 * surface colours back to Telegram's header and bottom bar, so its chrome
 * and the app surface become one continuous field -- see Day 1 plan 5.2.
 */
export function applyTheme(): 'light' | 'dark' {
  const scheme = colorScheme();
  const root = document.documentElement;
  root.dataset.theme = scheme;
  // The token sheet predates the data attribute and scopes its dark ramp to
  // `.dark`. Keep both hooks in sync: the attribute is useful state for
  // inspection, while the class activates every existing dark component
  // rule. Removing the class on light matters when Telegram changes theme
  // while the app is already open.
  root.classList.toggle('dark', scheme === 'dark');
  const app = webApp();
  const bg = app?.themeParams?.bg_color;
  if (bg) document.documentElement.style.setProperty('--tg-bg', bg);

  // Read AFTER the theme attribute above is applied, so the tokens
  // resolved are the ones for the scheme we just switched into.
  const page = resolveToHex(
    getComputedStyle(document.documentElement).getPropertyValue('--page'),
  );
  const surface = resolveToHex(
    getComputedStyle(document.documentElement).getPropertyValue(
      '--surface-primary',
    ),
  );
  if (page) {
    app?.setBackgroundColor?.(page);
    app?.setHeaderColor?.(page);
    app?.setBottomBarColor?.(page);
  } else if (surface) {
    app?.setHeaderColor?.(surface);
  }
  return scheme;
}

export function onThemeChanged(handler: () => void): () => void {
  const app = webApp();
  if (app) {
    app.onEvent('themeChanged', handler);
    return () => app.offEvent('themeChanged', handler);
  }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', handler);
  return () => media?.removeEventListener('change', handler);
}

export const backButton = {
  show(handler: () => void): () => void {
    const button = webApp()?.BackButton;
    if (!button) return () => {};
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
      button.hide();
    };
  },
};

/**
 * Open a web page.
 *
 * Inside Telegram this must go through `openLink`: a plain `window.open`
 * from a Mini App webview is either blocked or opens a tab the user cannot
 * get back from. Outside it, `window.open` is the only option.
 */
export function openExternal(url: string): void {
  if (!url) return;
  const app = webApp();
  if (app?.openLink) app.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Save bytes already in hand: no credential ever touches a URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Haptic =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'soft'
  | 'rigid'
  | 'success'
  | 'error'
  | 'warning'
  | 'select';

export function haptic(kind: Haptic): void {
  const feedback = webApp()?.HapticFeedback;
  if (!feedback) return;
  if (kind === 'success' || kind === 'error' || kind === 'warning') {
    feedback.notificationOccurred(kind);
  } else if (kind === 'select') {
    feedback.selectionChanged();
  } else {
    feedback.impactOccurred(kind);
  }
}

// --- native dialogs ---------------------------------------------------------

/**
 * A destructive confirmation, native to the client.
 *
 * Falls back to `window.confirm` in a plain browser (dev tunnel testing),
 * so the same call site works in both places.
 */
export function showConfirm(message: string): Promise<boolean> {
  const app = webApp();
  if (app?.showConfirm) {
    return new Promise((resolve) => app.showConfirm!(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/** A terminal notice, native to the client. */
export function showAlert(message: string): Promise<void> {
  const app = webApp();
  if (app?.showAlert) {
    return new Promise((resolve) => app.showAlert!(message, () => resolve()));
  }
  window.alert(message);
  return Promise.resolve();
}

/** A popup with up to three custom buttons; resolves the id tapped, or null. */
export function showPopup(params: {
  title?: string;
  message: string;
  buttons: WebAppPopupButton[];
}): Promise<string | null> {
  const app = webApp();
  if (app?.showPopup) {
    return new Promise((resolve) =>
      app.showPopup!(params, (id) => resolve(id ?? null)),
    );
  }
  return Promise.resolve(window.confirm(params.message) ? 'ok' : null);
}

// --- lifecycle: guard against a stray swipe mid-turn ------------------------

export function enableClosingConfirmation(): void {
  webApp()?.enableClosingConfirmation?.();
}

export function disableClosingConfirmation(): void {
  webApp()?.disableClosingConfirmation?.();
}

// --- native buttons ----------------------------------------------------------

export interface NativeButtonHandle {
  /** Detach the click handler and hide the button. */
  release(): void;
}

/**
 * Bind Telegram's MainButton or SecondaryButton to one action for as long
 * as the caller needs it, then release it cleanly. Only one thing should
 * own a given button at a time -- callers are expected to release before
 * mounting another binding on the same button.
 */
function bindBottomButton(
  button: WebAppBottomButton | undefined,
  options: {
    text: string;
    onClick: () => void;
    color?: string;
    textColor?: string;
    shine?: boolean;
  },
): NativeButtonHandle {
  if (!button) return { release: () => {} };
  const handler = options.onClick;
  button.setParams({
    text: options.text,
    is_visible: true,
    is_active: true,
    has_shine_effect: options.shine ?? false,
    ...(options.color ? { color: options.color } : {}),
    ...(options.textColor ? { text_color: options.textColor } : {}),
  });
  button.onClick(handler);
  return {
    release() {
      button.offClick(handler);
      button.setParams({ is_visible: false });
    },
  };
}

export const mainButton = {
  bind(options: { text: string; onClick: () => void; shine?: boolean }): NativeButtonHandle {
    return bindBottomButton(webApp()?.MainButton, options);
  },
  showLoader(): void {
    webApp()?.MainButton?.showProgress(true);
  },
  hideLoader(): void {
    webApp()?.MainButton?.hideProgress();
  },
  isSupported(): boolean {
    return Boolean(webApp()?.MainButton);
  },
};

export const secondaryButton = {
  bind(options: { text: string; onClick: () => void }): NativeButtonHandle {
    return bindBottomButton(webApp()?.SecondaryButton, options);
  },
  isSupported(): boolean {
    return Boolean(webApp()?.SecondaryButton);
  },
};

export const settingsButton = {
  show(handler: () => void): () => void {
    const button = webApp()?.SettingsButton;
    if (!button) return () => {};
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
      button.hide();
    };
  },
};

// --- cloud storage -----------------------------------------------------------

/**
 * Small per-account key/value store that survives a reinstall (it is
 * Telegram's, not the device's). Used for cosmetic continuity only --
 * last-open session id, per-session draft text, per-session mute -- never
 * for the bearer token. Falls back to `localStorage` outside Telegram so
 * dev tunnel testing behaves the same way.
 *
 * Limits per Telegram's docs: 1024 keys, 4096 chars per value.
 */
/**
 * Every CloudStorage call is answered by the Telegram host and by nothing
 * else, so a promise waiting on one of those callbacks hangs forever if the
 * host is not really there.
 *
 * That is not hypothetical. Load `telegram-web-app.js` in an ordinary browser
 * and `window.Telegram.WebApp.CloudStorage` exists and looks perfectly
 * healthy; its callbacks simply never fire. Boot code that awaits one of them
 * then never reaches `/api/auth`, and the app sits on its spinner with no
 * error and no network activity to explain it.
 *
 * The standalone entry point drops the script tag entirely, which is the real
 * fix. This is the belt to that pair of braces: past the deadline, fall back
 * to local storage and get on with it. A stale cached value is a cosmetic
 * problem. A permanent spinner is not.
 */
const CLOUD_TIMEOUT_MS = 1200;

function withDeadline<T>(
  attempt: (resolve: (value: T) => void) => void,
  fallback: () => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(fallback()), CLOUD_TIMEOUT_MS);
    try {
      attempt(finish);
    } catch {
      finish(fallback());
    }
  });
}

export const cloudStorage = {
  async getItem(key: string): Promise<string | null> {
    const local = () => readLocal(`miniapp.cloud.${key}`);
    const store = webApp()?.CloudStorage;
    if (!store) return local();
    return withDeadline<string | null>(
      (done) => store.getItem(key, (err, value) => done(err ? null : value ?? null)),
      local,
    );
  },
  async setItem(key: string, value: string): Promise<void> {
    const local = () => {
      writeLocal(`miniapp.cloud.${key}`, value);
    };
    const store = webApp()?.CloudStorage;
    if (!store) return local();
    return withDeadline<void>((done) => store.setItem(key, value, () => done()), local);
  },
  async removeItem(key: string): Promise<void> {
    const local = () => {
      removeLocal(`miniapp.cloud.${key}`);
    };
    const store = webApp()?.CloudStorage;
    if (!store) return local();
    return withDeadline<void>((done) => store.removeItem(key, () => done()), local);
  },
};

// --- device performance -------------------------------------------------------

/**
 * Parsed from the Android UA suffix Telegram appends:
 * `Telegram-Android/… (…; Android …; SDK …; {LOW|AVERAGE|HIGH})`.
 * Absent on iOS/desktop, where it defaults to HIGH -- those platforms do
 * not ship this signal and are not the ones motion needs to be cut for.
 */
export function performanceClass(): 'LOW' | 'AVERAGE' | 'HIGH' {
  const match = navigator.userAgent.match(/;\s*(LOW|AVERAGE|HIGH)\)/);
  return (match?.[1] as 'LOW' | 'AVERAGE' | 'HIGH') ?? 'HIGH';
}

// --- biometrics (Day 1 plan 5.6) --------------------------------------------

/**
 * Face ID / fingerprint gating app open. Deliberately FAIL-OPEN at every
 * step: this app is the only way to reach an Aside session from a phone,
 * and a gate that gets stuck denying access would lock the owner out of
 * their own tool with no recovery path except uninstalling and losing
 * whatever CloudStorage/SecureStorage state they had. So:
 *
 *  - the SETTING defaults to OFF, not on as the plan first suggested. The
 *    plan's "default on" was written without a live device to verify the
 *    init/request/authenticate sequence actually completes cleanly on
 *    the owner's own client -- shipping an unverified default-on OS auth gate
 *    in front of the only interface to a tool that runs arbitrary code is
 *    the wrong risk to take sight unseen. Opt-in first; default can move
 *    once it's been used for real.
 *  - if the manager is unsupported, not yet inited, or access was never
 *    granted, `authenticateIfEnabled` resolves `true` (pass) rather than
 *    blocking -- an unavailable lock is not a locked door.
 *  - `initBiometrics` only flips `isAccessGranted` on if the user actively
 *    grants it through `requestAccess`; declining leaves the setting
 *    effectively inert rather than retrying on every boot.
 */
export function biometricsSupported(): boolean {
  return Boolean(webApp()?.BiometricManager?.isBiometryAvailable);
}

/** Must resolve before `requestBiometricAccess`/`authenticateBiometrics` can do anything. */
export function initBiometrics(): Promise<void> {
  return new Promise((resolve) => {
    const manager = webApp()?.BiometricManager;
    if (!manager || manager.isInited) {
      resolve();
      return;
    }
    manager.init(() => resolve());
  });
}

export function requestBiometricAccess(reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    const manager = webApp()?.BiometricManager;
    if (!manager?.isBiometryAvailable) {
      resolve(false);
      return;
    }
    manager.requestAccess({ reason }, (granted) => resolve(Boolean(granted)));
  });
}

/**
 * Gate app open. Resolves `true` (proceed) in every case except an
 * explicit, granted, failed authentication attempt -- see the fail-open
 * note above.
 */
export async function authenticateIfEnabled(enabled: boolean, reason: string): Promise<boolean> {
  if (!enabled) return true;
  const manager = webApp()?.BiometricManager;
  if (!manager?.isBiometryAvailable) return true;
  await initBiometrics();
  if (!manager.isAccessGranted) return true;
  return new Promise((resolve) => {
    manager.authenticate({ reason }, (success) => resolve(success !== false));
  });
}
