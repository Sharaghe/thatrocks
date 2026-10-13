import { Rng } from '../core/rng';
import { WORLD } from '../config';
import { makeRecipe, type StoneRecipe } from '../stones/catalog';

/** The fixed boulder the tower is built on: big, granite, flat-topped. */
export function baseRockRecipe(seed: number = WORLD.environmentSeed): StoneRecipe {
  const rng = new Rng(seed ^ 0xba5e);
  const recipe = makeRecipe(rng, 'boulder', 1.18, 'granite');
  recipe.yaw = 0;
  return recipe;
}
