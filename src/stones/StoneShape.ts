import { Noise3 } from '../core/noise';
import { Rng } from '../core/rng';
import { convexHull2D, signedDistanceToConvexPolygon, type Vec2 } from '../core/geometry2d';
import { ROCKS, superRadius, type RockMaterial, type StoneRecipe } from './catalog';
import { icosphere } from './icosphere';
import { clampInsideHull, convexHull3D, limitFaceVertices, refineHullPoints } from './hull3d';
import { meshMassProperties, quaternionFromMatrix3, symmetricEigen3 } from './massProperties';

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export interface RestingPose {
  /** Rotation that puts this resting face down (object → world, before yaw). */
  quaternion: Quat;
  /** Tilt needed to tip the stone over from this face (radians). Larger = steadier. */
  tippingAngle: number;
  /** Outward normal of the resting face in object space. */
  normal: Vec3;
}

export interface StoneShape {
  recipe: StoneRecipe;
  rock: RockMaterial;
  /** Visual mesh, object space with the centre of mass at the origin. */
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB vertex colours. */
  colors: Float32Array;
  indices: Uint32Array;
  /** Inner points of the rounded collision hull (hull ⊕ sphere(borderRadius) ≈ visual mesh). */
  collisionPoints: Float32Array;
  borderRadius: number;
  volume: number;
  mass: number;
  principalInertia: Vec3;
  inertiaFrame: Quat;
  boundingRadius: number;
  restingPoses: RestingPose[];
}

export interface StoneShapeOptions {
  /** Icosphere subdivisions of the mesh (4 = 2562 verts; 3 is only meant for fast tests). */
  detail?: number;
  /** Icosphere level whose vertices build the collision hull (2 = 162 points). */
  collisionLevel?: number;
  /** Scenery only: skip collision-hull fitting and resting-pose analysis. */
  decorative?: boolean;
}

/**
 * Sharp radial distance function of a recipe for unit direction d: the
 * intersection of a lumpy superellipsoid with planar cut faces. Cut faces are
 * exactly planar on purpose — nearly coplanar micro-facets make resting
 * contacts flicker between features.
 */
export function stoneRadius(recipe: StoneRecipe, noise: Noise3, dx: number, dy: number, dz: number): number {
  const lump = noise.fbm(dx * recipe.lumpFreq + 11.3, dy * recipe.lumpFreq - 4.1, dz * recipe.lumpFreq + 7.7, 3);
  let r = superRadius([dx, dy, dz], recipe.radii, recipe.exponent) * (1 + recipe.lumpAmp * lump);
  for (const cut of recipe.cuts) {
    const dn = dx * cut.normal[0] + dy * cut.normal[1] + dz * cut.normal[2];
    if (dn > 1e-4) r = Math.min(r, cut.offset / dn);
  }
  return r;
}

const adjacencyCache = new Map<number, Uint32Array[]>();

function adjacency(level: number, indices: Uint32Array, n: number): Uint32Array[] {
  const hit = adjacencyCache.get(level);
  if (hit) return hit;
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    sets[a].add(b).add(c);
    sets[b].add(a).add(c);
    sets[c].add(a).add(b);
  }
  const adj = sets.map((set) => Uint32Array.from(set));
  adjacencyCache.set(level, adj);
  return adj;
}

/**
 * Taubin (λ|μ) smoothing: rounds sharp edges like weathering does while
 * keeping flat faces flat (the Laplacian of coplanar neighbours is in-plane)
 * and without the shrinkage of plain Laplacian smoothing.
 */
function taubinSmooth(positions: Float32Array, adj: Uint32Array[], iterations: number): void {
  const n = adj.length;
  const tmp = new Float32Array(positions.length);
  const pass = (factor: number) => {
    for (let i = 0; i < n; i++) {
      const nb = adj[i];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let j = 0; j < nb.length; j++) {
        const k = nb[j] * 3;
        sx += positions[k];
        sy += positions[k + 1];
        sz += positions[k + 2];
      }
      const inv = 1 / nb.length;
      const i3 = i * 3;
      tmp[i3] = positions[i3] + factor * (sx * inv - positions[i3]);
      tmp[i3 + 1] = positions[i3 + 1] + factor * (sy * inv - positions[i3 + 1]);
      tmp[i3 + 2] = positions[i3 + 2] + factor * (sz * inv - positions[i3 + 2]);
    }
    positions.set(tmp);
  };
  for (let it = 0; it < iterations; it++) {
    pass(0.5);
    pass(-0.53);
  }
}

