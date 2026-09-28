import { rigModel } from "./check";
(async () => {
  const r = await rigModel("c2d80bd6-7fba-4c1a-8cab-48655cdc8e2f");
  console.log(r.plan.bones.map((b) => b.name + "<" + b.parent).join(" "));
  const counts = new Map<string, number>();
  for (let i = 0; i < r.m.count; i++) for (let s = 0; s < 4; s++) if (r.skin.weight[i * 4 + s] > 0.01) { const n = r.plan.bones[r.skin.index[i * 4 + s]].name; counts.set(n, (counts.get(n) ?? 0) + 1); }
  console.log([...counts].join(" "));
  const c = r.clips.find((x) => x.clip.name === "Attack_Hammer")!;
  console.log(c.clip.tracks.map((t) => t.name).join(" "));
})();
