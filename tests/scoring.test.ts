import { describe, expect, it } from 'vitest';
import {
  comboMultiplier,
  computeRisk,
  initialScoreState,
  riskMultiplier,
  riskTier,
  scorePlacement,
} from '../src/game/Scoring';
import { SCORING } from '../src/config';

describe('risk', () => {
  it('is zero for a centred, flat placement on a wide support', () => {
    const r = computeRisk({ marginRatio: 0.8, overhang: 0, slopeDeg: 0 });
    expect(r.total).toBe(0);
  });

  it('is maximal when the centre of mass is outside the support polygon', () => {
    const r = computeRisk({ marginRatio: -0.1, overhang: 2, slopeDeg: 60 });
    expect(r.margin).toBe(1);
    expect(r.overhang).toBe(1);
    expect(r.slope).toBe(1);
    expect(r.total).toBeCloseTo(1);
  });

  it('grows monotonically as the margin shrinks', () => {
    const margins = [0.6, 0.4, 0.3, 0.2, 0.1, 0.02];
    const risks = margins.map((m) => computeRisk({ marginRatio: m, overhang: 0.3, slopeDeg: 5 }).total);
    for (let i = 1; i < risks.length; i++) expect(risks[i]).toBeGreaterThanOrEqual(risks[i - 1]);
  });

  it('weights sum to one', () => {
    const w = SCORING.weights;
    expect(w.margin + w.overhang + w.slope).toBeCloseTo(1);
  });
});

describe('tiers and multipliers', () => {
  it('maps risk to the configured tiers', () => {
    expect(riskTier(0).id).toBe('steady');
    expect(riskTier(0.29).id).toBe('steady');
    expect(riskTier(0.3).id).toBe('bold');
    expect(riskTier(0.6).id).toBe('daring');
    expect(riskTier(0.95).id).toBe('knife');
  });

  it('risk multiplier ranges from 1 to 1 + gain', () => {
    expect(riskMultiplier(0)).toBe(1);
    expect(riskMultiplier(1)).toBe(1 + SCORING.riskGain);
    expect(riskMultiplier(2)).toBe(1 + SCORING.riskGain); // clamped
  });

  it('combo multiplier starts at the second risky placement and is capped', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(2)).toBeCloseTo(1 + SCORING.comboStep);
    expect(comboMultiplier(100)).toBe(SCORING.comboMaxMultiplier);
  });
});

describe('scorePlacement', () => {
  it('awards base points plus level bonus for a safe placement', () => {
    const r = scorePlacement(initialScoreState(), { level: 3, risk: 0, closeCall: false });
    expect(r.points).toBe(SCORING.basePoints + 3 * SCORING.pointsPerLevel);
    expect(r.state.score).toBe(r.points);
    expect(r.state.placements).toBe(1);
    expect(r.combo).toBe(0);
  });

  it('pays more for riskier placements at the same level', () => {
    const safe = scorePlacement(initialScoreState(), { level: 5, risk: 0.1, closeCall: false });
    const bold = scorePlacement(initialScoreState(), { level: 5, risk: 0.6, closeCall: false });
    const knife = scorePlacement(initialScoreState(), { level: 5, risk: 0.95, closeCall: false });
    expect(bold.points).toBeGreaterThan(safe.points);
    expect(knife.points).toBeGreaterThan(bold.points);
  });

  it('builds a combo for consecutive risky placements and breaks it on a safe one', () => {
    let state = initialScoreState();
    const risky = { level: 1, risk: 0.7, closeCall: false };
    const r1 = scorePlacement(state, risky);
    state = r1.state;
    const r2 = scorePlacement(state, { ...risky, level: 2 });
    state = r2.state;
    const r3 = scorePlacement(state, { ...risky, level: 3 });
    state = r3.state;
    expect([r1.combo, r2.combo, r3.combo]).toEqual([1, 2, 3]);
    expect(r3.comboMultiplier).toBeGreaterThan(r2.comboMultiplier);
    expect(state.maxCombo).toBe(3);
    const r4 = scorePlacement(state, { level: 4, risk: 0.1, closeCall: false });
    expect(r4.combo).toBe(0);
    expect(r4.comboBroken).toBe(true);
    expect(r4.state.maxCombo).toBe(3);
  });

  it('adds a close-call bonus that scales with height', () => {
    const low = scorePlacement(initialScoreState(), { level: 0, risk: 0.5, closeCall: true });
    const high = scorePlacement(initialScoreState(), { level: 10, risk: 0.5, closeCall: true });
    expect(low.closeCallBonus).toBe(SCORING.closeCallBonus);
    expect(high.closeCallBonus).toBeGreaterThan(low.closeCallBonus);
    expect(low.state.closeCalls).toBe(1);
  });

  it('never mutates the input state', () => {
    const state = initialScoreState();
    scorePlacement(state, { level: 2, risk: 0.9, closeCall: true });
    expect(state).toEqual(initialScoreState());
  });
});
