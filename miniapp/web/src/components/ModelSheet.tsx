/**
 * Model and reasoning, in one sheet.
 *
 * This replaces the anchored popover, and it takes reasoning with it. The
 * old arrangement put a model pill AND an effort pill in the composer's
 * action row, which on a 390px phone left the model about 85px -- enough
 * for "DeepSee…", which names nothing. Claude's own app solves it by
 * nesting Effort inside the model sheet as a row, so the composer carries
 * a single pill. That is the shape here: one pill, one sheet, reasoning a
 * tap deeper.
 *
 * Four views, one component, because they are one decision. `back` is
 * always to the model list rather than a history stack: there is nowhere
 * else to come from.
 */
import { useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { SlideToConfirm } from './SlideToConfirm';
import { toast } from './Toasts';
import {
  Check,
  ChevronRight,
  PermissionGlyph,
  ProviderMark,
  Search,
  Settings,
} from './Icons';
import type { CatalogProvider } from '../types';

/** `220000` -> `220k`, `1000000` -> `1M`. */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M context`;
  }
  return `${Math.round(tokens / 1000)}k context`;
}

export interface ModelSheetProps {
  catalog: CatalogProvider[];
  currentProvider: string;
  currentModel: string;
  effortOptions: Array<{ id: string; label: string }>;
  currentEffort: string;
  /**
   * Permission moved in here from its own button on the composer row.
   *
   * It belongs with these: the model, the reasoning level and the
   * permission mode are the three settings that describe how the next turn
   * will run, and they were spread across a sheet, a sub-view and a badge.
   * One sheet, three rows.
   */
  permissionOptions: Array<{ id: string; label: string }>;
  permissionMode: string | null;
  finalConfirm: boolean | null;
  softConfirm?: boolean;
  onPickMode: (id: string) => void;
  onToggleConfirm: (next: boolean) => void;
  onPickModel: (provider: string, modelId: string) => void;
  onPickEffort: (id: string) => void;
  onOpenSettings?: () => void;
  onClose: () => void;
}

type View = 'models' | 'effort' | 'providers' | 'permission';

/** One tappable row in a grouped card. */
function Row({
  title,
  subtitle,
  leading,
  trailing,
  selected,
  onClick,
}: {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sheet-row surface-row ${selected ? 'is-selected' : ''}`}
      data-surface-row="option"
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
    >
      {leading ? <span className="sheet-row-glyph">{leading}</span> : null}
      <span className="sheet-row-text">
        <span className="sheet-row-title">{title}</span>
        {subtitle ? (
          <span
            className="sheet-row-subtitle surface-meta"
            data-surface-meta="subtitle"
          >
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="sheet-row-trailing">{trailing}</span> : null}
    </button>
  );
}

