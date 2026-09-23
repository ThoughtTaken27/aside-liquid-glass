/**
 * Settings.
 *
 * The Settings row in the model picker used to close the popover and do
 * nothing at all. This is the screen it should have opened.
 *
 * Structure follows Aside's own settings pages (`settings-*.js`,
 * `use-agent-settings-*.js`, `ai-*.js`): sections with a small uppercase
 * heading, rows carrying a title and a description on the left and the
 * control on the right, hairline dividers between them, and a footnote
 * where a setting's scope needs stating.
 *
 * Scope, stated once here and enforced on the server: everything writable
 * on this screen is a default for sessions THIS APP creates, stored in the
 * mini app's own file. Nothing here writes Aside's account-wide settings --
 * a default changed from a phone must not silently retarget the sessions
 * the owner starts on their computer. Aside's own values are shown, and
 * shown as read-only.
 */
import { useEffect, useState } from 'react';
import { AsideSymbol, Check, ChevronLeft, ProviderMark, Spinner } from './Icons';
import { MemoryBrowser } from './MemoryBrowser';
import { RoutinesList } from './RoutinesList';
import { api } from '../api';
import {
  applyTheme,
  biometricsSupported,
  cloudStorage,
  haptic,
  readThemeOverride,
  requestBiometricAccess,
  setThemeOverride,
} from '../telegram';
import type { ThemeOverride } from '../telegram';
import { playSound, setSoundsEnabled, soundsEnabled } from '../utils/sounds';
import type { MiniappSettings, StatusResponse } from '../types';

const BIOMETRICS_KEY = 'biometricsEnabled';

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section
      className="settings-section surface-section"
      data-surface-section="settings"
    >
      <h2 className="settings-heading" data-surface-heading>
        {title}
      </h2>
      <div
        className="settings-rows surface-group"
        data-surface-group="settings"
        data-separator="inset"
      >
        {children}
      </div>
      {note ? (
        <p className="settings-note surface-meta" data-surface-meta="note">
          {note}
        </p>
      ) : null}
    </section>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="settings-row surface-row" data-surface-row="setting">
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description ? (
          <span className="settings-row-description surface-meta" data-surface-meta="description">
            {description}
          </span>
        ) : null}
      </span>
      <span className="settings-row-control">{control}</span>
    </div>
  );
}

