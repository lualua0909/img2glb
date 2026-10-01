"use client";

import { ImagePlusIcon, XIcon } from "lucide-react";
import { type Dispatch, type SetStateAction, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_SHAPE_CANDIDATES,
  VIEW_NAMES,
  type ViewName,
} from "@/lib/config";
import { prepareImage } from "@/lib/prepare-image";
import { cn } from "@/lib/utils";
import { useI18n } from "./i18n-provider";

export type MultiViewState = {
  /** Preprocessed (background removed) view images, with an object URL for their preview. */
  views: Partial<Record<ViewName, { file: File; url: string }>>;
  candidates: number;
  omni: boolean;
  paintAllViews: boolean;
  /** Works without extra views too (sheets are textured from the main image). */
  wingSheets: boolean;
};

export const EMPTY_MULTI_VIEW: MultiViewState = {
  views: {},
  candidates: 1,
  omni: false,
  paintAllViews: false,
  wingSheets: false,
};

/** Extra views of the main image's object, each preprocessed by the worker like the main image, plus how to use them. */
export function MultiViewInput({
  value,
  onChange,
  onError,
}: {
  value: MultiViewState;
  onChange: Dispatch<SetStateAction<MultiViewState>>;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<ViewName>("front");
  const [busy, setBusy] = useState<Partial<Record<ViewName, boolean>>>({});

  const hasViews = Object.keys(value.views).length > 0;

  async function pick(name: ViewName, f: File | undefined) {
    onError(null);
    if (!f) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      onError(t.studio.badType);
      return;
    }
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      const prepared = await prepareImage(f);
      const body = new FormData();
      body.set("image", prepared);
      const res = await fetch("/api/preprocess", { method: "POST", body });
      if (!res.ok) throw new Error(res.status === 422 ? t.studio.noObject : t.studio.preprocessFailed);
      const blob = await res.blob();
      const file = new File([blob], `${name}.png`, { type: blob.type || "image/png" });
      const url = URL.createObjectURL(file);
      onChange((v) => {
        const old = v.views[name];
        if (old) URL.revokeObjectURL(old.url);
        return { ...v, views: { ...v.views, [name]: { file, url } } };
      });
    } catch (e) {
      onError(e instanceof Error && e.message ? e.message : t.studio.preprocessFailed);
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  function remove(name: ViewName) {
    onChange((v) => {
      const views = { ...v.views };
      if (views[name]) URL.revokeObjectURL(views[name].url);
      delete views[name];
      return Object.keys(views).length ? { ...v, views } : { ...EMPTY_MULTI_VIEW, wingSheets: v.wingSheets };
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t.studio.multiViewHint}</p>
      <div className="grid grid-cols-4 gap-2">
        {VIEW_NAMES.map((name) => {
          const label = t.studio.views[name];
          const preview = value.views[name]?.url;
          return (
            <div key={name} className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "relative aspect-square w-full overflow-hidden rounded-xl transition-colors",
                  preview ? "bg-stage" : "border-2 border-dashed border-black/10 bg-dots",
                )}
              >
                <button
                  type="button"
                  aria-label={t.studio.addView(label)}
                  onClick={() => {
                    target.current = name;
                    input.current?.click();
                  }}
                  className="grid size-full place-items-center outline-none focus-visible:ring-4 focus-visible:ring-ring/25"
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview} alt="" className={cn("size-full object-contain p-1.5", busy[name] && "opacity-50")} />
                  ) : (
                    <ImagePlusIcon className="size-5 text-muted-foreground" />
                  )}
                </button>
                {busy[name] ? (
                  <span className="pointer-events-none absolute inset-0 grid place-items-center">
                    <Spinner />
                  </span>
                ) : null}
                {preview && !busy[name] ? (
                  <button
                    type="button"
                    aria-label={t.studio.removeView(label)}
                    onClick={() => remove(name)}
                    className="glass absolute top-1 right-1 grid size-5 place-items-center rounded-full ring-1 ring-black/5"
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
            </div>
          );
        })}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          pick(target.current, e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className={cn("flex flex-col gap-2", !hasViews && "opacity-50")}>
        <Label className="px-1">{t.studio.candidates}</Label>
        <Tabs
          value={String(value.candidates)}
          onValueChange={(n) => onChange((v) => ({ ...v, candidates: Number(n) }))}
        >
          <TabsList className="w-full">
            {Array.from({ length: MAX_SHAPE_CANDIDATES }, (_, i) => i + 1).map((n) => (
              <TabsTrigger key={n} value={String(n)} disabled={!hasViews}>
                {n}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="px-1 text-xs text-muted-foreground">{t.studio.candidatesHint}</p>
      </div>

      {[
        { key: "omni" as const, label: t.studio.omni, hint: t.studio.omniHint },
        { key: "paintAllViews" as const, label: t.studio.paintAllViews, hint: t.studio.paintAllViewsHint },
      ].map(({ key, label, hint }) => (
        <label
          key={key}
          className={cn("flex items-center gap-3 px-1", hasViews ? "cursor-pointer" : "opacity-50")}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{label}</span>
            <span className="block text-xs leading-snug text-muted-foreground">{hint}</span>
          </span>
          <Switch
            checked={value[key]}
            disabled={!hasViews}
            onCheckedChange={(checked) => onChange((v) => ({ ...v, [key]: checked }))}
          />
        </label>
      ))}

      <label className="flex cursor-pointer items-center gap-3 px-1">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t.studio.wingSheets}</span>
          <span className="block text-xs leading-snug text-muted-foreground">{t.studio.wingSheetsHint}</span>
        </span>
        <Switch
          checked={value.wingSheets}
          onCheckedChange={(checked) => onChange((v) => ({ ...v, wingSheets: checked }))}
        />
      </label>
    </div>
  );
}
