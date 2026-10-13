/** Minimal 2D computational geometry used by the stability analysis. */

export interface Vec2 {
  x: number;
  y: number;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * Convex hull (Andrew's monotone chain), counter-clockwise, without collinear
 * points. Points closer than `epsilon` are merged first.
 */
export function convexHull2D(input: readonly Vec2[], epsilon = 1e-5): Vec2[] {
  const pts: Vec2[] = [];
  for (const p of input) {
    if (!pts.some((q) => Math.abs(q.x - p.x) < epsilon && Math.abs(q.y - p.y) < epsilon)) {
      pts.push({ x: p.x, y: p.y });
    }
  }
  if (pts.length < 3) return pts;
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= epsilon * epsilon) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= epsilon * epsilon) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : dedupeLine(pts);
}

/** All points collinear: return the two extreme points. */
function dedupeLine(pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts;
  let best = [pts[0], pts[1]];
  let bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
      if (d > bestD) {
        bestD = d;
        best = [pts[i], pts[j]];
      }
    }
  }
  return best;
}

export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Signed distance from a point to the boundary of a convex polygon (CCW).
 * Positive inside, negative outside. Degenerate polygons (a point or a
 * segment) have no interior, so the result is the negated distance.
 */
export function signedDistanceToConvexPolygon(p: Vec2, poly: readonly Vec2[]): number {
  if (poly.length === 0) return -Infinity;
  if (poly.length === 1) return -Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  if (poly.length === 2) return -distanceToSegment(p, poly[0], poly[1]);
  let minEdge = Infinity;
  let inside = true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = distanceToSegment(p, a, b);
    if (d < minEdge) minEdge = d;
    if (cross(a, b, p) < 0) inside = false;
  }
  return inside ? minEdge : -minEdge;
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  if (poly.length === 0) return { x: 0, y: 0 };
  if (poly.length < 3) {
    let x = 0;
    let y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    return { x: x / poly.length, y: y / poly.length };
  }
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-12) return polygonCentroid(poly.slice(0, 2));
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