/** A row that expands into a list of choices, with a tick on the live one. */
function ChoiceRow({
  title,
  description,
  value,
  options,
  onPick,
}: {
  title: string;
  description?: string;
  value: string;
  options: Array<{ id: string; label: string; leading?: React.ReactNode }>;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.id === value);

  return (
    <>
      <button
        type="button"
        className="settings-row surface-row is-button"
        data-surface-row="choice"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        <span className="settings-row-text">
          <span className="settings-row-title">{title}</span>
          {description ? (
            <span className="settings-row-description surface-meta" data-surface-meta="description">
              {description}
            </span>
          ) : null}
        </span>
        <span className="settings-row-value">
          {current?.leading}
          {current?.label ?? 'Aside’s default'}
        </span>
      </button>
      {open ? (
        <div
          className="settings-choices surface-group"
          data-surface-group="choices"
          data-separator="inset"
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`settings-choice surface-row ${option.id === value ? 'is-current' : ''}`}
              data-surface-row="choice-option"
              data-selected={option.id === value ? 'true' : undefined}
              onClick={() => {
                haptic('light');
                onPick(option.id);
                setOpen(false);
              }}
            >
              {option.leading}
              <span className="settings-choice-label">{option.label}</span>
              {option.id === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => {
        haptic('light');
        onChange(!checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function SettingsScreen({
  status,
  onClose,
}: {
  status: StatusResponse | null;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<MiniappSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Memory and Routines are destinations reached FROM Settings, not new
   * top-level screens -- App.tsx does not need to know about either. Each
   * swaps this screen's own rendered content, exactly like Settings itself
   * swaps App.tsx's, and each one's own back button returns here.
   */
  const [subScreen, setSubScreen] = useState<'none' | 'memory' | 'routines'>(
    'none',
  );

  const [biometricsOn, setBiometricsOn] = useState(false);

  // Theme and UI sounds are the only settings on this screen that live
  // on the device rather than on the server -- both are about THIS
  // screen on THIS phone, not about sessions the daemon will spawn.
  const [theme, setTheme] = useState<ThemeOverride>(() => readThemeOverride());
  const [soundsOn, setSoundsOn] = useState(() => soundsEnabled());
  useEffect(() => {
    cloudStorage.getItem(BIOMETRICS_KEY).then((value) => setBiometricsOn(value === '1'));
  }, []);

  /**
   * Turning this ON requires actually granting access first -- flipping
   * the switch without a granted access would silently do nothing at the
   * next boot (see `authenticateIfEnabled`'s fail-open contract in
   * telegram.ts), which reads as a broken toggle rather than an honest
   * one. Turning OFF has no such requirement.
   */
  /*
   * A manual theme lands with a circle reveal from the tap point
   * (the view-transition theme flip from the inspiration trawl).
   * Plain applyTheme underneath when transitions or motion are off.
   */
  const pickTheme = (
    event: { clientX: number; clientY: number },
    next: ThemeOverride,
  ) => {
    if (next === theme) return;
    haptic('light');
    setThemeOverride(next);
    setTheme(next);
    const doc = document as Document & {
      startViewTransition?: (update: () => void) => void;
    };
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    // A keyboard pick has no tap point (0,0 is the corner, not the
    // control), so it lands plainly like the reduced-motion path.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    if (doc.startViewTransition && !reduceMotion && !fromKeyboard) {
      const root = document.documentElement;
      root.style.setProperty('--reveal-x', event.clientX + 'px');
      root.style.setProperty('--reveal-y', event.clientY + 'px');
      doc.startViewTransition(() => {
        applyTheme();
      });
    } else {
      applyTheme();
    }
  };

  /*
   * No haptic here: the shared `Switch` already taps on every flip, and
   * two in a row reads as a stutter.
   */
  const toggleSounds = (next: boolean) => {
    setSoundsEnabled(next);
    setSoundsOn(next);
    if (next) playSound('toggle');
  };

  const toggleBiometrics = async (next: boolean) => {
    haptic('light');
    if (!next) {
      setBiometricsOn(false);
      void cloudStorage.setItem(BIOMETRICS_KEY, '0');
      return;
    }
    const granted = await requestBiometricAccess(
      'Confirm it\u2019s you before opening Aside',
    );
    setBiometricsOn(granted);
    void cloudStorage.setItem(BIOMETRICS_KEY, granted ? '1' : '0');
  };

  useEffect(() => {
    let alive = true;
    api.settings().then(
      (res) => alive && setSettings(res.settings),
      (err) => alive && setError((err as Error).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Optimistic, then corrected by what the server stored.
   *
   * The same shape the permission control already uses: the row moves on
   * tap, and a failed write puts the server's truth back rather than
   * leaving a claim on screen we cannot stand behind.
   */
  const save = (patch: Partial<MiniappSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    api.saveSettings(patch).then(
      (res) => setSettings(res.settings),
      () => {
        api.settings().then(
          (res) => setSettings(res.settings),
          () => {},
        );
      },
    );
  };

  const modelOptions = [
    { id: '', label: 'Aside’s default' },
    ...(status?.catalog ?? []).flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        label: `${provider.label} · ${model.label}`,
        leading: <ProviderMark id={provider.id} size={14} />,
      })),
    ),
  ];

  const effortOptions = [
    { id: '', label: 'Server default' },
    ...(status?.effortMenu ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    })),
  ];

  const permissionOptions = [
    { id: '', label: 'Leave Aside’s default' },
    ...(status?.permissionMenu ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    })),
  ];

  const service = status?.service;

  if (subScreen === 'memory') {
    return <MemoryBrowser onClose={() => setSubScreen('none')} />;
  }
  if (subScreen === 'routines') {
    return <RoutinesList onClose={() => setSubScreen('none')} />;
  }

  return (
    <div
      className="app settings-screen destination-surface"
      data-surface="destination"
      data-destination="settings"
    >
      <header className="thread-header surface-header" data-surface-header>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">Settings</span>
        </span>
        <span className="settings-brand">
          <AsideSymbol size={18} />
        </span>
      </header>

      <div className="settings-scroll surface-content" data-surface-content>
        {error ? <p className="list-empty">{error}</p> : null}
        {!settings && !error ? (
          <p className="list-empty">
            <Spinner size={14} /> Loading…
          </p>
        ) : null}

        {settings ? (
          <>
            <Section
              title="New sessions"
              note="These apply to sessions you start from this app. They do not change Aside’s own settings on your computer."
            >
              <ChoiceRow
                title="Model"
                description="What a new session runs on."
                value={
                  settings.defaultProvider && settings.defaultModelId
                    ? `${settings.defaultProvider}/${settings.defaultModelId}`
                    : ''
                }
                options={modelOptions}
                onPick={(id) => {
                  const slash = id.indexOf('/');
                  save(
                    slash === -1
                      ? { defaultProvider: '', defaultModelId: '' }
                      : {
                          defaultProvider: id.slice(0, slash),
                          defaultModelId: id.slice(slash + 1),
                        },
                  );
                }}
              />
              <ChoiceRow
                title="Reasoning"
                description="How hard a new session thinks before answering."
                value={settings.defaultEffort}
                options={effortOptions}
                onPick={(id) => save({ defaultEffort: id })}
              />
              <ChoiceRow
                title="Permission"
                description="What a new session is allowed to do."
                value={settings.defaultPermissionMode ?? ''}
                options={permissionOptions}
                onPick={(id) =>
                  save({ defaultPermissionMode: id ? id : null })
                }
              />
              {/*
                Not the daemon's `finalConfirm`. That one mandates the
                native confirmation tool, which can only be answered from
                Aside on the desktop -- so on a session started here it
                guarantees a thread that dies at the first external action.
                This asks on a card the phone can answer instead.
              */}
              <Row
                title="Confirm before acting"
                description="A new session asks here, on a card you can answer, before anything external or irreversible."
                control={
                  <Switch
                    checked={settings.defaultFinalConfirm === true}
                    label="Confirm before acting by default"
                    onChange={(next) => save({ defaultFinalConfirm: next })}
                  />
                }
              />
            </Section>

            <Section
              title="Aside account"
              note="Read-only here. Change these in Aside on your computer."
            >
              <Row
                title="Account default model"
                description="What Aside itself uses when nothing overrides it."
                control={
                  <span className="settings-readout">
                    {status?.defaults.modelLabel || '—'}
                  </span>
                }
              />
              <Row
                title="Account reasoning"
                control={
                  <span className="settings-readout">
                    {status?.defaults.effortLabel || '—'}
                  </span>
                }
              />
            </Section>

            {biometricsSupported() ? (
              <Section
                title="Privacy"
                note="Off by default. This app runs commands on your computer, so it's worth the extra tap."
              >
                <Row
                  title="Require Face ID / Touch ID"
                  description="Confirm it's you before Aside opens."
                  control={
                    <Switch
                      checked={biometricsOn}
                      label="Require Face ID to open"
                      onChange={(next) => void toggleBiometrics(next)}
                    />
                  }
                />
              </Section>
            ) : null}

            <Section title="Aside on your phone">
              <button
                type="button"
                className="settings-row is-button"
                onClick={() => {
                  haptic('light');
                  setSubScreen('memory');
                }}
              >
                <span className="settings-row-text">
                  <span className="settings-row-title">Memory</span>
                  <span className="settings-row-description">
                    Browse the account memory pages Aside itself keeps.
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="settings-row is-button"
                onClick={() => {
                  haptic('light');
                  setSubScreen('routines');
                }}
              >
                <span className="settings-row-text">
                  <span className="settings-row-title">Routines</span>
                  <span className="settings-row-description">
                    See scheduled routines. Read-only from here.
                  </span>
                </span>
              </button>
            </Section>

            <Section title="Appearance">
              <Row
                title="Theme"
                description={
                  theme === 'auto'
                    ? "Follows Telegram\u2019s own light or dark setting."
                    : theme === 'light'
                      ? 'Always light, whatever the client says.'
                      : 'Always dark, whatever the client says.'
                }
                control={
                  <span
                    className="settings-segmented"
                    role="radiogroup"
                    aria-label="Theme"
                  >
                    {(
                      [
                        { id: 'auto', label: 'Auto' },
                        { id: 'light', label: 'Light' },
                        { id: 'dark', label: 'Dark' },
                      ] as Array<{ id: ThemeOverride; label: string }>
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={theme === option.id}
                        className={
                          'settings-segment' +
                          (theme === option.id ? ' is-on' : '')
                        }
                        onClick={(event) => pickTheme(event, option.id)}
                        onKeyDown={(event) => {
                          if (
                            event.key !== 'ArrowRight' &&
                            event.key !== 'ArrowLeft'
                          ) {
                            return;
                          }
                          event.preventDefault();
                          const order: ThemeOverride[] = [
                            'auto',
                            'light',
                            'dark',
                          ];
                          const at = order.indexOf(option.id);
                          const next =
                            order[
                              (at +
                                (event.key === 'ArrowRight'
                                  ? 1
                                  : order.length - 1)) %
                                order.length
                            ];
                          pickTheme({ clientX: 0, clientY: 0 }, next);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </span>
                }
              />
              <Row
                title="Interface sounds"
                description="Quiet taps and chimes for sends, arrivals and switches. Off unless you ask."
                control={
                  <Switch
                    checked={soundsOn}
                    label="Interface sounds"
                    onChange={toggleSounds}
                  />
                }
              />
            </Section>

            <Section title="Connection">
              <Row
                title="Aside daemon"
                control={
                  <span
                    className={`settings-readout ${
                      service?.asideReachable ? 'is-ok' : 'is-bad'
                    }`}
                  >
                    {service?.asideReachable ? 'Reachable' : 'Unreachable'}
                  </span>
                }
              />
              <Row
                title="Telegram bridge"
                description="The Python bridge that handles plain chat messages."
                control={
                  <span className="settings-readout">
                    {service?.bridgeConfigured ? 'Configured' : 'Not found'}
                  </span>
                }
              />
              <Row
                title="Tunnel"
                description={
                  service?.tunnelUrl || (
                    service?.tunnel === 'cloudflared'
                      ? 'Starting…'
                      : 'Serving on the local network only.'
                  ) as string
                }
                control={
                  <span className="settings-readout">
                    {service?.tunnel === 'cloudflared' ? 'cloudflared' : 'Off'}
                  </span>
                }
              />
              <Row
                title="Mini app version"
                control={
                  <span className="settings-readout">
                    {service?.version || '—'}
                  </span>
                }
              />
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}