export function generateStoneShape(recipe: StoneRecipe, options: StoneShapeOptions = {}): StoneShape {
  const detail = options.detail ?? 4;
  const collisionLevel = Math.min(options.collisionLevel ?? 2, detail);
  const ico = icosphere(detail);
  const noise = new Noise3(recipe.noiseSeed);
  const n = ico.directions.length / 3;
  const indices = ico.indices;

  // 1. Sharp shape sampled on the sphere: exact cut planes, lumpy curved parts.
  const sharp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const dx = ico.directions[i * 3];
    const dy = ico.directions[i * 3 + 1];
    const dz = ico.directions[i * 3 + 2];
    const r = stoneRadius(recipe, noise, dx, dy, dz);
    sharp[i * 3] = dx * r;
    sharp[i * 3 + 1] = dy * r;
    sharp[i * 3 + 2] = dz * r;
  }
  // 2. Weathered (rounded) edges. Flat cut faces stay flat in their interior.
  const smooth = new Float32Array(sharp);
  const iterations = Math.round(Math.min(14, Math.max(2, recipe.softness / 0.0035)) / Math.pow(4, 4 - detail));
  taubinSmooth(smooth, adjacency(detail, indices, n), Math.max(1, iterations));
  const smoothNormals = computeNormals(smooth, indices);

  // 3. Collision hull from the smooth surface: coarse level, refined where the
  //    surface sticks out, then every face limited to four vertices (Rapier).
  const borderRadius = 0;
  const nc = ico.levelVertexCounts[collisionLevel];
  let collisionPoints = options.decorative
    ? smooth.slice(0, nc * 3)
    : limitFaceVertices(refineHullPoints(smooth.slice(0, nc * 3), smooth, 0.002));

  // 4. Visual surface: ≈1 mm relief along the normal, then clamped into the hull.
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const dx = ico.directions[i * 3];
    const dy = ico.directions[i * 3 + 1];
    const dz = ico.directions[i * 3 + 2];
    const r = Math.hypot(smooth[i * 3], smooth[i * 3 + 1], smooth[i * 3 + 2]);
    const relief = r * recipe.detailAmp * (noise.fbm(dx * recipe.detailFreq - 3.3, dy * recipe.detailFreq + 9.2, dz * recipe.detailFreq + 1.4, 3) - 0.35);
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = smooth[i * 3 + k] + smoothNormals[i * 3 + k] * relief;
  }
  if (!options.decorative) clampInsideHull(positions, collisionPoints);

  // Centre everything on the centre of mass so rotations and stability maths are natural.
  const preMass = meshMassProperties(positions, indices);
  const [cx, cy, cz] = preMass.centerOfMass;
  let boundingRadius = 0;
  for (let i = 0; i < n; i++) {
    positions[i * 3] -= cx;
    positions[i * 3 + 1] -= cy;
    positions[i * 3 + 2] -= cz;
    boundingRadius = Math.max(boundingRadius, Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  }
  collisionPoints = Float32Array.from(collisionPoints);
  for (let i = 0; i < collisionPoints.length; i += 3) {
    collisionPoints[i] -= cx;
    collisionPoints[i + 1] -= cy;
    collisionPoints[i + 2] -= cz;
  }
  const mass = meshMassProperties(positions, indices);
  const normals = computeNormals(positions, indices);

  const rock = ROCKS[recipe.rock];
  const density = rock.density;
  const eig = symmetricEigen3(mass.inertia.map((v) => v * density));
  const principalInertia: Vec3 = [Math.max(eig.values[0], 1e-6), Math.max(eig.values[1], 1e-6), Math.max(eig.values[2], 1e-6)];
  const inertiaFrame = quaternionFromMatrix3(eig.vectors);

  const restingPoses: RestingPose[] = options.decorative
    ? [{ quaternion: [0, 0, 0, 1], tippingAngle: 0, normal: [0, -1, 0] }]
    : computeRestingPoses(collisionPoints, borderRadius);
  const colors = computeColors(recipe, rock, positions, normals, indices);

  return {
    recipe,
    rock,
    positions,
    normals,
    colors,
    indices,
    collisionPoints,
    borderRadius,
    volume: mass.volume,
    mass: mass.volume * density,
    principalInertia,
    inertiaFrame,
    boundingRadius,
    restingPoses,
  };
}

