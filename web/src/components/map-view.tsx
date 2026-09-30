"use client";

import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  DownloadIcon,
  LocateFixedIcon,
  MapIcon,
  RotateCcwIcon,
  SaveIcon,
  ShrinkIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { COMPRESS_LEVELS } from "@/lib/config";
import type { Dictionary } from "@/lib/i18n";
import { fmtSecs } from "@/lib/i18n/dictionaries/en";
import { cn } from "@/lib/utils";
import type { MapDTO, MapEdit } from "@/server/maps";
import { formatBytes } from "./generation-view";
import { useI18n } from "./i18n-provider";
import { MAP_LAYERS, type MapLayer, type MapProp } from "./map-scene";

const MapScene = dynamic(() => import("./map-scene"), { ssr: false, loading: () => <div className="size-full animate-pulse rounded-[20px] bg-muted" /> });

const POLL_MS = 5000;
const STAGES = ["Estimating depth", "Finding objects", "Building terrain", "Generating props", "Composing scene"];

function stageLabel(message: string, t: Dictionary) {
  const queued = /^In queue \(position (\d+)\)$/.exec(message);
  if (queued) return t.gen.queuePosition(Number(queued[1]));
  const props = /^Generating props \((\d+)\/(\d+)\)$/.exec(message);
  if (props) return `${t.maps.stages["Generating props"]} (${props[1]}/${props[2]})`;
  return t.maps.stages[message] ?? message;
}

