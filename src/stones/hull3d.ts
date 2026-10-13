/**
 * Incremental 3D convex hull for small point sets (a few hundred points).
 * Used to find the stable resting faces of a stone; Rapier builds its own hull
 * for collision from the same points.
 */
export interface HullFace {
  a: number;
  b: number;
  c: number;
  /** Outward unit normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Plane offset: n·p = d for points on the face. */
  d: number;
}

export interface Hull3D {
  points: Float32Array;
  faces: HullFace[];
}

export function convexHull3D(points: Float32Array, eps = 1e-7): Hull3D {
  const n = points.length / 3;
  if (n < 4) throw new Error('convexHull3D needs at least 4 points');
  const P = (i: number, k: number) => points[i * 3 + k];

  // --- initial tetrahedron -------------------------------------------------
  let i0 = 0;
  let i1 = -1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (P(i, 0) - P(i0, 0)) ** 2 + (P(i, 1) - P(i0, 1)) ** 2 + (P(i, 2) - P(i0, 2)) ** 2;
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  let i2 = -1;
  best = -1;
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1) continue;
    const [cx, cy, cz] = crossSub(points, i0, i1, i);
    const d = cx * cx + cy * cy + cz * cz;
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  let i3 = -1;
  best = -1;
  const [tnx, tny, tnz] = crossSub(points, i0, i1, i2);
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const d = Math.abs(tnx * (P(i, 0) - P(i0, 0)) + tny * (P(i, 1) - P(i0, 1)) + tnz * (P(i, 2) - P(i0, 2)));
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i1 < 0 || i2 < 0 || i3 < 0 || best < eps) throw new Error('convexHull3D: degenerate point set');

  const faces: (HullFace | null)[] = [];
  const centroid = [0, 1, 2].map((k) => (P(i0, k) + P(i1, k) + P(i2, k) + P(i3, k)) / 4);

  const makeFace = (a: number, b: number, c: number): HullFace => {
    let [nx, ny, nz] = crossSub(points, a, b, c);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    let d = nx * P(a, 0) + ny * P(a, 1) + nz * P(a, 2);
    // orient outward relative to the initial centroid
    if (nx * centroid[0] + ny * centroid[1] + nz * centroid[2] - d > 0) {
      return makeFaceRaw(b, a, c);
    }
    return { a, b, c, nx, ny, nz, d };
  };
  const makeFaceRaw = (a: number, b: number, c: number): HullFace => {
    let [nx, ny, nz] = crossSub(points, a, b, c);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const d = nx * P(a, 0) + ny * P(a, 1) + nz * P(a, 2);
    return { a, b, c, nx, ny, nz, d };
  };

  faces.push(makeFace(i0, i1, i2), makeFace(i0, i1, i3), makeFace(i0, i2, i3), makeFace(i1, i2, i3));

  const used = new Set([i0, i1, i2, i3]);
  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    const px = P(p, 0);
    const py = P(p, 1);
    const pz = P(p, 2);
    const visible: number[] = [];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      if (!face) continue;
      if (face.nx * px + face.ny * py + face.nz * pz - face.d > eps) visible.push(f);
    }
    if (visible.length === 0) continue;

    // Directed edges of visible faces; horizon edges are those whose reverse is not visible.
    const edgeSet = new Set<string>();
    for (const f of visible) {
      const face = faces[f]!;
      edgeSet.add(`${face.a},${face.b}`);
      edgeSet.add(`${face.b},${face.c}`);
      edgeSet.add(`${face.c},${face.a}`);
    }
    const horizon: [number, number][] = [];
    for (const f of visible) {
      const face = faces[f]!;
      const edges: [number, number][] = [
        [face.a, face.b],
        [face.b, face.c],
        [face.c, face.a],
      ];
      for (const [u, v] of edges) {
        if (!edgeSet.has(`${v},${u}`)) horizon.push([u, v]);
      }
    }
    for (const f of visible) faces[f] = null;
    for (const [u, v] of horizon) faces.push(makeFaceRaw(u, v, p));
  }

  return { points, faces: faces.filter((f): f is HullFace => f !== null) };
}

