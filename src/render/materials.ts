import * as THREE from 'three';
import { ROCKS, type RockId } from '../stones/catalog';
import { WORLD } from '../config';
import type { SurfaceTextures } from './TextureFactory';

/** Shared, per-frame uniforms (time, water level). */
export const sharedUniforms = {
  uTime: { value: 0 },
  uWaterLevel: { value: WORLD.waterLevel },
};

const SPECKLE: Record<RockId, { dark: string; light: string }> = {
  granite: { dark: '#2d2b2a', light: '#e9e3da' },
  sandstone: { dark: '#6e5238', light: '#e2cfae' },
  basalt: { dark: '#1d1c1c', light: '#8b867f' },
  slate: { dark: '#30353a', light: '#9aa0a5' },
  quartzite: { dark: '#8d857a', light: '#fbf7ef' },
  limestone: { dark: '#6f6a60', light: '#e8e2d4' },
};

/**
 * Natural stone: vertex colours carry the per-stone mineral pattern, a
 * triplanar (object-space) detail layer adds grain, pits, speckles and
 * roughness variation without UVs, and stones darken/gloss when wet.
 */
export function createStoneMaterial(rock: RockId, tex: SurfaceTextures, opts: { texScale?: number; detail?: number } = {}): THREE.MeshStandardMaterial {
  const def = ROCKS[rock];
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: def.roughness,
    metalness: 0,
    envMapIntensity: 0.75,
  });
  const uniforms = {
    tStoneA: { value: tex.stoneA },
    tStoneB: { value: tex.stoneB },
    uTexScale: { value: opts.texScale ?? 2.6 },
    uSpeckle: { value: def.speckle },
    uSpeckleDark: { value: new THREE.Color(SPECKLE[rock].dark) },
    uSpeckleLight: { value: new THREE.Color(SPECKLE[rock].light) },
    uDetail: { value: opts.detail ?? 1 },
    uRoughVar: { value: 0.28 },
  };
  material.userData.stoneUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, sharedUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vWorldPos;
varying mat3 vNormalToView;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vObjPos = position;
vObjNormal = normal;
#ifdef USE_INSTANCING
  vWorldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  vNormalToView = normalMatrix * mat3(instanceMatrix);
#else
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormalToView = normalMatrix;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D tStoneA;
uniform sampler2D tStoneB;
uniform float uTexScale;
uniform float uSpeckle;
uniform vec3 uSpeckleDark;
uniform vec3 uSpeckleLight;
uniform float uDetail;
uniform float uRoughVar;
uniform float uWaterLevel;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vWorldPos;
varying mat3 vNormalToView;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 triN = normalize(vObjNormal);
vec3 triW = pow(abs(triN), vec3(4.0));
triW /= (triW.x + triW.y + triW.z);
vec2 uvX = vObjPos.zy * uTexScale;
vec2 uvY = vObjPos.xz * uTexScale + 0.37;
vec2 uvZ = vObjPos.xy * uTexScale + 0.71;
vec4 aX = texture2D(tStoneA, uvX);
vec4 aY = texture2D(tStoneA, uvY);
vec4 aZ = texture2D(tStoneA, uvZ);
vec4 sA = aX * triW.x + aY * triW.y + aZ * triW.z;
vec4 sB = texture2D(tStoneB, uvX) * triW.x + texture2D(tStoneB, uvY) * triW.y + texture2D(tStoneB, uvZ) * triW.z;
// macro variation (larger scale, cheap single fetch on the dominant axis)
float macro = texture2D(tStoneA, (triW.y > 0.5 ? vObjPos.xz : vObjPos.xy) * uTexScale * 0.23).b;
float grain = mix(0.82, 1.14, sA.b) * mix(0.9, 1.08, macro);
float cavity = smoothstep(0.15, 0.6, sA.a);
diffuseColor.rgb *= grain * mix(0.72, 1.0, cavity);
diffuseColor.rgb = mix(diffuseColor.rgb, uSpeckleDark, clamp(sB.r * uSpeckle, 0.0, 1.0) * 0.85);
diffuseColor.rgb = mix(diffuseColor.rgb, uSpeckleLight, clamp(sB.g * uSpeckle, 0.0, 1.0) * 0.6);
float wet = 1.0 - smoothstep(uWaterLevel - 0.01, uWaterLevel + 0.035, vWorldPos.y);
diffuseColor.rgb *= mix(1.0, 0.55, wet);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (sB.b - 0.5) * uRoughVar - (1.0 - cavity) * -0.08, 0.08, 1.0);
roughnessFactor = mix(roughnessFactor, 0.18, wet);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec3 nX = vec3((aX.rg * 2.0 - 1.0) * uDetail, 1.0);
  vec3 nY = vec3((aY.rg * 2.0 - 1.0) * uDetail, 1.0);
  vec3 nZ = vec3((aZ.rg * 2.0 - 1.0) * uDetail, 1.0);
  // Whiteout-blended triplanar normal mapping in object space.
  nX = vec3(nX.xy + triN.zy, abs(nX.z) * triN.x);
  nY = vec3(nY.xy + triN.xz, abs(nY.z) * triN.y);
  nZ = vec3(nZ.xy + triN.xy, abs(nZ.z) * triN.z);
  vec3 objN = normalize(nX.zyx * triW.x + nY.xzy * triW.y + nZ.xyz * triW.z);
  normal = normalize(vNormalToView * objN);
}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= mix(0.55, 1.0, cavity);`,
      );
  };
  material.customProgramCacheKey = () => 'stone-triplanar-v1';
  return material;
}

/** Translucent preview of where the held stone will land. */
export function createGhostMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#fff6e0') }, uOpacity: { value: 0.35 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        gl_FragColor = vec4(uColor, (0.025 + rim * 0.7) * uOpacity);
      }`,
  });
}
