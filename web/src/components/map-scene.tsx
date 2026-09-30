"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { gltfLoader } from "@/lib/gltf-loader";
import { useI18n } from "./i18n-provider";

export type MapLayer = "terrain" | "water" | "props" | "collision";
export const MAP_LAYERS: MapLayer[] = ["terrain", "water", "props", "collision"];

/** Top-level node names written by worker/map/mapgen.py (GLTFLoader strips the "/" in "Props/<variant>#n"). */
function layerOf(name: string): MapLayer | null {
  if (name === "Terrain") return "terrain";
  if (name === "Water") return "water";
  if (name.startsWith("Props")) return "props";
  if (name === "Collision") return "collision";
  return null;
}

/** A prop instance: its glTF node index (what the server edits by) and variant (shared model). */
export type MapProp = { node: number; variant: string };

/**
 * Orbit viewer for a map scene with per-layer visibility. `resetKey` changes re-frame the camera.
 * Clicking a prop reports its node index (`onPick`, null on empty ground); `selected` props are boxed, `hidden` ones not drawn.
 */
export default function MapScene({
  src,
  visible,
  resetKey,
  selected,
  hidden,
  onPick,
  onLoaded,
}: {
  src: string;
  visible: Record<MapLayer, boolean>;
  resetKey: number;
  selected: number[];
  hidden: number[];
  onPick: (node: number | null, additive: boolean) => void;
  onLoaded?: (counts: Record<MapLayer, number>, props: MapProp[]) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const layers = useRef<Record<MapLayer, THREE.Object3D[]>>({ terrain: [], water: [], props: [], collision: [] });
  const frame = useRef<() => void>(() => {});
  const shown = useRef(visible);
  const propNodes = useRef(new Map<number, THREE.Object3D>());
  const hide = useRef(new Set(hidden));
  const pick = useRef(onPick);
  const highlight = useRef<THREE.Group | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f5);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.4));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun, sun.target);
    const boxes = new THREE.Group();
    highlight.current = boxes;
    scene.add(boxes);
    const nodes = new Map<number, THREE.Object3D>();
    propNodes.current = nodes;

    let disposed = false;
    let raf = 0;
    let controls: { update(): void; dispose(): void; target: THREE.Vector3 } | null = null;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // A click (not an orbit drag) picks the prop under the cursor.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = null;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const candidates = shown.current.props ? [...nodes.entries()].filter(([n]) => !hide.current.has(n)) : [];
      const owner = new Map<THREE.Object3D, number>(candidates.map(([n, o]) => [o, n]));
      const hit = raycaster.intersectObjects(candidates.map(([, o]) => o), true)[0];
      let o: THREE.Object3D | null = hit?.object ?? null;
      while (o && !owner.has(o)) o = o.parent;
      pick.current(o ? owner.get(o)! : null, e.shiftKey || e.metaKey || e.ctrlKey);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    (async () => {
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (disposed) return;
      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      orbit.maxPolarAngle = Math.PI * 0.49; // stay above the ground
      controls = orbit;

      const gltf = await gltfLoader().loadAsync(src).catch(() => null);
      if (disposed) return;
      if (!gltf) return setError(true);
      const root = gltf.scene;
      const found: Record<MapLayer, THREE.Object3D[]> = { terrain: [], water: [], props: [], collision: [] };
      root.traverse((o) => {
        const layer = layerOf(o.name);
        if (layer && o.parent === root) found[layer].push(o);
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      for (const o of found.water) o.traverse((m) => ((m as THREE.Mesh).castShadow = false));
      for (const o of found.collision)
        o.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = mesh.receiveShadow = false;
          mesh.material = new THREE.MeshBasicMaterial({ color: 0xff2bd6, wireframe: true, transparent: true, opacity: 0.5 });
        });
      layers.current = found;
      const props: MapProp[] = [];
      for (const o of found.props) {
        const node = gltf.parser.associations.get(o)?.nodes;
        if (node === undefined) continue;
        nodes.set(node, o);
        props.push({ node, variant: o.name.split("#")[0] });
      }
      scene.add(root);

      const box = new THREE.Box3().setFromObject(found.terrain[0] ?? root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const span = Math.max(size.x, size.z);
      sun.position.copy(center).add(new THREE.Vector3(span * 0.5, span * 0.9, span * 0.35));
      sun.target.position.copy(center);
      Object.assign(sun.shadow.camera, { left: -span * 0.75, right: span * 0.75, top: span * 0.75, bottom: -span * 0.75, near: 0.1, far: span * 3 });
      sun.shadow.camera.updateProjectionMatrix();
      frame.current = () => {
        camera.position.copy(center).add(new THREE.Vector3(span * 0.62, span * 0.55, span * 0.62));
        orbit.target.copy(center);
        orbit.update();
      };
      frame.current();
      onLoaded?.({
        terrain: found.terrain.length,
        water: found.water.length,
        props: found.props.length,
        collision: found.collision.length,
      }, props);
    })();

    const tick = () => {
      raf = requestAnimationFrame(tick);
      for (const layer of MAP_LAYERS) for (const o of layers.current[layer]) o.visible = shown.current[layer];
      for (const [n, o] of nodes) if (hide.current.has(n)) o.visible = false;
      boxes.visible = shown.current.props;
      controls?.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls?.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const m of [mesh.material].flat()) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // onLoaded is a notification only; reloading on its identity would refetch the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    shown.current = visible;
  }, [visible]);

  useEffect(() => {
    if (resetKey) frame.current();
  }, [resetKey]);

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    hide.current = new Set(hidden);
  }, [hidden]);

  useEffect(() => {
    const boxes = highlight.current;
    if (!boxes) return;
    for (const b of boxes.children as THREE.Box3Helper[]) b.dispose();
    boxes.clear();
    for (const n of selected) {
      const o = propNodes.current.get(n);
      if (o) boxes.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(o), 0xffb020));
    }
  }, [selected]);

  return (
    <div ref={host} className="relative size-full overflow-hidden rounded-[20px]">
      {error ? <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{t.maps.loadFailed}</p> : null}
    </div>
  );
}
