import { Rng } from './rng';

/**
 * Seeded 3D gradient (Perlin-style) noise with fBm helpers.
 * Used for stone surface irregularities, colour variation and terrain.
 */
export class Noise3 {
  private perm = new Uint8Array(512);
  private grad: Float32Array;

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // 256 random unit gradients
    this.grad = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const [x, y, z] = rng.unitVector();
      this.grad[i * 3] = x;
      this.grad[i * 3 + 1] = y;
      this.grad[i * 3 + 2] = z;
    }
  }

  /** Gradient noise in roughly [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;
    const p = this.perm;
    const aaa = p[p[p[X] + Y] + Z];
    const aba = p[p[p[X] + Y + 1] + Z];
    const aab = p[p[p[X] + Y] + Z + 1];
    const abb = p[p[p[X] + Y + 1] + Z + 1];
    const baa = p[p[p[X + 1] + Y] + Z];
    const bba = p[p[p[X + 1] + Y + 1] + Z];
    const bab = p[p[p[X + 1] + Y] + Z + 1];
    const bbb = p[p[p[X + 1] + Y + 1] + Z + 1];
    const x1 = lerp(this.dot(aaa, xf, yf, zf), this.dot(baa, xf - 1, yf, zf), u);
    const x2 = lerp(this.dot(aba, xf, yf - 1, zf), this.dot(bba, xf - 1, yf - 1, zf), u);
    const y1 = lerp(x1, x2, v);
    const x3 = lerp(this.dot(aab, xf, yf, zf - 1), this.dot(bab, xf - 1, yf, zf - 1), u);
    const x4 = lerp(this.dot(abb, xf, yf - 1, zf - 1), this.dot(bbb, xf - 1, yf - 1, zf - 1), u);
    const y2 = lerp(x3, x4, v);
    return lerp(y1, y2, w) * 1.6;
  }

  fbm(x: number, y: number, z: number, octaves = 4, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x, y, z);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] — useful for mineral veins and creases. */
  ridged(x: number, y: number, z: number, octaves = 3): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x, y, z));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2.1;
      y *= 2.1;
      z *= 2.1;
    }
    return sum / norm;
  }

  private dot(hash: number, x: number, y: number, z: number): number {
    const g = this.grad;
    const i = hash * 3;
    return g[i] * x + g[i + 1] * y + g[i + 2] * z;
  }
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
