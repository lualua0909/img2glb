"use client";

import {
  ActivityIcon,
  CpuIcon,
  DownloadIcon,
  HardDriveIcon,
  ListChecksIcon,
  RefreshCwIcon,
  ServerOffIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useI18n } from "./i18n-provider";

// Shapes returned by the GPU worker's /v1/admin/* API (see worker/server.py), via /api/admin/worker/*.
type ModelConfig = {
  shape_model: string;
  shape_subfolder: string;
  enable_tex: boolean;
  tex_model: string;
  tex_subfolder: string;
  enable_t2i: boolean;
  t2i_model: string;
  low_vram: boolean;
};
type Status = {
  device: string;
  gpu: { name: string; free_bytes: number; total_bytes: number } | null;
  disk: { path: string; free_bytes: number; total_bytes: number };
  ready: boolean;
  loading: boolean;
  load_error: string | null;
  config: ModelConfig;
  pipeline?: { stage: PipelineStage; model: string; state: "active" | "standby" | "lazy" | "off" }[];
  jobs: Record<"queued" | "running" | "completed" | "failed", number>;
};
type PipelineStage = "shape" | "vae" | "texture" | "delight" | "dino" | "upscale" | "t2i" | "rembg" | "edit" | "translate";
type Download = {
  repo_id: string;
  subfolder: string;
  status: "running" | "completed" | "failed";
  total_bytes: number;
  downloaded_bytes: number;
  current_file: string | null;
  error: string | null;
};
type CatalogItem = {
  kind: "shape" | "texture" | "t2i";
  repo_id: string;
  subfolder: string;
  label: string;
  note: string;
  local_bytes: number;
  in_use: boolean;
  download: Download | null;
};
type Models = { catalog: CatalogItem[]; other_downloads: Download[] };

function fmtBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return n > 0 ? `${(n / 1e3).toFixed(0)} KB` : "—";
}

const ref = (repo: string, sub: string) => `${repo}|${sub}`;

