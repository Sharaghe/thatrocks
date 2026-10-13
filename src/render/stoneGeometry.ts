import * as THREE from 'three';
import type { StoneShape } from '../stones/StoneShape';

/** BufferGeometry for a generated stone (object space, COM at the origin). */
export function stoneGeometry(shape: StoneShape): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(shape.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(shape.colors, 3));
  const n = shape.positions.length / 3;
  geo.setIndex(new THREE.BufferAttribute(n < 65536 ? new Uint16Array(shape.indices) : shape.indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Wireframe of the collision hull (debug overlay). */
export function hullWireframe(points: Float32Array, faces: { a: number; b: number; c: number }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const seen = new Set<string>();
  for (const f of faces) {
    for (const [u, v] of [
      [f.a, f.b],
      [f.b, f.c],
      [f.c, f.a],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pos.push(points[u * 3], points[u * 3 + 1], points[u * 3 + 2], points[v * 3], points[v * 3 + 1], points[v * 3 + 2]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}
