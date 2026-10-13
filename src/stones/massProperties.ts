/**
 * Mass properties of a closed, outward-oriented triangle mesh with uniform
 * density: volume, centre of mass and the inertia tensor (with its principal
 * axes). This gives Rapier the true inertia of the visual stone.
 */
export interface MeshMassProperties {
  volume: number;
  centerOfMass: [number, number, number];
  /** Inertia tensor about the COM for density 1 (row-major 3x3). */
  inertia: number[];
}

export function meshMassProperties(positions: Float32Array, indices: Uint32Array): MeshMassProperties {
  let volume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  // Second moments about the origin: ∫x², ∫y², ∫z², ∫xy, ∫yz, ∫zx
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let yz = 0;
  let zx = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const qx = positions[c];
    const qy = positions[c + 1];
    const qz = positions[c + 2];
    const det = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    const v = det / 6;
    volume += v;
    cx += v * (ax + bx + qx) / 4;
    cy += v * (ay + by + qy) / 4;
    cz += v * (az + bz + qz) / 4;
    // Tetrahedron (0,a,b,c) second moments: det/120 * (Σ p_i p_j + Σ p_i²) per component
    const f = det / 120;
    xx += f * (ax * ax + bx * bx + qx * qx + (ax + bx + qx) ** 2);
    yy += f * (ay * ay + by * by + qy * qy + (ay + by + qy) ** 2);
    zz += f * (az * az + bz * bz + qz * qz + (az + bz + qz) ** 2);
    xy += f * (ax * ay + bx * by + qx * qy + (ax + bx + qx) * (ay + by + qy));
    yz += f * (ay * az + by * bz + qy * qz + (ay + by + qy) * (az + bz + qz));
    zx += f * (az * ax + bz * bx + qz * qx + (az + bz + qz) * (ax + bx + qx));
  }
  if (volume <= 0) throw new Error('meshMassProperties: mesh must be closed and outward oriented');
  cx /= volume;
  cy /= volume;
  cz /= volume;
  // Parallel axis shift to the centre of mass
  xx -= volume * cx * cx;
  yy -= volume * cy * cy;
  zz -= volume * cz * cz;
  xy -= volume * cx * cy;
  yz -= volume * cy * cz;
  zx -= volume * cz * cx;
  const inertia = [yy + zz, -xy, -zx, -xy, xx + zz, -yz, -zx, -yz, xx + yy];
  return { volume, centerOfMass: [cx, cy, cz], inertia };
}

/**
 * Symmetric 3x3 eigen decomposition (cyclic Jacobi). Returns eigenvalues and
 * eigenvectors as columns of a right-handed rotation matrix (row-major).
 */
export function symmetricEigen3(m: readonly number[]): { values: [number, number, number]; vectors: number[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p];
      const aqq = a[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  // Ensure right-handedness (det = +1) so the frame is a proper rotation.
  const det =
    v[0] * (v[4] * v[8] - v[5] * v[7]) - v[1] * (v[3] * v[8] - v[5] * v[6]) + v[2] * (v[3] * v[7] - v[4] * v[6]);
  if (det < 0) {
    v[2] = -v[2];
    v[5] = -v[5];
    v[8] = -v[8];
  }
  return { values: [a[0], a[4], a[8]], vectors: v };
}

/** Quaternion [x, y, z, w] from a row-major rotation matrix. */
export function quaternionFromMatrix3(m: readonly number[]): [number, number, number, number] {
  const m11 = m[0];
  const m12 = m[1];
  const m13 = m[2];
  const m21 = m[3];
  const m22 = m[4];
  const m23 = m[5];
  const m31 = m[6];
  const m32 = m[7];
  const m33 = m[8];
  const trace = m11 + m22 + m33;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
