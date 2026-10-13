export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01(invLerp(a, b, v));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing factor. */
export const dampFactor = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, dampFactor(lambda, dt));
export const degToRad = (d: number) => (d * Math.PI) / 180;
export const radToDeg = (r: number) => (r * 180) / Math.PI;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = ((a % twoPi) + twoPi) % twoPi;
  return a > Math.PI ? a - twoPi : a;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + wrapAngle(target - current) * dampFactor(lambda, dt);
}