export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return normals;
}

/** Quaternion rotating unit vector a onto unit vector b. */
export function quatFromUnitVectors(a: Vec3, b: Vec3): Quat {
  let r = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1;
  let x: number;
  let y: number;
  let z: number;
  if (r < 1e-6) {
    r = 0;
    if (Math.abs(a[0]) > Math.abs(a[2])) {
      x = -a[1];
      y = a[0];
      z = 0;
    } else {
      x = 0;
      y = -a[2];
      z = a[1];
    }
  } else {
    x = a[1] * b[2] - a[2] * b[1];
    y = a[2] * b[0] - a[0] * b[2];
    z = a[0] * b[1] - a[1] * b[0];
  }
  const l = Math.hypot(x, y, z, r);
  return [x / l, y / l, z / l, r / l];
}

/**
 * Finds faces the stone can rest on by itself (centre of mass projecting
 * inside the face) and ranks them by tipping angle.
 */
export function computeRestingPoses(points: Float32Array, borderRadius: number, maxPoses = 4): RestingPose[] {
  const hull = convexHull3D(points);
  const faces = hull.faces
    .map((f) => {
      const area = triangleArea(points, f.a, f.b, f.c);
      return { ...f, area };
    })
    .sort((p, q) => q.area - p.area);
  const assigned = new Array(faces.length).fill(false);
  const candidates: RestingPose[] = [];
  const cosTol = Math.cos((3 * Math.PI) / 180);
  for (let i = 0; i < faces.length; i++) {
    if (assigned[i]) continue;
    const f = faces[i];
    const verts = new Set<number>([f.a, f.b, f.c]);
    assigned[i] = true;
    for (let j = i + 1; j < faces.length; j++) {
      if (assigned[j]) continue;
      const g = faces[j];
      if (f.nx * g.nx + f.ny * g.ny + f.nz * g.nz > cosTol && Math.abs(g.d - f.d) < 0.002) {
        assigned[j] = true;
        verts.add(g.a).add(g.b).add(g.c);
      }
    }
    if (f.d <= 0) continue;
    // In-plane basis
    const nrm: Vec3 = [f.nx, f.ny, f.nz];
    const helper: Vec3 = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize3(cross3(nrm, helper));
    const v = cross3(nrm, u);
    const poly: Vec2[] = [];
    for (const idx of verts) {
      const px = points[idx * 3];
      const py = points[idx * 3 + 1];
      const pz = points[idx * 3 + 2];
      poly.push({ x: px * u[0] + py * u[1] + pz * u[2], y: px * v[0] + py * v[1] + pz * v[2] });
    }
    const hull2 = convexHull2D(poly);
    const margin = signedDistanceToConvexPolygon({ x: 0, y: 0 }, hull2);
    if (margin <= 0) continue;
    const height = f.d + borderRadius;
    const tippingAngle = Math.atan2(margin, height);
    if (tippingAngle < (3 * Math.PI) / 180) continue;
    candidates.push({ quaternion: quatFromUnitVectors(nrm, [0, -1, 0]), tippingAngle, normal: nrm });
  }
  candidates.sort((a, b) => b.tippingAngle - a.tippingAngle);
  const poses: RestingPose[] = [];
  const cosDistinct = Math.cos((35 * Math.PI) / 180);
  for (const c of candidates) {
    if (poses.some((p) => dot3(p.normal, c.normal) > cosDistinct)) continue;
    poses.push(c);
    if (poses.length >= maxPoses) break;
  }
  if (poses.length === 0) poses.push({ quaternion: [0, 0, 0, 1], tippingAngle: 0, normal: [0, -1, 0] });
  return poses;
}

