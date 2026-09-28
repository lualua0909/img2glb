import { rigModel } from "./check";
(async () => {
  for (const id of process.argv.slice(2)) {
    const r = await rigModel(id);
    const d = (n: string) => { const b = r.plan.bones.find((x) => x.name === n)!; return b.tail.clone().sub(b.head).normalize(); };
    const L = d("LeftUpperArm");
    console.log(id.slice(0, 8), "floor", JSON.stringify(r.plan.armFloor), "restL", Math.atan2(L.y, L.x).toFixed(2), "marks", ["shoulderL", "elbowL", "wristL", "kneeL", "ankleL", "groin", "chin"].map((k) => `${k}:${r.k[k].toArray().map((x) => (x / r.m.size.y).toFixed(2))}`).join(" "));
  }
})();
