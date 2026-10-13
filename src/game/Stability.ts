import { convexHull2D, polygonArea, polygonCentroid, signedDistanceToConvexPolygon, type Vec2 } from '../core/geometry2d';

export interface SupportContact {
  /** World-space contact point. */
  point: { x: number; y: number; z: number };
  /** Unit normal pointing from the supporting body into the evaluated stone. */
  normal: { x: number; y: number; z: number };
  /** Id of the supporting body (-1 = base rock). */
  supporter: number;
}

export interface StabilityInput {
  /** World-space centre of mass of the evaluated stone (plus anything it carries). */
  com: { x: number; y: number; z: number };
  contacts: SupportContact[];
  /** Horizontal footprint polygon of the stone (world xz, any order). */
  footprint: Vec2[];
  /** Horizontal centre of mass of the supporting bodies (world xz). */
  supporterCom: Vec2 | null;
  /** Footprint radius of the supporting body (m). */
  supporterRadius: number;
}

export interface StabilityReport {
  /** Support polygon (CCW, world xz). */
  supportPolygon: Vec2[];
  supportPoints: { x: number; y: number; z: number }[];
  comXZ: Vec2;
  /** Signed distance of the COM projection to the support polygon edge (m, + inside). */
  margin: number;
  footprintRadius: number;
  marginRatio: number;
  /** Horizontal offset from the supporters' COM relative to their radius. */
  overhang: number;
  /** Mean tilt of the supporting contact normals (degrees). */
  slopeDeg: number;
  contactCount: number;
  supportArea: number;
  supporters: number[];
}

/** Minimum upward component for a contact to count as supporting. */
const SUPPORT_NORMAL_MIN_Y = 0.25;

export function analyzeStability(input: StabilityInput): StabilityReport {
  const supportContacts = input.contacts.filter((c) => c.normal.y >= SUPPORT_NORMAL_MIN_Y);
  const pts2: Vec2[] = supportContacts.map((c) => ({ x: c.point.x, y: c.point.z }));
  const supportPolygon = convexHull2D(pts2, 1e-4);
  const comXZ = { x: input.com.x, y: input.com.z };
  const margin = supportPolygon.length ? signedDistanceToConvexPolygon(comXZ, supportPolygon) : -1;
  const footprintPoly = convexHull2D(input.footprint, 1e-4);
  const footprintRadius = Math.max(0.02, Math.sqrt(polygonArea(footprintPoly) / Math.PI));

  let slope = 0;
  for (const c of supportContacts) slope += Math.acos(Math.min(1, Math.max(-1, c.normal.y)));
  const slopeDeg = supportContacts.length ? ((slope / supportContacts.length) * 180) / Math.PI : 90;

  let overhang = 0;
  if (input.supporterCom) {
    const dx = comXZ.x - input.supporterCom.x;
    const dz = comXZ.y - input.supporterCom.y;
    overhang = Math.hypot(dx, dz) / Math.max(0.05, input.supporterRadius);
  } else if (supportPolygon.length) {
    const c = polygonCentroid(supportPolygon);
    overhang = Math.hypot(comXZ.x - c.x, comXZ.y - c.y) / footprintRadius;
  }

  return {
    supportPolygon,
    supportPoints: supportContacts.map((c) => c.point),
    comXZ,
    margin,
    footprintRadius,
    marginRatio: margin / footprintRadius,
    overhang,
    slopeDeg,
    contactCount: supportContacts.length,
    supportArea: supportPolygon.length >= 3 ? polygonArea(supportPolygon) : 0,
    supporters: [...new Set(supportContacts.map((c) => c.supporter))],
  };
}
