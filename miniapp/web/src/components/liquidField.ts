/**
 * Flow-field reconstruction validated against the public Liquid Headline demo.
 * Evidence: https://useplanes.com/components/liquid-headline (2026-10-21).
 * The UI/lifecycle code is local; no Planes package or gated registry is used.
 */
export const LIQUID_VERTEX = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

export const LIQUID_FRAGMENT = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform vec2 u_mouse;
uniform float u_crease;
uniform vec2 u_zoom;
uniform float u_speed;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform sampler2D u_mask;
uniform float u_useMask;

vec2 latticeGradient(vec2 cell) {
  vec2 projected = vec2(dot(cell, vec2(127.1, 311.7)), dot(cell, vec2(269.5, 183.3)));
  return fract(sin(projected) * 43758.5453) - 0.5;
}
float gradientNoise(vec2 position) {
  vec2 cell = floor(position);
  vec2 local = fract(position);
  vec2 blend = local * local * (3.0 - 2.0 * local);
  float lowerLeft = dot(latticeGradient(cell), local);
  float lowerRight = dot(latticeGradient(cell + vec2(1.0, 0.0)), local - vec2(1.0, 0.0));
  float upperLeft = dot(latticeGradient(cell + vec2(0.0, 1.0)), local - vec2(0.0, 1.0));
  float upperRight = dot(latticeGradient(cell + vec2(1.0, 1.0)), local - vec2(1.0, 1.0));
  return mix(mix(lowerLeft, lowerRight, blend.x), mix(upperLeft, upperRight, blend.x), blend.y) * 2.0;
}
float layeredNoise(vec2 position) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * gradientNoise(position);
    position = position * 2.02 + 7.3;
    amplitude *= 0.5;
  }
  return value;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 position = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 1.6 * u_zoom + u_seed;
  vec2 pointerOffset = uv - u_mouse;
  position += 0.35 * pointerOffset * exp(-4.0 * dot(pointerOffset, pointerOffset));
  float phase = u_time * 0.12 * u_speed;
  vec2 firstWarp = vec2(
    layeredNoise(position + phase),
    layeredNoise(position + vec2(3.1, 1.7) - phase)
  );
  vec2 secondWarp = vec2(
    layeredNoise(position + 2.4 * firstWarp + vec2(1.7, 9.2) + 0.3 * phase),
    layeredNoise(position + 2.4 * firstWarp + vec2(8.3, 2.8) - 0.2 * phase)
  );
  float fold = layeredNoise(position + 2.2 * secondWarp);
  float ramp = smoothstep(-0.35, 0.55, fold + 0.35 * uv.y - 0.15);
  vec3 color = mix(u_c0, u_c1, smoothstep(0.0, 0.55, ramp));
  color = mix(color, u_c2, smoothstep(0.55, 1.0, ramp));
  color *= 1.0 - 0.55 * u_crease * smoothstep(0.04, 0.0, abs(fold + 0.1));
  float coverage = u_useMask > 0.5 ? texture2D(u_mask, vec2(uv.x, 1.0 - uv.y)).a : 1.0;
  gl_FragColor = vec4(color * coverage, coverage);
}
`;

export const LIQUID_RESPONSE = 0.08;
export const LIQUID_CLICK_SEED = 3.7;
export const LIQUID_PALETTE_STATES = 5;
