import { describe, expect, it } from 'vitest';
import { StoneSequence, makeRecipe, type ArchetypeId } from '../src/stones/catalog';
import { generateStoneShape } from '../src/stones/StoneShape';
import { meshMassProperties } from '../src/stones/massProperties';
import { convexHull3D, maxMergedFaceVertices } from '../src/stones/hull3d';
import { Rng } from '../src/core/rng';

const archetypes: ArchetypeId[] = ['slab', 'disc', 'wedge', 'cobble', 'block', 'pebble', 'boulder'];

describe('stone generation', () => {
  it('is deterministic for a given seed and level', () => {
    const a = generateStoneShape(new StoneSequence(42).recipe(5), { detail: 3 });
    const b = generateStoneShape(new StoneSequence(42).recipe(5), { detail: 3 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.mass).toBe(b.mass);
    const c = generateStoneShape(new StoneSequence(43).recipe(5), { detail: 3 });
    expect(Array.from(c.positions)).not.toEqual(Array.from(a.positions));
  });

  it.each(archetypes)('%s stones have sane, centred mass properties', (archetype) => {
    const rng = new Rng(7);
    for (let i = 0; i < 6; i++) {
      const shape = generateStoneShape(makeRecipe(rng, archetype), { detail: 3 });
      const m = meshMassProperties(shape.positions, shape.indices);
      expect(m.volume).toBeGreaterThan(0);
      for (const c of m.centerOfMass) expect(Math.abs(c)).toBeLessThan(1e-4);
      expect(shape.mass).toBeGreaterThan(0.5);
      expect(shape.principalInertia.every((v) => v > 0)).toBe(true);
      expect(shape.restingPoses.length).toBeGreaterThan(0);
      expect(shape.restingPoses[0].tippingAngle).toBeGreaterThan(0.05);
    }
  });

  it('collision hull stays aligned with the visual mesh', () => {
    const seq = new StoneSequence(99);
    for (let level = 0; level < 10; level++) {
      const shape = generateStoneShape(seq.recipe(level));
      const hull = convexHull3D(shape.collisionPoints);
      let worstOutside = 0;
      let worstInside = 0;
      for (let i = 0; i < shape.positions.length; i += 3) {
        const x = shape.positions[i];
        const y = shape.positions[i + 1];
        const z = shape.positions[i + 2];
        let maxD = -Infinity;
        for (const f of hull.faces) maxD = Math.max(maxD, f.nx * x + f.ny * y + f.nz * z - f.d);
        worstOutside = Math.max(worstOutside, maxD);
        worstInside = Math.min(worstInside, maxD);
      }
      // The visual surface never pokes through its collider…
      expect(worstOutside).toBeLessThan(0.0005);
      // …and never hides more than a few millimetres inside it (visible gaps).
      expect(worstInside).toBeGreaterThan(-0.006);
    }
  });

  it('collision hull faces stay within Rapier\'s 4-vertex contact feature limit', () => {
    // Parry merges near-coplanar triangles and only uses 4 vertices per face
    // polygon for contacts; larger faces cause single-point contacts.
    const seq = new StoneSequence(5);
    for (let level = 0; level < 16; level++) {
      const shape = generateStoneShape(seq.recipe(level));
      expect(maxMergedFaceVertices(convexHull3D(shape.collisionPoints))).toBeLessThanOrEqual(4);
    }
  });
});