function crossSub(points: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ax = points[b * 3] - points[a * 3];
  const ay = points[b * 3 + 1] - points[a * 3 + 1];
  const az = points[b * 3 + 2] - points[a * 3 + 2];
  const bx = points[c * 3] - points[a * 3];
  const by = points[c * 3 + 1] - points[a * 3 + 1];
  const bz = points[c * 3 + 2] - points[a * 3 + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/**
 * Makes a hull safe for Rapier's polyhedral contacts.
 *
 * Rapier (Parry) merges adjacent hull triangles whose normals differ by less
 * than ~1.5° into polygon faces, but its contact generator only uses the first
 * four vertices of a face polygon. A large flat face with many vertices thus
 * yields one bogus contact point and deep penetration. This pass reduces every
 * such face to its largest inscribed quadrilateral and lowers the remaining
 * boundary vertices by `skirt` (a few millimetres — the visual edges are
 * rounded by more than that anyway), so every face has at most four vertices.
 */
export function limitFaceVertices(points: Float32Array, skirt = 0.003, maxVertices = 4, maxPasses = 12): Float32Array {
  let current = hullVertices(points);
  for (let pass = 0; pass < maxPasses; pass++) {
    const hull = convexHull3D(current);
    const groups = mergedFaceGroups(hull).filter((g) => g.boundary.length > maxVertices);
    if (groups.length === 0) return current;
    const next = Float32Array.from(current);
    const drop = new Set<number>();
    for (const g of groups) {
      const [nx, ny, nz] = g.normal;
      // In-plane basis
      const hx = Math.abs(ny) < 0.9 ? 0 : 1;
      const hy = Math.abs(ny) < 0.9 ? 1 : 0;
      let ux = ny * 0 - nz * hy;
      let uy = nz * hx - nx * 0;
      let uz = nx * hy - ny * hx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      const pts = g.boundary.map((i) => {
        const x = current[i * 3];
        const y = current[i * 3 + 1];
        const z = current[i * 3 + 2];
        return { i, u: x * ux + y * uy + z * uz, v: x * vx + y * vy + z * vz };
      });
      // Order boundary vertices around their centroid.
      const cu = pts.reduce((a, p) => a + p.u, 0) / pts.length;
      const cv = pts.reduce((a, p) => a + p.v, 0) / pts.length;
      pts.sort((a, b) => Math.atan2(a.v - cv, a.u - cu) - Math.atan2(b.v - cv, b.u - cu));
      const quad = maxAreaQuad(pts);
      const keep = new Set(quad.map((p) => p.i));
      for (const i of g.vertices) {
        if (keep.has(i)) continue;
        if (g.interior.has(i)) {
          drop.add(i);
          continue;
        }
        next[i * 3] -= nx * skirt;
        next[i * 3 + 1] -= ny * skirt;
        next[i * 3 + 2] -= nz * skirt;
      }
    }
    const kept: number[] = [];
    for (let i = 0; i < next.length / 3; i++) if (!drop.has(i)) kept.push(next[i * 3], next[i * 3 + 1], next[i * 3 + 2]);
    current = hullVertices(new Float32Array(kept));
  }
  return current;
}

function maxAreaQuad<T extends { u: number; v: number }>(poly: T[]): T[] {
  const n = poly.length;
  if (n <= 4) return poly;
  const tri = (a: T, b: T, c: T) => Math.abs((b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u)) / 2;
  let best: T[] = poly.slice(0, 4);
  let bestArea = -1;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        const abc = tri(poly[a], poly[b], poly[c]);
        for (let d = c + 1; d < n; d++) {
          const area = abc + tri(poly[a], poly[c], poly[d]);
          if (area > bestArea) {
            bestArea = area;
            best = [poly[a], poly[b], poly[c], poly[d]];
          }
        }
      }
    }
  }
  return best;
}

export interface MergedFaceGroup {
  faces: HullFace[];
  /** Vertices on the group's outline (what Parry keeps as polygon vertices). */
  boundary: number[];
  /** Vertices whose incident faces all belong to the group. */
  interior: Set<number>;
  vertices: Set<number>;
  normal: [number, number, number];
}

/** Groups hull triangles the way Parry merges them (adjacent normals within `mergeDeg`). */
export function mergedFaceGroups(hull: Hull3D, mergeDeg = 1.6): MergedFaceGroup[] {
  const cosMerge = Math.cos((mergeDeg * Math.PI) / 180);
  const faces = hull.faces;
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edgeFaces = new Map<string, number[]>();
  faces.forEach((f, i) => {
    for (const [u, v] of [
      [f.a, f.b],
      [f.b, f.c],
      [f.c, f.a],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const list = edgeFaces.get(key);
      if (list) list.push(i);
      else edgeFaces.set(key, [i]);
    }
  });
  const boundaryEdges: [number, number, number][] = [];
  for (const [key, fs] of edgeFaces) {
    if (fs.length !== 2) continue;
    const a = faces[fs[0]];
    const b = faces[fs[1]];
    if (a.nx * b.nx + a.ny * b.ny + a.nz * b.nz > cosMerge) parent[find(fs[0])] = find(fs[1]);
    else {
      const [u, v] = key.split(',').map(Number);
      boundaryEdges.push([fs[0], u, v], [fs[1], u, v]);
    }
  }
  const byRoot = new Map<number, MergedFaceGroup>();
  faces.forEach((f, i) => {
    const r = find(i);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = { faces: [], boundary: [], interior: new Set(), vertices: new Set(), normal: [0, 0, 0] }));
    g.faces.push(f);
    g.vertices.add(f.a).add(f.b).add(f.c);
  });
  const boundarySets = new Map<number, Set<number>>();
  for (const [fi, u, v] of boundaryEdges) {
    const r = find(fi);
    let set = boundarySets.get(r);
    if (!set) boundarySets.set(r, (set = new Set()));
    set.add(u).add(v);
  }
  for (const [r, g] of byRoot) {
    const b = boundarySets.get(r) ?? new Set<number>();
    g.boundary = [...b];
    for (const v of g.vertices) if (!b.has(v)) g.interior.add(v);
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const f of g.faces) {
      const area = triangleArea3(hull.points, f.a, f.b, f.c);
      nx += f.nx * area;
      ny += f.ny * area;
      nz += f.nz * area;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    g.normal = [nx / l, ny / l, nz / l];
  }
  return [...byRoot.values()];
}

