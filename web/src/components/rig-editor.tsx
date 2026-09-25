"use client";

import {
  BirdIcon,
  BoxIcon,
  CarIcon,
  ChevronLeftIcon,
  FishIcon,
  HouseIcon,
  MinusIcon,
  PawPrintIcon,
  PersonStandingIcon,
  PlaneIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  SproutIcon,
  TriangleAlertIcon,
  WavesIcon,
  WormIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Vector3 } from "three";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildClips, type RigClip } from "@/lib/rig/clips";
import { attackExtras, hitboxExtras } from "@/lib/rig/hitbox";
import { midDepth, nearestDepth } from "@/lib/rig/model";
import {
  autoRigPlan,
  DEFAULT_RIG_OPTIONS,
  FEELER_CATEGORIES,
  guessMarkers,
  markerIds,
  markerView,
  type Markers,
  MAX_FEELERS,
  planRig,
  RIG_CATEGORIES,
  type RigCategory,
  type RigOptions,
  type RigPlan,
  SWIM_STYLES,
  type SwimStyle,
  syncMirror,
  type Weapon,
  WEAPONS,
} from "@/lib/rig/rig";
import { archetypeOf, requiredClips, SPECIES, type Species } from "@/lib/rig/species";
import { computeSkin } from "@/lib/rig/skin";
import { createStage, type Stage } from "@/lib/rig/stage";
import { cn } from "@/lib/utils";
import type { GenerationDTO } from "@/server/generations";
import { useI18n } from "./i18n-provider";

type Step = "category" | "markers" | "rigging" | "animate";
type View = "front" | "side" | "top" | "free";
const PRESETS = ["front", "side", "top"] as const;

const ICONS: Record<RigCategory, LucideIcon> = {
  humanoid: PersonStandingIcon,
  quadruped: PawPrintIcon,
  bird: BirdIcon,
  serpent: WormIcon,
  fish: FishIcon,
  vehicle: CarIcon,
  aircraft: PlaneIcon,
  plant: SproutIcon,
  fluid: WavesIcon,
  building: HouseIcon,
  prop: BoxIcon,
};
const VIEW_AXES: Record<Exclude<View, "free">, Vector3> = {
  front: new Vector3(0, 0, 1),
  side: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0),
};
const sideOf = (id: string) => (id.endsWith("L") ? "L" : id.endsWith("R") ? "R" : null);
const markerColor = (id: string) => ({ L: "#0071e3", R: "#ff9500", center: "#34c759" })[sideOf(id) ?? "center"];

/**
 * Rig & animate a finished model in the browser: pick a type, drag the guessed joint markers (Mixamo-style),
 * compute skin weights, preview the procedural animations and save a rigged GLB as a new version.
 */
