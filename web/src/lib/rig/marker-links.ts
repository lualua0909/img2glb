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
      chain("hips", `rearKnee${side}`, `rearFoot${side}`);
      chain("shoulders", `elbow${side}`, `wrist${side}`);
      chain("chest", `foot${side}`);
    }
  }
  for (const side of ["L", "R"]) {
    const root = available.has(`wingRoot${side}`) ? `wingRoot${side}` : available.has("shoulders") ? "shoulders" : "chest";
    chain(root, `wingElbow${side}`, `wingWrist${side}`, `wingTip${side}`);
    for (let i = 2; i <= 3; i++) chain(available.has("chest") ? "chest" : "back", `wing${i}Elbow${side}`, `wing${i}Wrist${side}`, `wing${i}Tip${side}`);
    chain(`finRoot${side}`, `finMid${side}`, `finTip${side}`);
    chain("head", `hornTip${side}`);
    for (let i = 1; i <= 4; i++) chain(`feelerRoot${i}${side}`, `feelerTip${i}${side}`);
  }
  chain("head", "hornTip");
  return pairs.filter(([a, b], i) => pairs.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a)) === i);
}
