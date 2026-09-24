"use client";

import {
  ArrowBigUpIcon,
  BoneIcon,
  BoxIcon,
  CameraIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CompassIcon,
  CuboidIcon,
  FlipVertical2Icon,
  Gamepad2Icon,
  Grid2x2Icon,
  Grid3x3Icon,
  ImageIcon,
  InfoIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  Rotate3dIcon,
  RotateCcwIcon,
  RulerIcon,
  ScanEyeIcon,
  SkullIcon,
  SunIcon,
  SwordsIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Material, Mesh, Texture, Vector3 } from "three";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "./i18n-provider";

export type ViewMode = "textured" | "clay" | "wireframe" | "normals" | "uv" | "rig";
type Lighting = "studio" | "soft" | "contrast";
type CameraView = "iso" | "front" | "back" | "left" | "right" | "top";
/** Game controller: D-pad directions and the current locomotion state. */
export type PlayDir = "up" | "down" | "left" | "right";
export type PlayAction = "idle" | "walk" | "run" | "jump" | "attack" | "dead";

const MODES: { id: ViewMode; icon: LucideIcon }[] = [
  { id: "textured", icon: ImageIcon },
  { id: "clay", icon: CuboidIcon },
  { id: "wireframe", icon: Grid3x3Icon },
  { id: "normals", icon: CompassIcon },
  { id: "uv", icon: Grid2x2Icon },
  { id: "rig", icon: BoneIcon },
];
const LIGHTING: Lighting[] = ["studio", "soft", "contrast"];
const VIEWS: CameraView[] = ["iso", "front", "back", "left", "right", "top"];
const VIEW_DIRS: Record<CameraView, [number, number, number]> = {
  iso: [0.55, 0.35, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.001],
};

type Stats = {
  vertices: number;
  triangles: number;
  meshes: number;
  materials: number;
  textures: number;
  maxTextureSize: number;
  size: [number, number, number];
  hasUv: boolean;
  hasVertexColors: boolean;
  bones: number;
  animations: string[];
};

type Engine = {
  setMode(mode: ViewMode): void;
  setLighting(lighting: Lighting): void;
  setDark(dark: boolean): void;
  setGrid(on: boolean): void;
  setBounds(on: boolean): void;
  setAutoRotate(on: boolean): void;
  /** Turns the model 180° about its center (Z axis), so it stays on the ground. */
  setFlipped(on: boolean): void;
  /** The model as shown (textured, rest pose, current orientation) as binary GLB. */
  exportGlb(): Promise<ArrayBuffer>;
  view(view: CameraView): void;
  playAnimation(index: number | null): void;
  /** Plays a clip once, then calls `done`. */
  playOnce(index: number, done: () => void): void;
  /** Whether a canvas pixel is on the model. */
  hit(x: number, y: number): boolean;
  screenshot(): string;
  /** Game controller: drive the character around the grid (takes over the mixer while on). */
  setPlay(on: boolean): void;
  setDir(dir: PlayDir, on: boolean): void;
  /** Returns false when the model has no such animation (React shows a hint). */
  playJump(): boolean;
  playAttack(): boolean;
  playDie(): boolean;
  resetPlay(): void;
  onPlayState(cb: (a: PlayAction) => void): () => void;
};

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/** Colored, labelled grid for checking UV layout and texel stretching. */
function uvCheckerCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  const n = 8;
  const cell = canvas.width / n;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 36px Montserrat, system-ui, sans-serif";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = `hsl(${(x / n) * 320} 65% ${(x + y) % 2 ? 66 : 52}%)`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.fillStyle = "rgb(255 255 255 / 0.92)";
      ctx.fillText(`${String.fromCharCode(65 + x)}${n - y}`, (x + 0.5) * cell, (y + 0.5) * cell);
    }
  return canvas;
}

