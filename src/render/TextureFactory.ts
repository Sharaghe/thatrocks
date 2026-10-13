import * as THREE from 'three';

/**
 * Procedural, tileable PBR detail textures rendered once on the GPU at start-up.
 *
 * Suitable CC0 texture libraries (Poly Haven, ambientCG) were not reachable
 * from the build environment, so every surface texture is generated here
 * instead — deterministic, resolution independent and zero download size.
 *
 * Packing (RGBA8, linear data):
 *   stoneA / sand / pebbles / moss / water:  RG = tangent-space normal.xy,
 *     B = albedo variation (pebbles: per-pebble tone, water: caustics), A = height/cavity
 *   stoneB:  R = dark mineral speckles, G = light speckles, B = roughness variation
 */
export type TextureKind = 'stoneA' | 'stoneB' | 'sand' | 'pebbles' | 'moss' | 'water';

const MODES: Record<TextureKind, number> = { stoneA: 0, stoneB: 1, sand: 2, pebbles: 3, moss: 4, water: 5 };

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform int uMode;
uniform float uSeed;
uniform float uTexel;

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.01731);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.01373);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Periodic gradient noise: integer frequencies tile seamlessly over [0,1).
float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(mod(i, per)) * 2.0 - 1.0;
  vec2 g10 = hash22(mod(i + vec2(1.0, 0.0), per)) * 2.0 - 1.0;
  vec2 g01 = hash22(mod(i + vec2(0.0, 1.0), per)) * 2.0 - 1.0;
  vec2 g11 = hash22(mod(i + vec2(1.0, 1.0), per)) * 2.0 - 1.0;
  float a = dot(g00, f);
  float b = dot(g10, f - vec2(1.0, 0.0));
  float c = dot(g01, f - vec2(0.0, 1.0));
  float d = dot(g11, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.45;
}
float fbm(vec2 uv, float freq, int octaves, float gain) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    s += a * gnoise(uv * freq, vec2(freq));
    n += a;
    a *= gain;
    freq *= 2.0;
  }
  return s / n;
}
// Periodic Worley noise. Returns (F1, F2, cell hash).
vec3 cellular(vec2 uv, float freq) {
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 cell = mod(i + o, vec2(freq));
      vec2 r = o + hash22(cell) * 0.85 + 0.075 - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash12(cell + 7.3); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

float heightStone(vec2 uv) {
  float h = 0.55 * fbm(uv, 3.0, 6, 0.55);
  h += 0.22 * fbm(uv + 0.37, 24.0, 3, 0.5);
  vec3 c = cellular(uv, 36.0);
  h -= 0.28 * smoothstep(0.32, 0.0, c.x) * step(0.55, c.z);   // weathering pits
  h += 0.08 * gnoise(uv * 160.0, vec2(160.0));                  // grain
  return h;
}
float heightSand(vec2 uv) {
  float warp = fbm(uv, 3.0, 3, 0.5);
  float ripples = sin((uv.y + warp * 0.12 + 0.03 * sin(uv.x * 6.2831 * 2.0)) * 6.2831 * 14.0);
  float h = 0.18 * ripples * (0.6 + 0.4 * fbm(uv + 0.5, 2.0, 2, 0.5));
  h += 0.35 * fbm(uv, 8.0, 4, 0.5);
  h += 0.22 * gnoise(uv * 220.0, vec2(220.0));
  return h;
}
float heightPebbles(vec2 uv) {
  vec3 big = cellular(uv, 11.0);
  vec3 small = cellular(uv + 0.31, 29.0);
  float hb = sqrt(clamp(1.0 - pow(big.x / max(big.y, 1e-3), 2.0) * 1.15, 0.0, 1.0));
  float hs = sqrt(clamp(1.0 - pow(small.x / max(small.y, 1e-3), 2.0) * 1.2, 0.0, 1.0));
  float h = max(hb, hs * 0.55);
  h = max(h, 0.18 + 0.1 * fbm(uv + 0.6, 16.0, 3, 0.5)); // sand bed between pebbles
  h += 0.05 * gnoise(uv * 140.0, vec2(140.0));
  return h;
}
float heightMoss(vec2 uv) {
  float h = 0.5 * fbm(uv, 6.0, 5, 0.6);
  h += 0.25 * abs(gnoise(uv * vec2(90.0, 30.0), vec2(90.0, 30.0)));
  h += 0.18 * gnoise(uv * 200.0, vec2(200.0));
  return h;
}
float heightWater(vec2 uv) {
  return 0.6 * fbm(uv, 4.0, 5, 0.52) + 0.25 * fbm(uv + 0.21, 12.0, 3, 0.5);
}
float heightOf(vec2 uv) {
  if (uMode == 0 || uMode == 1) return heightStone(uv);
  if (uMode == 2) return heightSand(uv);
  if (uMode == 3) return heightPebbles(uv);
  if (uMode == 4) return heightMoss(uv);
  return heightWater(uv);
}

vec2 normalXY(vec2 uv, float strength) {
  float e = uTexel;
  float hl = heightOf(uv - vec2(e, 0.0));
  float hr = heightOf(uv + vec2(e, 0.0));
  float hd = heightOf(uv - vec2(0.0, e));
  float hu = heightOf(uv + vec2(0.0, e));
  vec3 n = normalize(vec3((hl - hr) * strength, (hd - hu) * strength, 1.0));
  return n.xy * 0.5 + 0.5;
}

void main() {
  vec2 uv = vUv;
  vec4 outColor = vec4(0.5, 0.5, 0.5, 1.0);
  if (uMode == 0) {
    float h = heightStone(uv);
    outColor = vec4(normalXY(uv, 0.9), 0.5 + 0.5 * fbm(uv + 0.71, 6.0, 4, 0.55), clamp(0.55 + h * 0.9, 0.0, 1.0));
  } else if (uMode == 1) {
    vec3 c = cellular(uv, 85.0);
    float dark = smoothstep(0.42, 0.18, c.x) * step(0.62, c.z);
    vec3 c2 = cellular(uv + 0.5, 60.0);
    float light = smoothstep(0.38, 0.12, c2.x) * step(c2.z, 0.18);
    float rough = 0.5 + 0.5 * fbm(uv + 0.13, 10.0, 3, 0.5);
    outColor = vec4(dark, light, rough, 1.0);
  } else if (uMode == 2) {
    float h = heightSand(uv);
    float grains = hash12(floor(uv * 512.0));
    float v = 0.5 + 0.35 * fbm(uv + 0.2, 5.0, 4, 0.5) + (grains - 0.5) * 0.25;
    outColor = vec4(normalXY(uv, 0.55), v, clamp(0.5 + h, 0.0, 1.0));
  } else if (uMode == 3) {
    vec3 big = cellular(uv, 11.0);
    float h = heightPebbles(uv);
    outColor = vec4(normalXY(uv, 1.3), big.z, clamp(h, 0.0, 1.0));
  } else if (uMode == 4) {
    float h = heightMoss(uv);
    float v = 0.5 + 0.45 * fbm(uv + 0.4, 3.0, 4, 0.55);
    outColor = vec4(normalXY(uv, 1.1), v, clamp(0.5 + h, 0.0, 1.0));
  } else {
    // Water ripples + animated-caustics source pattern (Voronoi ridges).
    vec2 w = vec2(fbm(uv, 3.0, 3, 0.5), fbm(uv + 0.5, 3.0, 3, 0.5));
    vec3 c = cellular(uv + w * 0.06, 9.0);
    float caustic = 1.0 - smoothstep(0.0, 0.16, c.y - c.x);
    outColor = vec4(normalXY(uv, 0.7), caustic, 1.0);
  }
  gl_FragColor = outColor;
}
`;

export class TextureFactory {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly targets: THREE.WebGLRenderTarget[] = [];

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uMode: { value: 0 }, uSeed: { value: 1 }, uTexel: { value: 1 / 512 } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  generate(kind: TextureKind, size: number, seed = 1): THREE.Texture {
    const target = new THREE.WebGLRenderTarget(size, size, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    target.texture.name = `procedural-${kind}`;
    this.material.uniforms.uMode.value = MODES[kind];
    this.material.uniforms.uSeed.value = seed;
    this.material.uniforms.uTexel.value = 1 / size;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    this.targets.push(target);
    return target.texture;
  }

  dispose(): void {
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

export interface SurfaceTextures {
  stoneA: THREE.Texture;
  stoneB: THREE.Texture;
  sand: THREE.Texture;
  pebbles: THREE.Texture;
  moss: THREE.Texture;
  water: THREE.Texture;
}

export function generateSurfaceTextures(renderer: THREE.WebGLRenderer, size: number): SurfaceTextures {
  const f = new TextureFactory(renderer);
  const small = Math.max(256, size / 2);
  const textures: SurfaceTextures = {
    stoneA: f.generate('stoneA', size, 3),
    stoneB: f.generate('stoneB', size, 5),
    sand: f.generate('sand', size, 7),
    pebbles: f.generate('pebbles', size, 11),
    moss: f.generate('moss', size, 13),
    water: f.generate('water', small, 17),
  };
  f.dispose();
  return textures;
}
