"use client";

import { BrushIcon, PaintBucketIcon, Rotate3dIcon, Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BufferAttribute, Material, Mesh } from "three";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { GenerationDTO } from "@/server/generations";
import { useI18n } from "./i18n-provider";

const SWATCHES = ["#ffffff", "#1f1f23", "#e63946", "#f4a259", "#f6e7c1", "#e9c46a", "#2a9d8f", "#3a86ff", "#8338ec", "#8d6e63"];
const MAX_UNDO = 30;

type Tool = "brush" | "rotate";
type Editor = { fill(): void; undo(): void; exportGlb(): Promise<ArrayBuffer> };

/**
 * Hand-painting for shape-only models: brush vertex colors onto the mesh, then save it back as GLB.
 * Brush tool: drag on the model paints, drag on the background rotates.
 */
export function PaintEditor({
  gen,
  onSaved,
  onCancel,
}: {
  gen: GenerationDTO;
  onSaved: (g: GenerationDTO) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const [color, setColor] = useState(SWATCHES[3]);
  const [size, setSize] = useState(5); // brush radius, % of the model's bounding radius
  const [tool, setTool] = useState<Tool>("brush");
  const [status, setStatus] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const brush = useRef({ color, size, tool });

  useEffect(() => {
    brush.current = { color, size, tool };
  }, [color, size, tool]);

  useEffect(() => {
    const el = mount.current!;
    let cleanup: (() => void) | undefined;
    let disposed = false;

    (async () => {
      const THREE = await import("three");
      const { gltfLoader } = await import("@/lib/gltf-loader");
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const gltf = await gltfLoader().loadAsync(gen.modelUrl!);
      if (disposed) return;

      const meshes: Mesh[] = [];
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) meshes.push(o);
      });
      for (const m of meshes) {
        const g = m.geometry;
        if (!g.getAttribute("color"))
          g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(1), 3));
        m.material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.8,
          metalness: 0,
          flatShading: !g.getAttribute("normal"),
        });
      }

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      el.appendChild(canvas);

      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2));
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
      const headlight = new THREE.DirectionalLight(0xffffff, 1.5);
      headlight.position.set(1, 1, 2);
      camera.add(headlight);
      scene.add(camera, gltf.scene);

      const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
      camera.near = sphere.radius / 100;
      camera.far = sphere.radius * 100;
      camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, sphere.radius * 2.6));
      const controls = new OrbitControls(camera, canvas);
      controls.target.copy(sphere.center);
      controls.update();

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = el;
        renderer.setSize(w, h);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      renderer.setAnimationLoop(() => renderer.render(scene, camera));

      // ---- painting ----
      const colors = () => meshes.map((m) => m.geometry.getAttribute("color") as BufferAttribute);
      const snapshot = () => colors().map((a) => (a.array as Float32Array).slice());
      const undoStack: Float32Array[][] = [];
      const pushUndo = (s: Float32Array[]) => {
        undoStack.push(s);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        setUndoCount(undoStack.length);
      };

      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const local = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const hit = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return raycaster.intersectObjects(meshes, false)[0];
      };
      const paintAt = (h: NonNullable<ReturnType<typeof hit>>) => {
        const mesh = h.object as Mesh;
        const c = new THREE.Color(brush.current.color); // sRGB hex -> linear, as glTF COLOR_0 expects
        mesh.worldToLocal(local.copy(h.point));
        const radius = (sphere.radius * brush.current.size) / 100 / mesh.getWorldScale(scale).x;
        const pos = mesh.geometry.getAttribute("position");
        const col = mesh.geometry.getAttribute("color");
        for (let i = 0; i < pos.count; i++) {
          const dx = pos.getX(i) - local.x;
          const dy = pos.getY(i) - local.y;
          const dz = pos.getZ(i) - local.z;
          if (dx * dx + dy * dy + dz * dz <= radius * radius) col.setXYZ(i, c.r, c.g, c.b);
        }
        col.needsUpdate = true;
      };

      let stroke: Float32Array[] | null = null;
      // Capture phase: runs before OrbitControls, so a stroke on the model disables orbiting first.
      const onDown = (e: PointerEvent) => {
        if (brush.current.tool !== "brush" || e.button !== 0) return;
        const h = hit(e);
        if (!h) return;
        controls.enabled = false;
        stroke = snapshot();
        canvas.setPointerCapture(e.pointerId);
        paintAt(h);
      };
      const onMove = (e: PointerEvent) => {
        if (!stroke) return;
        const h = hit(e);
        if (h) paintAt(h);
      };
      const onUp = () => {
        if (!stroke) return;
        pushUndo(stroke);
        stroke = null;
        controls.enabled = true;
      };
      canvas.addEventListener("pointerdown", onDown, { capture: true });
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onUp);

      editor.current = {
        fill() {
          pushUndo(snapshot());
          const c = new THREE.Color(brush.current.color);
          for (const col of colors()) {
            for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
            col.needsUpdate = true;
          }
        },
        undo() {
          const s = undoStack.pop();
          if (!s) return;
          colors().forEach((col, i) => {
            (col.array as Float32Array).set(s[i]);
            col.needsUpdate = true;
          });
          setUndoCount(undoStack.length);
        },
        async exportGlb() {
          return (await new GLTFExporter().parseAsync(gltf.scene, { binary: true })) as ArrayBuffer;
        },
      };
      setStatus("ready");

      cleanup = () => {
        editor.current = null;
        renderer.setAnimationLoop(null);
        ro.disconnect();
        controls.dispose();
        for (const m of meshes) {
          m.geometry.dispose();
          (m.material as Material).dispose();
        }
        renderer.dispose();
        canvas.remove();
      };
    })().catch((e) => {
      console.error(e);
      if (!disposed) setLoadFailed(true);
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [gen.modelUrl]);

  async function save() {
    if (!editor.current) return;
    setStatus("saving");
    setError(null);
    try {
      const glb = await editor.current.exportGlb();
      const res = await fetch(`/api/generations/${gen.id}/model`, {
        method: "PUT",
        body: glb,
        headers: { "Content-Type": "model/gltf-binary" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      onSaved(data as GenerationDTO);
      toast.success(t.paint.saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.paint.saveFailed);
      setStatus("ready");
    }
  }

  const ready = status === "ready";
  const message = loadFailed ? t.paint.loadFailed : error;
  return (
    <div className="absolute inset-0">
      <div ref={mount} className={cn("absolute inset-0", tool === "brush" && "cursor-crosshair")} />
      {status === "loading" && !loadFailed ? (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-6 text-primary" />
        </div>
      ) : null}

      <div className="glass absolute inset-x-3 top-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl p-2 shadow-float ring-1 ring-black/5">
        <Tabs value={tool} onValueChange={(v) => setTool(v as Tool)}>
          <TabsList>
            <TabsTrigger value="brush">
              <BrushIcon />
              {t.paint.brush}
            </TabsTrigger>
            <TabsTrigger value="rotate">
              <Rotate3dIcon />
              {t.paint.rotate}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((s) => (
            <button
              key={s}
              onClick={() => setColor(s)}
              aria-label={t.paint.color(s)}
              className={cn(
                "size-6 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110",
                color === s && "ring-2 ring-primary ring-offset-2",
              )}
              style={{ background: s }}
            />
          ))}
          <label
            className="relative size-6 cursor-pointer rounded-full ring-1 ring-black/10 transition-transform hover:scale-110"
            style={{ background: "conic-gradient(#ff3b30, #ff9500, #ffcc00, #34c759, #5ac8fa, #0071e3, #af52de, #ff3b30)" }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label={t.paint.customColor}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold text-muted-foreground">{t.paint.size}</span>
          <Slider min={1} max={30} value={[size]} onValueChange={([v]) => setSize(v)} className="w-24" />
        </div>
        <div className="ml-auto flex gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t.paint.fillAll} onClick={() => editor.current?.fill()} disabled={!ready}>
                <PaintBucketIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.paint.fillAll}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t.paint.undo}
                onClick={() => editor.current?.undo()}
                disabled={!ready || undoCount === 0}
              >
                <Undo2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.paint.undo}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-end gap-2">
        {message ? (
          <p className="mr-auto rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">{message}</p>
        ) : (
          <p className="glass mr-auto hidden rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground ring-1 ring-black/5 sm:block">
            {t.paint.hint}
          </p>
        )}
        <Button variant="outline" onClick={onCancel} disabled={status === "saving"}>
          {t.common.cancel}
        </Button>
        <Button onClick={save} disabled={!ready}>
          {status === "saving" ? <Spinner /> : null}
          {t.paint.save}
        </Button>
      </div>
    </div>
  );
}
