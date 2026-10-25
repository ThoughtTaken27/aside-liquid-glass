/**
 * The School / Personal switch. One control, two sizes (phone top bar,
 * Mac sidebar). A thumb slides under the chosen side; each side shows how
 * much needs you today, and a clay dot if the side you are NOT looking at
 * has a real deadline today or already past, so separating never hides
 * something urgent.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { NextSpace } from '../types';
import { SPACES, type SpaceSummary } from '../utils/nextSpace';

export function SpaceGlyph({ space, size = 8 }: { space: NextSpace; size?: number }) {
  return <span className={`sp-glyph is-${space}`} style={{ width: size, height: size }} aria-hidden />;
}

export function SpaceSwitch({
  space,
  onChange,
  summary,
  variant = 'phone',
}: {
  space: NextSpace;
  onChange: (s: NextSpace) => void;
  summary?: Partial<Record<NextSpace, SpaceSummary>>;
  variant?: 'phone' | 'desk';
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // The thumb stretches toward a new side only after a real switch, so
  // opening Next never plays it (affectUI Segmented control).
  const [moved, setMoved] = useState(false);
  const pick = (to: NextSpace) => {
    setMoved(true);
    onChange(to);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const to: NextSpace = e.key === 'ArrowLeft' ? 'school' : 'personal';
    if (to !== space) pick(to);
    refs.current[to === 'school' ? 0 : 1]?.focus();
  };
  return (
    <div className={`sp-switch is-${variant}${moved ? ' is-moved' : ''}`} data-space={space} role="tablist" aria-label="School or personal" onKeyDown={onKey}>
      <span className="sp-thumb" aria-hidden />
      {SPACES.map(({ id, label }, i) => {
        const s = summary?.[id];
        const on = id === space;
        const alert = !on && s?.urgent;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'is-on' : ''}
            onClick={() => !on && pick(id)}
            aria-label={`${label}${s ? `, ${s.count} today${alert ? ', has something due' : ''}` : ''}`}
          >
            <SpaceGlyph space={id} />
            <span className="sp-label">{label}</span>
            {s && s.count > 0 ? <span className="sp-count">{s.count}</span> : null}
            {alert ? <span className="sp-alert" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** "Where does this live?" inside add and edit forms. */
export function SpaceChoice({ value, onChange }: { value: NextSpace; onChange: (s: NextSpace) => void }) {
  return (
    <div className="np-chips sp-choice" role="radiogroup" aria-label="School or personal">
      {SPACES.map(({ id, label }) => (
        <button type="button" key={id} role="radio" aria-checked={value === id} className={value === id ? 'is-on' : ''} onClick={() => onChange(id)}>
          <SpaceGlyph space={id} size={7} />
          {label}
        </button>
      ))}
    </div>
  );
}
