import { Vector3 } from "three";
import { rigModel, snap } from "./check";
const SP = "/private/tmp/claude-502/-Users-duyna-Desktop-Img-to-3D/31a54945-396b-4ac6-8c43-1a0c65d69d10/scratchpad/";
(async () => {
  const [id, json, spec, tag] = process.argv.slice(2);
  const r = await rigModel(id, json ? JSON.parse(json) : {});
  const views = [new Vector3(0, 0, -1), new Vector3(-1, 0, -0.35), new Vector3(0, 0, 1)];
  const focus = process.env.FOCUS ? (() => { const [x, y, z, rr] = process.env.FOCUS!.split(",").map(Number); return { c: r.m.center.clone().add(new Vector3(x, y, z).multiplyScalar(r.m.size.y)), r: rr * r.m.size.y }; })() : undefined;
  for (const item of spec.split(",")) {
    const [name, t] = item.split("@");
    const c = name === "rest" ? null : r.clips.find((x) => x.clip.name === name)!;
    await snap(`${SP}${tag ?? "s"}_${name}_${t ?? 0}.png`, r.plan, r.m, r.skin, c, [Number(t ?? 0)], views, focus);
  }
})();
