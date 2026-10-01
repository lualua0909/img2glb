import type { RigCategory } from "./categories";

/** Anatomical guide edges between editable markers, separate from generated/helper bones. */
export function markerLinks(category: RigCategory, ids: readonly string[]) {
  const available = new Set(ids);
  const pairs: [string, string][] = [];
  const chain = (...nodes: string[]) => {
    const present = nodes.filter(n => available.has(n));
    for (let i = 1; i < present.length; i++) pairs.push([present[i - 1], present[i]]);
  };
  if (category === "humanoid") {
    chain("groin", "chin");
    chain("shoulderL", "shoulderR");
    for (const side of ["L", "R"]) {
      chain("chin", `shoulder${side}`, `elbow${side}`, `wrist${side}`);
      chain("groin", `knee${side}`, `ankle${side}`);
    }
  } else {
    chain("tailTip", "hips", "back", "shoulders", "neckBase", "neckLower", "neckMid", "neckUpper", "neckTop", "head", "trunkMid", "nose");
    chain("shoulders", "belly", "hips");
    chain("back", "belly");
    chain("head", "jawTip");
    if (category === "bird") chain("tailTip", "chest", "head");
    for (const side of ["L", "R"]) {
      chain("shoulders", `frontKnee${side}`, `frontFoot${side}`);
      chain(`midHip${side}`, `midKnee${side}`, `midFoot${side}`);
      chain("hips", `rearKnee${side}`, `rearFoot${side}`);
      chain("shoulders", `elbow${side}`, `wrist${side}`);
      chain("chest", `foot${side}`);
    }
  }
  for (const side of ["L", "R"]) {
    // Each wing from its own root (not all from the shoulders).
    for (const w of ["wing", "wing2", "wing3"]) chain(`${w}Root${side}`, `${w}Elbow${side}`, `${w}Wrist${side}`, `${w}Tip${side}`);
    chain(`finRoot${side}`, `finMid${side}`, `finTip${side}`);
    chain("head", `hornTip${side}`);
    for (let i = 1; i <= 4; i++) chain(`feelerRoot${i}${side}`, `feelerTip${i}${side}`);
  }
  chain("head", "hornTip");
  for (let i = 1; i <= 6; i++) chain(`crestRoot${i}`, `crestTip${i}`);
  return pairs.filter(([a, b], i) => pairs.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a)) === i);
}
