/**
 * The Aside critter, as pixel art.
 *
 * Silhouette follows Claude's own pixel crab: boxy clay body, stub arms at
 * mid-height, four short legs, and a darker right-hand column so the body
 * reads lit from the left with a shaded side. Ours adds tall eyes that
 * blink and glance, a rounded top with one highlight pixel, arms that can
 * wave, and a smile that only shows when it is happy.
 *
 * 12 x 9 grid of 1x1 rects (crispEdges), so it scales on whole-pixel
 * steps. Every part is its own group, so CSS/JS animate parts without
 * redrawing.   # body   s shade   h highlight   e eye
 */
import type { ReactElement } from 'react';

const BODY = [
  '...#####s...',
  '..##e##e#s..',
  '..##e##e#s..',
  '..#######s..',
  '..#######s..',
  '..#######s..',
  '..#######s..',
];
/** A pixel U: corners up at the eye columns, two pixels of grin below. */
const MOUTH = ['', '', '', '', '....#..#....', '.....##.....'];
const ARM_L = ['##', '##'];
const ARM_R = ['ss', 'ss'];
/** Frame A: all four feet down. Frame B: second and fourth lifted. */
const LEGS_A = ['..#.#..#.s..', '..#.#..#.s..'];
const LEGS_B = ['..#.#..#.s..', '..#....#....'];

function pixels(rows: string[], x0: number, y0: number, chars: string): ReactElement[] {
  const out: ReactElement[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (chars.includes(row[x])) {
        out.push(<rect key={`${x + x0}-${y + y0}`} x={x + x0} y={y + y0} width={1.02} height={1.02} />);
      }
    }
  });
  return out;
}

export function EmberSprite({
  className,
  prefix,
  width = 36,
}: {
  className?: string;
  /** Class prefix for the parts, e.g. `pull-critter` -> `pull-critter-legs`. */
  prefix: string;
  width?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 9"
      width={width}
      height={(width * 9) / 12}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g className={`${prefix}-arm is-l`}>{pixels(ARM_L, 0, 3, '#')}</g>
      <g className={`${prefix}-arm is-r`}>{pixels(ARM_R, 10, 3, 's')}</g>
      <g className={`${prefix}-body`}>{pixels(BODY, 0, 0, '#e')}</g>
      <g className={`${prefix}-shade`}>{pixels(BODY, 0, 0, 's')}</g>
      <g className={`${prefix}-hi`}>{pixels(BODY, 0, 0, 'h')}</g>
      <g className={`${prefix}-mouth`}>{pixels(MOUTH, 0, 0, '#')}</g>
      <g className={`${prefix}-eyes`}>{pixels(BODY, 0, 0, 'e')}</g>
      <g className={`${prefix}-legs is-a`}>
        <g className={`${prefix}-leg-fill`}>{pixels(LEGS_A, 0, 7, '#')}</g>
        <g className={`${prefix}-leg-shade`}>{pixels(LEGS_A, 0, 7, 's')}</g>
      </g>
      <g className={`${prefix}-legs is-b`}>
        <g className={`${prefix}-leg-fill`}>{pixels(LEGS_B, 0, 7, '#')}</g>
        <g className={`${prefix}-leg-shade`}>{pixels(LEGS_B, 0, 7, 's')}</g>
      </g>
    </svg>
  );
}
