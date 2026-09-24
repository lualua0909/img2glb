"use client";

import { InfoIcon, PauseCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { QUALITY_PRESETS, USE_CASES, type Quality } from "@/lib/config";
import type { AppSettings } from "@/lib/settings";
import { useI18n } from "./i18n-provider";

type Provider = AppSettings["generation"]["provider"];

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {hint ? <CardDescription>{hint}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="px-1 text-[13px] text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="px-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Field label={props.label}>
      <Input
        type="number"
        className="tabular-nums"
        value={Number.isNaN(props.value) ? "" : props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.valueAsNumber)}
      />
    </Field>
  );
}

export function AdminSettingsForm({
  initial,
  defaults,
  providers,
  local,
  storage,
}: {
  initial: AppSettings;
  defaults: AppSettings;
  providers: Provider[];
  local: boolean;
  storage: string;
}) {
  const { t } = useI18n();
  const ts = t.admin.settings;
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  /** Immutable update: `fn` mutates a copy. */
  const update = (fn: (draft: AppSettings) => void) =>
    setS((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      setS(data.settings);
      toast.success(ts.saved);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : ts.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const g = s.generation;
  const providerOptions = providers.includes(g.provider) ? providers : [g.provider, ...providers];

  return (
    <div className="flex flex-col gap-5">
      <Section title={ts.generation} hint={ts.storageHint(storage)}>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-secondary/60 p-3.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-warning text-white">
            <PauseCircleIcon className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{ts.pause}</span>
            <span className="block text-xs text-muted-foreground">{ts.pauseHint}</span>
          </span>
          <Switch checked={g.paused} onCheckedChange={(v) => update((d) => void (d.generation.paused = v))} />
        </label>
        {g.paused ? (
          <Field id="paused-msg" label={ts.pausedMessage}>
            <Input
              id="paused-msg"
              maxLength={200}
              value={g.pausedMessage}
              onChange={(e) => update((d) => void (d.generation.pausedMessage = e.target.value))}
            />
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="provider" label={ts.provider} hint={ts.providerHint}>
            <Select value={g.provider} disabled>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((p) => (
                  <SelectItem key={p} value={p} disabled={!providers.includes(p)}>
                    {ts.providers[p] ?? p}
                    {providers.includes(p) ? "" : ` — ${ts.notConfigured}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="guidance" label={ts.guidance} hint={ts.guidanceHint}>
            <Input
              id="guidance"
              type="number"
              min={1}
              max={20}
              step={0.5}
              placeholder={ts.guidancePlaceholder}
              value={g.guidanceScale ?? ""}
              onChange={(e) =>
                update((d) => void (d.generation.guidanceScale = e.target.value === "" ? null : e.target.valueAsNumber))
              }
            />
          </Field>
        </div>
      </Section>

      <Section title={ts.qualityPresets} hint={ts.qualityHint}>
        {(Object.keys(QUALITY_PRESETS) as Quality[]).map((q) => (
          <div key={q} className="flex flex-col gap-3 rounded-2xl bg-secondary/50 p-4">
            <p className="text-sm font-semibold">
              {t.quality[q].label} <span className="font-mono text-xs font-normal text-muted-foreground">{q}</span>
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={ts.label}>
                <Input
                  className="bg-card"
                  maxLength={20}
                  value={s.quality[q].label}
                  onChange={(e) => update((d) => void (d.quality[q].label = e.target.value))}
                />
              </Field>
              <Field label={ts.hint}>
                <Input
                  className="bg-card"
                  maxLength={60}
                  value={s.quality[q].hint}
                  onChange={(e) => update((d) => void (d.quality[q].hint = e.target.value))}
                />
              </Field>
              <NumberField
                label={ts.steps}
                value={s.quality[q].steps}
                min={1}
                max={100}
                onChange={(v) => update((d) => void (d.quality[q].steps = v))}
              />
              <NumberField
                label={ts.octree}
                value={s.quality[q].octreeResolution}
                min={64}
                max={512}
                onChange={(v) => update((d) => void (d.quality[q].octreeResolution = v))}
              />
            </div>
          </div>
        ))}
      </Section>

      <Section title={ts.useCases} hint={ts.useCasesHint}>
        <div className="grid gap-4 sm:grid-cols-4">
          {USE_CASES.map((u) => (
            <NumberField
              key={u.id}
              label={t.useCases[u.id]}
              value={s.faceCount[u.id]}
              min={1000}
              max={500_000}
              step={1000}
              onChange={(v) => update((d) => void (d.faceCount[u.id] = v))}
            />
          ))}
        </div>
      </Section>

      <Section title={ts.creditsLimits}>
        {local ? (
          <p className="flex gap-2 rounded-xl bg-primary/8 px-3.5 py-3 text-sm text-primary">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            {ts.localHint}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <NumberField
            label={ts.shape}
            value={s.credits.shape}
            min={0}
            max={1000}
            disabled={local}
            onChange={(v) => update((d) => void (d.credits.shape = v))}
          />
          <NumberField
            label={ts.textured}
            value={s.credits.textured}
            min={0}
            max={1000}
            disabled={local}
            onChange={(v) => update((d) => void (d.credits.textured = v))}
          />
          <NumberField
            label={ts.textPrompt}
            value={s.credits.textPrompt}
            min={0}
            max={1000}
            disabled={local}
            onChange={(v) => update((d) => void (d.credits.textPrompt = v))}
          />
          <NumberField
            label={ts.signupBonus}
            value={s.credits.signupBonus}
            min={0}
            max={100_000}
            disabled={local}
            onChange={(v) => update((d) => void (d.credits.signupBonus = v))}
          />
          <NumberField
            label={ts.maxJobs}
            value={s.limits.maxActiveJobsPerUser}
            min={1}
            max={50}
            disabled={local}
            onChange={(v) => update((d) => void (d.limits.maxActiveJobsPerUser = v))}
          />
          <NumberField
            label={ts.timeout}
            value={s.limits.jobTimeoutMinutes}
            min={1}
            max={1440}
            onChange={(v) => update((d) => void (d.limits.jobTimeoutMinutes = v))}
          />
        </div>
      </Section>

      <div className="glass sticky bottom-24 z-10 flex flex-wrap items-center gap-2 rounded-2xl p-2.5 shadow-float ring-1 ring-black/5 md:bottom-4">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? <Spinner /> : null}
          {ts.save}
        </Button>
        <Button variant="outline" onClick={() => setS(initial)} disabled={saving || !dirty}>
          {ts.discard}
        </Button>
        <Button variant="ghost" onClick={() => setS(defaults)} disabled={saving}>
          {ts.reset}
        </Button>
        {dirty ? <p className="ml-auto hidden px-2 text-xs font-medium text-muted-foreground sm:block">{ts.unsaved}</p> : null}
      </div>
    </div>
  );
}
