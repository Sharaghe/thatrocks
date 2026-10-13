import { describe, expect, it } from 'vitest';
import { convexHull2D, polygonArea, polygonCentroid, signedDistanceToConvexPolygon } from '../src/core/geometry2d';
import { analyzeStability, type SupportContact } from '../src/game/Stability';

const square = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
];

describe('geometry2d', () => {
  it('computes a CCW convex hull without interior or duplicate points', () => {
    const hull = convexHull2D([...square, { x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }, { x: 0, y: -1 }]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(4);
  });

  it('handles degenerate inputs', () => {
    expect(convexHull2D([{ x: 1, y: 1 }])).toHaveLength(1);
    const line = convexHull2D([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(line).toHaveLength(2);
  });

  it('signed distance is positive inside and negative outside', () => {
    const hull = convexHull2D(square);
    expect(signedDistanceToConvexPolygon({ x: 0, y: 0 }, hull)).toBeCloseTo(1);
    expect(signedDistanceToConvexPolygon({ x: 0.5, y: 0 }, hull)).toBeCloseTo(0.5);
    expect(signedDistanceToConvexPolygon({ x: 2, y: 0 }, hull)).toBeCloseTo(-1);
    expect(signedDistanceToConvexPolygon({ x: 0, y: 0 }, [{ x: 3, y: 4 }])).toBeCloseTo(-5);
  });

  it('finds the centroid of a polygon', () => {
    const c = polygonCentroid(convexHull2D(square.map((p) => ({ x: p.x + 2, y: p.y }))));
    expect(c.x).toBeCloseTo(2);
    expect(c.y).toBeCloseTo(0);
  });
});

describe('analyzeStability', () => {
  const contact = (x: number, z: number, ny = 1): SupportContact => ({
    point: { x, y: 0, z },
    normal: { x: 0, y: ny, z: Math.sqrt(1 - ny * ny) },
    supporter: -1,
  });
  const footprint = [
    { x: -0.2, y: -0.2 },
    { x: 0.2, y: -0.2 },
    { x: 0.2, y: 0.2 },
    { x: -0.2, y: 0.2 },
  ];

  it('measures the margin of the centre of mass inside the support polygon', () => {
    const r = analyzeStability({
      com: { x: 0, y: 0.1, z: 0 },
      contacts: [contact(-0.1, -0.1), contact(0.1, -0.1), contact(0.1, 0.1), contact(-0.1, 0.1)],
      footprint,
      supporterCom: { x: 0, y: 0 },
      supporterRadius: 0.5,
    });
    expect(r.margin).toBeCloseTo(0.1);
    expect(r.contactCount).toBe(4);
    expect(r.supportArea).toBeCloseTo(0.04);
    expect(r.slopeDeg).toBeCloseTo(0);
    expect(r.overhang).toBeCloseTo(0);
  });

  it('reports a negative margin when the COM is outside the support', () => {
    const r = analyzeStability({
      com: { x: 0.3, y: 0.1, z: 0 },
      contacts: [contact(-0.1, -0.1), contact(0.1, -0.1), contact(0.1, 0.1)],
      footprint,
      supporterCom: { x: 0, y: 0 },
      supporterRadius: 0.5,
    });
    expect(r.margin).toBeLessThan(0);
    expect(r.overhang).toBeCloseTo(0.6);
  });

  it('ignores side contacts that cannot carry weight', () => {
    const r = analyzeStability({
      com: { x: 0, y: 0.1, z: 0 },
      contacts: [contact(-0.1, -0.1), contact(0.1, -0.1), contact(0.1, 0.1), contact(0.5, 0.5, 0.05)],
      footprint,
      supporterCom: null,
      supporterRadius: 0.3,
    });
    expect(r.contactCount).toBe(3);
  });
});