function computeColors(
  recipe: StoneRecipe,
  rock: RockMaterial,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const rng = new Rng(recipe.colorSeed);
  const noise = new Noise3(recipe.colorSeed ^ 0x5bd1e995);
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  const base = srgbToLinear(rng.pick(rock.palette));
  const brightness = rng.range(0.92, 1.08);
  const secondary = srgbToLinear(rock.secondary);
  const vein = rng.chance(rock.veinChance)
    ? {
        normal: normalize3(rng.unitVector() as Vec3),
        offset: rng.range(-0.04, 0.04),
        width: rng.range(0.004, 0.012),
        color: srgbToLinear(rng.chance(0.7) ? '#e9e5dc' : '#d8cdb8'),
      }
    : null;
  const lichen = rng.chance(rock.lichenChance)
    ? {
        dir: normalize3([rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)]),
        color: srgbToLinear(rng.pick(['#b9b78f', '#c4c3b2', '#a9ad86', '#c9a25a'])),
        amount: rng.range(0.3, 0.75),
      }
    : null;
  const bandAxis = normalize3([rng.range(-0.25, 0.25), 1, rng.range(-0.25, 0.25)]);
  const bandFreq = rng.range(55, 110);

  // Cavity term: how far a vertex sits below the average of its neighbours.
  const cavity = new Float32Array(n);
  const neighbourSum = new Float32Array(n * 3);
  const neighbourCount = new Float32Array(n);
  for (let i = 0; i < indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[i + e];
      const b = indices[i + ((e + 1) % 3)];
      neighbourSum[a * 3] += positions[b * 3];
      neighbourSum[a * 3 + 1] += positions[b * 3 + 1];
      neighbourSum[a * 3 + 2] += positions[b * 3 + 2];
      neighbourCount[a] += 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const c = neighbourCount[i] || 1;
    const dx = neighbourSum[i * 3] / c - positions[i * 3];
    const dy = neighbourSum[i * 3 + 1] / c - positions[i * 3 + 1];
    const dz = neighbourSum[i * 3 + 2] / c - positions[i * 3 + 2];
    // positive when neighbours are "outside" relative to the normal → concave
    cavity[i] = dx * normals[i * 3] + dy * normals[i * 3 + 1] + dz * normals[i * 3 + 2];
  }

  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const m = noise.fbm(px * 5.5 + 3.1, py * 5.5, pz * 5.5 - 2.7, 4);
    const t = smooth(-0.35, 0.55, m) * 0.75;
    let r = lerp(base[0], secondary[0], t);
    let g = lerp(base[1], secondary[1], t);
    let b = lerp(base[2], secondary[2], t);
    const fine = 1 + rock.mottle * noise.fbm(px * 16, py * 16 + 5, pz * 16, 3);
    r *= fine * brightness;
    g *= fine * brightness;
    b *= fine * brightness;
    if (rock.banding > 0) {
      const warp = noise.fbm(px * 3 + 7, py * 3, pz * 3, 3) * 4;
      const band = Math.sin((px * bandAxis[0] + py * bandAxis[1] + pz * bandAxis[2]) * bandFreq + warp);
      const k = 1 + rock.banding * 0.11 * band;
      r *= k;
      g *= k * 0.995;
      b *= k * 0.985;
    }
    if (vein) {
      const dist =
        Math.abs(px * vein.normal[0] + py * vein.normal[1] + pz * vein.normal[2] - vein.offset) +
        noise.fbm(px * 9, py * 9, pz * 9 + 4, 2) * 0.012;
      const w = 1 - smooth(vein.width * 0.5, vein.width, dist);
      r = lerp(r, vein.color[0], w * 0.85);
      g = lerp(g, vein.color[1], w * 0.85);
      b = lerp(b, vein.color[2], w * 0.85);
    }
    if (lichen) {
      const up = normals[i * 3] * lichen.dir[0] + normals[i * 3 + 1] * lichen.dir[1] + normals[i * 3 + 2] * lichen.dir[2];
      const spots = smooth(0.18, 0.42, noise.fbm(px * 11 - 9, py * 11, pz * 11 + 2, 4) + (lichen.amount - 0.5) * 0.3);
      const l = spots * smooth(-0.2, 0.6, up) * 0.75;
      r = lerp(r, lichen.color[0], l);
      g = lerp(g, lichen.color[1], l);
      b = lerp(b, lichen.color[2], l);
    }
    const cav = Math.max(0, Math.min(1, cavity[i] * 180));
    const ao = 1 - cav * 0.35;
    colors[i * 3] = r * ao;
    colors[i * 3 + 1] = g * ao;
    colors[i * 3 + 2] = b * ao;
  }
  return colors;
}

function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const e1: Vec3 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
  const e2: Vec3 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
  const cr = cross3(e1, e2);
  return Math.hypot(cr[0], cr[1], cr[2]) / 2;
}

const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smooth(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function srgbToLinear(hex: string): Vec3 {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))) as Vec3;
}
