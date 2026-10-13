/**
 * Central, tweakable game configuration.
 *
 * Every gameplay, physics, scoring, camera and quality parameter lives here so
 * balancing never requires hunting through modules. Units are SI (metres,
 * seconds, kilograms) unless noted otherwise.
 */

export const PHYSICS = {
  /** Fixed simulation step. 120 Hz keeps small, irregular stones stable. */
  fixedDt: 1 / 120,
  /** Upper bound of physics steps per rendered frame (prevents spiral of death). */
  maxStepsPerFrame: 8,
  gravity: -9.81,
  /** Rapier's characteristic object size; scales sleep thresholds and tolerances. */
  lengthUnit: 0.3,
  solverIterations: 8,
  internalPgsIterations: 1,
  /** Extra solver iterations for stones (tall stacks need well-converged contacts). */
  additionalSolverIterations: 4,
  linearDamping: 0.05,
  angularDamping: 0.12,
  /** Small skin so convex hulls rest without visible jitter. */
  contactSkin: 0.0015,
  maxCcdSubsteps: 2,
  /** Base / terrain friction. Stone friction comes from the rock material. */
  groundFriction: 0.85,
  groundRestitution: 0.05,
  /** Contact-force event threshold relative to a stone's static weight. */
  impactForceThresholdWeights: 1.6,
} as const;

export const GAMEPLAY = {
  /** Vertical gap between the held stone's lowest point and the landing surface. */
  hoverClearance: 0.045,
  /** Max horizontal distance of the held stone from the tower axis. */
  maxHorizontalRange: 1.15,
  /** Simulated time a drop must at least run before it can count as settled. */
  minSettleTime: 0.45,
  /** Velocities below which the world counts as at rest. */
  settleLinearSpeed: 0.03,
  settleAngularSpeed: 0.12,
  /** How long the tower must stay at rest before the placement is scored. */
  settleHoldTime: 0.45,
  /** Give up waiting for full rest after this long and score the current state. */
  settleTimeout: 7,
  /** Simulated seconds the collapse plays out before the results screen. */
  collapseDuration: 2.6,
  /** A stone below this height (m) has fallen out of bounds. */
  outOfBoundsY: -3,
  outOfBoundsRadius: 14,
  /** Angular speed that marks a dramatic wobble once the landing transient is over (rad/s). */
  wobbleAngularSpeed: 1.4,
  /** Landing transient ignored by wobble detection (s). */
  wobbleIgnoreTime: 0.22,
  /** The new stone rocked this far (deg) away from where it finally rests → close call. */
  closeCallTiltDeg: 9,
  /** An older stone swayed this far (deg) and recovered → close call. */
  closeCallTowerTiltDeg: 3.5,
  slowMotionScale: 0.32,
  slowMotionMaxRealTime: 1.1,
  /** Continuous rotation speed when a rotate button is held (rad/s). */
  rotateSpeed: Math.PI * 0.6,
  rotateStep: Math.PI / 12,
  /** Input smoothing time constant (s); small enough to keep precision. */
  inputSmoothing: 0.045,
  /** Drag gain range; slow drags map to the low end for fine positioning. */
  dragGainSlow: 0.55,
  dragGainFast: 1.25,
  dragSpeedForFullGain: 900, // px/s
} as const;

export const SCORING = {
  basePoints: 10,
  pointsPerLevel: 2,
  /** riskMultiplier = 1 + riskGain * risk^riskExponent */
  riskGain: 3,
  riskExponent: 1.5,
  /** Margin (as a fraction of the stone's footprint radius) considered perfectly safe. */
  safeMarginFraction: 0.45,
  /** Weighting of the individual risk components (sums to 1). */
  weights: { margin: 0.62, overhang: 0.2, slope: 0.18 },
  /** Horizontal offset from the supporting stone (in footprint radii) that maxes overhang risk. */
  overhangFull: 1.1,
  /** Contact slope (deg) that maxes slope risk. */
  slopeFullDeg: 32,
  /** Placements at or above this risk extend the combo. */
  comboRiskThreshold: 0.5,
  comboStep: 0.25,
  comboMaxMultiplier: 3,
  closeCallBonus: 25,
  tiers: [
    { id: 'steady', label: 'Steady', minRisk: 0 },
    { id: 'bold', label: 'Bold', minRisk: 0.3 },
    { id: 'daring', label: 'Daring', minRisk: 0.55 },
    { id: 'knife', label: 'Knife-edge', minRisk: 0.8 },
  ],
} as const;

export const CAMERA = {
  fovPortrait: 48,
  fovLandscape: 40,
  pitchDeg: 17,
  /** Vertical world span kept in view around the working height. */
  minSpan: 1.55,
  maxSpan: 3.4,
  spanPerMetre: 0.32,
  /** Minimum horizontal world span (keeps the placement range visible in portrait). */
  minHorizontalSpan: 1.25,
  /** Fraction of the span placed below the focus point. */
  focusBias: 0.6,
  followDamping: 3.2,
  orbitDamping: 9,
  zoomMin: 0.7,
  zoomMax: 1.7,
  shakeMax: 0.035,
  shakeDecay: 1.8,
  shakeFrequency: 22,
} as const;

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  maxPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  softShadows: boolean;
  stoneDetail: number; // icosphere subdivisions for visual stones
  textureSize: number;
  terrainSegments: number;
  scatterDensity: number;
  grassBlades: number;
  trees: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1.35,
    antialias: false,
    shadowMapSize: 1024,
    softShadows: false,
    stoneDetail: 3,
    textureSize: 512,
    terrainSegments: 110,
    scatterDensity: 0.45,
    grassBlades: 1800,
    trees: 60,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 2,
    antialias: true,
    shadowMapSize: 2048,
    softShadows: true,
    stoneDetail: 4,
    textureSize: 1024,
    terrainSegments: 170,
    scatterDensity: 0.75,
    grassBlades: 4500,
    trees: 110,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    antialias: true,
    shadowMapSize: 2048,
    softShadows: true,
    stoneDetail: 4,
    textureSize: 1024,
    terrainSegments: 220,
    scatterDensity: 1,
    grassBlades: 9000,
    trees: 160,
  },
};

export const ADAPTIVE = {
  /** Window over which frame times are averaged before adapting. */
  sampleSeconds: 2.5,
  /** Average frame time (ms) above which resolution is reduced. */
  downshiftMs: 21,
  /** Average frame time (ms) below which resolution may be raised again. */
  upshiftMs: 13.5,
  minResolutionScale: 0.6,
  resolutionStep: 0.1,
} as const;

export const WORLD = {
  waterLevel: 0,
  /** Height of the base rock's flat top above the water. */
  baseTop: 0.32,
  baseRadius: 0.62,
  environmentSeed: 20250611,
} as const;

export const STORAGE_KEY = 'rockstack.v1';
