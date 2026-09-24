"use client";

import {
  BoneIcon,
  BrushIcon,
  CircleCheckIcon,
  CircleIcon,
  FileXIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { GenerationDTO, VersionDTO } from "@/server/generations";
import { ExportMenu } from "./export-menu";
import { useI18n } from "./i18n-provider";
import { ModelInspector } from "./model-inspector";
import { PaintEditor } from "./paint-editor";
import { RefinePanel } from "./refine-panel";

// Loaded on demand: three.js + BVH + skinning only when the user opens the rig editor.
const RigEditor = dynamic(() => import("./rig-editor").then((m) => m.RigEditor), { ssr: false });

const POLL_MS = 2500;
const isActive = (g: GenerationDTO) => g.status === "queued" || g.status === "processing";

/** Stages reported by the self-hosted worker, in order (see worker/server.py). */
const STAGES = ["Creating concept image", "Preparing image", "Generating shape", "Cleaning mesh", "Painting texture"];

function stagesOf(gen: GenerationDTO) {
  const { refine } = gen;
  if (refine)
    return [
      "Preparing image",
      "Editing image",
      ...(refine.keepShape ? ["Loading model"] : ["Generating shape", "Cleaning mesh"]),
      ...(gen.textured ? ["Painting texture"] : []),
    ];
  return STAGES.filter(
    (s) => (s !== "Creating concept image" || gen.mode === "text") && (s !== "Painting texture" || gen.textured),
  );
}

export function formatBytes(n: number | null) {
  if (!n) return "";
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function stageLabel(message: string, t: Dictionary) {
  const queued = /^In queue \(position (\d+)\)$/.exec(message);
  if (queued) return t.gen.queuePosition(Number(queued[1]));
  return t.gen.stages[message] ?? message;
}

function Progress({ gen, elapsed }: { gen: GenerationDTO; elapsed: number }) {
  const { t } = useI18n();
  const message = gen.progressMessage ?? "Generating";
  const steps = stagesOf(gen);
  const current = steps.indexOf(message);
  const percent = gen.progress ?? 0;
  return (
    <div className="glass-card w-full max-w-xs rounded-[20px] p-5 text-left">
      <div className="flex items-center gap-3.5">
        {gen.inputImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={gen.inputImageUrl} alt="" className="size-14 shrink-0 rounded-2xl bg-muted object-contain p-1" />
        ) : (
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <SparklesIcon className="size-6" />
          </span>
        )}
        <div className="min-w-0">
          <p className="font-semibold">{gen.refine ? t.gen.refining : t.gen.working}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {gen.refine ? t.gen.elapsedRefine(elapsed) : t.gen.elapsed(elapsed)}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <ProgressBar value={percent} aria-label={t.gen.working} className="h-2" />
        <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums">{percent}%</span>
      </div>
      {gen.refine ? (
        <p className="mt-3 line-clamp-2 rounded-xl bg-primary/5 px-3 py-2 text-xs font-medium text-primary">
          {gen.refine.prompt}
        </p>
      ) : null}
      <ul className="mt-5 flex flex-col gap-3 text-sm">
        {current === -1 ? (
          <li className="flex items-center gap-2.5 font-medium">
            <Spinner className="text-primary" />
            {stageLabel(message, t)}
          </li>
        ) : (
          steps.map((s, i) => (
            <li
              key={s}
              className={cn(
                "flex items-center gap-2.5",
                i === current ? "font-semibold" : i > current ? "text-muted-foreground" : "",
              )}
            >
              {i < current ? (
                <CircleCheckIcon className="size-4 text-success" />
              ) : i === current ? (
                <Spinner className="text-primary" />
              ) : (
                <CircleIcon className="size-4 opacity-40" />
              )}
              {stageLabel(s, t)}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function Versions({ versions, currentId, onOpen }: { versions: VersionDTO[]; currentId: string; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-2 pt-1 pb-1.5">
      <span className="shrink-0 text-xs font-semibold text-muted-foreground">{t.gen.versions}</span>
      {versions.map((v, i) => (
        <Tooltip key={v.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onOpen(v.id)}
              aria-current={v.id === currentId}
              className={cn(
                "relative size-11 shrink-0 overflow-hidden rounded-xl bg-stage ring-1 ring-black/5 transition-transform hover:scale-105",
                v.id === currentId && "ring-2 ring-primary",
              )}
            >
              {v.inputImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.inputImageUrl} alt="" className="size-full object-contain p-0.5" />
              ) : (
                <SparklesIcon className="m-auto size-4 text-muted-foreground" />
              )}
              {v.status === "queued" || v.status === "processing" ? (
                <span className="absolute inset-0 grid place-items-center bg-white/60">
                  <Spinner className="size-4 text-primary" />
                </span>
              ) : v.status === "failed" ? (
                <span className="absolute inset-0 grid place-items-center bg-white/60 text-destructive">
                  <TriangleAlertIcon className="size-4" />
                </span>
              ) : null}
              <span className="absolute bottom-0.5 left-0.5 rounded-[5px] bg-black/55 px-1 text-[10px] leading-4 font-bold text-white">
                {t.gen.version(i + 1)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">
            {v.rig
              ? t.rig.summary(t.rig.categories[v.rig.category]?.label ?? v.rig.category, v.rig.clips.length)
              : (v.refine?.prompt ?? t.gen.original)}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Shows a generation and keeps polling it until it reaches a terminal state. With `syncUrl` (the model page),
 * opening another version or starting a refinement navigates to that version's URL.
 */
export function GenerationView({ initial, syncUrl = false }: { initial: GenerationDTO; syncUrl?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [gen, setGen] = useState(initial);
  const [elapsed, setElapsed] = useState(0);
  const [painting, setPainting] = useState(false);
  const [refining, setRefining] = useState(false);
  const [rigging, setRigging] = useState(false);
  const [versions, setVersions] = useState<VersionDTO[]>([]);

  useEffect(() => {
    if (!isActive(gen)) return;
    let cancelled = false;
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - Date.parse(gen.createdAt)) / 1000)), 1000);
    const poll = setTimeout(async () => {
      try {
        const res = await fetch(`/api/generations/${gen.id}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as GenerationDTO;
        if (cancelled) return;
        setGen(next);
        if (!isActive(next)) router.refresh(); // refresh credit balance (refunds) and lists
      } catch {
        // transient error: re-render schedules another poll
        if (!cancelled) setGen((g) => ({ ...g }));
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(tick);
      clearTimeout(poll);
    };
  }, [gen, router]);

  // Reload the version list when another version is shown or this one finishes.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/generations/${gen.id}/versions`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((list: VersionDTO[] | null) => {
        if (list && !cancelled) setVersions(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gen.id, gen.status]);

  async function open(id: string) {
    setRefining(false);
    setPainting(false);
    setRigging(false);
    if (syncUrl) return router.replace(`/app/generations/${id}`, { scroll: false });
    const res = await fetch(`/api/generations/${id}`, { cache: "no-store" });
    if (res.ok) setGen((await res.json()) as GenerationDTO);
  }

  const done = gen.status === "succeeded" && gen.modelUrl && gen.modelDownloadUrl;
  const editing = painting || rigging;
  /** A new version was made (refined or rigged): show it. */
  const showVersion = (next: GenerationDTO) => {
    setRefining(false);
    setRigging(false);
    if (syncUrl) router.replace(`/app/generations/${next.id}`, { scroll: false });
    else setGen(next);
    router.refresh(); // credit balance and nav busy indicator
  };
  const baseName = `model-${gen.id.slice(0, 8)}`;

  return (
    <div className="@container/gen flex h-full flex-col">
      <div className="relative flex min-h-[320px] flex-1 gap-2">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-[1.25rem] bg-stage">
          {gen.status === "succeeded" && gen.modelUrl ? (
            rigging ? (
              <RigEditor gen={gen} onCancel={() => setRigging(false)} onSaved={showVersion} />
            ) : painting ? (
              <PaintEditor
                gen={gen}
                onCancel={() => setPainting(false)}
                onSaved={(next) => {
                  setGen(next);
                  setPainting(false);
                }}
              />
            ) : (
              <ModelInspector
                src={gen.modelUrl}
                fileBytes={gen.modelBytes}
                baseName={baseName}
                onSaveModel={async (glb) => {
                  const res = await fetch(`/api/generations/${gen.id}/model`, {
                    method: "PUT",
                    body: glb,
                    headers: { "Content-Type": "model/gltf-binary" },
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
                  setGen(data as GenerationDTO);
                }}
              />
            )
          ) : gen.status === "succeeded" ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="flex max-w-sm flex-col items-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
                  <FileXIcon className="size-7" />
                </span>
                <p className="mt-4 font-semibold">{t.gen.fileMissing}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t.gen.fileMissingBody}</p>
              </div>
            </div>
          ) : gen.status === "failed" ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="flex max-w-sm flex-col items-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
                  <TriangleAlertIcon className="size-7" />
                </span>
                <p className="mt-4 font-semibold">{t.gen.failed}</p>
                {gen.error ? <p className="mt-1 text-sm text-muted-foreground">{gen.error}</p> : null}
                {gen.cost > 0 ? <p className="mt-1 text-xs text-muted-foreground">{t.gen.failedHint}</p> : null}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center overflow-hidden p-6">
              {gen.inputImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={gen.inputImageUrl}
                  alt=""
                  aria-hidden
                  className="pointer-events-none absolute inset-0 size-full scale-105 object-cover opacity-90 blur-sm"
                />
              ) : null}
              <Progress gen={gen} elapsed={elapsed} />
            </div>
          )}
        </div>
        {refining && done && !editing ? (
          <RefinePanel gen={gen} onClose={() => setRefining(false)} onCreated={showVersion} />
        ) : null}
      </div>

      <div className="flex flex-col gap-3 px-2 pt-3 pb-1 @xl/gen:flex-row @xl/gen:items-center @xl/gen:justify-between">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{gen.prompt ?? t.gen.imageTo3d}</p>
          {gen.refine ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <WandSparklesIcon className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">{gen.refine.prompt}</span>
            </p>
          ) : null}
          {gen.rig ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <BoneIcon className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">
                {t.rig.summary(t.rig.categories[gen.rig.category]?.label ?? gen.rig.category, gen.rig.clips.length)}
              </span>
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={gen.textured ? "default" : "secondary"} className={gen.textured ? "bg-primary/10 text-primary" : ""}>
              {gen.textured ? t.gen.textured : t.gen.shapeOnly}
            </Badge>
            {[
              t.engines[gen.engine] ?? gen.engine,
              t.quality[gen.quality]?.label ?? gen.quality,
              t.gen.seed(gen.seed),
              gen.cost > 0 ? t.common.credits(gen.cost) : null,
              gen.modelBytes ? formatBytes(gen.modelBytes) : null,
            ]
              .filter(Boolean)
              .map((s) => (
                <Badge key={s} variant="secondary" className="font-medium text-muted-foreground">
                  {s}
                </Badge>
              ))}
          </div>
          {gen.stats ? <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">{t.gen.stats(gen.stats)}</p> : null}
        </div>
        {done && !editing ? (
          <div className="flex flex-wrap items-center gap-2">
            {!gen.rig ? (
              <Button
                variant="outline"
                onClick={() => {
                  setRefining(false);
                  setRigging(true);
                }}
              >
                <BoneIcon />
                {t.rig.open}
              </Button>
            ) : null}
            {gen.inputImageUrl ? (
              <Button variant="tinted" onClick={() => setRefining((v) => !v)} aria-expanded={refining}>
                <WandSparklesIcon />
                {t.gen.refine}
              </Button>
            ) : null}
            {/* No auto texture: let the user paint colors by hand. */}
            {!gen.textured && !gen.rig ? (
              <Button variant="outline" onClick={() => setPainting(true)}>
                <BrushIcon />
                {t.gen.paint}
              </Button>
            ) : null}
            <ExportMenu modelUrl={gen.modelUrl!} downloadUrl={gen.modelDownloadUrl!} baseName={baseName} />
          </div>
        ) : null}
      </div>
      {versions.length > 1 ? <Versions versions={versions} currentId={gen.id} onOpen={open} /> : null}
    </div>
  );
}