export function ModelSheet({
  catalog,
  currentProvider,
  currentModel,
  effortOptions,
  currentEffort,
  permissionOptions,
  permissionMode,
  finalConfirm,
  softConfirm,
  onPickMode,
  onToggleConfirm,
  onPickModel,
  onPickEffort,
  onOpenSettings,
  onClose,
}: ModelSheetProps) {
  const [view, setView] = useState<View>('models');
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /*
   * The mode waiting on its slide. Full access is the one setting in
   * this sheet that removes a guardrail instead of moving one, so it is
   * the one that asks for a gesture with commitment in it (bencho's
   * slide-to-confirm) rather than a tap that could be a mis-tap.
   */
  const [slideFor, setSlideFor] = useState<string | null>(null);

  const active =
    catalog.find((p) => p.id === currentProvider) || catalog[0] || null;

  /**
   * Search flattens every provider into one list.
   *
   * Without it you would have to already know which provider owns a model
   * to find it, which is the thing a search is for.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: Array<{ provider: CatalogProvider; id: string; label: string; ctx: number }> = [];
    for (const provider of catalog) {
      for (const model of provider.models) {
        const hay = `${provider.label} ${model.label} ${model.id}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({
            provider,
            id: model.id,
            label: model.label,
            ctx: model.contextWindow,
          });
        }
      }
    }
    return out;
  }, [catalog, query]);

  // Picking a model or an effort level no longer closes the sheet. The owner
  // wants to set both in one visit (model, then reasoning) without
  // reopening it, so the sheet now only closes on an explicit dismissal:
  // backdrop tap, the X button, or Escape.
  // A disconnected provider's models stay visible -- hiding a working
  // model is worse than showing one that needs connecting -- but picking
  // one is refused with directions: the Mac has no credentials for it, so
  // the pick could never run.
  const choose = (provider: string, modelId: string) => {
    const entry = catalog.find((p) => p.id === provider);
    if (entry?.connected === false) {
      toast(`Connect ${entry.label} on your Mac to use this model`);
      return;
    }
    onPickModel(provider, modelId);
  };

  const effortLabel =
    effortOptions.find((o) => o.id === currentEffort)?.label || currentEffort;

  /*
   * A null mode means the daemon could not be read. It says so rather than
   * naming a plausible default -- printing "Guard" here would claim the
   * agent is sandboxed when it may be on full access, which is the one
   * wrong answer this row can give.
   */
  const permissionLabel = permissionMode
    ? permissionOptions.find((o) => o.id === permissionMode)?.label ||
      permissionMode
    : 'Unknown';

  // --- reasoning -----------------------------------------------------
  if (view === 'effort') {
    return (
      <Sheet
        side="bottom"
        title="Reasoning"
        onBack={() => setView('models')}
        backLabel="model"
        onClose={onClose}
      >
        <div
          className="sheet-group surface-group"
          data-surface-group="list"
          data-separator="inset"
        >
          {effortOptions.map((option) => (
            <Row
              key={option.id}
              title={option.label}
              selected={option.id === currentEffort}
              trailing={
                option.id === currentEffort ? <Check size={17} /> : null
              }
              onClick={() => {
                onPickEffort(option.id);
                setView('models');
              }}
            />
          ))}
        </div>
      </Sheet>
    );
  }

  const pickMode = (id: string) => {
    onPickMode(id);
    setSlideFor(null);
    setView('models');
  };

  // --- permission ----------------------------------------------------
  if (view === 'permission') {
    return (
      <Sheet
        side="bottom"
        title="Permission"
        onBack={() => {
          setSlideFor(null);
          setView('models');
        }}
        backLabel="model"
        onClose={onClose}
      >
        <div
          className="sheet-group surface-group"
          data-surface-group="list"
          data-separator="inset"
        >
          {permissionOptions.map((option) => (
            <Row
              key={option.id}
              title={option.label}
              leading={<PermissionGlyph mode={option.id} size={16} />}
              selected={option.id === permissionMode}
              trailing={
                option.id === permissionMode ? <Check size={17} /> : null
              }
              onClick={() => {
                // Full access earns its slide; everything else picks on
                // tap exactly as before.
                if (
                  option.id === 'full-access' &&
                  option.id !== permissionMode
                ) {
                  setSlideFor(option.id);
                  return;
                }
                pickMode(option.id);
              }}
            />
          ))}
        </div>

        {slideFor ? (
          <div className="permission-slide">
            <p className="sheet-note surface-meta" data-surface-meta="note">
              Full access lets the agent work without asking first. Only for
              machines you trust.
            </p>
            <SlideToConfirm
              label="Slide to allow full access"
              onConfirm={() => pickMode(slideFor)}
            />
            <button
              type="button"
              className="permission-slide-cancel"
              onClick={() => setSlideFor(null)}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {/*
          The switch does not navigate back the way the mode rows do. Modes
          are a choice and dismissing on pick is the reward for making it;
          a toggle is something you may want to watch settle, and a sheet
          that closes itself under a switch reads as an error.
        */}
        <div
          className="sheet-group surface-group"
          data-surface-group="controls"
          data-separator="inset"
        >
          <div className="sheet-row surface-row is-static" data-surface-row="control">
            <span className="sheet-row-text">
              <span className="sheet-row-title">Confirm before acting</span>
              <span
                className="sheet-row-subtitle surface-meta"
                data-surface-meta="description"
              >
                {softConfirm
                  ? 'Aside checks in before consequential steps'
                  : 'Aside asks this device to confirm'}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={finalConfirm === true}
              aria-label="Confirm before acting"
              className={`switch ${finalConfirm ? 'is-on' : ''}`}
              onClick={() => onToggleConfirm(!finalConfirm)}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>

        {/*
          Not decoration: the setting is read when the next `aside exec` is
          spawned, so a change binds from the next message and cannot reach
          into a turn already running. Cheaper to say than to discover.
        */}
        <p className="sheet-note surface-meta" data-surface-meta="note">
          Applies from your next message.
        </p>
      </Sheet>
    );
  }

  // --- every provider ------------------------------------------------
  if (view === 'providers') {
    const drilled = browsing
      ? catalog.find((p) => p.id === browsing) || null
      : null;

    return (
      <Sheet
        side="bottom"
        title={drilled ? drilled.label : 'More models'}
        onBack={() => (drilled ? setBrowsing(null) : setView('models'))}
        backLabel={drilled ? 'all providers' : 'model'}
        onClose={onClose}
      >

        {drilled ? (
          <>
            {drilled.connected === false ? (
              <p
                className="sheet-note surface-meta"
                data-surface-meta="note"
              >
                Not connected — connect {drilled.label} on your Mac to use
                these models.
              </p>
            ) : null}
            <div
              className="sheet-group surface-group"
              data-surface-group="list"
              data-separator="inset"
            >
              {drilled.models.map((model) => (
              <Row
                key={model.id}
                title={model.label}
                subtitle={formatContext(model.contextWindow)}
                selected={
                  drilled.id === currentProvider && model.id === currentModel
                }
                trailing={
                  drilled.id === currentProvider && model.id === currentModel ? (
                    <Check size={17} />
                  ) : null
                }
                onClick={() => choose(drilled.id, model.id)}
              />
            ))}
            {drilled.models.length === 0 ? (
              <p className="sheet-empty">No models configured</p>
            ) : null}
            </div>
          </>
        ) : (
          <>
            <label className="sheet-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            {matches ? (
              <div
                className="sheet-group surface-group"
                data-surface-group="list"
                data-separator="inset"
              >
                {matches.map((match) => (
                  <Row
                    key={`${match.provider.id}/${match.id}`}
                    title={match.label}
                    subtitle={`${match.provider.label} · ${formatContext(match.ctx)}${match.provider.connected === false ? ' · Not connected' : ''}`}
                    leading={<ProviderMark id={match.provider.id} size={17} />}
                    selected={
                      match.provider.id === currentProvider &&
                      match.id === currentModel
                    }
                    trailing={
                      match.provider.id === currentProvider &&
                      match.id === currentModel ? (
                        <Check size={17} />
                      ) : null
                    }
                    onClick={() => choose(match.provider.id, match.id)}
                  />
                ))}
                {matches.length === 0 ? (
                  <p className="sheet-empty">No matches</p>
                ) : null}
              </div>
            ) : (
              <div
                className="sheet-group surface-group"
                data-surface-group="providers"
                data-separator="inset"
              >
                {catalog.map((provider) => (
                  <Row
                    key={provider.id}
                    title={provider.label}
                    subtitle={`${provider.models.length} model${
                      provider.models.length === 1 ? '' : 's'
                    }${provider.connected === false ? ' · Not connected' : ''}`}
                    leading={<ProviderMark id={provider.id} size={17} />}
                    selected={provider.id === currentProvider}
                    trailing={<ChevronRight size={16} />}
                    onClick={() => setBrowsing(provider.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Sheet>
    );
  }

  // --- the default view: this provider's models, then reasoning ------
  return (
    <Sheet side="bottom" title="Select model" onClose={onClose}>
      <div
        className="sheet-group surface-group"
        data-surface-group="models"
        data-separator="inset"
      >
        {(active?.models ?? []).map((model) => (
          <Row
            key={model.id}
            title={model.label}
            subtitle={formatContext(model.contextWindow)}
            selected={
              active?.id === currentProvider && model.id === currentModel
            }
            trailing={
              active?.id === currentProvider && model.id === currentModel ? (
                <Check size={17} />
              ) : null
            }
            onClick={() => choose(active!.id, model.id)}
          />
        ))}
        {!active || active.models.length === 0 ? (
          <p className="sheet-empty">No models configured</p>
        ) : null}
      </div>

      <div
        className="sheet-group surface-group"
        data-surface-group="settings"
        data-separator="inset"
      >
        <Row
          title="Reasoning"
          subtitle={effortLabel}
          leading={<span className="sheet-dot-glyph" aria-hidden />}
          trailing={<ChevronRight size={16} />}
          onClick={() => setView('effort')}
        />
        <Row
          title="Permission"
          subtitle={permissionLabel}
          leading={<PermissionGlyph mode={permissionMode || 'guard'} size={16} />}
          trailing={<ChevronRight size={16} />}
          onClick={() => setView('permission')}
        />
        <Row
          title="More models"
          subtitle={`${catalog.length} provider${catalog.length === 1 ? '' : 's'}`}
          leading={<span className="sheet-dots-glyph" aria-hidden />}
          trailing={<ChevronRight size={16} />}
          onClick={() => {
            setBrowsing(null);
            setQuery('');
            setView('providers');
          }}
        />
        {onOpenSettings ? (
          <Row
            title="Settings"
            leading={<Settings size={16} />}
            trailing={<ChevronRight size={16} />}
            onClick={onOpenSettings}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
