import assert from "node:assert/strict";
import test from "node:test";
import { markerLinks } from "./marker-links";

test("anatomical guides connect limbs separately and connect back to belly", () => {
  const links = markerLinks("quadruped", ["head", "nose", "hips", "back", "shoulders", "belly", "tailTip",
    "frontKneeL", "frontFootL", "frontKneeR", "frontFootR", "wingElbowL", "wingWristL", "wingTipL"]);
  for (const pair of [["frontKneeL", "frontFootL"], ["frontKneeR", "frontFootR"], ["back", "belly"], ["wingElbowL", "wingWristL"], ["wingWristL", "wingTipL"]])
    assert.ok(links.some(([a, b]) => a === pair[0] && b === pair[1]));
  assert.ok(!links.some(([a, b]) => a.endsWith("L") && b.endsWith("R")));
  assert.ok(!links.some(([a, b]) => a === "tailTip" && b === "head"));
});

test("humanoid arm and leg guides follow the edited joints", () => {
  const links = markerLinks("humanoid", ["groin", "chin", "shoulderL", "elbowL", "wristL", "kneeL", "ankleL"]);
  assert.ok(links.some(([a, b]) => a === "elbowL" && b === "wristL"));
  assert.ok(links.some(([a, b]) => a === "kneeL" && b === "ankleL"));
  assert.ok(!links.flat().some(id => id.endsWith("R")));
});
