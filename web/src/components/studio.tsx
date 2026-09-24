"use client";

import {
  BoxIcon,
  Gamepad2Icon,
  ImageIcon,
  ImagePlusIcon,
  LightbulbIcon,
  PaletteIcon,
  PrinterIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  SparklesIcon,
  TriangleAlertIcon,
  TypeIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ACCEPTED_IMAGE_TYPES,
  generationCost,
  MAX_FACE_COUNT,
  MAX_PROMPT_LENGTH,
  MAX_TEXTURE_SIZE,
  MESH_DETAIL_PRESETS,
  MIN_FACE_COUNT,
  QUALITY_PRESETS,
  TEXTURE_SIZES,
  USE_CASES,
  type Quality,
  type TextureSize,
  type UseCase,
} from "@/lib/config";
import {
  DEFAULT_PAUSED_MESSAGE,
  type AppSettings,
  type CreditCosts,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { GenerationDTO } from "@/server/generations";
import { GenerationView } from "./generation-view";
import { useI18n } from "./i18n-provider";

const MeshPreview = dynamic(() => import("./mesh-preview"), { ssr: false });

const EXAMPLE_IMAGES = ["ivysaur", "squirtle", "charmander"].map(
  (n) => `/samples/examples/${n}.png`,
);
// Kept in English: the text-to-image stage understands English (and Chinese) prompts best.
const EXAMPLE_PROMPTS = [
  "a lovely rabbit eating carrots",
  "a pot of green plants in a red flower pot",
  "a medieval treasure chest with gold trim",
  "a low-poly sci-fi drone",
];
const USE_CASE_ICONS: Record<UseCase, LucideIcon> = {
  game: Gamepad2Icon,
  print: PrinterIcon,
  ar: SmartphoneIcon,
  prototype: LightbulbIcon,
};

// The face count slider is logarithmic so the low end (1K–20K) is as easy to hit as the high end.
const SLIDER_STEPS = 1000;
const faceRange = Math.log(MAX_FACE_COUNT / MIN_FACE_COUNT);
const sliderToFaces = (p: number) => {
  const v = MIN_FACE_COUNT * Math.exp((p / SLIDER_STEPS) * faceRange);
  const unit = v < 10_000 ? 100 : v < 100_000 ? 1000 : 5000;
  return Math.min(
    MAX_FACE_COUNT,
    Math.max(MIN_FACE_COUNT, Math.round(v / unit) * unit),
  );
};
const facesToSlider = (v: number) =>
  Math.round((Math.log(v / MIN_FACE_COUNT) / faceRange) * SLIDER_STEPS);

/** Downscale to ≤1024px so uploads stay small; PNG keeps alpha, others become JPEG. */
async function prepareImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3 * 1024 * 1024) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob(
      (b) => (b ? ok(b) : fail(new Error("encode failed"))),
      type,
      0.92,
    ),
  );
  return new File(
    [blob],
    file.name.replace(/\.\w+$/, type === "image/png" ? ".png" : ".jpg"),
    { type },
  );
}

/** Admin-configured bits the studio needs. `pausedMessage` is set while generation is paused. */
export type StudioOptions = {
  quality: AppSettings["quality"];
  faceCount: AppSettings["faceCount"];
  costs: CreditCosts;
  pausedMessage: string | null;
  /** Configured Hunyuan3D engines (hunyuan = 2.0, hunyuan21 = 2.1); the picker shows when there are two. */
  engines: AppSettings["generation"]["provider"][];
  defaultEngine: AppSettings["generation"]["provider"];
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="px-1 text-[13px] font-semibold text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Simulates how the texture reads at `size`: a 2× center crop of `src`, resampled to the texel density
 * that size gives relative to the engine's native one, then drawn with hard pixels so the loss is visible.
 */
function TexturePreview({ src, size }: { src: string; size: TextureSize }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const texels = Math.round((512 * size) / MAX_TEXTURE_SIZE);
      const crop = Math.min(img.naturalWidth, img.naturalHeight) / 2;
      el.width = el.height = texels;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, texels, texels);
      ctx.drawImage(
        img,
        (img.naturalWidth - crop) / 2,
        (img.naturalHeight - crop) / 2,
        crop,
        crop,
        0,
        0,
        texels,
        texels,
      );
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src, size]);
  return (
    <canvas
      ref={canvas}
      className="size-28 shrink-0 rounded-xl bg-stage"
      style={{ imageRendering: "pixelated" }}
      aria-hidden
    />
  );
}