function Progress({ map }: { map: MapDTO }) {
  const { t } = useI18n();
  const message = map.progressMessage ?? "Starting";
  const stage = STAGES.find((s) => message.startsWith(s));
  const current = stage ? STAGES.indexOf(stage) : -1;
  const percent = map.progress ?? 0;
  return (
    <div className="glass-card w-full max-w-sm rounded-[20px] p-5 text-left">
      <div className="flex items-center gap-3.5">
        {map.inputImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={map.inputImageUrl} alt="" className="size-14 shrink-0 rounded-2xl bg-muted object-cover" />
        ) : (
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <MapIcon className="size-6" />
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold">{map.name ?? t.meta.map}</p>
          <p className="text-xs text-muted-foreground">{stageLabel(message, t)}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <ProgressBar value={percent} aria-label={t.maps.build} className="h-2" />
        <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums">{percent}%</span>
      </div>
      <ul className="mt-5 flex flex-col gap-3 text-sm">
        {STAGES.map((s, i) => (
          <li key={s} className={cn("flex items-center gap-2.5", i === current ? "font-semibold" : i > current ? "text-muted-foreground" : "")}>
            {i < current ? (
              <CircleCheckIcon className="size-4 text-success" />
            ) : i === current ? (
              <Spinner className="text-primary" />
            ) : (
              <CircleIcon className="size-4 opacity-40" />
            )}
            {i === current ? stageLabel(message, t) : t.maps.stages[s]}
          </li>
        ))}
      </ul>
      <p className="mt-5 rounded-xl bg-primary/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{t.maps.timeNote}</p>
    </div>
  );
}

export function MapView({ initial }: { initial: MapDTO }) {
  const { t } = useI18n();
  const router = useRouter();
  const [map, setMap] = useState(initial);
  const [visible, setVisible] = useState<Record<MapLayer, boolean>>({ terrain: true, water: true, props: true, collision: false });
  const [counts, setCounts] = useState<Record<MapLayer, number> | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [props, setProps] = useState<MapProp[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [removed, setRemoved] = useState<number[]>([]); // hidden in the viewer until saved
  const [busy, setBusy] = useState(false);
  const active = map.status === "queued" || map.status === "processing";

  const onLoaded = useCallback((c: Record<MapLayer, number>, p: MapProp[]) => {
    setCounts(c);
    setProps(p);
  }, []);

  const onPick = useCallback((node: number | null, additive: boolean) => {
    setSelected((cur) => {
      if (node === null) return additive ? cur : [];
      if (!additive) return cur.length === 1 && cur[0] === node ? [] : [node];
      return cur.includes(node) ? cur.filter((n) => n !== node) : [...cur, node];
    });
  }, []);

  const removeSelected = useCallback(() => {
    setRemoved((cur) => [...cur, ...selected.filter((n) => !cur.includes(n))]);
    setSelected([]);
  }, [selected]);

  function selectSameVariant() {
    const variants = new Set(props.filter((p) => selected.includes(p.node)).map((p) => p.variant));
    setSelected(props.filter((p) => variants.has(p.variant) && !removed.includes(p.node)).map((p) => p.node));
  }

  async function edit(body: MapEdit) {
    setBusy(true);
    try {
      const res = await fetch(`/api/maps/${map.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      const next = data as MapDTO;
      if ("compress" in body) toast.success(t.compress.done(formatBytes(map.modelBytes), formatBytes(next.modelBytes)));
      setMap(next);
      setSelected([]);
      setRemoved([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.maps.edit.failed);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!selected.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Delete" || e.key === "Backspace") removeSelected();
      if (e.key === "Escape") setSelected([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, removeSelected]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/maps/${map.id}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const next = (await res.json()) as MapDTO;
      setMap(next);
      if (next.status !== "queued" && next.status !== "processing") router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, map.id, router]);

  if (active)
    return (
      <div className="grid size-full place-items-center rounded-[20px] bg-stage p-4">
        <Progress map={map} />
      </div>
    );

  if (map.status === "failed" || !map.modelUrl)
    return (
      <div className="grid size-full place-items-center rounded-[20px] bg-stage p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2">
          <TriangleAlertIcon className="size-8 text-destructive" />
          <p className="font-semibold">{t.maps.failed}</p>
          {map.error ? <p className="text-sm text-muted-foreground">{map.error}</p> : null}
          <p className="text-xs text-muted-foreground">{t.maps.retryHint}</p>
        </div>
      </div>
    );

  const s = map.stats ?? {};
  const stats = [
    s.props !== undefined && [t.maps.stats.props, String(s.props)],
    s.variants !== undefined && [t.maps.stats.variants, String(s.variants)],
    s.size_m !== undefined && [t.maps.stats.size, `${s.size_m} m`],
    map.modelBytes && [t.maps.stats.fileSize, formatBytes(map.modelBytes)],
    s["t:total"] !== undefined && [t.maps.stats.time, fmtSecs(s["t:total"])],
  ].filter((x): x is string[] => Boolean(x));

  return (
    <div className="relative size-full">
      <MapScene
        src={map.modelUrl}
        visible={visible}
        resetKey={resetKey}
        selected={selected}
        hidden={removed}
        onPick={onPick}
        onLoaded={onLoaded}
      />
      <div className="glass-card absolute top-3 left-3 flex w-56 flex-col gap-2.5 rounded-2xl p-3.5">
        <p className="text-xs font-semibold text-muted-foreground uppercase">{t.maps.layers}</p>
        {MAP_LAYERS.map((layer) => (
          <label key={layer} className="flex items-center justify-between gap-2 text-sm font-medium">
            <span>
              {t.maps.layer[layer]}
              {counts && layer === "props" ? (
                <span className="ml-1 text-xs text-muted-foreground tabular-nums">{counts.props - removed.length}</span>
              ) : null}
            </span>
            <Switch
              checked={visible[layer]}
              disabled={counts !== null && counts[layer] === 0}
              onCheckedChange={(v) => setVisible((cur) => ({ ...cur, [layer]: v }))}
            />
          </label>
        ))}
        {props.length ? (
          <div className="flex flex-col gap-2 border-t border-black/5 pt-2.5 text-xs">
            <p className="text-muted-foreground">{selected.length ? t.maps.edit.selected(selected.length) : t.maps.edit.hint}</p>
            {selected.length ? (
              <div className="flex gap-1.5">
                <Button size="xs" variant="secondary" onClick={selectSameVariant}>
                  {t.maps.edit.sameVariant}
                </Button>
                <Button size="xs" variant="destructive" onClick={removeSelected}>
                  <Trash2Icon />
                  {t.maps.edit.remove}
                </Button>
              </div>
            ) : null}
            {removed.length ? (
              <>
                <p className="font-semibold">{t.maps.edit.pending(removed.length)}</p>
                <div className="flex gap-1.5">
                  <Button size="xs" variant="secondary" disabled={busy} onClick={() => setRemoved([])}>
                    <Undo2Icon />
                    {t.maps.edit.undo}
                  </Button>
                  <Button size="xs" disabled={busy} onClick={() => edit({ removeProps: removed })}>
                    {busy ? <Spinner /> : <SaveIcon />}
                    {t.maps.edit.save}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {stats.length ? (
          <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 border-t border-black/5 pt-2.5 text-xs">
            {stats.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <div className="absolute right-3 bottom-3 flex gap-2">
        {map.edited ? (
          <Button variant="secondary" disabled={busy} onClick={() => edit({ restore: true })}>
            <RotateCcwIcon />
            {t.maps.edit.restore}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" disabled={busy || removed.length > 0}>
              {busy ? <Spinner /> : <ShrinkIcon />}
              {t.maps.edit.compress}
              <ChevronDownIcon className="-mr-1 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t.maps.edit.compressNote}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {COMPRESS_LEVELS.map((level) => (
              <DropdownMenuItem key={level} onSelect={() => edit({ compress: level })}>
                <span className="flex flex-col">
                  <span className="font-semibold">{t.compress.levels[level].label}</span>
                  <span className="text-xs text-muted-foreground">{t.compress.levels[level].hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="secondary" onClick={() => setResetKey((k) => k + 1)}>
          <LocateFixedIcon />
          {t.maps.reset}
        </Button>
        {map.modelDownloadUrl ? (
          <Button asChild>
            <a href={map.modelDownloadUrl}>
              <DownloadIcon />
              {t.maps.download}
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
