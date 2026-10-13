import { Rng } from '../core/rng';
import { clamp, smoothstep } from '../core/math';

/**
 * Rock materials: physical constants, colour palettes and sound signatures.
 * Densities are typical values for the rock type (kg/m³). Friction values are
 * for clean, dry-ish river stone on stone.
 */
export type RockId = 'granite' | 'sandstone' | 'basalt' | 'slate' | 'quartzite' | 'limestone';

export interface RockMaterial {
  id: RockId;
  name: string;
  density: number;
  friction: number;
  restitution: number;
  /** sRGB palette the base tone is picked from. */
  palette: string[];
  /** Secondary tone for mottling. */
  secondary: string;
  mottle: number;
  /** Visual grain/speckle strength used by the shader (0–1). */
  speckle: number;
  /** Sedimentary banding strength (0–1). */
  banding: number;
  veinChance: number;
  lichenChance: number;
  roughness: number;
  /** Sound: base modal frequency multiplier, ring (Q) and brightness. */
  sound: { pitch: number; ring: number; brightness: number; grit: number };
}

export const ROCKS: Record<RockId, RockMaterial> = {
  granite: {
    id: 'granite',
    name: 'Granite',
    density: 2700,
    friction: 0.78,
    restitution: 0.08,
    palette: ['#8f8a84', '#9a948d', '#a39b92', '#857f7a'],
    secondary: '#b4aba0',
    mottle: 0.12,
    speckle: 0.9,
    banding: 0,
    veinChance: 0.25,
    lichenChance: 0.25,
    roughness: 0.78,
    sound: { pitch: 1.0, ring: 1.0, brightness: 1.0, grit: 0.7 },
  },
  sandstone: {
    id: 'sandstone',
    name: 'Sandstone',
    density: 2350,
    friction: 0.9,
    restitution: 0.04,
    palette: ['#b38f6c', '#a8835f', '#bf9c78', '#9d7a5a'],
    secondary: '#c9ab88',
    mottle: 0.16,
    speckle: 0.35,
    banding: 0.55,
    veinChance: 0.05,
    lichenChance: 0.3,
    roughness: 0.92,
    sound: { pitch: 0.72, ring: 0.45, brightness: 0.55, grit: 1.0 },
  },
  basalt: {
    id: 'basalt',
    name: 'Basalt',
    density: 3000,
    friction: 0.72,
    restitution: 0.09,
    palette: ['#4a4846', '#55524e', '#3f3e3d', '#5c5853'],
    secondary: '#6a655f',
    mottle: 0.1,
    speckle: 0.25,
    banding: 0,
    veinChance: 0.12,
    lichenChance: 0.2,
    roughness: 0.7,
    sound: { pitch: 0.85, ring: 1.15, brightness: 0.8, grit: 0.5 },
  },
  slate: {
    id: 'slate',
    name: 'Slate',
    density: 2800,
    friction: 0.62,
    restitution: 0.1,
    palette: ['#5b6168', '#646a70', '#525860', '#6d6e70'],
    secondary: '#7b7f82',
    mottle: 0.08,
    speckle: 0.1,
    banding: 0.35,
    veinChance: 0.08,
    lichenChance: 0.1,
    roughness: 0.58,
    sound: { pitch: 1.35, ring: 1.6, brightness: 1.25, grit: 0.35 },
  },
  quartzite: {
    id: 'quartzite',
    name: 'Quartzite',
    density: 2650,
    friction: 0.66,
    restitution: 0.1,
    palette: ['#c9c2b6', '#d3cdc2', '#bdb5a8', '#d8cfc0'],
    secondary: '#e6dfd3',
    mottle: 0.1,
    speckle: 0.4,
    banding: 0.15,
    veinChance: 0.15,
    lichenChance: 0.08,
    roughness: 0.55,
    sound: { pitch: 1.2, ring: 1.3, brightness: 1.3, grit: 0.45 },
  },
  limestone: {
    id: 'limestone',
    name: 'Limestone',
    density: 2500,
    friction: 0.82,
    restitution: 0.05,
    palette: ['#aaa597', '#b5ae9e', '#9f9a8c', '#bcb4a2'],
    secondary: '#c8c0ae',
    mottle: 0.14,
    speckle: 0.3,
    banding: 0.25,
    veinChance: 0.1,
    lichenChance: 0.35,
    roughness: 0.85,
    sound: { pitch: 0.9, ring: 0.7, brightness: 0.75, grit: 0.85 },
  },
};

