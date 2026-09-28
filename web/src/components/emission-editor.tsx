"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "./i18n-provider";
import { DEFAULT_EMISSION, type EmissionSettings } from "@/lib/emission/settings";
import type { GenerationDTO } from "@/server/generations";

type Tool = "brush" | "erase" | "rotate";
type Editor = {
  update(value: Partial<EmissionSettings>): void;
  select(color: string, tolerance: number): void;
  clear(): void;
  undo(): void;
  exportGlb(): Promise<ArrayBuffer>;
};

export function EmissionEditor({ gen, onSaved, onCancel }: {
  gen: GenerationDTO; onSaved: (gen: GenerationDTO) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const [settings, setSettings] = useState({ ...DEFAULT_EMISSION });
  const [tool, setTool] = useState<Tool>("brush");
  const [size, setSize] = useState(3);
  const [bloom, setBloom] = useState(true);
  const [target, setTarget] = useState("#65ffb5");
  const [tolerance, setTolerance] = useState(0.2);
  const [status, setStatus] = useState<"loading" | "ready" | "saving">("loading");
  const [undoCount, setUndoCount] = useState(0);
  const [available, setAvailable] = useState(false);
  const [hasTexture, setHasTexture] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef({ tool, size, bloom, enabled: settings.enabled, status });
  useEffect(() => { live.current = { tool, size, bloom, enabled: settings.enabled, status }; }, [tool, size, bloom, settings.enabled, status]);

  useEffect(() => {
    let disposed = false;
    const releases: (() => void)[] = [];
    const el = mount.current!;
    (async () => {
      const THREE = await import("three");
      const { gltfLoader } = await import("@/lib/gltf-loader");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const { createBloom } = await import("@/lib/emission/bloom");
      const { emissionSurfaces } = await import("@/lib/emission/surfaces");
      // The save endpoint replaces the same URL. Always open the latest edited file.
      const url = new URL(gen.modelUrl!, window.location.href);
      url.searchParams.set("edit", String(Date.now()));
      const gltf = await gltfLoader().loadAsync(url.href);
      const meshes: InstanceType<typeof THREE.Mesh>[] = [];
      const materials = new Set<InstanceType<typeof THREE.Material>>();
      const textures = new Set<InstanceType<typeof THREE.Texture>>();
      gltf.scene.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        meshes.push(o);
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(mat);
          for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      const releaseModel = () => {
        meshes.forEach(m => m.geometry.dispose());
        materials.forEach(m => m.dispose()); textures.forEach(tx => tx.dispose());
      };
      if (disposed) { releaseModel(); return; }
      releases.push(releaseModel);
      const surfaces = emissionSurfaces(meshes);
      releases.push(() => surfaces.forEach(s => s.texture.dispose()));
      const first = [...surfaces.values()].find(s => s.settings.enabled) ?? [...surfaces.values()][0];
      const initial = first ? { ...first.settings } : { ...DEFAULT_EMISSION };
      setSettings(initial);
      live.current.enabled = initial.enabled;
      setAvailable(surfaces.size > 0);
      setHasTexture([...surfaces.values()].some(s => s.base && s.material.map?.channel === s.texture.channel));
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      releases.push(() => { renderer.setAnimationLoop(null); renderer.dispose(); renderer.domElement.remove(); });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.NeutralToneMapping;
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      el.appendChild(canvas);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x171b20);
      scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0x555555, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(2, 3, 4); scene.add(light);
      const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 0.001);
      const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
      camera.position.copy(sphere.center).add(new THREE.Vector3(0, radius * 0.3, radius * 3));
      const controls = new OrbitControls(camera, canvas);
      releases.push(() => controls.dispose());
      controls.target.copy(sphere.center); controls.update();
      const fx = createBloom(renderer, scene, camera);
      releases.push(() => fx.dispose());
      const resize = () => {
        const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
        renderer.setSize(w, h); fx.resize(w, h);
        camera.aspect = w / h; camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize); ro.observe(el); resize();
      releases.push(() => ro.disconnect());
      renderer.setAnimationLoop(() => {
        controls.update();
        if (live.current.bloom && live.current.enabled) fx.render(); else renderer.render(scene, camera);
      });
      type Surface = (typeof surfaces extends Map<unknown, infer S> ? S : never);
      type Snapshot = { surface: Surface; pixels: ImageData }[];
      const history: Snapshot[] = [];
      let historyBytes = 0;
      const bytesOf = (snapshot: Snapshot) => snapshot.reduce((n, s) => n + s.pixels.data.byteLength, 0);
      const push = (snapshot: Snapshot) => {
        history.push(snapshot); historyBytes += bytesOf(snapshot);
        while (history.length > 1 && (historyBytes > 32 * 1024 * 1024 || history.length > 20)) historyBytes -= bytesOf(history.shift()!);
        setUndoCount(history.length);
      };
      const snapshot = (s: Surface) => ({ surface: s, pixels: s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height) });
      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const hit = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        ndc.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        raycaster.setFromCamera(ndc, camera);
        const h = raycaster.intersectObjects(meshes, false)[0];
        if (!h?.face) return null;
        const mesh = h.object as InstanceType<typeof THREE.Mesh>;
        const mat = Array.isArray(mesh.material) ? mesh.material[h.face.materialIndex] : mesh.material;
        const s = surfaces.get(mat as InstanceType<typeof THREE.MeshStandardMaterial>);
        if (!s) return null;
        const attr = mesh.geometry.getAttribute(s.texture.channel === 0 ? "uv" : `uv${s.texture.channel}`);
        if (!attr || !h.barycoord) return null;
        const uv = new THREE.Vector2();
        for (const [index, weight] of [[h.face.a, h.barycoord.x], [h.face.b, h.barycoord.y], [h.face.c, h.barycoord.z]])
          uv.addScaledVector(new THREE.Vector2(attr.getX(index), attr.getY(index)), weight);
        if (s.texture.matrixAutoUpdate) s.texture.updateMatrix();
        s.texture.transformUv(uv);
        return { s, x: uv.x * s.canvas.width, y: uv.y * s.canvas.height };
      };
      let stroke: Snapshot | null = null;
      let pointer: number | null = null;
      let previous: ReturnType<typeof hit> = null;
      const paint = (h: NonNullable<ReturnType<typeof hit>>) => {
        if (!stroke!.some(entry => entry.surface === h.s)) stroke!.push(snapshot(h.s));
        const { s, x, y } = h;
        const r = live.current.size / 100 * Math.min(s.canvas.width, s.canvas.height);
        s.ctx.fillStyle = s.ctx.strokeStyle = live.current.tool === "erase" ? "black" : "white";
        s.ctx.lineWidth = r * 2; s.ctx.lineCap = "round";
        // Do not connect across UV seams or different materials.
        if (previous?.s === s && Math.hypot(previous.x - x, previous.y - y) < r * 8) {
          s.ctx.beginPath(); s.ctx.moveTo(previous.x, previous.y); s.ctx.lineTo(x, y); s.ctx.stroke();
        }
        s.ctx.beginPath(); s.ctx.arc(x, y, r, 0, Math.PI * 2); s.ctx.fill();
        s.attach(); previous = h;
      };
      const down = (e: PointerEvent) => {
        if (live.current.status !== "ready" || !live.current.enabled || live.current.tool === "rotate" || e.button !== 0 || pointer !== null) return;
        const h = hit(e); if (!h) return;
        controls.enabled = false; stroke = []; pointer = e.pointerId;
        canvas.setPointerCapture(e.pointerId); paint(h);
      };
      const move = (e: PointerEvent) => {
        if (!stroke || e.pointerId !== pointer) return;
        const h = hit(e); if (h) paint(h); else previous = null;
      };
      const up = () => {
        if (stroke?.length) push(stroke);
        stroke = null; previous = null; pointer = null; controls.enabled = true;
      };
      canvas.addEventListener("pointerdown", down, true);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
      canvas.addEventListener("lostpointercapture", up);
      releases.push(() => {
        canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      });
      editor.current = {
        update(next) { surfaces.forEach(s => s.update(next)); },
        select(hex, tolerance) {
          const target = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
          const eligible = [...surfaces.values()].filter(s => s.base && s.material.map?.channel === s.texture.channel);
          push(eligible.map(snapshot)); eligible.forEach(s => s.select(target, tolerance));
        },
        clear() {
          push([...surfaces.values()].map(snapshot));
          surfaces.forEach(s => { s.ctx.fillStyle = "black"; s.ctx.fillRect(0, 0, s.canvas.width, s.canvas.height); s.attach(); });
        },
        undo() {
          const entries = history.pop(); if (!entries) return;
          historyBytes -= bytesOf(entries);
          entries.forEach(({ surface: s, pixels }) => { s.ctx.putImageData(pixels, 0, 0); s.attach(); });
          setUndoCount(history.length);
        },
        async exportGlb() {
          return await new GLTFExporter().parseAsync(gltf.scene, { binary: true, animations: gltf.animations }) as ArrayBuffer;
        },
      };
      setStatus("ready");
    })().catch(e => {
      releases.splice(0).reverse().forEach(release => release());
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { disposed = true; editor.current = null; releases.splice(0).reverse().forEach(release => release()); };
  }, [gen.modelUrl]);

  function update(next: Partial<EmissionSettings>) {
    setSettings(s => ({ ...s, ...next }));
    if (next.enabled !== undefined) live.current.enabled = next.enabled;
    editor.current?.update(next);
  }
  async function save() {
    if (!editor.current) return;
    live.current.status = "saving"; setStatus("saving"); setError(null);
    try {
      const glb = await editor.current.exportGlb();
      const res = await fetch(`/api/generations/${gen.id}/model`, {
        method: "PUT", body: glb, headers: { "Content-Type": "model/gltf-binary" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      onSaved(data as GenerationDTO); toast.success(t.emission.saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.paint.saveFailed); setStatus("ready"); live.current.status = "ready";
    }
  }
  const ready = status === "ready";
  const editable = ready && available && settings.enabled;
  const rangeClass = "w-full accent-primary";
  return <div className="absolute inset-0 flex flex-col sm:flex-row">
    <div ref={mount} className="relative min-h-40 min-w-0 flex-1" aria-label={t.emission.preview} />
    <aside className="flex max-h-[55%] w-full shrink-0 flex-col gap-4 overflow-y-auto border-t bg-background/95 p-4 sm:max-h-full sm:w-64 sm:border-t-0 sm:border-l">
      <h3 className="font-semibold">{t.emission.open}</h3>
      {status === "loading" && !error ? <Spinner /> : null}
      <label className="flex items-center justify-between gap-3 text-sm font-medium">
        {t.emission.enable}<input type="checkbox" role="switch" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} disabled={!ready || !available} className="size-4 accent-primary" />
      </label>
      <p className="text-xs text-muted-foreground">{t.emission.optional}</p>
      {ready && !available ? <p role="status" className="text-sm text-amber-600">{t.emission.noUv}</p> : null}
      <fieldset disabled={!editable} className="space-y-4 disabled:opacity-50">
        <label className="flex items-center justify-between text-sm">{t.emission.color}<input type="color" aria-label={t.emission.color} value={settings.color} onChange={e => update({ color: e.target.value })} className="h-8 w-12" /></label>
        <label className="block space-y-1 text-sm"><span>{t.emission.intensity} · {settings.intensity.toFixed(1)}</span><input type="range" min="0" max="20" step="0.1" value={settings.intensity} onChange={e => update({ intensity: +e.target.value })} className={rangeClass} /></label>
        <div className="space-y-2 rounded-xl border p-3">
          <label className="flex items-center justify-between gap-2 text-sm">{t.emission.target}<input type="color" aria-label={t.emission.target} value={target} onChange={e => setTarget(e.target.value)} disabled={!hasTexture} className="h-8 w-12" /></label>
          <label className="block text-xs">{t.emission.tolerance} · {Math.round(tolerance * 100)}%<input type="range" min="0.01" max="0.6" step="0.01" value={tolerance} onChange={e => setTolerance(+e.target.value)} disabled={!hasTexture} className={rangeClass} /></label>
          <Button variant="outline" size="sm" className="w-full" disabled={!hasTexture} onClick={() => editor.current?.select(target, tolerance)}>{t.emission.select}</Button>
          <p className="text-xs text-muted-foreground">{hasTexture ? t.emission.selectHint : t.emission.noTexture}</p>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t.emission.tools}>
          {(["brush", "erase", "rotate"] as const).map(v => <Button key={v} size="sm" variant={tool === v ? "default" : "outline"} aria-pressed={tool === v} onClick={() => setTool(v)}>{v === "erase" ? t.emission.erase : t.paint[v]}</Button>)}
        </div>
        <label className="block text-sm">{t.paint.size} · {size}<input type="range" min="0.5" max="15" step="0.5" value={size} onChange={e => setSize(+e.target.value)} className={rangeClass} /></label>
        <div className="flex gap-2"><Button variant="outline" size="sm" disabled={!undoCount} onClick={() => editor.current?.undo()}>{t.paint.undo}</Button><Button variant="outline" size="sm" onClick={() => editor.current?.clear()}>{t.emission.clear}</Button></div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={bloom} onChange={e => setBloom(e.target.checked)} disabled={!editable} className="accent-primary" />{t.emission.bloom}</label>
      <p className="text-xs text-muted-foreground">{t.emission.hint}</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="mt-auto flex gap-2 pt-2"><Button variant="outline" onClick={onCancel} disabled={status === "saving"}>{t.common.cancel}</Button><Button onClick={save} disabled={!ready || !available}>{status === "saving" ? <Spinner /> : null}{t.emission.save}</Button></div>
    </aside>
  </div>;
}
