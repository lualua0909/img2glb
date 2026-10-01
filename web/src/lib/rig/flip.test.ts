import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Mesh } from "three";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, rigFrame } from "./rig";
import { SPECIES } from "./species";

const box = (x: number, y: number, z: number, w: number, h: number, d: number) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, 6, 6, 6));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** A model for each category, facing +Z: a raised head in front, a tail behind (and wings on a bird). */
const MODELS = {
  quadruped: buildModelData([
    box(0, 1, 0, 1, 1, 2),
    box(0, 1.8, 1.2, 0.7, 0.6, 0.8),
    box(0, 1, -1.5, 0.25, 0.25, 1.2),
    ...[-0.35, 0.35].flatMap((x) => [box(x, 0.3, 0.7, 0.25, 0.6, 0.25), box(x, 0.3, -0.7, 0.25, 0.6, 0.25)]),
  ]),
  bird: buildModelData([
    box(0, 1, 0, 0.6, 0.6, 1.2),
    box(0, 1.6, 0.5, 0.4, 0.4, 0.4),
    box(0, 1, -1, 0.3, 0.1, 0.8),
    box(-1, 1.1, 0, 1.4, 0.05, 0.6),
    box(1, 1.1, 0, 1.4, 0.05, 0.6),
    box(-0.15, 0.35, 0, 0.1, 0.7, 0.1),
    box(0.15, 0.35, 0, 0.1, 0.7, 0.1),
  ]),
  serpent: buildModelData([box(0, 0.15, 0, 0.3, 0.3, 4)]),
  fish: buildModelData([box(0, 0.5, 0.3, 0.5, 0.6, 1.4), box(0, 0.5, -1, 0.15, 0.3, 1.2)]),
} as const;

test("every species preset can be flipped: its head and tail ends swap", () => {
  for (const species of SPECIES) {
    const model = MODELS[species.category as keyof typeof MODELS];
    assert.ok(model, species.id);
    const forward = (flip: boolean) => {
      const o = { ...DEFAULT_RIG_OPTIONS, ...species.options, flip };
      return rigFrame(species.category, model, guessMarkers(species.category, model, o), o).forward;
    };
    assert.ok(forward(false).dot(forward(true)) < -0.9, `${species.id}: ${forward(false).toArray()} / ${forward(true).toArray()}`);
  }
});