export const ROCK_IDS = Object.keys(ROCKS) as RockId[];

export type ArchetypeId = 'slab' | 'disc' | 'wedge' | 'cobble' | 'block' | 'pebble' | 'boulder';

export interface CutPlane {
  normal: [number, number, number];
  offset: number;
}

/** Fully specified stone recipe; deterministic given its seeds. */
export interface StoneRecipe {
  archetype: ArchetypeId;
  rock: RockId;
  radii: [number, number, number];
  exponent: number;
  cuts: CutPlane[];
  softness: number;
  lumpAmp: number;
  lumpFreq: number;
  detailAmp: number;
  detailFreq: number;
  noiseSeed: number;
  colorSeed: number;
  /** Random yaw applied to the spawn orientation. */
  yaw: number;
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Superellipsoid radial distance in a given direction. */
export function superRadius(d: readonly number[], radii: readonly number[], p: number): number {
  const s =
    Math.pow(Math.abs(d[0] / radii[0]), p) + Math.pow(Math.abs(d[1] / radii[1]), p) + Math.pow(Math.abs(d[2] / radii[2]), p);
  return 1 / Math.pow(s, 1 / p);
}

/** Cap plane tilted up to `maxTiltDeg` away from `axis`, cutting at `fraction` of the radius. */
function cap(rng: Rng, axis: [number, number, number], maxTiltDeg: number, radius: number, fraction: number): CutPlane {
  const tilt = (rng.range(0, maxTiltDeg) * Math.PI) / 180;
  const az = rng.range(0, Math.PI * 2);
  // perpendicular basis
  const helper: [number, number, number] = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize([
    axis[1] * helper[2] - axis[2] * helper[1],
    axis[2] * helper[0] - axis[0] * helper[2],
    axis[0] * helper[1] - axis[1] * helper[0],
  ]);
  const w: [number, number, number] = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  const n = normalize([
    axis[0] * ct + (u[0] * Math.cos(az) + w[0] * Math.sin(az)) * st,
    axis[1] * ct + (u[1] * Math.cos(az) + w[1] * Math.sin(az)) * st,
    axis[2] * ct + (u[2] * Math.cos(az) + w[2] * Math.sin(az)) * st,
  ]);
  return { normal: n, offset: radius * fraction };
}

function sideCuts(rng: Rng, count: number, radii: [number, number, number], exponent: number, depth: [number, number], vertical = 0.25): CutPlane[] {
  const cuts: CutPlane[] = [];
  const base = rng.range(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const a = base + (i / count) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const n = normalize([Math.cos(a), rng.range(-vertical, vertical), Math.sin(a)]);
    const r = superRadius(n, radii, exponent);
    cuts.push({ normal: n, offset: r * rng.range(depth[0], depth[1]) });
  }
  return cuts;
}

function randomCuts(rng: Rng, count: number, radii: [number, number, number], exponent: number, depth: [number, number]): CutPlane[] {
  const cuts: CutPlane[] = [];
  for (let i = 0; i < count; i++) {
    const n = normalize(rng.unitVector());
    const r = superRadius(n, radii, exponent);
    cuts.push({ normal: n, offset: r * rng.range(depth[0], depth[1]) });
  }
  return cuts;
}

const ROCK_WEIGHTS: Record<ArchetypeId, Partial<Record<RockId, number>>> = {
  slab: { slate: 3, sandstone: 3, limestone: 2, granite: 1.2, basalt: 1 },
  disc: { slate: 2, sandstone: 2, granite: 1, limestone: 1.5, quartzite: 1 },
  wedge: { slate: 2, sandstone: 2, granite: 1.5, basalt: 1, limestone: 1 },
  cobble: { granite: 3, basalt: 2, quartzite: 2, limestone: 1, sandstone: 1 },
  block: { granite: 2, basalt: 2, limestone: 2, sandstone: 1.5, quartzite: 1 },
  pebble: { quartzite: 2.5, granite: 2, basalt: 2, slate: 1 },
  boulder: { granite: 2, basalt: 1, sandstone: 1, limestone: 1 },
};

/** Spawn weights per archetype as a function of tower level (difficulty ramp). */
export function archetypeWeights(level: number): Record<Exclude<ArchetypeId, 'boulder'>, number> {
  const t = smoothstep(2, 22, level);
  return {
    slab: 4 - 2 * t,
    disc: 1.6 - 0.9 * t,
    wedge: 0.4 + 1.5 * t,
    cobble: 0.8 + 1.6 * t,
    block: 0.7 + 0.8 * t,
    pebble: 0.05 + 1.0 * t,
  };
}

export function makeRecipe(rng: Rng, archetype: ArchetypeId, scale = 1, rockOverride?: RockId): StoneRecipe {
  const rockWeights = ROCK_WEIGHTS[archetype];
  const rockIds = Object.keys(rockWeights) as RockId[];
  const rock = rockOverride ?? rng.weighted(rockIds, rockIds.map((id) => rockWeights[id] ?? 0));
  const s = scale;
  let radii: [number, number, number];
  let exponent: number;
  let cuts: CutPlane[] = [];
  let softness: number;
  let lumpAmp = rng.range(0.014, 0.028);

  switch (archetype) {
    case 'slab': {
      radii = [rng.range(0.17, 0.25) * s, rng.range(0.055, 0.085) * s, rng.range(0.13, 0.2) * s];
      exponent = rng.range(2.3, 3.1);
      cuts.push(cap(rng, [0, 1, 0], 7, radii[1], rng.range(0.62, 0.82)));
      cuts.push(cap(rng, [0, -1, 0], 6, radii[1], rng.range(0.62, 0.82)));
      cuts.push(...sideCuts(rng, rng.int(2, 4), radii, exponent, [0.8, 0.95], 0.2));
      softness = rng.range(0.012, 0.02) * s;
      break;
    }
    case 'disc': {
      const r = rng.range(0.2, 0.26) * s;
      radii = [r * rng.range(0.92, 1.08), rng.range(0.05, 0.075) * s, r * rng.range(0.9, 1.05)];
      exponent = rng.range(2.1, 2.5);
      cuts.push(cap(rng, [0, 1, 0], 4, radii[1], rng.range(0.6, 0.78)));
      cuts.push(cap(rng, [0, -1, 0], 4, radii[1], rng.range(0.6, 0.78)));
      softness = rng.range(0.015, 0.022) * s;
      lumpAmp *= 0.8;
      break;
    }
    case 'wedge': {
      radii = [rng.range(0.15, 0.22) * s, rng.range(0.07, 0.1) * s, rng.range(0.12, 0.18) * s];
      exponent = rng.range(2.2, 3.0);
      const top = cap(rng, [0, 1, 0], 2, radii[1], rng.range(0.45, 0.65));
      // tilt the top strongly in a random horizontal direction
      const a = rng.range(0, Math.PI * 2);
      const tilt = (rng.range(11, 19) * Math.PI) / 180;
      top.normal = normalize([Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)]);
      cuts.push(top, cap(rng, [0, -1, 0], 5, radii[1], rng.range(0.6, 0.8)));
      cuts.push(...sideCuts(rng, rng.int(1, 3), radii, exponent, [0.82, 0.95], 0.25));
      softness = rng.range(0.012, 0.019) * s;
      break;
    }
    case 'cobble': {
      const r = rng.range(0.12, 0.17) * s;
      radii = [r * rng.range(0.95, 1.2), r * rng.range(0.6, 0.82), r * rng.range(0.85, 1.05)];
      exponent = rng.range(2.0, 2.4);
      cuts.push(cap(rng, [0, -1, 0], 10, radii[1], rng.range(0.75, 0.92)));
      cuts.push(...randomCuts(rng, rng.int(2, 4), radii, exponent, [0.82, 0.95]));
      softness = rng.range(0.016, 0.026) * s;
      lumpAmp *= 1.2;
      break;
    }
    case 'block': {
      const r = rng.range(0.11, 0.15) * s;
      radii = [r * rng.range(0.95, 1.25), r * rng.range(0.75, 0.95), r * rng.range(0.9, 1.15)];
      exponent = rng.range(2.8, 3.6);
      cuts.push(cap(rng, [0, 1, 0], 9, radii[1], rng.range(0.78, 0.92)));
      cuts.push(cap(rng, [0, -1, 0], 7, radii[1], rng.range(0.78, 0.92)));
      cuts.push(...randomCuts(rng, rng.int(3, 6), radii, exponent, [0.78, 0.92]));
      softness = rng.range(0.008, 0.014) * s;
      break;
    }
    case 'pebble': {
      const r = rng.range(0.085, 0.12) * s;
      radii = [r * rng.range(1.0, 1.25), r * rng.range(0.55, 0.75), r * rng.range(0.85, 1.05)];
      exponent = rng.range(2.0, 2.2);
      if (rng.chance(0.6)) cuts.push(cap(rng, [0, -1, 0], 8, radii[1], rng.range(0.82, 0.94)));
      softness = rng.range(0.018, 0.026) * s;
      lumpAmp *= 0.7;
      break;
    }
    case 'boulder': {
      const r = rng.range(0.5, 0.62) * s;
      radii = [r * rng.range(1.0, 1.15), r * rng.range(0.55, 0.7), r * rng.range(0.92, 1.06)];
      exponent = rng.range(2.2, 2.6);
      cuts.push(cap(rng, [0, 1, 0], 2.5, radii[1], rng.range(0.6, 0.7)));
      cuts.push(...sideCuts(rng, rng.int(3, 5), radii, exponent, [0.85, 0.96], 0.4));
      softness = 0.05 * s;
      lumpAmp *= 1.3;
      break;
    }
  }

