/**
 * What the model and effort pills should read.
 *
 * The precedence is the whole of it: an explicit local pick wins, and
 * otherwise the pills mirror the DAEMON's own account default (from
 * `/api/status`, which reads `aside.settings.getAll().defaultModel`) rather
 * than anything from the bridge config. A user who has never chosen should
 * see what the browser would use.
 *
 * Extracted from App so it can be tested directly. It also had a real bug
 * that only a direct test would have caught: the label started at the
 * daemon default's label and was only overwritten when the picked model was
 * found in the catalog -- so an explicit pick of a model the catalog does
 * not list displayed the DAEMON's model name while actually running the
 * picked one. The pill has to name the model that will run, or it is worse
 * than no pill.
 */
import type { CatalogProvider, StatusResponse } from '../types';

export interface PillState {
  provider: string;
  modelId: string;
  modelLabel: string;
  effortId: string;
  effortLabel: string;
  /**
   * Why the stored model pick is not the one running, when it isn't.
   * `removed` = the Mac no longer lists it; `disconnected` = its provider
   * has no credentials right now. Either way the pills show the daemon
   * default instead, and the stored pick resumes on its own if it ever
   * becomes valid again -- self-healing in both directions, with no wipe.
   */
  modelDegraded: 'removed' | 'disconnected' | null;
  /** The stored effort pick is not on the Mac's menu; the default runs. */
  effortDegraded: boolean;
}

export interface LocalPick {
  provider: string;
  modelId: string;
  effort: string;
}

/** The catalog's display name for a model, or '' when it lists no such one. */
export function catalogLabel(
  catalog: CatalogProvider[] | undefined,
  provider: string,
  modelId: string,
): string {
  if (!catalog || !provider || !modelId) return '';
  for (const entry of catalog) {
    if (entry.id !== provider) continue;
    const found = entry.models.find((m) => m.id === modelId);
    if (found) return found.label;
  }
  return '';
}

/**
 * Where a stored pick stands against the live catalog.
 *
 * `ok` covers "nothing stored" as well as a good pick: with no pick there
 * is nothing to degrade. Anything else means the pick must not run -- the
 * pills fall back to the daemon default while the stored pick waits for
 * the Mac to offer it again.
 */
export function pickStanding(
  catalog: CatalogProvider[] | undefined,
  provider: string,
  modelId: string,
): 'ok' | 'removed' | 'disconnected' {
  if (!provider || !modelId) return 'ok';
  const entry = catalog?.find((p) => p.id === provider);
  if (!entry || !entry.models.some((m) => m.id === modelId)) return 'removed';
  if (entry.connected === false) return 'disconnected';
  return 'ok';
}

export function resolvePills(
  status: StatusResponse | null,
  pick: LocalPick,
): PillState {
  const defaults = status?.defaults;

  // A pick the live catalog cannot honor stops running but stays stored:
  // deleting it on a transient status glitch would be un-healable, while
  // falling back resumes the pick the moment the Mac offers it again.
  // Before the first status there is nothing to validate against, so the
  // stored pick runs unmarked rather than flickering through a fallback.
  const hasModelPick = Boolean(pick.modelId);
  const standing =
    status && hasModelPick
      ? pickStanding(status.catalog, pick.provider, pick.modelId)
      : 'ok';
  const usePick = hasModelPick && (!status || standing === 'ok');
  const provider = usePick ? pick.provider : defaults?.provider || '';
  const modelId = usePick ? pick.modelId : defaults?.modelId || '';

  // With a pick, the label must describe the PICKED model: the catalog's
  // name for it, else its bare id. Falling back to the daemon's label here
  // is what made the pill lie.
  const modelLabel = usePick
    ? catalogLabel(status?.catalog, provider, modelId) || modelId || 'Model'
    : catalogLabel(status?.catalog, provider, modelId) ||
      defaults?.modelLabel ||
      modelId ||
      'Model';
  const modelDegraded =
    hasModelPick && status && standing !== 'ok' ? standing : null;

  // Same treatment for reasoning: a level the Mac's menu does not carry
  // falls back to the daemon's instead of sending an id nothing honors
  // (which also used to render as a blank pill).
  const menu = status?.effortMenu;
  const effortValid =
    !pick.effort || !menu || menu.length === 0 || menu.some((e) => e.id === pick.effort);
  const useEffortPick = Boolean(pick.effort) && effortValid;
  const effortId = useEffortPick ? pick.effort : defaults?.effort || 'high';
  const effortLabel =
    status?.effortMenu?.find((e) => e.id === effortId)?.label ||
    (!useEffortPick ? defaults?.effortLabel : '') ||
    effortId;
  const effortDegraded = Boolean(pick.effort) && status != null && !effortValid;

  return {
    provider,
    modelId,
    modelLabel,
    effortId,
    effortLabel,
    modelDegraded,
    effortDegraded,
  };
}

/**
 * The model name as the composer pill should show it.
 *
 * The pill lives in the tightest row in the app -- three round buttons and
 * two pills inside a 336px card -- and a catalog label like
 * "DeepSeek V4 Flash (Free)" needs about 165px of the ~200px the two pills
 * share. The result was a pill reading "DeepSee…", which names nothing.
 *
 * A trailing parenthetical is the part worth losing: "(Free)", "(Max)",
 * "(Nvidia)" qualify a model, they do not identify it, and the full label
 * is still shown in the picker one tap away. Everything else is left
 * alone, and CSS ellipsis remains the backstop for genuinely long ids.
 */
export function pillModelLabel(label: string): string {
  const trimmed = String(label || '').trim();
  const withoutSuffix = trimmed.replace(/\s*\([^()]*\)\s*$/, '').trim();
  // Never return an empty pill: a label that is ONLY a parenthetical keeps
  // whatever it had.
  return withoutSuffix || trimmed;
}

/**
 * The reasoning level as the composer pill should show it.
 *
 * The pill shares one 336px row with the attach button, the permission
 * badge, the model pill and send. Aside's own effort names run to
 * "Extra High" and "Ultrabrowse", and at full length either one pushes the
 * model pill down to an ellipsis that names nothing.
 *
 * These abbreviations are short enough to fit and long enough to stay
 * unambiguous -- no two levels share a prefix here -- and the full name is
 * still what the picker shows.
 */
const EFFORT_SHORT: Record<string, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  'extra high': 'XHigh',
  xhigh: 'XHigh',
  max: 'Max',
  ultrabrowse: 'Ultra',
};

export function pillEffortLabel(label: string): string {
  const trimmed = String(label || '').trim();
  return EFFORT_SHORT[trimmed.toLowerCase()] ?? trimmed;
}
