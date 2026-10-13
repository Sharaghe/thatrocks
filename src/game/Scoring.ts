import { SCORING } from '../config';
import { clamp01 } from '../core/math';
import type { StabilityReport } from './Stability';

export type TierId = (typeof SCORING.tiers)[number]['id'];

export interface RiskBreakdown {
  margin: number;
  overhang: number;
  slope: number;
  total: number;
}

export interface Tier {
  id: TierId;
  label: string;
  minRisk: number;
}

type RiskInput = Pick<StabilityReport, 'marginRatio' | 'overhang' | 'slopeDeg'>;

/** Turns measured stability values into a risk value in [0, 1]. */
export function computeRisk(report: RiskInput, config = SCORING): RiskBreakdown {
  const margin = report.marginRatio <= 0 ? 1 : 1 - clamp01(report.marginRatio / config.safeMarginFraction);
  const overhang = clamp01(report.overhang / config.overhangFull);
  const slope = clamp01(report.slopeDeg / config.slopeFullDeg);
  const w = config.weights;
  const total = clamp01(margin * w.margin + overhang * w.overhang + slope * w.slope);
  return { margin, overhang, slope, total };
}

export function riskTier(risk: number, config = SCORING): Tier {
  let tier: Tier = config.tiers[0];
  for (const t of config.tiers) if (risk >= t.minRisk) tier = t;
  return tier;
}

export function riskMultiplier(risk: number, config = SCORING): number {
  return 1 + config.riskGain * Math.pow(clamp01(risk), config.riskExponent);
}

export function comboMultiplier(combo: number, config = SCORING): number {
  if (combo < 2) return 1;
  return Math.min(config.comboMaxMultiplier, 1 + config.comboStep * (combo - 1));
}

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  placements: number;
  closeCalls: number;
}

export const initialScoreState = (): ScoreState => ({ score: 0, combo: 0, maxCombo: 0, placements: 0, closeCalls: 0 });

export interface PlacementInput {
  /** Zero-based tower level of the placed stone. */
  level: number;
  risk: number;
  closeCall: boolean;
}

export interface PlacementResult {
  points: number;
  basePoints: number;
  riskMultiplier: number;
  comboMultiplier: number;
  closeCallBonus: number;
  tier: Tier;
  combo: number;
  comboBroken: boolean;
  state: ScoreState;
}

/** Pure scoring step: returns the awarded points and the next score state. */
export function scorePlacement(state: ScoreState, input: PlacementInput, config = SCORING): PlacementResult {
  const risk = clamp01(input.risk);
  const risky = risk >= config.comboRiskThreshold;
  const combo = risky ? state.combo + 1 : 0;
  const comboBroken = !risky && state.combo >= 2;
  const basePoints = config.basePoints + config.pointsPerLevel * input.level;
  const rMult = riskMultiplier(risk, config);
  const cMult = comboMultiplier(combo, config);
  const closeCallBonus = input.closeCall ? Math.round(config.closeCallBonus * (1 + input.level * 0.1)) : 0;
  const points = Math.round(basePoints * rMult * cMult) + closeCallBonus;
  return {
    points,
    basePoints,
    riskMultiplier: rMult,
    comboMultiplier: cMult,
    closeCallBonus,
    tier: riskTier(risk, config),
    combo,
    comboBroken,
    state: {
      score: state.score + points,
      combo,
      maxCombo: Math.max(state.maxCombo, combo),
      placements: state.placements + 1,
      closeCalls: state.closeCalls + (input.closeCall ? 1 : 0),
    },
  };
}