async function api<T>(engine: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/worker/${path}`, {
    cache: "no-store",
    ...init,
    headers: { ...init?.headers, "X-Engine": engine },
  });
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail; // FastAPI errors
  if (!res.ok) throw new Error(data.error ?? detail ?? `Request failed (${res.status})`);
  return data as T;
}

function Progress({ d }: { d: Download }) {
  const { t } = useI18n();
  const pct = d.total_bytes ? Math.min(100, (d.downloaded_bytes / d.total_bytes) * 100) : 0;
  return (
    <div className="flex w-44 flex-col gap-1.5">
      <ProgressBar value={pct} />
      <p className="text-xs text-muted-foreground tabular-nums">
        {d.total_bytes
          ? `${fmtBytes(d.downloaded_bytes)} / ${fmtBytes(d.total_bytes)} · ${pct.toFixed(0)}%`
          : t.admin.models.listing}
      </p>
    </div>
  );
}

function Stat({ icon: Icon, tint, label, children }: { icon: LucideIcon; tint: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px] text-white", tint)}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {children}
      </div>
    </div>
  );
}

/** One tab per configured engine (Hunyuan3D 2.0 / 2.1), each talking to its own worker. */
export function AdminModels({ configured, engines }: { configured: boolean; engines: string[] }) {
  const { t } = useI18n();
  const [engine, setEngine] = useState(engines[0] ?? "hunyuan");
  return (
    <div className="flex flex-col gap-5">
      {engines.length > 1 ? (
        <Tabs value={engine} onValueChange={setEngine}>
          <TabsList className="w-full sm:w-auto">
            {engines.map((e) => (
              <TabsTrigger key={e} value={e}>
                {t.engines[e] ?? e}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
      <EngineModels key={engine} engine={engine} configured={configured} />
    </div>
  );
}

function EngineModels({ configured, engine }: { configured: boolean; engine: string }) {
  const { t } = useI18n();
  const tm = t.admin.models;
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState({ repo_id: "", subfolder: "" });
  const [removing, setRemoving] = useState<CatalogItem | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api<Status>(engine, "status"), api<Models>(engine, "models")]);
      setStatus(s);
      setModels(m);
      setDraft((d) => d ?? s.config);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tm.workerFailed);
    }
  }, [engine, tm.workerFailed]);

  const active =
    Boolean(status?.loading) ||
    Boolean(models?.catalog.some((i) => i.download?.status === "running")) ||
    Boolean(models?.other_downloads.some((d) => d.status === "running"));

  useEffect(() => {
    if (!configured) return;
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, active ? 2000 : 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [configured, active, refresh]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.somethingWrong);
    } finally {
      setBusy(null);
    }
  }

  const download = (repo_id: string, subfolder: string) =>
    act(`dl:${ref(repo_id, subfolder)}`, () =>
      api(engine, "models/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_id, subfolder }),
      }),
    );

  const remove = (item: CatalogItem) =>
    act(`rm:${ref(item.repo_id, item.subfolder)}`, () =>
      api(engine, `models?${new URLSearchParams({ repo_id: item.repo_id, subfolder: item.subfolder })}`, { method: "DELETE" }),
    );

  const applyConfig = () =>
    act("config", () =>
      api(engine, "config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }),
    );

  if (!configured)
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
            <ServerOffIcon className="size-5" />
          </span>
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">{tm.notConfiguredTitle}</p>
            <p className="text-muted-foreground">{tm.notConfiguredBody}</p>
            <pre className="rounded-xl bg-secondary px-3.5 py-2.5 font-mono text-xs">
              HUNYUAN_WORKER_URL=…{"\n"}HUNYUAN_WORKER_TOKEN=…
            </pre>
            <p className="text-muted-foreground">{tm.weightsIn}</p>
          </div>
        </CardContent>
      </Card>
    );

  const byKind = (kind: CatalogItem["kind"]) => models?.catalog.filter((i) => i.kind === kind) ?? [];
  const localOf = (repo: string, sub: string) =>
    (models?.catalog.find((i) => i.repo_id === repo && i.subfolder === sub)?.local_bytes ?? 0) > 0;
  const configChanged = draft && status && JSON.stringify(draft) !== JSON.stringify(status.config);

  return (
    <div className="flex flex-col gap-5">
      {error ? <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p> : null}

      {!status || !models ? (
        !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {tm.connecting}
          </p>
        ) : null
      ) : (
        <>
          <Card>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                icon={ActivityIcon}
                tint={status.loading ? "bg-primary" : status.ready ? "bg-success" : "bg-destructive"}
                label={tm.state}
              >
                <p className="font-semibold">{status.loading ? tm.loading : status.ready ? tm.ready : tm.notLoaded}</p>
              </Stat>
              <Stat icon={CpuIcon} tint="bg-[#5e5ce6]" label={tm.device}>
                <p className="truncate font-semibold">{status.gpu?.name ?? status.device}</p>
                {status.gpu ? (
                  <p className="text-xs text-muted-foreground">
                    {tm.vram(fmtBytes(status.gpu.total_bytes - status.gpu.free_bytes), fmtBytes(status.gpu.total_bytes))}
                  </p>
                ) : null}
              </Stat>
              <Stat icon={HardDriveIcon} tint="bg-[#8e8e93]" label={tm.diskFree}>
                <p className="font-semibold">{fmtBytes(status.disk.free_bytes)}</p>
                <p className="truncate font-mono text-xs text-muted-foreground" title={status.disk.path}>
                  {status.disk.path}
                </p>
              </Stat>
              <Stat icon={ListChecksIcon} tint="bg-warning" label={tm.jobs}>
                <p className="font-semibold">{tm.jobsActive(status.jobs.running, status.jobs.queued)}</p>
                <p className="text-xs text-muted-foreground">{tm.jobsDone(status.jobs.completed, status.jobs.failed)}</p>
              </Stat>
              {status.load_error ? (
                <p className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive sm:col-span-2 lg:col-span-4">
                  {status.load_error}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {status.pipeline ? (
            <Card className="gap-0 pb-0">
              <CardHeader className="border-b">
                <CardTitle>{tm.pipeline}</CardTitle>
                <CardDescription>{tm.pipelineHint}</CardDescription>
              </CardHeader>
              <div className="divide-y divide-border">
                {status.pipeline.map((p) => (
                  <div key={p.stage} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
                    <p className="w-44 shrink-0 font-medium">{tm.stages[p.stage]}</p>
                    <p
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-xs",
                        p.state === "off" ? "text-muted-foreground line-through" : "",
                      )}
                      title={p.model}
                    >
                      {p.model}
                    </p>
                    <Badge
                      className={cn(
                        p.state === "active" && "bg-success/15 text-success-foreground",
                        (p.state === "lazy" || p.state === "standby") && "bg-primary/10 text-primary",
                        p.state === "off" && "bg-secondary text-muted-foreground",
                      )}
                    >
                      {tm.states[p.state]}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {draft ? (
            <Card>
              <CardHeader>
                <CardTitle>{tm.activeModels}</CardTitle>
                <CardDescription>{tm.activeHint}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="shape" className="px-1 text-[13px] text-muted-foreground">
                      {tm.shapeModel}
                    </Label>
                    <Select
                      value={ref(draft.shape_model, draft.shape_subfolder)}
                      onValueChange={(v) => {
                        const [shape_model, shape_subfolder] = v.split("|");
                        setDraft({ ...draft, shape_model, shape_subfolder });
                      }}
                    >
                      <SelectTrigger id="shape" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {byKind("shape").some(
                          (i) => ref(i.repo_id, i.subfolder) === ref(draft.shape_model, draft.shape_subfolder),
                        ) ? null : (
                          <SelectItem value={ref(draft.shape_model, draft.shape_subfolder)}>
                            {draft.shape_model}/{draft.shape_subfolder}
                          </SelectItem>
                        )}
                        {byKind("shape").map((i) => (
                          <SelectItem key={i.subfolder} value={ref(i.repo_id, i.subfolder)}>
                            {i.label}
                            {i.local_bytes ? "" : ` — ${tm.notDownloaded}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="tex" className="px-1 text-[13px] text-muted-foreground">
                      {tm.textureModel}
                    </Label>
                    <Select
                      disabled={!draft.enable_tex}
                      value={ref(draft.tex_model, draft.tex_subfolder)}
                      onValueChange={(v) => {
                        const [tex_model, tex_subfolder] = v.split("|");
                        setDraft({ ...draft, tex_model, tex_subfolder });
                      }}
                    >
                      <SelectTrigger id="tex" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {byKind("texture")
                          .filter((i) => !i.subfolder.includes("delight"))
                          .map((i) => (
                            <SelectItem key={i.subfolder} value={ref(i.repo_id, i.subfolder)}>
                              {i.label}
                              {i.local_bytes ? "" : ` — ${tm.notDownloaded}`}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-secondary/50">
                  {(
                    [
                      ["enable_tex", tm.enableTex],
                      ["enable_t2i", tm.enableT2i(draft.t2i_model.split("/").pop() ?? "")],
                      ["low_vram", tm.lowVram],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                      {label}
                      <Switch checked={draft[k]} onCheckedChange={(v) => setDraft({ ...draft, [k]: v })} />
                    </label>
                  ))}
                </div>
                {!localOf(draft.shape_model, draft.shape_subfolder) ? (
                  <p className="px-1 text-xs text-warning-foreground">{tm.shapeMissing}</p>
                ) : null}
                <div className="flex gap-2">
                  <Button onClick={applyConfig} disabled={!configChanged || busy === "config" || status.loading}>
                    {busy === "config" || status.loading ? <Spinner /> : <RefreshCwIcon />}
                    {tm.apply}
                  </Button>
                  <Button variant="outline" onClick={() => setDraft(status.config)} disabled={!configChanged}>
                    {t.common.discard}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {(["shape", "texture", "t2i"] as const).map((kind) => (
            <Card key={kind} className="gap-0 pb-0">
              <CardHeader className="border-b">
                <CardTitle>{tm.kinds[kind]}</CardTitle>
              </CardHeader>
              <div className="divide-y divide-border">
                {byKind(kind).map((i) => {
                  const k = ref(i.repo_id, i.subfolder);
                  const running = i.download?.status === "running";
                  return (
                    <div key={k} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 text-sm">
                      <div className="min-w-60 flex-1">
                        <p className="flex items-center gap-2 font-semibold">
                          {i.label}
                          {i.in_use ? <Badge className="bg-success/15 text-success-foreground">{tm.inUse}</Badge> : null}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{i.note}</p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {i.repo_id}
                          {i.subfolder ? `/${i.subfolder}` : ""}
                        </p>
                        {i.download?.status === "failed" ? (
                          <p className="mt-1 text-xs text-destructive">{tm.downloadFailed(i.download.error ?? "")}</p>
                        ) : null}
                      </div>
                      {running ? (
                        <Progress d={i.download!} />
                      ) : (
                        <p className="w-20 text-right font-medium text-muted-foreground tabular-nums">
                          {fmtBytes(i.local_bytes)}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={running || busy === `dl:${k}`}
                          onClick={() => download(i.repo_id, i.subfolder)}
                          title={i.local_bytes ? tm.recheck : undefined}
                        >
                          {running ? <Spinner /> : <DownloadIcon />}
                          {running ? tm.downloading : i.local_bytes ? tm.verify : t.common.download}
                        </Button>
                        <Button
                          variant="destructive"
                          size="icon-sm"
                          aria-label={t.common.delete}
                          disabled={!i.local_bytes || i.in_use || running || busy === `rm:${k}`}
                          title={i.in_use ? tm.usedByActive : t.common.delete}
                          onClick={() => setRemoving(i)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle>{tm.another}</CardTitle>
              <CardDescription>{tm.anotherHint}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="repo" className="px-1 text-[13px] text-muted-foreground">
                    {tm.repoId}
                  </Label>
                  <Input
                    id="repo"
                    className="font-mono"
                    placeholder="tencent/Hunyuan3D-2mv"
                    value={custom.repo_id}
                    onChange={(e) => setCustom({ ...custom, repo_id: e.target.value.trim() })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sub" className="px-1 text-[13px] text-muted-foreground">
                    {tm.subfolder}
                  </Label>
                  <Input
                    id="sub"
                    className="font-mono"
                    placeholder="hunyuan3d-dit-v2-mv-turbo"
                    value={custom.subfolder}
                    onChange={(e) => setCustom({ ...custom, subfolder: e.target.value.trim() })}
                  />
                </div>
                <Button
                  className="h-11"
                  disabled={!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(custom.repo_id) || busy?.startsWith("dl:")}
                  onClick={() => download(custom.repo_id, custom.subfolder)}
                >
                  <DownloadIcon />
                  {t.common.download}
                </Button>
              </div>
              {models.other_downloads.map((d) => (
                <div key={ref(d.repo_id, d.subfolder)} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="font-mono text-xs">
                    {d.repo_id}
                    {d.subfolder ? `/${d.subfolder}` : ""}
                  </span>
                  {d.status === "running" ? (
                    <Progress d={d} />
                  ) : d.status === "failed" ? (
                    <span className="text-xs text-destructive">{tm.failed(d.error ?? "")}</span>
                  ) : (
                    <span className="text-xs font-medium text-success-foreground">{tm.downloaded(fmtBytes(d.total_bytes))}</span>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{removing ? tm.deleteTitle(removing.label) : null}</AlertDialogTitle>
            <AlertDialogDescription>{removing ? tm.deleteBody(fmtBytes(removing.local_bytes)) : null}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && remove(removing)}>
              {t.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
