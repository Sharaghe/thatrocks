import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, type QualitySettings } from '../config';
import { Rng } from '../core/rng';
import { Noise3 } from '../core/noise';
import { clamp01, smoothstep } from '../core/math';
import { Terrain } from '../world/terrain';
import { generateStoneShape, type StoneShape, type Vec3 } from '../stones/StoneShape';
import { makeRecipe, type RockId } from '../stones/catalog';
import { createStoneMaterial, sharedUniforms } from './materials';
import type { SurfaceTextures } from './TextureFactory';
import { stoneGeometry } from './stoneGeometry';

export interface EnvironmentOptions {
  quality: QualitySettings;
  textures: SurfaceTextures;
  terrain: Terrain;
  baseShape: StoneShape;
  basePosition: Vec3;
  seed?: number;
}

/** Sun direction (towards the sun): warm late-afternoon light from behind-left of the default view. */
export const SUN_DIRECTION = new THREE.Vector3(0.56, 0.47, 0.68).normalize();
export const FOG_COLOR = new THREE.Color('#c9cdc0');

/**
 * The riverbank: sky, sun and image-based light, terrain with sand, gravel and
 * moss, a shallow stream with caustics, scattered pebbles, boulders, grass,
 * reeds and a distant tree line.
 */
export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly baseMesh: THREE.Mesh;
  private readonly shadowFocus = new THREE.Vector3();
  private readonly rng: Rng;
  private readonly noise: Noise3;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  envMap: THREE.Texture | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly opts: EnvironmentOptions,
  ) {
    const seed = opts.seed ?? WORLD.environmentSeed;
    this.rng = new Rng(seed);
    this.noise = new Noise3(seed ^ 0x51ab);
    scene.add(this.group);

    this.createSky();
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.021);

    this.sun = new THREE.DirectionalLight('#ffdcb0', 4.0);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(opts.quality.shadowMapSize, opts.quality.shadowMapSize);
    s.camera.near = 0.5;
    s.camera.far = 30;
    s.bias = -0.0003;
    s.normalBias = 0.012;
    s.radius = 3;
    this.setShadowExtent(2.4);
    scene.add(this.sun, this.sun.target);
    // Soft sky fill from above, warm bounce from the ground.
    scene.add(new THREE.HemisphereLight('#c4d6f2', '#86704e', 0.16));

    this.createTerrain();
    this.createWater();
    this.baseMesh = this.createBaseRock();
    this.createScatter();
    this.createGrass();
    this.createTrees();
  }

  private createSky() {
    const sky = new Sky();
    sky.scale.setScalar(450);
    const u = sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 1.25;
    u.mieCoefficient.value = 0.0045;
    u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(SUN_DIRECTION);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = 0.32;
      u.cloudDensity.value = 0.35;
      u.cloudScale.value = 0.00018;
    }
    this.scene.add(sky);

    // Image-based lighting from the same sky.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(450);
    for (const key of Object.keys(u)) {
      const src = u[key].value;
      envSky.material.uniforms[key].value = src && typeof src.clone === 'function' ? src.clone() : src;
    }
    // The sun disc is far brighter than half-float PMREM targets can hold
    // (inf → NaN → black lighting), so the IBL capture uses the sky without it.
    if (envSky.material.uniforms.showSunDisc) envSky.material.uniforms.showSunDisc.value = 0;
    envScene.add(envSky);
    // A dim ground disc so the lower hemisphere is earth-coloured, not sky.
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 32), new THREE.MeshBasicMaterial({ color: '#4a4636', side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    const rt = pmrem.fromScene(envScene, 0.02);
    this.envMap = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
  }

  setShadowExtent(extent: number): void {
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
  }

  /** Keep the shadow frustum centred on the action. */
  update(focus: THREE.Vector3, extent: number): void {
    // Snap to shadow texels to avoid shimmering while the camera moves.
    const texel = (extent * 2) / this.opts.quality.shadowMapSize;
    this.shadowFocus.set(Math.round(focus.x / texel) * texel, Math.round(focus.y / texel) * texel, Math.round(focus.z / texel) * texel);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(SUN_DIRECTION, 12);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    if (Math.abs(cam.right - extent) > 0.05) this.setShadowExtent(extent);
  }

  // ---------------------------------------------------------------- terrain
  private createTerrain() {
    const { terrain, quality, textures } = this.opts;
    const size = 90;
    const seg = quality.terrainSegments;
    const half = size / 2;
    const warp = (u: number) => half * (0.32 * u + 0.68 * u * u * u); // dense near the tower
    const verts = seg + 1;
    const positions = new Float32Array(verts * verts * 3);
    const splat = new Float32Array(verts * verts * 4);
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = warp((i / seg) * 2 - 1);
        const z = warp((j / seg) * 2 - 1);
        const k = j * verts + i;
        positions[k * 3] = x;
        positions[k * 3 + 1] = terrain.height(x, z);
        positions[k * 3 + 2] = z;
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * verts + i;
        indices.push(a, a + verts, a + 1, a + 1, a + verts, a + verts + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const normals = geo.getAttribute('normal') as THREE.BufferAttribute;
    const n = this.noise;
    for (let k = 0; k < verts * verts; k++) {
      const x = positions[k * 3];
      const h = positions[k * 3 + 1];
      const z = positions[k * 3 + 2];
      const slope = 1 - normals.getY(k);
      const patch = n.fbm(x * 0.35, 1.3, z * 0.35, 3);
      const patch2 = n.fbm(x * 0.9 + 4, 2.1, z * 0.9, 2);
      // riverbed & shore gravel
      let pebbles = (1 - smoothstep(-0.02, 0.12, h)) * (0.65 + 0.35 * smoothstep(-0.2, 0.3, patch));
      pebbles += smoothstep(0.02, 0.1, h) * (1 - smoothstep(0.16, 0.3, h)) * smoothstep(0.05, 0.35, patch2) * 0.8;
      // sandy beach band and sand patches in the stream
      let sand = smoothstep(-0.1, 0.04, h) * (1 - smoothstep(0.2, 0.42, h)) + (1 - smoothstep(-0.05, 0.1, h)) * smoothstep(0.1, 0.45, -patch) * 0.7;
      // moss / grass on the banks
      let moss = smoothstep(0.14, 0.38, h) * (0.55 + 0.45 * smoothstep(-0.3, 0.3, patch2));
      // bare earth on slopes and transitions
      let dirt = smoothstep(0.12, 0.35, slope) * 0.9 + smoothstep(0.2, 0.32, h) * (1 - smoothstep(0.32, 0.5, h)) * 0.35;
      pebbles = Math.max(0, pebbles);
      sand = Math.max(0, sand);
      moss = Math.max(0, moss) * (1 - smoothstep(0.2, 0.5, slope));
      dirt = Math.max(0, dirt);
      const sum = pebbles + sand + moss + dirt + 1e-4;
      splat.set([sand / sum, pebbles / sum, moss / sum, dirt / sum], k * 4);
    }
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));

    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0, envMapIntensity: 0.7 });
    const uniforms = {
      tSand: { value: textures.sand },
      tPebbles: { value: textures.pebbles },
      tMoss: { value: textures.moss },
      tWater: { value: textures.water },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, sharedUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aSplat;
varying vec4 vSplat;
varying vec3 vWPos;
varying vec3 vWNormal;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vSplat = aSplat;
vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * normal);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D tSand;
uniform sampler2D tPebbles;
uniform sampler2D tMoss;
uniform sampler2D tWater;
uniform float uTime;
uniform float uWaterLevel;
varying vec4 vSplat;
varying vec3 vWPos;
varying vec3 vWNormal;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
vec2 wp = vWPos.xz;
vec4 ts = texture2D(tSand, wp * 0.85);
vec4 tsM = texture2D(tSand, wp * 0.11 + 0.3);
vec4 tp = texture2D(tPebbles, wp * 0.85);
vec4 tm = texture2D(tMoss, wp * 0.7);
vec4 tmM = texture2D(tMoss, wp * 0.09 + 0.6);
vec4 w4 = vSplat;
// height-aware blending: pebbles poke through sand, moss fills hollows
w4.y *= 0.6 + tp.a * 0.9;
w4.x *= 0.8 + (1.0 - tp.a) * 0.4;
w4 = max(w4, vec4(0.0));
w4 = pow(w4, vec4(1.6));
w4 /= max(1e-4, w4.x + w4.y + w4.z + w4.w);
vec3 sandCol = mix(vec3(0.53, 0.43, 0.30), vec3(0.66, 0.56, 0.41), ts.b) * mix(0.9, 1.08, tsM.b);
vec3 pebA = vec3(0.33, 0.30, 0.26);
vec3 pebB = vec3(0.52, 0.47, 0.40);
vec3 pebC = vec3(0.47, 0.38, 0.28);
vec3 pebCol = mix(mix(pebA, pebB, smoothstep(0.0, 0.6, tp.b)), pebC, smoothstep(0.6, 1.0, tp.b));
pebCol *= mix(0.85, 1.06, tp.a) * mix(0.85, 1.1, tsM.b);
// pebbles bedded in sand: the gaps between them show sand, not dark cracks
pebCol = mix(sandCol * 0.82, pebCol, smoothstep(0.12, 0.42, tp.a));
vec3 mossCol = mix(vec3(0.16, 0.20, 0.07), vec3(0.32, 0.33, 0.12), tm.b) * mix(0.8, 1.15, tmM.b);
vec3 dirtCol = vec3(0.30, 0.24, 0.17) * mix(0.85, 1.1, ts.b);
vec3 groundCol = sandCol * w4.x + pebCol * w4.y + mossCol * w4.z + dirtCol * w4.w;
float depth = uWaterLevel - vWPos.y;
float wet = 1.0 - smoothstep(-0.015, 0.09, -depth);
groundCol *= mix(1.0, 0.58, wet);
if (depth > 0.0) {
  // light absorption in the water column (green-blue tint)
  groundCol *= exp(-depth * vec3(2.5, 1.05, 1.45));
  vec2 cuv = wp * 0.55;
  float c1 = texture2D(tWater, cuv + vec2(uTime * 0.035, uTime * 0.012)).b;
  float c2 = texture2D(tWater, cuv * 1.31 + vec2(-uTime * 0.021, uTime * 0.027) + 0.5).b;
  float caustic = pow(min(c1, c2) * 1.6, 2.0);
  groundCol += vec3(0.95, 1.0, 0.85) * caustic * 0.32 * smoothstep(0.0, 0.05, depth) * exp(-depth * 2.2);
}
diffuseColor.rgb *= groundCol;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor = mix(0.97 * w4.x + 0.82 * w4.y + 1.0 * w4.z + 0.95 * w4.w, 0.32, wet);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
  vec2 nxy = (ts.rg * 2.0 - 1.0) * w4.x * 0.9 + (tp.rg * 2.0 - 1.0) * w4.y * 0.85 + (tm.rg * 2.0 - 1.0) * w4.z + (ts.rg * 2.0 - 1.0) * w4.w * 0.6;
  vec3 N = normalize(vWNormal);
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B = normalize(cross(T, N));
  vec3 wn = normalize(N + T * nxy.x - B * nxy.y);
  normal = normalize(mat3(viewMatrix) * wn);
}`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-v1';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(geo);
  }

  // ------------------------------------------------------------------ water
  private createWater() {
    const { terrain, textures } = this.opts;
    const size = 90;
    const seg = 120;
    const half = size / 2;
    const warp = (u: number) => half * (0.32 * u + 0.68 * u * u * u);
    const verts = seg + 1;
    const positions = new Float32Array(verts * verts * 3);
    const depth = new Float32Array(verts * verts);
    const flow = new Float32Array(verts * verts * 2);
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = warp((i / seg) * 2 - 1);
        const z = warp((j / seg) * 2 - 1);
        const k = j * verts + i;
        positions[k * 3] = x;
        positions[k * 3 + 1] = WORLD.waterLevel;
        positions[k * 3 + 2] = z;
        depth[k] = WORLD.waterLevel - terrain.height(x, z);
        const f = terrain.flowDirection(x);
        flow[k * 2] = f[0];
        flow[k * 2 + 1] = f[1];
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * verts + i;
        // skip quads that are entirely dry
        if (depth[a] < -0.15 && depth[a + 1] < -0.15 && depth[a + verts] < -0.15 && depth[a + verts + 1] < -0.15) continue;
        indices.push(a, a + verts, a + 1, a + 1, a + verts, a + verts + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * verts * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
    geo.setIndex(indices);

    const mat = new THREE.MeshStandardMaterial({
      color: '#3f6450',
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      envMapIntensity: 0.62,
    });
    const uniforms = { tWater: { value: textures.water }, uBaseCenter: { value: new THREE.Vector2(this.opts.basePosition[0], this.opts.basePosition[2]) } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, sharedUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aDepth;
attribute vec2 aFlow;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vWPos;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vDepth = aDepth;
vFlow = aFlow;
vWPos = (modelMatrix * vec4(position, 1.0)).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D tWater;
uniform float uTime;
uniform vec2 uBaseCenter;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vWPos;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
vec2 fl = normalize(vFlow);
vec2 wp = vWPos.xz;
float speed = 0.16;
vec4 w1 = texture2D(tWater, wp * 0.33 - fl * uTime * speed);
vec4 w2 = texture2D(tWater, wp * 0.71 + vec2(0.37, 0.11) - fl * uTime * speed * 1.7);
vec4 w3 = texture2D(tWater, wp * 0.12 + vec2(0.2, 0.6) - fl * uTime * speed * 0.5);
float d = max(vDepth, 0.0);
float shore = smoothstep(0.0, 0.035, vDepth);
float alphaDepth = mix(0.14, 0.7, smoothstep(0.02, 0.7, d));
// foam: shoreline band and around the base rock, broken up by noise
float foamNoise = w2.a * 0.6 + w1.a * 0.4;
float rockDist = length(wp - uBaseCenter);
float foam = (1.0 - smoothstep(0.0, 0.045, vDepth)) * smoothstep(0.5, 0.72, foamNoise) * 0.8;
foam += (1.0 - smoothstep(0.55, 0.8, rockDist)) * smoothstep(0.6, 0.82, foamNoise + 0.12 * sin(uTime * 1.3 + rockDist * 14.0)) * 0.35;
foam = clamp(foam, 0.0, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb * mix(1.1, 0.7, smoothstep(0.0, 0.6, d)), vec3(0.9, 0.93, 0.9), foam * 0.8);
diffuseColor.a = clamp(alphaDepth + foam * 0.55, 0.0, 1.0) * shore;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
  vec2 nxy = (w1.rg * 2.0 - 1.0) * 0.55 + (w2.rg * 2.0 - 1.0) * 0.35 + (w3.rg * 2.0 - 1.0) * 0.45;
  nxy *= mix(0.35, 1.0, smoothstep(0.0, 0.25, d));
  vec3 wn = normalize(vec3(nxy.x, 1.0, nxy.y));
  normal = normalize(mat3(viewMatrix) * wn);
}`,
        )
        .replace(
          '#include <opaque_fragment>',
          `// Premultiplied composite: reflections are not weakened by the low water opacity.
float specLum = clamp(dot(totalSpecular, vec3(0.3333)), 0.0, 1.0);
float outA = clamp(diffuseColor.a + specLum * diffuseColor.a * 4.0, 0.0, 1.0);
gl_FragColor = vec4((totalDiffuse * diffuseColor.a + totalSpecular * shore * 0.8) / max(outA, 0.001), outA);`,
        );
    };
    mat.customProgramCacheKey = () => 'water-v1';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.name = 'water';
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(geo);
  }

  // ------------------------------------------------------------- base rock
  private createBaseRock(): THREE.Mesh {
    const { baseShape, basePosition, textures } = this.opts;
    const geo = stoneGeometry(baseShape);
    const mat = createStoneMaterial(baseShape.recipe.rock, textures, { texScale: 1.7, detail: 1.15 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(basePosition[0], basePosition[1], basePosition[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'base-rock';
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(geo);
    return mesh;
  }

  // --------------------------------------------------------------- scatter
  private createScatter() {
    const { terrain, quality, textures } = this.opts;
    const rng = this.rng.fork();
    const rocks: RockId[] = ['granite', 'basalt', 'quartzite', 'sandstone', 'limestone', 'slate'];
    const variants = 6;
    const total = Math.round(900 * quality.scatterDensity);
    for (let v = 0; v < variants; v++) {
      const rock = rocks[v % rocks.length];
      const shape = generateStoneShape(makeRecipe(rng, 'pebble', 1, rock), { detail: 2, collisionLevel: 1, decorative: true });
      const geo = stoneGeometry(shape);
      const mat = createStoneMaterial(rock, textures, { texScale: 5 });
      const count = Math.round(total / variants);
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const color = new THREE.Color();
      let placed = 0;
      for (let tries = 0; placed < count && tries < count * 30; tries++) {
        const r = 1.0 + Math.pow(rng.next(), 1.6) * 16;
        const a = rng.range(0, Math.PI * 2);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = terrain.height(x, z);
        // pebbles gather on the riverbed and along the waterline
        const p = h < 0.05 ? 0.85 : h < 0.25 ? 0.45 : 0.06;
        if (!rng.chance(p)) continue;
        if (Math.hypot(x - this.opts.basePosition[0], z - this.opts.basePosition[2]) < 0.85) continue;
        const scale = rng.range(0.28, 0.85) * (h < 0 ? 1 : 0.8);
        e.set(rng.range(-0.25, 0.25), rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25));
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, h - 0.02 * scale, z), q, new THREE.Vector3(scale, scale * rng.range(0.8, 1.05), scale));
        mesh.setMatrixAt(placed, m);
        color.setScalar(rng.range(0.78, 1.12));
        mesh.setColorAt(placed, color);
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.receiveShadow = true;
      mesh.name = `pebbles-${v}`;
      this.group.add(mesh);
      this.materials.push(mat);
      this.geometries.push(geo);
    }

    // Boulders along the banks and in the stream
    const boulderCount = 9;
    for (let b = 0; b < boulderCount; b++) {
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 50; tries++) {
        const r = rng.range(2.6, 13);
        const a = rng.range(0, Math.PI * 2);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        if (terrain.height(x, z) > -0.25 && terrain.height(x, z) < 0.9) break;
      }
      const rock = rng.pick(['granite', 'granite', 'basalt', 'sandstone', 'limestone'] as RockId[]);
      const shape = generateStoneShape(makeRecipe(rng, rng.chance(0.5) ? 'cobble' : 'block', rng.range(2.2, 5), rock), { detail: 3, collisionLevel: 1, decorative: true });
      const geo = stoneGeometry(shape);
      const mat = createStoneMaterial(rock, textures, { texScale: 1.6 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.set(rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3));
      mesh.position.set(x, 0, z);
      mesh.updateMatrixWorld(true);
      // Bury the boulder: its lowest point sits 30 % of its height below the lowest ground under it.
      const box = new THREE.Box3().setFromObject(mesh);
      let ground = Infinity;
      for (const [ox, oz] of [[0, 0], [box.min.x - x, 0], [box.max.x - x, 0], [0, box.min.z - z], [0, box.max.z - z]]) {
        ground = Math.min(ground, terrain.height(x + ox * 0.7, z + oz * 0.7));
      }
      mesh.position.y = ground - box.min.y - (box.max.y - box.min.y) * 0.3;
      mesh.receiveShadow = true;
      mesh.castShadow = Math.hypot(x, z) < 4;
      mesh.name = `boulder-${b}`;
      this.group.add(mesh);
      this.materials.push(mat);
      this.geometries.push(geo);
    }
  }

  // ----------------------------------------------------------------- grass
  private createGrass() {
    const { terrain, quality } = this.opts;
    const rng = this.rng.fork();
    // A tuft of curved blades (uniform instance scaling keeps normals simple).
    const blade = this.grassTuftGeometry(rng);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.78, side: THREE.DoubleSide, envMapIntensity: 0.6 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sharedUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying float vBladeT;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vBladeT = uv.y;
vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
float gust = sin(uTime * 1.3 + iPos.x * 0.35 + iPos.z * 0.2) * 0.5 + 0.5;
float sway = sin(uTime * 2.1 + iPos.x * 1.7 + iPos.z * 1.3) * (0.08 + 0.12 * gust);
float bend = uv.y * uv.y;
transformed.z += sway * 0.35 * bend;
transformed.x += sway * 0.5 * bend;`,
        )
        .replace(
          '#include <defaultnormal_vertex>',
          `#include <defaultnormal_vertex>
// Grass is lit like the ground it grows from: stable shading from every side.
transformedNormal = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vBladeT;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\nnormal = normalize(vNormal);`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= mix(0.45, 1.05, smoothstep(0.0, 0.9, vBladeT));`,
        );
    };
    mat.customProgramCacheKey = () => 'grass-v1';

    const count = Math.round(quality.grassBlades / 4);
    const mesh = new THREE.InstancedMesh(blade, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    const n = this.noise;
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 20; tries++) {
      const r = 1.6 + Math.pow(rng.next(), 1.3) * 22;
      const a = rng.range(0, Math.PI * 2);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = terrain.height(x, z);
      if (h < 0.06) continue;
      // clumps: dense where the clump noise is high, plus reeds near the waterline
      const clump = n.fbm(x * 0.6, 9.1, z * 0.6, 3);
      const nearWater = h < 0.2;
      const p = nearWater ? smoothstep(-0.1, 0.25, clump) * 0.9 : smoothstep(-0.25, 0.3, clump) * clamp01((h - 0.12) * 4);
      if (!rng.chance(p)) continue;
      const height = nearWater ? rng.range(0.4, 0.8) : rng.range(0.14, 0.34) * (0.8 + clump * 0.6);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m.compose(new THREE.Vector3(x, h - 0.01, z), q, new THREE.Vector3(height, height, height));
      mesh.setMatrixAt(placed, m);
      if (nearWater) color.setRGB(rng.range(0.16, 0.22), rng.range(0.22, 0.28), rng.range(0.06, 0.09));
      else color.setRGB(rng.range(0.2, 0.32), rng.range(0.24, 0.31), rng.range(0.07, 0.1));
      mesh.setColorAt(placed, color);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'grass';
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(blade);
  }

  private grassTuftGeometry(rng: Rng): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const blades = 7;
    const segs = 3;
    for (let b = 0; b < blades; b++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, 0.12);
      const ox = Math.cos(a) * r;
      const oz = Math.sin(a) * r;
      const yaw = rng.range(0, Math.PI * 2);
      const lean = rng.range(0.1, 0.45);
      const h = rng.range(0.6, 1.0);
      const w = rng.range(0.035, 0.055);
      const dx = Math.cos(yaw);
      const dz = Math.sin(yaw);
      const base = pos.length / 3;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const width = w * (1 - t * 0.9);
        const bend = lean * t * t;
        const cx = ox + Math.cos(a) * bend * h;
        const cz = oz + Math.sin(a) * bend * h;
        const y = t * h;
        pos.push(cx - dz * width, y, cz + dx * width, cx + dz * width, y, cz - dx * width);
        uv.push(0, t, 1, t);
      }
      for (let s = 0; s < segs; s++) {
        const i = base + s * 2;
        idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex(idx);
    return geo;
  }

  // ----------------------------------------------------------------- trees
  private createTrees() {
    const { terrain, quality } = this.opts;
    const rng = this.rng.fork();
    const conifer = this.coniferGeometry(rng);
    const broadleaf = this.broadleafGeometry(rng);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, envMapIntensity: 0.5 });
    for (const [geo, share] of [
      [conifer, 0.65],
      [broadleaf, 0.35],
    ] as const) {
      const count = Math.round(quality.trees * share);
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const color = new THREE.Color();
      let placed = 0;
      for (let tries = 0; placed < count && tries < count * 40; tries++) {
        const r = rng.range(17, 48);
        const a = rng.range(0, Math.PI * 2);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = terrain.height(x, z);
        if (h < 0.55) continue;
        const s = rng.range(0.75, 1.35) * (geo === conifer ? rng.range(5, 9) : rng.range(4, 7));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
        m.compose(new THREE.Vector3(x, h - 0.2, z), q, new THREE.Vector3(s * rng.range(0.85, 1.15), s, s * rng.range(0.85, 1.15)));
        mesh.setMatrixAt(placed, m);
        color.setScalar(rng.range(0.75, 1.15));
        mesh.setColorAt(placed, color);
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = 'trees';
      this.group.add(mesh);
      this.geometries.push(geo);
    }
    this.materials.push(mat);
  }

  private coniferGeometry(rng: Rng): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.025, 0.04, 0.35, 6);
    trunk.translate(0, 0.17, 0);
    paint(trunk, new THREE.Color('#4d3b2c'));
    parts.push(trunk);
    const tiers = 7;
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const radius = 0.36 * (1 - f * 0.8) * rng.range(0.9, 1.1);
      const cone = new THREE.ConeGeometry(radius, 0.34 - f * 0.1, 10, 2);
      cone.translate(0, 0.28 + f * 0.68, 0);
      jitter(cone, rng, 0.03);
      paint(cone, new THREE.Color().setRGB(0.075 + f * 0.035, 0.13 + f * 0.05, 0.065 + f * 0.01));
      parts.push(cone);
    }
    return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  }

  private broadleafGeometry(rng: Rng): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.5, 6);
    trunk.translate(0, 0.25, 0);
    paint(trunk, new THREE.Color('#4a3a2b'));
    parts.push(trunk);
    for (let b = 0; b < 6; b++) {
      const blob = new THREE.IcosahedronGeometry(rng.range(0.16, 0.26), 1);
      blob.translate(rng.range(-0.16, 0.16), rng.range(0.55, 0.95), rng.range(-0.16, 0.16));
      jitter(blob, rng, 0.035);
      paint(blob, new THREE.Color().setRGB(rng.range(0.13, 0.22), rng.range(0.19, 0.27), rng.range(0.06, 0.09)));
      parts.push(blob);
    }
    return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
  }
}

function paint(geo: THREE.BufferGeometry, color: THREE.Color) {
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([color.r, color.g, color.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function jitter(geo: THREE.BufferGeometry, rng: Rng, amount: number) {
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  // Displace shared positions consistently so the mesh stays closed.
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = [rng.range(-amount, amount), rng.range(-amount, amount) * 0.5, rng.range(-amount, amount)]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
}
