import { rigModel, sampler, edges } from "./check";
(async () => {
  const [id, json, name, tt] = process.argv.slice(2);
  const r = await rigModel(id, json ? JSON.parse(json) : {});
  const { m, plan, skin } = r;
  const c = r.clips.find((x) => x.clip.name === name)!;
  const S = sampler(plan, m, skin);
  const A = S.pose(c, Number(tt)).slice();
  const E = edges(m);
  const P = m.positions;
  const L = (X: Float32Array, a: number, b: number) => Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2]);
  const ws = (i: number) => [0, 1, 2, 3].filter((s) => skin.weight[i * 4 + s] > 0.01).map((s) => `${plan.bones[skin.index[i * 4 + s]].name}=${skin.weight[i * 4 + s].toFixed(2)}`).join(",");
  const combos = new Map<string, { n: number; ex: string }>();
  for (let e = 0; e < E.length / 2; e++) {
    const [a, b] = [E[e * 2], E[e * 2 + 1]];
    const r0 = L(P, a, b); if (r0 < 0.002 * m.size.y) continue;
    const s = L(A, a, b) / r0;
    if (s < 1.6 && s > 1 / 1.6) continue;
    const key = [...new Set([a, b].flatMap((i) => [0, 1, 2, 3].filter((k) => skin.weight[i * 4 + k] > 0.05).map((k) => plan.bones[skin.index[i * 4 + k]].name)))].sort().join("+");
    const it = combos.get(key) ?? { n: 0, ex: "" };
    it.n++;
    if (!it.ex) it.ex = `s=${s.toFixed(2)} a(${[0, 1, 2].map((k) => ((P[a * 3 + k] - m.center.getComponent(k)) / m.size.y).toFixed(2))}) [${ws(a)}] b [${ws(b)}]`;
    combos.set(key, it);
  }
  for (const [k, v] of [...combos].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(v.n, k, "\n   ", v.ex);
  console.log(plan.bones.map((b) => `${b.name} ${b.head.toArray().map((x) => x.toFixed(2))}`).join("\n"));
})();