function ToolButton({
  label,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * D-pad button: press-and-hold to walk/run. Uses pointer capture so a tap always
 * releases on the same button (a double release is a no-op in the engine).
 */
function PadButton({
  dir,
  label,
  active,
  onPress,
  children,
}: {
  dir: PlayDir;
  label: string;
  active?: boolean;
  onPress: (dir: PlayDir, on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          aria-pressed={active}
          onFocus={(e) => e.currentTarget.blur()}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            onPress(dir, true);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            onPress(dir, false);
          }}
          onPointerCancel={() => onPress(dir, false)}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            "grid size-11 place-items-center rounded-xl bg-card text-foreground/70 ring-1 ring-black/10 transition-colors hover:text-foreground",
            active && "bg-primary/15 text-primary ring-primary/40",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** One-shot game action (jump / attack / die). Fires on press for low latency. */
function ActionButton({
  label,
  shortcut,
  onTap,
  highlight,
  danger,
  children,
}: {
  label: string;
  shortcut: string;
  onTap: () => void;
  highlight?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          onFocus={(e) => e.currentTarget.blur()}
          onPointerDown={(e) => {
            e.preventDefault();
            onTap();
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            "flex size-11 flex-col items-center justify-center gap-0 rounded-xl text-foreground/70 transition-colors hover:bg-card hover:text-foreground",
            highlight && "bg-primary/15 text-primary",
            danger && "bg-destructive/10 text-destructive",
          )}
        >
          {children}
          <span className="text-[9px] leading-none font-bold opacity-60">{shortcut}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
/**
 * Three.js model inspector: textured / clay / wireframe / normals / UV checker / rig views, lighting presets,
 * camera presets, grid, bounds, upside-down flip (saved to the model file), mesh statistics, screenshots and fullscreen.
 */
export function ModelInspector({
  src,
  fileBytes,
  baseName,
  onSaveModel,
}: {
  src: string;
  fileBytes?: number | null;
  baseName: string;
  /** Persists an edited model (binary GLB); the saved copy comes back as a new `src`. */
  onSaveModel: (glb: ArrayBuffer) => Promise<void>;
}) {
  const { t } = useI18n();
  const tv = t.viewer;
  const root = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [loaded, setLoaded] = useState<{ src: string; ok: boolean } | null>(null);
  const status = loaded?.src !== src ? "loading" : loaded.ok ? "ready" : "failed";
  const [stats, setStats] = useState<Stats | null>(null);
  const [mode, setMode] = useState<ViewMode>("textured");
  const [lighting, setLighting] = useState<Lighting>("studio");
  const [dark, setDark] = useState(false);
  const [grid, setGrid] = useState(true);
  const [bounds, setBounds] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [clip, setClip] = useState(0);
  const [paused, setPaused] = useState(false);
  const anim = useRef({ clip, paused });
  const pointerDown = useRef<{ x: number; y: number } | null>(null);
  const [playMode, setPlayMode] = useState(false);
  const [playAction, setPlayAction] = useState<PlayAction>("idle");
  const [heldDirs, setHeldDirs] = useState<Set<PlayDir>>(new Set());
  const playModeRef = useRef(false);
  useEffect(() => {
    playModeRef.current = playMode;
  }, [playMode]);

  useEffect(() => {
    const el = mount.current!;
    let cleanup: (() => void) | undefined;
    let disposed = false;

    (async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const gltf = await new GLTFLoader().loadAsync(src);
      if (disposed) return;
      const model = gltf.scene;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      el.appendChild(canvas);

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;

      // ---- model + stats ----
      const meshes: Mesh[] = [];
      model.traverse((o) => {
        if ((o as Mesh).isMesh) meshes.push(o as Mesh);
      });
      const original = new Map<Mesh, Material | Material[]>();
      const materials = new Set<Material>();
      const textures = new Set<Texture>();
      const bones = new Set<string>();
      let vertices = 0;
      let triangles = 0;
      let hasUv = false;
      let hasVertexColors = false;
      for (const m of meshes) {
        const g = m.geometry;
        if (!g.getAttribute("normal")) g.computeVertexNormals();
        m.castShadow = true;
        original.set(m, m.material);
        const count = g.getAttribute("position").count;
        vertices += count;
        triangles += (g.index ? g.index.count : count) / 3;
        hasUv ||= Boolean(g.getAttribute("uv"));
        hasVertexColors ||= Boolean(g.getAttribute("color"));
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          materials.add(mat);
          for (const v of Object.values(mat)) if ((v as Texture)?.isTexture) textures.add(v as Texture);
        }
        const skinned = m as Mesh & { isSkinnedMesh?: boolean; skeleton?: { bones: { uuid: string }[] } };
        if (skinned.isSkinnedMesh) skinned.skeleton?.bones.forEach((b) => bones.add(b.uuid));
      }
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
      // Flipping turns this pivot 180° about Z through the box center, which maps the box onto itself.
      const pivot = new THREE.Group();
      // The mover carries the game-controller offset (position + facing). It sits outside `model`
      // so `restPose` (which resets every object under `model`) never wipes the character's place.
      const mover = new THREE.Group();
      pivot.add(mover);
      mover.add(model);
      scene.add(pivot);
      setStats({
        vertices,
        triangles: Math.round(triangles),
        meshes: meshes.length,
        materials: materials.size,
        textures: textures.size,
        maxTextureSize: Math.max(0, ...[...textures].map((tx) => (tx.image as { width?: number } | null)?.width ?? 0)),
        size: [size.x, size.y, size.z],
        hasUv,
        hasVertexColors,
        bones: bones.size,
        animations: gltf.animations.map((a, i) => a.name || `#${i + 1}`),
      });

      // ---- view-mode materials ----
      const clay = new THREE.MeshStandardMaterial({ color: 0x9d9da6, roughness: 0.7, metalness: 0 });
      const wireBase = clay.clone();
      Object.assign(wireBase, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const wireLines = new THREE.MeshBasicMaterial({ color: 0x1d1d1f, wireframe: true, transparent: true, opacity: 0.32 });
      const normals = new THREE.MeshNormalMaterial();
      const checkerMap = new THREE.CanvasTexture(uvCheckerCanvas());
      Object.assign(checkerMap, { colorSpace: THREE.SRGBColorSpace, flipY: false, anisotropy: 8 });
      checkerMap.wrapS = checkerMap.wrapT = THREE.RepeatWrapping;
      const checker = new THREE.MeshStandardMaterial({ map: checkerMap, roughness: 0.75 });
      const xray = new THREE.MeshStandardMaterial({ color: 0x9d9da6, transparent: true, opacity: 0.3, depthWrite: false });
      const wires = meshes.map((m) => {
        const w = new THREE.Mesh(m.geometry, wireLines);
        w.visible = false;
        m.add(w);
        return w;
      });
      const skeleton = bones.size ? new THREE.SkeletonHelper(model) : null;
      if (skeleton) {
        const mat = skeleton.material as Material;
        mat.depthTest = false;
        skeleton.renderOrder = 999;
        skeleton.visible = false;
        scene.add(skeleton);
      }

      // ---- lights, ground, helpers ----
      const hemi = new THREE.HemisphereLight(0xffffff, 0x8d8d95, 0.4);
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.02;
      Object.assign(key.shadow.camera, {
        left: -radius * 1.6,
        right: radius * 1.6,
        top: radius * 1.6,
        bottom: -radius * 1.6,
        near: radius * 0.1,
        far: radius * 12,
      });
      key.target.position.copy(center);
      scene.add(hemi, key, key.target);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(radius * 12, radius * 12),
        new THREE.ShadowMaterial({ opacity: 0.16 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(center.x, box.min.y, center.z);
      ground.receiveShadow = true;
      const makeGrid = (isDark: boolean) => {
        const g = new THREE.GridHelper(radius * 6, 24, isDark ? 0x5a5a60 : 0xa1a1a8, isDark ? 0x3a3a3e : 0xc8c8ce);
        const mat = g.material as Material;
        mat.transparent = true;
        mat.opacity = 0.7;
        g.position.set(center.x, box.min.y - radius * 0.002, center.z);
        return g;
      };
      let gridHelper = makeGrid(false);
      const boundsHelper = new THREE.Box3Helper(box, 0x0071e3);
      boundsHelper.visible = false;
      scene.add(ground, gridHelper, boundsHelper);

      // ---- camera + controls ----
      const camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.85;
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotateSpeed = 1.5;
      controls.minDistance = radius * 0.2;
      controls.maxDistance = radius * 20;
      controls.target.copy(center);
      const dirOf = (v: CameraView) => new THREE.Vector3(...VIEW_DIRS[v]).normalize();
      camera.position.copy(center).addScaledVector(dirOf("iso"), distance);
      controls.update();

      let tween: { from: Vector3; to: Vector3; start: number } | null = null;

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = el;
        renderer.setSize(w, h);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      const mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : null;
      // Clips only key the bones they move: restore the rest pose before switching clips.
      const rest: [InstanceType<typeof THREE.Object3D>, Vector3, InstanceType<typeof THREE.Quaternion>, Vector3][] = [];
      model.traverse((o) => rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
      const restPose = () =>
        rest.forEach(([o, p, q, s]) => {
          o.position.copy(p);
          o.quaternion.copy(q);
          o.scale.copy(s);
        });
      const raycaster = new THREE.Raycaster();
      const timer = new THREE.Timer();

      // ---- game controller: walk / run inside the grid, jump / attack / die ----
      // Single tap on a direction = a short walk step; holding the button (>0.45s) = run.
      // Position is clamped to the grid so the character never leaves the map.
      const play = {
        on: false,
        dirs: new Set<PlayDir>(),
        downAt: new Map<PlayDir, number>(),
        x: 0,
        z: 0,
        yaw: 0,
        vy: 0,
        y: 0,
        air: false,
        atkUntil: 0,
        dead: false,
        walkUntil: 0,
        loop: "__none",
        action: "idle" as PlayAction,
        listeners: new Set<(a: PlayAction) => void>(),
      };
      const RUN_AFTER_MS = 450;
      const TAP_MS = 260;
      const WALK_SPEED = radius * 1.2;
      const RUN_SPEED = radius * 3.1;
      const LIMIT = radius * 2.4;
      const JUMP_H = radius * 0.6;
      const JUMP_T = 0.65;
      const JUMP_V0 = (4 * JUMP_H) / JUMP_T;
      const JUMP_G = (8 * JUMP_H) / (JUMP_T * JUMP_T);
      const DIR_VEC: Record<PlayDir, [number, number]> = {
        up: [0, -1],
        down: [0, 1],
        left: [-1, 0],
        right: [1, 0],
      };
      const animNames = gltf.animations.map((a) => a.name);
      const findClip = (re: RegExp) => animNames.findIndex((n) => re.test(n));
      const idxIdle = findClip(/idle/i);
      const idxWalk = findClip(/walk/i);
      const idxRun = findClip(/run/i);
      const idxMoveAlt = findClip(/drive|fly|swim|glide|hover/i);
      const idxJump = findClip(/jump|hop/i);
      const idxAttack = findClip(/attack/i);
      const idxHit = findClip(/hit/i);
      const idxDeath = findClip(/death/i);
      const idxFall = findClip(/fall/i);
      const moveWalkIdx =
        idxWalk >= 0 ? idxWalk : idxRun >= 0 ? idxRun : idxMoveAlt >= 0 ? idxMoveAlt : idxIdle >= 0 ? idxIdle : -1;
      const moveRunIdx = idxRun >= 0 ? idxRun : moveWalkIdx;
      const jumpClipIdx = idxJump;
      const attackClipIdx = idxAttack >= 0 ? idxAttack : idxHit;
      const deathClipIdx = idxDeath >= 0 ? idxDeath : idxHit >= 0 ? idxHit : idxFall;
      const tmpTarget = new THREE.Vector3();
      const emitAction = (a: PlayAction) => {
        if (play.action === a) return;
        play.action = a;
        play.listeners.forEach((cb) => cb(a));
      };
      const playLoopIdx = (i: number) => {
        if (!mixer || i < 0 || !gltf.animations[i]) return;
        if (play.loop === `loop:${i}`) return;
        mixer.stopAllAction();
        restPose();
        mixer.clipAction(gltf.animations[i]).reset().setLoop(THREE.LoopRepeat, Infinity).play();
        play.loop = `loop:${i}`;
      };
      const playOnceIdx = (i: number) => {
        if (!mixer || i < 0 || !gltf.animations[i]) return 0;
        mixer.stopAllAction();
        restPose();
        const action = mixer.clipAction(gltf.animations[i]).reset();
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        play.loop = `once:${i}:${performance.now()}`;
        return gltf.animations[i].duration;
      };
      const stopToIdle = () => {
        if (idxIdle >= 0) playLoopIdx(idxIdle);
        else if (mixer && play.loop !== "stopped") {
          mixer.stopAllAction();
          restPose();
          play.loop = "stopped";
        }
        emitAction("idle");
      };
      const angleLerp = (a: number, b: number, t: number) => {
        let d = (b - a) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        return a + d * t;
      };
      const focusOf = (out: Vector3) => out.set(center.x + play.x, center.y, center.z + play.z);
      const playTick = (dt: number, now: number) => {
        if (!play.on) return;
        // The camera gently follows the character so it never walks out of view.
        tmpTarget.set(center.x + play.x, center.y, center.z + play.z);
        controls.target.lerp(tmpTarget, 1 - Math.exp(-4 * dt));
        let ix = 0;
        let iz = 0;
        play.dirs.forEach((d) => {
          const [vx, vz] = DIR_VEC[d];
          ix += vx;
          iz += vz;
        });
        const hasInput = ix !== 0 || iz !== 0;
        if (play.dead) {
          // Any direction revives the character.
          if (hasInput) {
            play.dead = false;
            play.atkUntil = 0;
            play.loop = "__none";
            stopToIdle();
          }
          return;
        }
        if (play.air) {
          play.vy -= JUMP_G * dt;
          play.y += play.vy * dt;
          if (play.y <= 0) {
            play.y = 0;
            play.air = false;
            play.loop = "__none";
            stopToIdle();
          } else {
            mover.position.set(play.x, play.y, play.z);
          }
          return;
        }
        if (now < play.atkUntil) return;
        if (hasInput) {
          let earliest = Infinity;
          play.dirs.forEach((d) => {
            const t = play.downAt.get(d) ?? now;
            if (t < earliest) earliest = t;
          });
          const running = now - earliest > RUN_AFTER_MS;
          const speed = running ? RUN_SPEED : WALK_SPEED;
          const len = Math.hypot(ix, iz) || 1;
          play.x = THREE.MathUtils.clamp(play.x + (ix / len) * speed * dt, -LIMIT, LIMIT);
          play.z = THREE.MathUtils.clamp(play.z + (iz / len) * speed * dt, -LIMIT, LIMIT);
          play.yaw = angleLerp(play.yaw, Math.atan2(ix / len, iz / len), 1 - Math.exp(-12 * dt));
          mover.position.set(play.x, 0, play.z);
          mover.rotation.set(0, play.yaw, 0);
          playLoopIdx(running ? moveRunIdx : moveWalkIdx);
          emitAction(running ? "run" : "walk");
        } else {
          // A quick tap keeps the walk clip playing briefly so a single press visibly steps.
          if (now < play.walkUntil) {
            playLoopIdx(moveWalkIdx);
            emitAction("walk");
            return;
          }
          stopToIdle();
        }
      };

      renderer.setAnimationLoop((time) => {
        timer.update(time);
        const dt = Math.min(timer.getDelta(), 0.05);
        if (tween) {
          const k = Math.min(1, (performance.now() - tween.start) / 450);
          const ease = 1 - Math.pow(1 - k, 3);
          camera.position.lerpVectors(tween.from, tween.to, ease);
          if (k === 1) tween = null;
        }
        playTick(dt, performance.now());
        mixer?.update(dt);
        controls.update();
        renderer.render(scene, camera);
      });

      let currentMode: ViewMode = "textured";
      engine.current = {
        setMode(mode) {
          currentMode = mode;
          const material = { clay, wireframe: wireBase, normals, uv: checker, rig: xray }[mode as Exclude<ViewMode, "textured">];
          for (const m of meshes) m.material = mode === "textured" ? original.get(m)! : material;
          for (const w of wires) w.visible = mode === "wireframe";
          if (skeleton) skeleton.visible = mode === "rig";
        },
        setLighting(l) {
          const p = {
            studio: { env: 1, key: 1.6, hemi: 0.4, shadow: 0.16, dir: [1.2, 2.2, 1.6] },
            soft: { env: 1.25, key: 0.5, hemi: 0.6, shadow: 0.08, dir: [0.4, 3, 0.8] },
            contrast: { env: 0.35, key: 3.2, hemi: 0.15, shadow: 0.3, dir: [2.4, 1.6, 0.6] },
          }[l];
          scene.environmentIntensity = p.env;
          key.intensity = p.key;
          hemi.intensity = p.hemi;
          (ground.material as InstanceType<typeof THREE.ShadowMaterial>).opacity = p.shadow;
          key.position.copy(center).add(new THREE.Vector3(...p.dir).multiplyScalar(radius * 2));
        },
        setDark(isDark) {
          const visible = gridHelper.visible;
          scene.remove(gridHelper);
          gridHelper.dispose();
          gridHelper = makeGrid(isDark);
          gridHelper.visible = visible;
          scene.add(gridHelper);
          wireLines.color.set(isDark ? 0xf5f5f7 : 0x1d1d1f);
        },
        setGrid(on) {
          gridHelper.visible = on;
        },
        setBounds(on) {
          boundsHelper.visible = on;
        },
        setAutoRotate(on) {
          controls.autoRotate = on;
        },
        setFlipped(on) {
          pivot.rotation.z = on ? Math.PI : 0;
          pivot.position.set(on ? center.x * 2 : 0, on ? center.y * 2 : 0, 0);
        },
        async exportGlb() {
          // Export original materials, no wireframe overlay, bones at rest.
          const mode = currentMode;
          this.setMode("textured");
          mixer?.stopAllAction();
          restPose();
          const mx = mover.position.x;
          const my = mover.position.y;
          const mz = mover.position.z;
          const ry = mover.rotation.y;
          mover.position.set(0, 0, 0);
          mover.rotation.set(0, 0, 0);
          try {
            return (await new GLTFExporter().parseAsync(pivot, {
              binary: true,
              animations: gltf.animations,
            })) as ArrayBuffer;
          } finally {
            mover.position.set(mx, my, mz);
            mover.rotation.set(0, ry, 0);
            this.setMode(mode);
          }
        },
        view(v) {
          const focus = play.on ? focusOf(new THREE.Vector3()) : center.clone();
          controls.target.copy(focus);
          tween = {
            from: camera.position.clone(),
            to: focus.addScaledVector(dirOf(v), distance),
            start: performance.now(),
          };
        },
        playAnimation(index) {
          if (!mixer || play.on) return;
          mixer.stopAllAction();
          restPose();
          if (index !== null && gltf.animations[index]) mixer.clipAction(gltf.animations[index]).reset().play();
        },
        playOnce(index, done) {
          if (!mixer) return;
          mixer.stopAllAction();
          restPose();
          const action = mixer.clipAction(gltf.animations[index]).reset();
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          const onFinished = (e: { action: unknown }) => {
            if (e.action !== action) return;
            mixer.removeEventListener("finished", onFinished);
            done();
          };
          mixer.addEventListener("finished", onFinished);
          action.play();
        },
        hit(x, y) {
          raycaster.setFromCamera(new THREE.Vector2((x / el.clientWidth) * 2 - 1, 1 - (y / el.clientHeight) * 2), camera);
          return raycaster.intersectObjects(meshes, false).length > 0;
        },
        screenshot() {
          renderer.render(scene, camera);
          return canvas.toDataURL("image/png");
        },
        setPlay(on) {
          play.on = on;
          play.dirs.clear();
          play.downAt.clear();
          play.x = 0;
          play.z = 0;
          play.yaw = 0;
          play.vy = 0;
          play.y = 0;
          play.air = false;
          play.atkUntil = 0;
          play.dead = false;
          play.walkUntil = 0;
          play.loop = "__none";
          mover.position.set(0, 0, 0);
          mover.rotation.set(0, 0, 0);
          if (on) {
            controls.autoRotate = false;
            controls.target.copy(center);
            if (mixer) {
              if (idxIdle >= 0) playLoopIdx(idxIdle);
              else {
                mixer.stopAllAction();
                restPose();
                play.loop = "stopped";
              }
            }
            emitAction("idle");
          } else {
            controls.target.copy(center);
            if (mixer) {
              mixer.stopAllAction();
              restPose();
            }
          }
        },
        setDir(dir, on) {
          if (!play.on) return;
          const now = performance.now();
          if (on) {
            if (!play.dirs.has(dir)) {
              play.downAt.set(dir, now);
              play.dirs.add(dir);
            }
            return;
          }
          if (!play.dirs.has(dir)) return;
          const held = now - (play.downAt.get(dir) ?? now);
          play.dirs.delete(dir);
          play.downAt.delete(dir);
          // Quick tap = one visible walk step plus a short walk tail.
          if (!play.dead && !play.air && now >= play.atkUntil && held < TAP_MS) {
            const [vx, vz] = DIR_VEC[dir];
            const step = radius * 0.35;
            play.x = THREE.MathUtils.clamp(play.x + vx * step, -LIMIT, LIMIT);
            play.z = THREE.MathUtils.clamp(play.z + vz * step, -LIMIT, LIMIT);
            play.yaw = angleLerp(play.yaw, Math.atan2(vx, vz), 0.6);
            mover.position.set(play.x, 0, play.z);
            mover.rotation.set(0, play.yaw, 0);
            play.walkUntil = now + 450;
            playLoopIdx(moveWalkIdx);
            emitAction("walk");
          }
        },
        playJump() {
          if (!play.on || play.dead || play.air) return false;
          if (performance.now() < play.atkUntil) return false;
          play.air = true;
          play.vy = JUMP_V0;
          play.y = 0;
          if (jumpClipIdx >= 0) playOnceIdx(jumpClipIdx);
          emitAction("jump");
          return true;
        },
        playAttack() {
          if (!play.on || play.dead || play.air) return false;
          const now = performance.now();
          if (now < play.atkUntil || attackClipIdx < 0) return false;
          const dur = playOnceIdx(attackClipIdx);
          play.atkUntil = now + Math.max(dur, 0.4) * 1000;
          emitAction("attack");
          return true;
        },
        playDie() {
          if (!play.on || play.air || deathClipIdx < 0) return false;
          if (play.dead) {
            play.dead = false;
            play.atkUntil = 0;
            play.loop = "__none";
            stopToIdle();
            return true;
          }
          play.dirs.clear();
          play.downAt.clear();
          play.atkUntil = 0;
          playOnceIdx(deathClipIdx);
          play.dead = true;
          emitAction("dead");
          return true;
        },
        resetPlay() {
          if (!play.on) return;
          play.dirs.clear();
          play.downAt.clear();
          play.x = 0;
          play.z = 0;
          play.yaw = 0;
          play.vy = 0;
          play.y = 0;
          play.air = false;
          play.atkUntil = 0;
          play.dead = false;
          play.walkUntil = 0;
          play.loop = "__none";
          mover.position.set(0, 0, 0);
          mover.rotation.set(0, 0, 0);
          controls.target.copy(center);
          stopToIdle();
        },
        onPlayState(cb) {
          play.listeners.add(cb);
          cb(play.action);
          return () => {
            play.listeners.delete(cb);
          };
        },
      };
      setClip(0);
      setPaused(false);
      // Plain white shape-only models read better as clay.
      if (!textures.size && !hasVertexColors) setMode("clay");
      setLoaded({ src, ok: true });

      cleanup = () => {
        engine.current = null;
        renderer.setAnimationLoop(null);
        ro.disconnect();
        controls.dispose();
        mixer?.stopAllAction();
        model.traverse((o) => {
          const m = o as Mesh;
          if (!m.isMesh) return;
          m.geometry.dispose();
        });
        for (const mat of [...materials, clay, wireBase, wireLines, normals, checker, xray]) mat.dispose();
        for (const tx of [...textures, checkerMap, envMap]) tx.dispose();
        skeleton?.dispose();
        gridHelper.dispose();
        boundsHelper.dispose();
        ground.geometry.dispose();
        pmrem.dispose();
        renderer.dispose();
        canvas.remove();
      };
    })().catch((e) => {
      console.error(e);
      if (!disposed) setLoaded({ src, ok: false });
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [src]);

  // Push UI state into the scene (also re-applied once the model has loaded).
  useEffect(() => engine.current?.setMode(mode), [mode, status]);
  useEffect(() => engine.current?.setLighting(lighting), [lighting, status]);
  useEffect(() => engine.current?.setDark(dark), [dark, status]);
  useEffect(() => engine.current?.setGrid(grid), [grid, status]);
  useEffect(() => engine.current?.setBounds(bounds), [bounds, status]);
  useEffect(() => engine.current?.setAutoRotate(autoRotate), [autoRotate, status]);
  useEffect(() => {
    anim.current = { clip, paused };
    if (playModeRef.current) return;
    engine.current?.playAnimation(paused ? null : clip);
  }, [clip, paused, status]);

  // Game controller: entering play mode hands the mixer to the engine; leaving restores the chosen clip.
  useEffect(() => {
    if (status !== "ready") return;
    engine.current?.setPlay(playMode);
    if (!playMode) engine.current?.playAnimation(paused ? null : clip);
  }, [playMode, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror the current locomotion state for the HUD.
  useEffect(() => {
    if (!playMode || status !== "ready") return;
    return engine.current?.onPlayState(setPlayAction);
  }, [playMode, status]);

  // Game keys: arrows move (tap = walk, hold = run), Space = jump, A = attack, D = die.
  useEffect(() => {
    if (!playMode) return;
    const dirOf = (key: string): PlayDir | null =>
      key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : null;
    const onDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest("input, textarea, select, [contenteditable]")) return;
      const d = dirOf(e.key);
      if (d) {
        e.preventDefault();
        pressDir(d, true);
        return;
      }
      if (e.repeat) return;
      if (e.key === " ") {
        e.preventDefault();
        engine.current?.playJump();
      } else if (e.key === "a" || e.key === "A") {
        if (engine.current?.playAttack() === false) toast.info(tv.noAttack);
      } else if (e.key === "d" || e.key === "D") {
        if (engine.current?.playDie() === false) toast.info(tv.noDeath);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const d = dirOf(e.key);
      if (d) {
        e.preventDefault();
        pressDir(d, false);
      }
    };
    const onBlur = () => releaseAllDirs();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [playMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keyboard: 1–6 view modes, F frames the model. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest("input, textarea, select, [contenteditable]")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= MODES.length) setMode(MODES[n - 1].id);
      else if (e.key === "f" || e.key === "F") engine.current?.view("iso");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function screenshot() {
    const url = engine.current?.screenshot();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.png`;
    a.click();
  }

  /** Flips the model and saves it, so rigging, painting and downloads all get the upright copy. */
  async function flip() {
    const e = engine.current;
    if (!e) return;
    setSaving(true);
    e.setFlipped(true);
    try {
      await onSaveModel(await e.exportGlb());
      toast.success(tv.orientationSaved);
    } catch (err) {
      engine.current?.setFlipped(false);
      toast.error(err instanceof Error ? err.message : t.paint.saveFailed);
    } finally {
      setSaving(false);
      const { clip: c, paused: p } = anim.current;
      engine.current?.playAnimation(p ? null : c);
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen();
  }

  function pressDir(dir: PlayDir, on: boolean) {
    engine.current?.setDir(dir, on);
    setHeldDirs((prev) => {
      if (on ? prev.has(dir) : !prev.has(dir)) return prev;
      const next = new Set(prev);
      if (on) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }

  function releaseAllDirs() {
    (["up", "down", "left", "right"] as const).forEach((d) => engine.current?.setDir(d, false));
    setHeldDirs((prev) => (prev.size ? new Set() : prev));
  }

  function togglePlay() {
    if (!ready && !playMode) return;
    releaseAllDirs();
    if (!playMode) setAutoRotate(false);
    setPlayMode((v) => !v);
  }

  function doJump() {
    engine.current?.playJump();
  }

  function doAttack() {
    if (engine.current?.playAttack() === false) toast.info(tv.noAttack);
  }

  function doDie() {
    if (engine.current?.playDie() === false) toast.info(tv.noDeath);
  }

  const playLabel =
    playAction === "walk"
      ? tv.walk
      : playAction === "run"
        ? tv.run
        : playAction === "jump"
          ? tv.jump
          : playAction === "attack"
            ? tv.attack
            : playAction === "dead"
              ? tv.die
              : tv.idle;

  const ready = status === "ready";
  const notice =
    ready && stats
      ? mode === "rig" && !stats.bones
        ? { title: tv.noRigTitle, body: tv.noRigBody }
        : mode === "uv" && !stats.hasUv
          ? { title: tv.noUvTitle, body: tv.noUvBody }
          : null
      : null;
  const dims = stats?.size.map((v) => v.toFixed(v < 10 ? 2 : 1)).join(" × ");
  const interaction = stats?.animations.findIndex((n) => n.startsWith("Interact")) ?? -1;
  const clipLabel = (name: string) => t.rig.clips[name] ?? name;

  return (
    <div
      ref={root}
      className={cn("@container absolute inset-0 overflow-hidden", dark ? "bg-[#1c1c1e]" : "bg-stage", fullscreen && "rounded-none")}
    >
      <div
        ref={mount}
        className="absolute inset-0"
        onPointerDown={(e) => {
          pointerDown.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          // A click (not a drag) on the model plays its interaction clip once (disabled while playing).
          const start = pointerDown.current;
          pointerDown.current = null;
          if (playModeRef.current) return;
          if (!start || interaction < 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
          const r = mount.current!.getBoundingClientRect();
          const engineNow = engine.current;
          if (!engineNow?.hit(e.clientX - r.left, e.clientY - r.top)) return;
          engineNow.playOnce(interaction, () => {
            const { clip: c, paused: p } = anim.current;
            engine.current?.playAnimation(p ? null : c);
          });
        }}
      />

      {status === "loading" ? (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-6 text-primary" />
        </div>
      ) : status === "failed" ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlertIcon className="size-4" />
            {tv.loadFailed}
          </p>
        </div>
      ) : null}

      {/* View modes */}
      <div className="glass absolute top-3 left-3 flex max-w-[calc(100%-4.5rem)] gap-0.5 overflow-x-auto rounded-[12px] p-[3px] shadow-float ring-1 ring-black/5">
        {MODES.map(({ id, icon: Icon }, i) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setMode(id)}
                disabled={!ready}
                aria-pressed={mode === id}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-semibold text-foreground/60 transition-all hover:text-foreground disabled:opacity-40",
                  mode === id && "bg-card text-foreground shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)]",
                )}
              >
                <Icon className="size-4" />
                <span className="hidden @3xl:inline">{tv.modes[id]}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {tv.modes[id]} · {i + 1}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Tools */}
      <div className="glass absolute top-3 right-3 flex flex-col gap-0.5 rounded-[14px] p-1 shadow-float ring-1 ring-black/5">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={tv.lighting} disabled={!ready}>
                  <SunIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">{tv.lighting}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="left" align="start" className="w-44">
            <DropdownMenuLabel>{tv.lighting}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={lighting} onValueChange={(v) => setLighting(v as Lighting)}>
              {LIGHTING.map((l) => (
                <DropdownMenuRadioItem key={l} value={l}>
                  {tv.lights[l]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={tv.camera} disabled={!ready}>
                  <ScanEyeIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">{tv.camera}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="left" align="start" className="w-44">
            <DropdownMenuLabel>{tv.camera}</DropdownMenuLabel>
            {VIEWS.map((v) => (
              <DropdownMenuItem key={v} onSelect={() => engine.current?.view(v)}>
                {tv.views[v]}
                {v === "iso" ? <DropdownMenuShortcut>F</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton label={tv.autoRotate} active={autoRotate} onClick={() => setAutoRotate((v) => !v)} disabled={!ready || playMode}>
          <Rotate3dIcon />
        </ToolButton>
        <ToolButton label={tv.grid} active={grid} onClick={() => setGrid((v) => !v)} disabled={!ready}>
          <Grid3x3Icon />
        </ToolButton>
        <ToolButton label={tv.bounds} active={bounds} onClick={() => setBounds((v) => !v)} disabled={!ready}>
          <RulerIcon />
        </ToolButton>
        <ToolButton label={tv.flip} onClick={flip} disabled={!ready || saving || playMode}>
          {saving ? <Spinner /> : <FlipVertical2Icon />}
        </ToolButton>
        <ToolButton label={playMode ? tv.exitPlay : tv.playMode} active={playMode} onClick={togglePlay} disabled={!ready}>
          <Gamepad2Icon />
        </ToolButton>
        <ToolButton label={dark ? tv.lightBackground : tv.darkBackground} onClick={() => setDark((v) => !v)}>
          {dark ? <SunIcon /> : <MoonIcon />}
        </ToolButton>
        <div className="mx-1.5 my-0.5 h-px bg-border" />
        <ToolButton label={tv.screenshot} onClick={screenshot} disabled={!ready}>
          <CameraIcon />
        </ToolButton>
        <ToolButton label={fullscreen ? tv.exitFullscreen : tv.fullscreen} onClick={toggleFullscreen}>
          {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </ToolButton>
      </div>

      {/* Stats */}
      {ready && stats ? (
        <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
          {showStats ? (
            <div className="glass w-60 rounded-2xl p-3.5 text-xs shadow-float ring-1 ring-black/5">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                <BoxIcon className="size-4 text-primary" />
                {tv.stats}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                {(
                  [
                    [tv.vertices, stats.vertices.toLocaleString()],
                    [tv.triangles, stats.triangles.toLocaleString()],
                    [tv.meshes, String(stats.meshes)],
                    [tv.materials, String(stats.materials)],
                    [
                      tv.textures,
                      stats.textures ? `${stats.textures} · ${stats.maxTextureSize}px` : tv.none,
                    ],
                    [tv.uv, stats.hasUv ? tv.yes : tv.no],
                    [tv.vertexColors, stats.hasVertexColors ? tv.yes : tv.no],
                    [tv.bones, stats.bones ? String(stats.bones) : tv.none],
                    [tv.dimensions, dims],
                    ...(fileBytes ? [[tv.fileSize, `${(fileBytes / 1024 / 1024).toFixed(1)} MB`]] : []),
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setShowStats((v) => !v)}
            className="glass inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold shadow-float ring-1 ring-black/5 transition-colors hover:text-primary"
          >
            <InfoIcon className="size-3.5" />
            {tv.trisShort(compact(stats.triangles))}
            <span className="text-muted-foreground">·</span>
            <span className="font-medium text-muted-foreground">{tv.vertsShort(compact(stats.vertices))}</span>
          </button>
        </div>
      ) : null}

      {/* Animations (rigged models): play in every view mode. Hidden while playing — the game controller owns the mixer. */}
      {ready && stats?.animations.length && !playMode ? (
        <div className="glass absolute right-3 bottom-3 flex max-w-[calc(100%-1.5rem)] items-center gap-0.5 rounded-full p-1 shadow-float ring-1 ring-black/5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={paused ? tv.play : tv.pause}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0">
                <span className="truncate">{clipLabel(stats.animations[clip] ?? "")}</span>
                <ChevronDownIcon className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuLabel>{tv.animations(stats.animations.length)}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(clip)}
                onValueChange={(v) => {
                  setClip(Number(v));
                  setPaused(false);
                }}
              >
                {stats.animations.map((name, i) => (
                  <DropdownMenuRadioItem key={`${i}-${name}`} value={String(i)}>
                    {clipLabel(name)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {interaction >= 0 ? (
                <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{t.rig.clickHint}</p>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {/* Game controller HUD: current state + key hints */}
      {playMode && ready ? (
        <div className="pointer-events-none absolute inset-x-3 top-16 flex flex-col items-center gap-1.5">
          <div
            className={cn(
              "glass inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold shadow-float ring-1 ring-black/5",
              (playAction === "run" || playAction === "attack") && "text-primary",
              playAction === "dead" && "text-destructive",
            )}
          >
            <Gamepad2Icon className="size-4" />
            {playLabel}
          </div>
          <p className="glass rounded-full px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-float ring-1 ring-black/5">
            {tv.playHint}
          </p>
        </div>
      ) : null}

      {/* D-pad: tap = walk one step, hold = run. Clamped to the grid. */}
      {playMode && ready ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 touch-none select-none">
          <div className="glass grid grid-cols-3 gap-1 rounded-2xl p-2 shadow-float ring-1 ring-black/5" onContextMenu={(e) => e.preventDefault()}>
            <span />
            <PadButton dir="up" active={heldDirs.has("up")} label="↑" onPress={pressDir}>
              <ChevronUpIcon className="size-5" />
            </PadButton>
            <span />
            <PadButton dir="left" active={heldDirs.has("left")} label="←" onPress={pressDir}>
              <ChevronLeftIcon className="size-5" />
            </PadButton>
            <PadButton dir="down" active={heldDirs.has("down")} label="↓" onPress={pressDir}>
              <ChevronDownIcon className="size-5" />
            </PadButton>
            <PadButton dir="right" active={heldDirs.has("right")} label="→" onPress={pressDir}>
              <ChevronRightIcon className="size-5" />
            </PadButton>
          </div>
        </div>
      ) : null}

      {/* Action buttons: Space = jump, A = attack, D = die */}
      {playMode && ready ? (
        <div className="absolute right-3 bottom-3 flex items-center gap-1.5 touch-none select-none">
          <div className="glass flex items-center gap-1 rounded-full p-1 shadow-float ring-1 ring-black/5" onContextMenu={(e) => e.preventDefault()}>
            <ActionButton label={`${tv.jump} (Space)`} shortcut="Space" onTap={doJump}>
              <ArrowBigUpIcon className="size-5" />
            </ActionButton>
            <ActionButton label={`${tv.attack} (A)`} shortcut="A" onTap={doAttack} highlight={playAction === "attack"}>
              <SwordsIcon className="size-5" />
            </ActionButton>
            <ActionButton label={`${tv.die} (D)`} shortcut="D" onTap={doDie} danger={playAction === "dead"}>
              <SkullIcon className="size-5" />
            </ActionButton>
            <div className="mx-0.5 h-6 w-px bg-border" />
            <ToolButton label={tv.resetPos} onClick={() => engine.current?.resetPlay()}>
              <RotateCcwIcon />
            </ToolButton>
          </div>
        </div>
      ) : null}

      {notice && !playMode ? (
        <div className="pointer-events-none absolute inset-x-3 top-16 flex justify-center">
          <div className="glass max-w-sm rounded-2xl px-4 py-3 text-center shadow-float ring-1 ring-black/5">
            <p className="text-sm font-semibold">{notice.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{notice.body}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
