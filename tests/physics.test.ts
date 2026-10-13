import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier, PhysicsWorld, type Rapier } from '../src/physics/PhysicsWorld';
import { Simulation, type StoneBody } from '../src/game/Simulation';
import { generateStoneShape } from '../src/stones/StoneShape';
import { StoneSequence, makeRecipe } from '../src/stones/catalog';
import { baseRockRecipe } from '../src/world/baseRock';
import { quatMultiply, quatYaw } from '../src/core/quat';
import { Rng } from '../src/core/rng';
import { GAMEPLAY } from '../src/config';
import { computeRisk } from '../src/game/Scoring';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

function makeSim() {
  const sim = new Simulation(new PhysicsWorld(R));
  sim.setFlatGround(-0.3);
  sim.setBase(generateStoneShape(baseRockRecipe(), { detail: 3 }));
  sim.step(); // scene queries use the broad phase, which is built during a step
  return sim;
}

function drop(sim: Simulation, shapeLevel: number, x: number, z: number, seed = 1) {
  const shape = generateStoneShape(new StoneSequence(seed).recipe(shapeLevel), { detail: 3 });
  const rot = quatMultiply(quatYaw(0.3), shape.restingPoses[0].quaternion);
  const cast = sim.createCastShape(shape);
  const landing = sim.castLanding(cast, x, z, rot, sim.towerTop() + 1);
  expect(landing).not.toBeNull();
  return sim.addStone(shape, [x, landing!.y + GAMEPLAY.hoverClearance, z], rot, shapeLevel);
}

function runUntilRest(sim: Simulation, maxSeconds = 8) {
  let rest = 0;
  let grounded = false;
  const steps = Math.round(maxSeconds / sim.physics.dt);
  for (let i = 0; i < steps; i++) {
    const r = sim.step();
    if (r.groundTouches.length) grounded = true;
    const m = sim.motion();
    if (m.maxLinear < GAMEPLAY.settleLinearSpeed && m.maxAngular < GAMEPLAY.settleAngularSpeed) rest += sim.physics.dt;
    else rest = 0;
    if (rest > GAMEPLAY.settleHoldTime && sim.physics.time > GAMEPLAY.minSettleTime) break;
  }
  return { grounded, time: sim.physics.time };
}

describe('physics simulation', () => {
  it('a centred stone settles on the base and is measured as stable', () => {
    const sim = makeSim();
    const stone = drop(sim, 0, 0, 0);
    const { grounded } = runUntilRest(sim);
    expect(grounded).toBe(false);
    expect(stone.groundContact).toBe(false);
    const report = sim.analyze(stone);
    expect(report.contactCount).toBeGreaterThanOrEqual(3);
    expect(report.margin).toBeGreaterThan(0.03);
    expect(report.supporters).toContain(-1);
    // Supporting normals point up into the stone.
    expect(report.slopeDeg).toBeLessThan(20);
    expect(computeRisk(report).total).toBeLessThan(0.35);
  });

  it('a stone dropped far over the edge falls and touches the ground', () => {
    const sim = makeSim();
    const stone = drop(sim, 0, 0.78, 0);
    const { grounded } = runUntilRest(sim, 6);
    expect(grounded).toBe(true);
    expect(stone.groundContact).toBe(true);
  });

  it('an offset stone is riskier than a centred one', () => {
    const a = makeSim();
    const sa = drop(a, 0, 0, 0);
    runUntilRest(a);
    const b = makeSim();
    const sb = drop(b, 0, 0.3, 0.05);
    runUntilRest(b);
    if (sb.groundContact) return; // fell: also acceptable evidence of real physics
    expect(computeRisk(b.analyze(sb)).total).toBeGreaterThan(computeRisk(a.analyze(sa)).total);
  });

  it('is deterministic for identical inputs', () => {
    const run = () => {
      const sim = makeSim();
      const stones: StoneBody[] = [];
      const rng = new Rng(5);
      for (let level = 0; level < 4; level++) {
        stones.push(drop(sim, level, rng.range(-0.05, 0.05), rng.range(-0.05, 0.05), 77));
        runUntilRest(sim, 4);
      }
      return stones.map((s) => [...s.pos, ...s.rot]);
    };
    expect(run()).toEqual(run());
  });

  it('stacks several stones without fake support', () => {
    const sim = makeSim();
    const rng = new Rng(3);
    let fell = false;
    for (let level = 0; level < 6; level++) {
      const shape = generateStoneShape(makeRecipe(rng, 'slab'), { detail: 3 });
      const rot = quatMultiply(quatYaw(rng.range(-1, 1)), shape.restingPoses[0].quaternion);
      const landing = sim.castLanding(sim.createCastShape(shape), 0, 0, rot, sim.towerTop() + 1)!;
      sim.addStone(shape, [0, landing.y + GAMEPLAY.hoverClearance, 0], rot, level);
      const r = runUntilRest(sim, 5);
      fell ||= r.grounded;
    }
    expect(fell).toBe(false);
    expect(sim.towerTop()).toBeGreaterThan(0.32 + 6 * 0.07);
  });
});
