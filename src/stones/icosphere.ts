/**
 * Hierarchical icosphere. Vertices of subdivision level L are the first
 * N(L) vertices of level L+1, which lets the collision hull reuse a subset of
 * the visual vertices so both shapes stay perfectly aligned.
 */
export interface Icosphere {
  /** Unit directions, xyz interleaved. */
  directions: Float32Array;
  indices: Uint32Array;
  /** Vertex count of each level (index = level). */
  levelVertexCounts: number[];
}

const cache = new Map<number, Icosphere>();

export function icosphere(subdivisions: number): Icosphere {
  const cached = cache.get(subdivisions);
  if (cached) return cached;

  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[] = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ];
  for (let i = 0; i < verts.length; i += 3) {
    const l = Math.hypot(verts[i], verts[i + 1], verts[i + 2]);
    verts[i] /= l;
    verts[i + 1] /= l;
    verts[i + 2] /= l;
  }
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  const levelVertexCounts = [verts.length / 3];

  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map<number, number>();
    const getMid = (a: number, b: number) => {
      const key = a < b ? a * 1_000_003 + b : b * 1_000_003 + a;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      let x = verts[a * 3] + verts[b * 3];
      let y = verts[a * 3 + 1] + verts[b * 3 + 1];
      let z = verts[a * 3 + 2] + verts[b * 3 + 2];
      const l = Math.hypot(x, y, z);
      x /= l;
      y /= l;
      z /= l;
      const idx = verts.length / 3;
      verts.push(x, y, z);
      mid.set(key, idx);
      return idx;
    };
    const next: number[] = [];
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i];
      const b = faces[i + 1];
      const c = faces[i + 2];
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
    levelVertexCounts.push(verts.length / 3);
  }

  const result: Icosphere = {
    directions: new Float32Array(verts),
    indices: new Uint32Array(faces),
    levelVertexCounts,
  };
  cache.set(subdivisions, result);
  return result;
}