/** `credits` is null in local mode: no cost shown, no balance check. */
export function Studio({
  credits,
  options,
}: {
  credits: number | null;
  options: StudioOptions;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"image" | "text">("image");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const pickRun = useRef(0); // ignores results of an upload replaced while it was still preprocessing
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [useCase, setUseCase] = useState<UseCase>("game");
  const [textured, setTextured] = useState(true);
  const [quality, setQuality] = useState<Quality>("standard");
  const [seed, setSeed] = useState("");
  const [faceCount, setFaceCount] = useState(options.faceCount.game);
  const [flatShading, setFlatShading] = useState(false);
  const [meshPicked, setMeshPicked] = useState(false);
  const [textureSize, setTextureSize] = useState<TextureSize>(MAX_TEXTURE_SIZE);
  const [texturePicked, setTexturePicked] = useState(false);
  const [engine, setEngine] = useState(options.defaultEngine);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<GenerationDTO | null>(null);

  const cost =
    credits === null ? 0 : generationCost({ mode, textured }, options.costs);
  const canAfford = credits === null || credits >= cost;
  const ready = mode === "image" ? Boolean(file) : prompt.trim().length >= 3;
  // Admin labels win; untouched built-in labels are shown translated.
  const preset = (q: Quality) => ({
    label:
      options.quality[q].label === QUALITY_PRESETS[q].label
        ? t.quality[q].label
        : options.quality[q].label,
    hint:
      options.quality[q].hint === QUALITY_PRESETS[q].hint
        ? t.quality[q].hint
        : options.quality[q].hint,
  });
  const meshDetail = MESH_DETAIL_PRESETS.find((m) => m.faceCount === faceCount);
  const pausedMessage =
    options.pausedMessage === DEFAULT_PAUSED_MESSAGE
      ? t.studio.pausedDefault
      : options.pausedMessage;

  function showPreview(url: string | null) {
    setPreview((old) => {
      if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
      return url;
    });
  }

  /** Shows the upload while the worker denoises it and removes the background, then previews and keeps the result. */
  async function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      setError(t.studio.badType);
      return;
    }
    const run = ++pickRun.current;
    let prepared: File;
    try {
      prepared = await prepareImage(f);
    } catch {
      setError(t.studio.readFailed);
      return;
    }
    if (run !== pickRun.current) return;
    setFile(null);
    showPreview(URL.createObjectURL(prepared));
    setProcessing(true);
    try {
      const body = new FormData();
      body.set("image", prepared);
      const res = await fetch("/api/preprocess", { method: "POST", body });
      if (!res.ok)
        throw new Error(
          res.status === 422 ? t.studio.noObject : t.studio.preprocessFailed,
        );
      const blob = await res.blob();
      if (run !== pickRun.current) return;
      const processed = new File(
        [blob],
        prepared.name.replace(/\.\w+$/, ".png"),
        { type: blob.type || "image/png" },
      );
      setFile(processed);
      showPreview(URL.createObjectURL(processed));
    } catch (e) {
      if (run !== pickRun.current) return;
      showPreview(null);
      setError(
        e instanceof Error && e.message ? e.message : t.studio.preprocessFailed,
      );
    } finally {
      if (run === pickRun.current) setProcessing(false);
    }
  }

  function clearImage() {
    pickRun.current++;
    setProcessing(false);
    setFile(null);
    showPreview(null);
  }

  async function pickExample(url: string) {
    const blob = await (await fetch(url)).blob();
    await pick(new File([blob], url.split("/").pop()!, { type: blob.type }));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body = new FormData();
    body.set("mode", mode);
    body.set("textured", String(textured));
    body.set("quality", quality);
    body.set("useCase", useCase);
    if (seed) body.set("seed", seed);
    body.set("faceCount", String(faceCount));
    body.set("flatShading", String(flatShading));
    if (textured) body.set("textureSize", String(textureSize));
    if (options.engines.length > 1) body.set("engine", engine);
    if (mode === "image" && file) body.set("image", file);
    if (mode === "text") body.set("prompt", prompt.trim());
    try {
      const res = await fetch("/api/generations", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error ?? t.common.requestFailed(res.status));
      setCurrent(data as GenerationDTO);
      router.refresh(); // update credit balance and nav busy indicator
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.somethingWrong);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-6 rounded-3xl bg-card p-5 shadow-soft ring-1 ring-black/[0.04]">
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as "image" | "text")}
        >
          <TabsList className="w-full">
            <TabsTrigger value="image">
              <ImageIcon />
              {t.studio.modeImage}
            </TabsTrigger>
            <TabsTrigger value="text">
              <TypeIcon />
              {t.studio.modeText}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "image" ? (
          <div className="flex flex-col gap-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files[0]);
              }}
              className={cn(
                "relative aspect-[4/3] overflow-hidden rounded-2xl border-2 border-dashed transition-colors",
                dragging
                  ? "border-primary bg-primary/5"
                  : preview
                    ? "border-transparent bg-stage"
                    : "border-black/10 bg-dots",
              )}
            >
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="group grid size-full place-items-center outline-none focus-visible:ring-4 focus-visible:ring-ring/25"
              >
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview}
                    alt=""
                    className={cn(
                      "size-full object-contain p-5 transition",
                      processing && "opacity-50 blur-[2px]",
                    )}
                  />
                ) : (
                  <span className="flex flex-col items-center gap-3 px-8 text-center">
                    <span className="grid size-12 place-items-center rounded-2xl bg-card text-primary shadow-soft ring-1 ring-black/5 transition-transform group-hover:-translate-y-0.5">
                      <ImagePlusIcon className="size-6" />
                    </span>
                    <span className="text-sm font-semibold">
                      {t.studio.dropTitle}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {t.studio.dropHint}
                    </span>
                    <span className="flex gap-1.5">
                      {["PNG", "JPG", "WEBP"].map((f) => (
                        <span
                          key={f}
                          className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
                        >
                          {f}
                        </span>
                      ))}
                    </span>
                  </span>
                )}
              </button>
              {processing ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <span className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold ring-1 ring-black/5">
                    <Spinner />
                    {t.studio.preprocessing}
                  </span>
                </div>
              ) : file ? (
                <span className="glass pointer-events-none absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-black/5">
                  <SparklesIcon className="size-3.5 text-primary" />
                  {t.studio.preprocessed}
                </span>
              ) : null}
              {preview ? (
                <div className="absolute top-2.5 right-2.5 flex gap-1.5">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="glass"
                    aria-label={t.studio.replace}
                    onClick={() => fileInput.current?.click()}
                  >
                    <RefreshCwIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="glass"
                    aria-label={t.studio.remove}
                    onClick={clearImage}
                  >
                    <XIcon />
                  </Button>
                </div>
              ) : null}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              className="hidden"
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t.studio.tryExample}
              </span>
              <div className="flex gap-2">
                {EXAMPLE_IMAGES.map((src) => (
                  <button
                    key={src}
                    onClick={() => pickExample(src)}
                    className="size-11 overflow-hidden rounded-xl bg-stage ring-1 ring-black/5 transition hover:ring-2 hover:ring-primary/60"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={t.studio.example}
                      className="size-full object-contain p-1"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between px-1">
              <Label
                htmlFor="prompt"
                className="text-[13px] font-semibold text-muted-foreground"
              >
                {t.studio.promptLabel}
              </Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {prompt.length}/{MAX_PROMPT_LENGTH}
              </span>
            </div>
            <Textarea
              id="prompt"
              rows={4}
              maxLength={MAX_PROMPT_LENGTH}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t.studio.promptPlaceholder}
              className="min-h-28 resize-none"
            />
            <p className="px-1 text-xs text-muted-foreground">
              {t.studio.promptHint}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPrompt(p)}
                  className="rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        <Section title={t.studio.useCase}>
          <div className="grid grid-cols-2 gap-2">
            {USE_CASES.map((u) => {
              const Icon = USE_CASE_ICONS[u.id];
              const active = useCase === u.id;
              return (
                <button
                  key={u.id}
                  onClick={() => {
                    setUseCase(u.id);
                    setTextured(u.textured);
                    setFaceCount(options.faceCount[u.id]);
                    setFlatShading(false);
                  }}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition-all",
                    active
                      ? "bg-primary/8 text-primary ring-2 ring-primary"
                      : "bg-secondary/70 hover:bg-secondary",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  {t.useCases[u.id]}
                </button>
              );
            })}
          </div>
        </Section>

        {options.engines.length > 1 ? (
          <Section title={t.studio.engine}>
            <Tabs
              value={engine}
              onValueChange={(v) => setEngine(v as typeof engine)}
            >
              <TabsList className="w-full">
                {options.engines.map((e) => (
                  <TabsTrigger key={e} value={e}>
                    {t.engines[e]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="px-1 text-xs text-muted-foreground">
              {t.studio.engineHint[engine]}
            </p>
          </Section>
        ) : null}

        <Section title={t.studio.quality}>
          <Tabs value={quality} onValueChange={(v) => setQuality(v as Quality)}>
            <TabsList className="w-full">
              {(Object.keys(QUALITY_PRESETS) as Quality[]).map((q) => (
                <TabsTrigger key={q} value={q}>
                  {preset(q).label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="px-1 text-xs text-muted-foreground">
            {preset(quality).hint}
          </p>
        </Section>

        <Accordion type="single" collapsible className="-my-2">
          <AccordionItem value="advanced" className="border-none">
            <AccordionTrigger className="px-1 text-[13px] font-semibold text-muted-foreground hover:no-underline">
              {t.studio.advanced}
            </AccordionTrigger>
            <AccordionContent className="flex flex-col gap-6 px-px pt-1">
              <Section title={t.studio.meshDetail}>
                <div className="grid grid-cols-5 gap-1.5">
                  {MESH_DETAIL_PRESETS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setFaceCount(m.faceCount);
                        setFlatShading(m.flat);
                        setMeshPicked(true);
                      }}
                      className={cn(
                        "rounded-xl px-1 py-2 text-center text-xs font-semibold transition-all",
                        meshDetail?.id === m.id
                          ? "bg-primary/8 text-primary ring-2 ring-primary"
                          : "bg-secondary/70 hover:bg-secondary",
                      )}
                    >
                      {t.studio.meshDetails[m.id].label}
                    </button>
                  ))}
                </div>
                {meshPicked ? (
                  <div className="flex items-center gap-3 px-1">
                    <MeshPreview faceCount={faceCount} flat={flatShading} />
                    <div className="flex flex-col gap-0.5 text-xs">
                      <span className="font-semibold tabular-nums">
                        {faceCount.toLocaleString()} {t.studio.faceUnit}
                      </span>
                      <span className="text-muted-foreground">
                        {t.studio.meshDetailPreview}
                      </span>
                    </div>
                  </div>
                ) : null}
                {meshDetail ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    {t.studio.meshDetails[meshDetail.id].hint}
                  </p>
                ) : null}
                <div className="mt-1 flex items-center justify-between px-1">
                  <Label>{t.studio.faceCount}</Label>
                  <span className="text-sm font-semibold tabular-nums">
                    {faceCount.toLocaleString()}
                  </span>
                </div>
                <Slider
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  value={[facesToSlider(faceCount)]}
                  onValueChange={([v]) => {
                    setFaceCount(sliderToFaces(v));
                    setMeshPicked(true);
                  }}
                  className="py-1.5"
                />
                <p className="px-1 text-xs text-muted-foreground">
                  {t.studio.faceCountHint}
                </p>
                <label className="flex cursor-pointer items-center gap-3 px-1 pt-1">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">
                      {t.studio.flatShading}
                    </span>
                    <span className="block text-xs leading-snug text-muted-foreground">
                      {t.studio.flatShadingHint}
                    </span>
                  </span>
                  <Switch
                    checked={flatShading}
                    onCheckedChange={setFlatShading}
                  />
                </label>
              </Section>

              <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-secondary/60 p-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-linear-to-br from-[#ff9f0a] to-[#ff375f] text-white">
                  <PaletteIcon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {t.studio.texture}
                  </span>
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {t.studio.textureHint}
                  </span>
                </span>
                <Switch checked={textured} onCheckedChange={setTextured} />
              </label>

              {textured ? (
                <Section title={t.studio.textureSize}>
                  <Tabs
                    value={String(textureSize)}
                    onValueChange={(v) => {
                      setTextureSize(Number(v) as TextureSize);
                      setTexturePicked(true);
                    }}
                  >
                    <TabsList className="w-full">
                      {TEXTURE_SIZES.map((size) => (
                        <TabsTrigger key={size} value={String(size)}>
                          {size === MAX_TEXTURE_SIZE
                            ? t.studio.textureSizeNative
                            : size >= 1024
                              ? `${size / 1024}K`
                              : size}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  {texturePicked ? (
                    <div className="flex items-center gap-3 px-1">
                      <TexturePreview
                        src={(mode === "image" && preview) || EXAMPLE_IMAGES[2]}
                        size={textureSize}
                      />
                      <div className="flex flex-col gap-0.5 text-xs">
                        <span className="font-semibold">
                          {textureSize} × {textureSize} px
                        </span>
                        <span className="text-muted-foreground">
                          {t.studio.textureSizePreview}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <p className="px-1 text-xs text-muted-foreground">
                    {t.studio.textureSizeHint}
                  </p>
                </Section>
              ) : null}

              <div className="flex flex-col gap-2">
                <Label htmlFor="seed" className="px-1">
                  {t.studio.seed}
                </Label>
                <Input
                  id="seed"
                  inputMode="numeric"
                  value={seed}
                  onChange={(e) =>
                    setSeed(e.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  placeholder={t.studio.seedPlaceholder}
                />
                <p className="px-1 text-xs text-muted-foreground">
                  {t.studio.seedHint}
                </p>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {pausedMessage ? (
          <p className="flex gap-2 rounded-xl bg-warning/10 px-3.5 py-3 text-sm text-warning-foreground">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {pausedMessage}
          </p>
        ) : null}
        {error ? (
          <p className="flex gap-2 rounded-xl bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2.5">
          <Button
            size="lg"
            onClick={submit}
            disabled={
              !ready || submitting || !canAfford || Boolean(pausedMessage)
            }
            className="w-full"
          >
            {submitting ? <Spinner /> : <SparklesIcon />}
            {t.studio.generate}
            {cost > 0 ? (
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold">
                {t.common.credits(cost)}
              </span>
            ) : null}
          </Button>
          {!canAfford ? (
            <p className="text-center text-xs text-muted-foreground">
              {t.studio.notEnough}{" "}
              <Link
                href="/app/billing"
                className="font-semibold text-primary hover:underline"
              >
                {t.studio.buyCredits}
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      <div className="h-[70vh] min-h-[420px] rounded-3xl bg-card p-2 shadow-soft ring-1 ring-black/[0.04] lg:sticky lg:top-22 lg:h-[calc(100dvh-8rem)]">
        {current ? (
          <GenerationView key={current.id} initial={current} />
        ) : (
          <div className="grid size-full place-items-center rounded-[1.25rem] bg-stage p-6 text-center">
            <div className="flex max-w-sm flex-col items-center">
              <span className="grid size-16 place-items-center rounded-[1.25rem] bg-card text-primary shadow-float ring-1 ring-black/5">
                <BoxIcon className="size-8" strokeWidth={1.6} />
              </span>
              <p className="mt-5 text-lg font-bold tracking-tight">
                {t.studio.emptyTitle}
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t.studio.emptyBody}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {t.studio.tips.map((tip) => (
                  <span
                    key={tip}
                    className="glass rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-black/5"
                  >
                    {tip}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