function triangleArea3(p: Float32Array, a: number, b: number, c: number): number {
  const e1x = p[b * 3] - p[a * 3];
  const e1y = p[b * 3 + 1] - p[a * 3 + 1];
  const e1z = p[b * 3 + 2] - p[a * 3 + 2];
  const e2x = p[c * 3] - p[a * 3];
  const e2y = p[c * 3 + 1] - p[a * 3 + 1];
  const e2z = p[c * 3 + 2] - p[a * 3 + 2];
  return Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) / 2;
}

/**
 * Greedily adds surface points to a coarse point set until the convex hull is
 * within `tolerance` of every surface point (adds the worst offenders first,
 * spread out so one iteration fixes several regions).
 */
export function refineHullPoints(
  initial: Float32Array,
  surface: Float32Array,
  tolerance = 0.002,
  maxIterations = 14,
  perIteration = 10,
): Float32Array {
  let current = hullVertices(initial);
  const n = surface.length / 3;
  for (let it = 0; it < maxIterations; it++) {
    const hull = convexHull3D(current);
    const errors: { i: number; e: number }[] = [];
    for (let i = 0; i < n; i++) {
      const x = surface[i * 3];
      const y = surface[i * 3 + 1];
      const z = surface[i * 3 + 2];
      let e = -Infinity;
      for (const f of hull.faces) {
        const d = f.nx * x + f.ny * y + f.nz * z - f.d;
        if (d > e) e = d;
      }
      if (e > tolerance) errors.push({ i, e });
    }
    if (errors.length === 0) break;
    errors.sort((a, b) => b.e - a.e);
    const added: number[] = [];
    const chosen: number[] = [];
    for (const { i } of errors) {
      const x = surface[i * 3];
      const y = surface[i * 3 + 1];
      const z = surface[i * 3 + 2];
      if (chosen.some((j) => (surface[j * 3] - x) ** 2 + (surface[j * 3 + 1] - y) ** 2 + (surface[j * 3 + 2] - z) ** 2 < 0.03 * 0.03)) continue;
      chosen.push(i);
      added.push(x, y, z);
      if (chosen.length >= perIteration) break;
    }
    const merged = new Float32Array(current.length + added.length);
    merged.set(current);
    merged.set(added, current.length);
    current = hullVertices(merged);
  }
  return current;
}

/**
 * Moves every surface point that lies outside the hull back onto it along its
 * radial direction, so the visual mesh never pokes through its collider.
 */
export function clampInsideHull(surface: Float32Array, hullPoints: Float32Array, margin = 0): void {
  const hull = convexHull3D(hullPoints);
  for (let i = 0; i < surface.length; i += 3) {
    const x = surface[i];
    const y = surface[i + 1];
    const z = surface[i + 2];
    let scale = 1;
    for (const f of hull.faces) {
      const nd = f.nx * x + f.ny * y + f.nz * z;
      if (nd > f.d - margin && nd > 1e-9) scale = Math.min(scale, (f.d - margin) / nd);
    }
    if (scale < 1) {
      surface[i] = x * scale;
      surface[i + 1] = y * scale;
      surface[i + 2] = z * scale;
    }
  }
}

/** Points that are vertices of their convex hull. */
export function hullVertices(points: Float32Array): Float32Array {
  const hull = convexHull3D(points);
  const used = new Set<number>();
  for (const f of hull.faces) used.add(f.a).add(f.b).add(f.c);
  const out: number[] = [];
  for (const i of [...used].sort((a, b) => a - b)) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  return new Float32Array(out);
}




/** Largest polygon vertex count after Parry-style face merging. */
export function maxMergedFaceVertices(hull: Hull3D): number {
  let max = 3;
  for (const g of mergedFaceGroups(hull)) max = Math.max(max, g.boundary.length);
  return max;
}
