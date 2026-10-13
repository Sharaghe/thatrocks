import { Noise3 } from '../core/noise';
import { smoothstep } from '../core/math';
import { WORLD } from '../config';

/**
 * Riverbank terrain shared by physics (collision mesh) and rendering.
 * A shallow stream meanders across the scene; the base rock sits in the
 * stream close to the near bank. Heights are in metres, water level is 0.
 */
export class Terrain {
  private noise: Noise3;
  readonly riverbedDepth = -0.32;

  constructor(seed = WORLD.environmentSeed) {
    this.noise = new Noise3(seed);
  }

  /** Signed distance (m) from the stream centre line, measured along z. */
  streamOffset(x: number, z: number): number {
    const centre = 0.35 + Math.sin(x * 0.11 + 0.6) * 2.2 + Math.sin(x * 0.27 + 1.9) * 0.6;
    return z - centre;
  }

  streamHalfWidth(x: number): number {
    return 3.1 + Math.sin(x * 0.19 + 0.3) * 0.7 + this.noise.noise(x * 0.08, 3.3, 0.5) * 0.5;
  }

  /** Stream flow direction (unit xz) at a point. */
  flowDirection(x: number): [number, number] {
    const dzdx = Math.cos(x * 0.11 + 0.6) * 2.2 * 0.11 + Math.cos(x * 0.27 + 1.9) * 0.6 * 0.27;
    const l = Math.hypot(1, dzdx);
    return [1 / l, dzdx / l];
  }

  height(x: number, z: number): number {
    const n = this.noise;
    const off = this.streamOffset(x, z);
    const hw = this.streamHalfWidth(x);
    const across = Math.abs(off) / hw; // 0 at centre, 1 at the water's edge (approx.)
    // Riverbed: gently bowl shaped with sandy ripples
    const bed = this.riverbedDepth * (1 - across * across * 0.55) + n.fbm(x * 0.6, 0.2, z * 0.6, 3) * 0.05;
    // Banks: rise beyond the edge, steeper on the outside of bends
    const bankT = smoothstep(0.82, 1.55, across);
    const bankRise = 0.18 + (across - 0.9) * 0.55;
    const hills = n.fbm(x * 0.05 + 10, 1.7, z * 0.05 - 4, 4) * 2.4 + 1.1;
    const farT = smoothstep(2.2, 6.5, across);
    const bank = bankRise + n.fbm(x * 0.35, 4.2, z * 0.35, 3) * 0.12;
    let h = bed * (1 - bankT) + bank * bankT;
    h = h * (1 - farT) + (bank + hills * (across - 2.2) * 0.42) * farT;
    // Small-scale ground detail
    h += n.fbm(x * 2.2, 7.7, z * 2.2, 2) * 0.012;
    // Keep the area around the tower calm and slightly deeper so the base rock reads well.
    const r = Math.hypot(x, z);
    h -= (1 - smoothstep(0.6, 2.2, r)) * 0.05;
    return h;
  }

  /** Depth of water at a point (0 on dry land). */
  waterDepth(x: number, z: number): number {
    return Math.max(0, WORLD.waterLevel - this.height(x, z));
  }

  /**
   * Regular grid mesh (xz plane) covering [-size/2, size/2]². Returns
   * positions and triangle indices, used for the physics trimesh.
   */
  gridMesh(size: number, segments: number, centreX = 0, centreZ = 0): { positions: Float32Array; indices: Uint32Array } {
    const verts = segments + 1;
    const positions = new Float32Array(verts * verts * 3);
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = centreX - size / 2 + (i / segments) * size;
        const z = centreZ - size / 2 + (j / segments) * size;
        const k = (j * verts + i) * 3;
        positions[k] = x;
        positions[k + 1] = this.height(x, z);
        positions[k + 2] = z;
      }
    }
    const indices = new Uint32Array(segments * segments * 6);
    let t = 0;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }
    return { positions, indices };
  }
}