  return {
    archetype,
    rock,
    radii,
    exponent,
    cuts,
    softness: clamp(softness * 1.6, 0.006, 0.1),
    lumpAmp,
    lumpFreq: rng.range(1.5, 2.4),
    detailAmp: rng.range(0.003, 0.006),
    detailFreq: rng.range(6, 9),
    noiseSeed: rng.nextUint(),
    colorSeed: rng.nextUint(),
    yaw: rng.range(-Math.PI, Math.PI),
  };
}

/**
 * Deterministic stone sequence for a game: the n-th stone of a seed is always
 * the same, independent of how the game went.
 */
export class StoneSequence {
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  recipe(level: number): StoneRecipe {
    const rng = new Rng((this.seed ^ Math.imul(level + 1, 0x9e3779b1)) >>> 0);
    const weights = archetypeWeights(level);
    const ids = Object.keys(weights) as (keyof typeof weights)[];
    // First stone is always a forgiving slab or disc.
    const archetype = level === 0 ? rng.pick(['slab', 'disc'] as const) : rng.weighted(ids, ids.map((id) => weights[id]));
    // Cairn logic: stones get somewhat smaller as the tower grows.
    const scale = (1 - 0.22 * smoothstep(0, 26, level)) * rng.range(0.9, 1.1);
    return makeRecipe(rng, archetype, scale);
  }
}
