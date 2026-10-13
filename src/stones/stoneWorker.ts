/// <reference lib="webworker" />
import { generateStoneShape, type StoneShape } from './StoneShape';
import type { StoneRecipe } from './catalog';

interface Request {
  id: number;
  recipe: StoneRecipe;
  detail: number;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, recipe, detail } = event.data;
  try {
    const shape: StoneShape = generateStoneShape(recipe, { detail });
    const transfer = [shape.positions.buffer, shape.normals.buffer, shape.colors.buffer, shape.collisionPoints.buffer];
    (self as unknown as Worker).postMessage({ id, shape }, transfer as Transferable[]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
