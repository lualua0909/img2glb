"use client";

import { WandSparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { MAX_PROMPT_LENGTH } from "@/lib/config";
import type { RefineOptions } from "@/lib/db/schema";
import type { GenerationDTO } from "@/server/generations";
import { useI18n } from "./i18n-provider";

const STRENGTHS: RefineOptions["strength"][] = ["subtle", "balanced", "strong"];

/**
 * The user's instruction and options for refining `gen` into a new version. A side panel next to the viewer in
 * wide layouts (container `gen`), an overlay covering it in narrow ones.
 */
export function RefinePanel({
  gen,
  onCreated,
  onClose,
}: {
  gen: GenerationDTO;
  onCreated: (g: GenerationDTO) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tr = t.refine;
  const [prompt, setPrompt] = useState("");
  const [strength, setStrength] = useState<RefineOptions["strength"]>("balanced");
  const [keepShape, setKeepShape] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = prompt.trim().length >= 3 && !submitting;

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/generations/${gen.id}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), strength, keepShape } satisfies RefineOptions),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      toast.success(tr.started);
      onCreated(data as GenerationDTO);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr.failed);
      setSubmitting(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col gap-3.5 rounded-[1.25rem] bg-card p-4 ring-1 ring-black/5 @3xl/gen:static @3xl/gen:w-[340px] @3xl/gen:shrink-0 @3xl/gen:bg-secondary/40 @3xl/gen:ring-0">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <WandSparklesIcon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{tr.title}</p>
          <p className="text-xs text-muted-foreground">{tr.body}</p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label={t.common.cancel} onClick={onClose} className="-mt-1 -mr-1">
          <XIcon />
        </Button>
      </div>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-1 pb-1 [&>*]:shrink-0">
        <Textarea
          autoFocus
          rows={3}
          value={prompt}
          maxLength={MAX_PROMPT_LENGTH}
          placeholder={tr.placeholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          className="min-h-24 shrink-0 resize-none bg-card"
        />
        <div className="flex flex-wrap gap-1.5">
          {tr.examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt((p) => (p.trim() ? `${p.trim()}, ${ex.toLowerCase()}` : ex))}
              className="rounded-full bg-card px-2.5 py-1 text-xs font-medium ring-1 ring-black/5 transition-colors hover:text-primary"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="px-1 text-[13px] font-semibold text-muted-foreground">{tr.strength}</span>
          <Tabs value={strength} onValueChange={(v) => setStrength(v as RefineOptions["strength"])}>
            <TabsList>
              {STRENGTHS.map((s) => (
                <TabsTrigger key={s} value={s}>
                  {tr.strengths[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl bg-card px-3.5 py-2.5 ring-1 ring-black/5">
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{tr.keepShape}</span>
            <span className="block text-xs text-muted-foreground">{tr.keepShapeHint}</span>
          </span>
          <Switch checked={keepShape} onCheckedChange={setKeepShape} />
        </label>

        {error ? (
          <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">{error}</p>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">{tr.limits}</p>
        )}
      </div>

      <Button onClick={submit} disabled={!ready} className="shrink-0">
        {submitting ? <Spinner /> : <WandSparklesIcon />}
        {tr.submit}
      </Button>
    </div>
  );
}