export function RigEditor({
  gen,
  onCancel,
  onSaved,
}: {
  gen: GenerationDTO;
  onCancel: () => void;
  onSaved: (g: GenerationDTO) => void;
}) {
  const { t } = useI18n();
  const tr = t.rig;
  const mount = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const markers = useRef<Markers>({});
  const markerEls = useRef(new Map<string, HTMLElement>());
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [step, setStep] = useState<Step>("category");
  const [category, setCategory] = useState<RigCategory>("humanoid");
  const [options, setOptions] = useState<RigOptions>(DEFAULT_RIG_OPTIONS);
  // Animal preset: sets the options and picks the clips that species needs.
  const [species, setSpecies] = useState<Species | null>(null);
  // Save which bones deal damage in each attack (glTF extras).
  const [hitbox, setHitbox] = useState(false);
  const plan = useRef<RigPlan | null>(null);
  const [view, setView] = useState<View>("front");
  // Marker picked in the list or last dragged: drawn on top with its name shown.
  const [active, setActive] = useState<string | null>(null);
  // Left and right markers overlap in side and top views: edit one side at a time.
  const [side, setSide] = useState<"all" | "L" | "R">("all");
  const [ids, setIds] = useState<{ ids: string[]; derived: Set<string> }>({ ids: [], derived: new Set() });
  const [progress, setProgress] = useState(0);
  const [clips, setClips] = useState<RigClip[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const [showBones, setShowBones] = useState(false);
  const [saving, setSaving] = useState(false);
  // AI auto-rig (only offered when a CUDA worker can do it); `auto` = the current rig came from it.
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [auto, setAuto] = useState(false);
  const [rigMessage, setRigMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/generations/${gen.id}/autorig`)
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => active && setAutoAvailable(d.available === true))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [gen.id]);

  useEffect(() => {
    let disposed = false;
    let created: Stage | null = null;
    createStage(mount.current!, gen.modelUrl!)
      .then((s) => {
        if (disposed) return s.dispose();
        created = stage.current = s;
        const half = s.model.size.length() / 2;
        let shown: View | null = null;
        // Keep the DOM markers glued to their joints while the view orbits, pans and zooms. Markers on the far side
        // of the model shrink and fade, the near ones sit on top, so left and right no longer look alike.
        s.onFrame(() => {
          if (!markerEls.current.size) return;
          const axis = s.viewAxis();
          const v = PRESETS.find((k) => axis.dot(VIEW_AXES[k]) > 0.9995) ?? "free";
          if (v !== shown) setView((shown = v));
          for (const [id, el] of markerEls.current) {
            const p = markers.current[id];
            if (!p) continue;
            const { x, y } = s.project(p);
            const depth = Math.max(-1, Math.min(1, p.clone().sub(s.model.center).dot(axis) / half));
            el.style.transform = `translate(${x}px, ${y}px) scale(${1 + depth * 0.25})`;
            el.style.opacity = depth < -0.05 ? "0.45" : "1";
            el.style.zIndex = String(Number(el.dataset.layer) * 1000 + Math.round((depth + 1) * 400));
          }
        });
        setStatus("ready");
      })
      .catch((e) => {
        console.error(e);
        if (!disposed) setStatus("failed");
      });
    return () => {
      disposed = true;
      created?.dispose();
      stage.current = null;
    };
  }, [gen.modelUrl]);

  const rigInfo = () => ({ archetype: species?.archetype ?? archetypeOf(category, options), species: species?.id ?? null });
  /** Hitbox capsules of the attacks in `list`, on the model rigged from markers. */
  const hitboxesOf = (list: RigClip[]) =>
    plan.current && stage.current ? hitboxExtras(stage.current.model, plan.current, list, rigInfo()).rig.hitboxes : null;

  const refreshPreview = (c = category, o = options) => {
    const s = stage.current;
    if (s) s.setPreview(planRig(c, s.model, markers.current, o));
  };

  /** Guesses the markers; `keep` = placed markers to keep where they are (the ones still used); `keepView` = leave the camera. */
  function startMarkers(c: RigCategory, o: RigOptions, keepView = false, keep: Markers = {}) {
    const s = stage.current!;
    const next = markerIds(c, o);
    const kept = Object.fromEntries(Object.entries(keep).filter(([id]) => next.ids.includes(id) && !next.derived.has(id)));
    markers.current = syncMirror(c, s.model, { ...guessMarkers(c, s.model, o), ...kept }, o);
    setIds(next);
    if (keepView) s.showMarkers(null);
    else {
      const axis = markerView(c, s.model, markers.current, o);
      const v = Math.abs(axis.y) > 0.9 ? "top" : Math.abs(axis.x) > Math.abs(axis.z) ? "side" : "front";
      setView(v);
      s.showMarkers(VIEW_AXES[v]);
    }
    refreshPreview(c, o);
  }

  function chooseCategory(c: RigCategory, sp: Species | null = null) {
    const o = { ...DEFAULT_RIG_OPTIONS, ...sp?.options };
    setCategory(c);
    setSpecies(sp);
    setOptions(o);
    startMarkers(c, o);
    setStep("markers");
  }

  function changeOptions(next: RigOptions) {
    setOptions(next);
    const s = stage.current!;
    // Options other than mirroring change the markers themselves (vehicles: mirroring too, it adds or removes wheels);
    // markers placed by hand stay unless the direction flips.
    const changed = (Object.keys(next) as (keyof RigOptions)[]).filter((key) => next[key] !== options[key]);
    if (category === "vehicle" || changed.some((key) => key !== "symmetry"))
      return startMarkers(category, next, true, category === "vehicle" || changed.includes("flip") ? {} : markers.current);
    markers.current = syncMirror(category, s.model, markers.current, next);
    setIds(markerIds(category, next));
    refreshPreview(category, next);
  }

  function changeView(v: Exclude<View, "free">) {
    setView(v);
    stage.current?.showMarkers(VIEW_AXES[v]);
    refreshPreview();
  }

  function dragMarker(id: string, e: React.PointerEvent<HTMLElement>) {
    const s = stage.current;
    if (!s || ids.derived.has(id)) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(id);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = mount.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const p = s.unproject(ev.clientX - rect.left, ev.clientY - rect.top, markers.current[id]);
      markers.current = syncMirror(category, s.model, { ...markers.current, [id]: (id.startsWith("wing") ? nearestDepth : midDepth)(s.model, p, s.viewAxis()) }, options);
      refreshPreview();
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  async function autoRig() {
    const s = stage.current!;
    const api = `/api/generations/${gen.id}/autorig`;
    setStep("rigging");
    setRigMessage(tr.autoStarting);
    try {
      const res = await fetch(api, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      const job = encodeURIComponent(data.job);
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        if (stage.current !== s) return; // editor closed
        const st = await fetch(`${api}?job=${job}`).then((r) => r.json());
        if (st.status === "failed" || st.error) throw new Error(st.error ?? tr.autoFailed);
        if (st.status === "completed") break;
        setRigMessage(st.message ?? tr.autoStarting);
      }
      const glb = await fetch(`${api}?job=${job}&model`).then((r) => {
        if (!r.ok) throw new Error(t.common.requestFailed(r.status));
        return r.arrayBuffer();
      });
      if (stage.current !== s) return;
      const predicted = (plan.current = autoRigPlan(s.model));
      await s.applyAutoRig(glb, predicted);
      s.setShowBones(showBones);
      const built = buildClips(predicted);
      setAuto(true);
      setClips(built);
      setSelected(new Set(built.map((c) => c.clip.name)));
      setStep("animate");
      play(built[0] ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr.autoFailed);
      setStep("category");
    } finally {
      setRigMessage(null);
    }
  }

  async function rig() {
    const s = stage.current!;
    setAuto(false);
    setStep("rigging");
    setProgress(0);
    const planned = (plan.current = planRig(category, s.model, markers.current, options));
    const skin = await computeSkin(s.model, planned, setProgress);
    s.applyRig(planned, skin);
    s.setShowBones(showBones);
    const built = buildClips(planned);
    setClips(built);
    // A preset starts with the clips its species needs, otherwise all of them.
    const need = species && new Set(requiredClips(species));
    setSelected(new Set(built.filter((c) => !need || need.has(c.clip.name)).map((c) => c.clip.name)));
    if (hitbox) s.setHitboxes(hitboxesOf(built));
    setStep("animate");
    play(built[0] ?? null);
  }

  function play(c: RigClip | null) {
    stage.current?.play(c?.clip ?? null, c?.attack);
    setPlaying(c?.clip.name ?? null);
  }

  function adjust() {
    play(null);
    if (auto) return setStep("category");
    setStep("markers");
    stage.current?.showMarkers(null);
    refreshPreview();
  }

  async function save() {
    const s = stage.current;
    if (!s) return;
    setSaving(true);
    try {
      const chosen = clips.filter((c) => selected.has(c.clip.name));
      const withHitboxes = hitbox && !auto && plan.current;
      for (const c of chosen) c.clip.userData = withHitboxes ? attackExtras(c) : {};
      const extras = withHitboxes
        ? hitboxExtras(s.model, plan.current!, chosen, rigInfo())
        : {};
      const glb = await s.exportGlb(
        chosen.map((c) => c.clip),
        extras,
      );
      const form = new FormData();
      form.set("model", new Blob([glb], { type: "model/gltf-binary" }), "model.glb");
      form.set("meta", JSON.stringify({ category: auto ? "auto" : category, clips: chosen.map((c) => c.clip.name) }));
      const res = await fetch(`/api/generations/${gen.id}/rig`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      toast.success(tr.saved);
      onSaved(data as GenerationDTO);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr.saveFailed);
      setSaving(false);
      const current = clips.find((c) => c.clip.name === playing);
      if (current) s.play(current.clip, current.attack);
    }
  }

  const label = (id: string) => {
    const wheel = /^wheel(\d+)([LR])$/.exec(id);
    if (wheel) return tr.wheel(Number(wheel[1]), wheel[2]);
    const feeler = /^feeler(Root|Tip)(\d+)([LR])$/.exec(id);
    if (feeler) return tr.feeler(Number(feeler[2]), feeler[3], feeler[1] === "Tip");
    return tr.markers[id] ?? id;
  };
  const ready = status === "ready";
  const editable = ids.ids.filter((id) => !ids.derived.has(id));
  const twoSided = editable.some((id) => sideOf(id) === "L") && editable.some((id) => sideOf(id) === "R");
  const locked = (id: string) => ids.derived.has(id) || (twoSided && side !== "all" && sideOf(id) !== null && sideOf(id) !== side);
  const byMovement = [...clips].sort((a, b) => a.movement.localeCompare(b.movement));

  return (
    <div className="absolute inset-0 flex flex-col @3xl/gen:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={mount} className="absolute inset-0" />
        {step === "markers" ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {ids.ids.map((id) => {
              const off = locked(id);
              const on = id === active;
              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) markerEls.current.set(id, el);
                    else markerEls.current.delete(id);
                  }}
                  // Stacking layer: locked markers below the ones that can be dragged, the active one above all.
                  data-layer={off ? 0 : on ? 2 : 1}
                  className="absolute top-0 left-0"
                  style={{ transform: "translate(-999px, -999px)" }}
                >
                  <button
                    type="button"
                    aria-label={label(id)}
                    onPointerDown={(e) => dragMarker(id, e)}
                    className={cn(
                      "group absolute top-0 left-0 grid size-4 -translate-1/2 touch-none place-items-center rounded-full ring-2 ring-white shadow-md transition-[width,height,opacity]",
                      off
                        ? "pointer-events-none size-2.5 opacity-40 ring-1"
                        : "pointer-events-auto cursor-grab active:cursor-grabbing",
                      on && "size-5 ring-[3px]",
                    )}
                    style={{ background: markerColor(id) }}
                  >
                    {/* Exact joint position: the middle of the point. */}
                    {off ? null : <span className="size-1 rounded-full bg-white" />}
                    {off ? null : (
                      <span
                        className={cn(
                          "pointer-events-none absolute top-1/2 left-full ml-1.5 -translate-y-1/2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white transition-opacity",
                          on ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        {label(id)}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-6 text-primary" />
          </div>
        ) : status === "failed" ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <TriangleAlertIcon className="size-4" />
              {tr.loadFailed}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex max-h-[55%] shrink-0 flex-col gap-3.5 rounded-[1.25rem] bg-secondary/40 p-4 @3xl/gen:max-h-none @3xl/gen:w-[320px]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {step === "category" ? tr.chooseTitle : step === "animate" ? tr.animTitle : tr.markersTitle}
            </p>
            <p className="text-xs text-muted-foreground">
              {step === "category"
                ? tr.chooseBody
                : step === "animate"
                  ? tr.animBody
                  : ids.ids.length
                    ? tr.markersBody
                    : tr.noMarkers}
            </p>
          </div>
          <Button variant="ghost" size="icon-xs" aria-label={t.common.cancel} onClick={onCancel} className="-mt-1 -mr-1">
            <XIcon />
          </Button>
        </div>

        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-1 [&>*]:shrink-0">
          {step === "category" && autoAvailable ? (
            <button
              type="button"
              disabled={!ready}
              onClick={autoRig}
              className="flex items-start gap-3 rounded-2xl bg-primary/10 p-3 text-left ring-1 ring-primary/30 transition-all hover:ring-primary/60 disabled:opacity-40"
            >
              <SparklesIcon className="mt-0.5 size-5 shrink-0 text-primary" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] leading-tight font-semibold">{tr.autoTitle}</span>
                <span className="text-[11px] leading-tight text-muted-foreground">{tr.autoHint}</span>
              </span>
            </button>
          ) : null}

          {step === "category" ? (
            <div className="grid grid-cols-2 gap-2">
              {RIG_CATEGORIES.map((c) => {
                const Icon = ICONS[c];
                return (
                  <button
                    key={c}
                    type="button"
                    disabled={!ready}
                    onClick={() => chooseCategory(c)}
                    className="flex flex-col items-start gap-1.5 rounded-2xl bg-card p-3 text-left ring-1 ring-black/5 transition-all hover:ring-primary/40 disabled:opacity-40"
                  >
                    <Icon className="size-5 text-primary" />
                    <span className="text-[13px] leading-tight font-semibold">{tr.categories[c].label}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{tr.categories[c].hint}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {step === "category" ? (
            <>
              <div className="px-1">
                <p className="text-[13px] font-semibold">{tr.speciesTitle}</p>
                <p className="text-[11px] text-muted-foreground">{tr.speciesBody}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SPECIES.map((sp) => (
                  <button
                    key={sp.id}
                    type="button"
                    disabled={!ready}
                    onClick={() => chooseCategory(sp.category, sp)}
                    className="flex flex-col items-start gap-0.5 rounded-xl bg-card px-3 py-2 text-left ring-1 ring-black/5 transition-all hover:ring-primary/40 disabled:opacity-40"
                  >
                    <span className="text-[13px] leading-tight font-semibold">{tr.species[sp.id]?.label ?? sp.id}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{tr.species[sp.id]?.hint}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {step === "markers" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="px-1 text-[13px] font-semibold text-muted-foreground">{tr.view}</span>
                <Tabs value={view} onValueChange={(v) => changeView(v as Exclude<View, "free">)}>
                  <TabsList>
                    {PRESETS.map((v) => (
                      <TabsTrigger key={v} value={v}>
                        {tr.views[v]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <p className="w-full px-1 text-[11px] leading-snug text-muted-foreground">{tr.orbitHint}</p>
              </div>
              <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-card ring-1 ring-black/5">
                {["humanoid", "quadruped", "bird", "fish", "vehicle"].includes(category) ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {category === "vehicle" ? tr.bothSides : tr.symmetry}
                    <Switch checked={options.symmetry} onCheckedChange={(v) => changeOptions({ ...options, symmetry: v })} />
                  </label>
                ) : null}
                {category === "vehicle" ? (
                  <div className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm font-medium">
                    {tr.wheels}
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="-"
                        disabled={options.wheels <= 1}
                        onClick={() => changeOptions({ ...options, wheels: options.wheels - 1 })}
                      >
                        <MinusIcon />
                      </Button>
                      <span className="w-5 text-center tabular-nums">{options.wheels}</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="+"
                        disabled={options.wheels >= 4}
                        onClick={() => changeOptions({ ...options, wheels: options.wheels + 1 })}
                      >
                        <PlusIcon />
                      </Button>
                    </div>
                  </div>
                ) : null}
                {["vehicle", "aircraft", "humanoid", "quadruped", "building"].includes(category) ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.flip}
                    <Switch checked={options.flip} onCheckedChange={(v) => changeOptions({ ...options, flip: v })} />
                  </label>
                ) : null}
                {category === "humanoid" ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.tail}
                    <Switch checked={options.tail} onCheckedChange={(v) => changeOptions({ ...options, tail: v })} />
                  </label>
                ) : null}
                {category === "quadruped" ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.trunk}
                    <Switch checked={options.trunk} onCheckedChange={(v) => changeOptions({ ...options, trunk: v })} />
                  </label>
                ) : null}
                {category === "fish" ? (
                  <>
                    <div className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm font-medium">
                      {tr.swim}
                      <Select value={options.swim} onValueChange={(v) => changeOptions({ ...options, swim: v as SwimStyle })}>
                        <SelectTrigger size="sm" className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SWIM_STYLES.map((w) => (
                            <SelectItem key={w} value={w}>
                              {tr.swimStyles[w]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                      {tr.fins}
                      <Switch checked={options.fins} onCheckedChange={(v) => changeOptions({ ...options, fins: v })} />
                    </label>
                  </>
                ) : null}
                {category === "quadruped" || category === "serpent" || category === "fish" ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.jaw}
                    <Switch checked={options.jaw} onCheckedChange={(v) => changeOptions({ ...options, jaw: v })} />
                  </label>
                ) : null}
                {category === "quadruped" || category === "fish" ? (
                  <>
                    <div className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm font-medium">
                      {tr.horns}
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="-"
                          disabled={options.horns <= 0}
                          onClick={() => changeOptions({ ...options, horns: options.horns - 1 })}
                        >
                          <MinusIcon />
                        </Button>
                        <span className="w-5 text-center tabular-nums">{options.horns}</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="+"
                          disabled={options.horns >= 2}
                          onClick={() => changeOptions({ ...options, horns: options.horns + 1 })}
                        >
                          <PlusIcon />
                        </Button>
                      </div>
                    </div>
                    {category === "quadruped" ? (
                      <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                        {tr.bipedal}
                        <Switch checked={options.bipedal} onCheckedChange={(v) => changeOptions({ ...options, bipedal: v })} />
                      </label>
                    ) : null}
                  </>
                ) : null}
                {category === "humanoid" || category === "quadruped" ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.wings}
                    <Switch checked={options.wings} onCheckedChange={(v) => changeOptions({ ...options, wings: v })} />
                  </label>
                ) : null}
                {category === "humanoid"
                  ? (["weaponRight", "weaponLeft"] as const).map((key) => (
                      <div key={key} className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm font-medium">
                        {tr[key]}
                        <Select value={options[key]} onValueChange={(v) => changeOptions({ ...options, [key]: v as Weapon })}>
                          <SelectTrigger size="sm" className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WEAPONS.map((w) => (
                              <SelectItem key={w} value={w}>
                                {tr.weapons[w]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))
                  : null}
                {FEELER_CATEGORIES.includes(category) ? (
                  <div className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm font-medium">
                    {tr.feelers}
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="-"
                        disabled={!options.feelers}
                        onClick={() => changeOptions({ ...options, feelers: options.feelers - 1 })}
                      >
                        <MinusIcon />
                      </Button>
                      <span className="w-5 text-center tabular-nums">{options.feelers}</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="+"
                        disabled={options.feelers >= MAX_FEELERS}
                        onClick={() => changeOptions({ ...options, feelers: options.feelers + 1 })}
                      >
                        <PlusIcon />
                      </Button>
                    </div>
                  </div>
                ) : null}
                {category === "serpent" ? (
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium">
                    {tr.legs}
                    <Switch checked={options.legs} onCheckedChange={(v) => changeOptions({ ...options, legs: v })} />
                  </label>
                ) : null}
              </div>
              {FEELER_CATEGORIES.includes(category) && options.feelers ? (
                <p className="px-1 text-xs leading-snug text-muted-foreground">{tr.feelersHint}</p>
              ) : null}
              {category === "humanoid" && (options.weaponRight !== "none" || options.weaponLeft !== "none") ? (
                <p className="px-1 text-xs leading-snug text-muted-foreground">{tr.weaponHint}</p>
              ) : null}
              {twoSided ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="px-1 text-[13px] font-semibold text-muted-foreground">{tr.side}</span>
                  <Tabs value={side} onValueChange={(v) => setSide(v as typeof side)}>
                    <TabsList>
                      {(["all", "L", "R"] as const).map((v) => (
                        <TabsTrigger key={v} value={v}>
                          {v === "all" ? null : <span className="size-2 rounded-full" style={{ background: markerColor(v) }} />}
                          {tr.sides[v]}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
              ) : null}
              {editable.length ? (
                <ul className="grid grid-cols-2 gap-1 text-xs">
                  {editable.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => {
                          setActive(id);
                          if (locked(id)) setSide("all");
                        }}
                        className={cn(
                          "flex w-full items-center gap-1.5 truncate rounded-lg px-1.5 py-1 text-left transition-colors",
                          id === active ? "bg-primary/10 font-semibold text-primary" : "hover:bg-card",
                          locked(id) && "opacity-40",
                        )}
                      >
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: markerColor(id) }} />
                        {label(id)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {ids.ids.length ? (
                <Button variant="ghost" size="sm" className="self-start" onClick={() => startMarkers(category, options, true)}>
                  <RotateCcwIcon />
                  {tr.reset}
                </Button>
              ) : null}
            </>
          ) : null}

          {step === "rigging" ? (
            <div className="flex flex-col gap-2 py-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Spinner className="text-primary" />
                {rigMessage ?? tr.rigging(Math.round(progress * 100))}
              </p>
              {rigMessage === null ? <Progress value={progress * 100} /> : null}
            </div>
          ) : null}

          {step === "animate" ? (
            <>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl bg-card px-3.5 py-2.5 text-sm font-medium ring-1 ring-black/5">
                {tr.showBones}
                <Switch
                  checked={showBones}
                  onCheckedChange={(v) => {
                    setShowBones(v);
                    stage.current?.setShowBones(v);
                  }}
                />
              </label>
              {auto ? null : (
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl bg-card px-3.5 py-2.5 text-sm font-medium ring-1 ring-black/5">
                  <span className="flex flex-col gap-0.5">
                    {tr.hitbox}
                    <span className="text-[11px] leading-tight font-normal text-muted-foreground">{tr.hitboxHint}</span>
                  </span>
                  <Switch
                    checked={hitbox}
                    onCheckedChange={(v) => {
                      setHitbox(v);
                      stage.current?.setHitboxes(v ? hitboxesOf(clips) : null);
                    }}
                  />
                </label>
              )}
              <p className="px-1 text-xs font-semibold text-muted-foreground">{tr.selected(selected.size)}</p>
              <ul className="flex flex-col gap-1">
                {byMovement.map((c) => {
                  const name = c.clip.name;
                  return (
                    <li
                      key={name}
                      className={cn(
                        "flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors",
                        playing === name ? "bg-primary/10" : "hover:bg-card",
                      )}
                    >
                      <input
                        type="checkbox"
                        aria-label={tr.clips[name] ?? name}
                        checked={selected.has(name)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(name);
                            else next.delete(name);
                            return next;
                          })
                        }
                        className="size-4 accent-[var(--primary)]"
                      />
                      <span
                        title={tr.movements[c.movement]}
                        className="w-7 shrink-0 rounded-md bg-muted py-0.5 text-center font-mono text-[11px] font-semibold text-muted-foreground"
                      >
                        {c.movement}
                      </span>
                      <button
                        type="button"
                        onClick={() => play(c)}
                        className={cn("flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-sm", playing === name && "font-semibold text-primary")}
                      >
                        <span className="truncate">{tr.clips[name] ?? name}</span>
                        <PlayIcon className="size-3.5 shrink-0 opacity-60" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>

        {step === "markers" ? (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              onClick={() => {
                stage.current?.setPreview(null);
                setStep("category");
              }}
            >
              <ChevronLeftIcon />
              {tr.back}
            </Button>
            <Button className="flex-1" onClick={rig}>
              {tr.rig}
            </Button>
          </div>
        ) : step === "animate" ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={adjust} disabled={saving}>
              <ChevronLeftIcon />
              {tr.adjust}
            </Button>
            <Button className="flex-1" onClick={save} disabled={saving || selected.size === 0}>
              {saving ? <Spinner /> : null}
              {tr.save}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
