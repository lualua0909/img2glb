"use client";

import { ImageUpIcon, MapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ACCEPTED_IMAGE_TYPES, MAP_MAX_UPLOAD_BYTES } from "@/lib/config";
import { useI18n } from "./i18n-provider";

/** Upload card for a new game map. Unlike the studio, the image is sent at full size: terrain texture detail comes from it. */
export function MapUpload({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  function pick(f: File | undefined) {
    if (!f) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) return void toast.error(t.maps.uploadHint);
    if (f.size > MAP_MAX_UPLOAD_BYTES) return void toast.error(t.maps.uploadHint);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!name) setName(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("image", file);
    form.set("name", name);
    const res = await fetch("/api/maps", { method: "POST", body: form }).catch(() => null);
    if (!res?.ok) {
      setBusy(false);
      toast.error((await res?.json().catch(() => ({})))?.error ?? t.common.somethingWrong);
      return;
    }
    const { id } = await res.json();
    router.push(`/app/maps/${id}`);
    router.refresh();
  }

  if (!enabled)
    return <p className="rounded-2xl bg-card p-5 text-sm text-muted-foreground shadow-soft ring-1 ring-black/[0.04]">{t.maps.notEnabled}</p>;

  return (
    <div className="grid gap-4 rounded-3xl bg-card p-4 shadow-soft ring-1 ring-black/[0.04] sm:p-5 md:grid-cols-[1.4fr_1fr]">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files[0]);
        }}
        className="relative grid aspect-[16/10] place-items-center overflow-hidden rounded-2xl bg-stage ring-1 ring-black/5 transition-shadow outline-none hover:shadow-float focus-visible:ring-4 focus-visible:ring-ring/25"
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="size-full object-contain" />
        ) : (
          <span className="flex flex-col items-center gap-2 px-6 text-center">
            <span className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
              <ImageUpIcon className="size-7" />
            </span>
            <span className="font-semibold">{t.maps.upload}</span>
            <span className="text-xs text-muted-foreground">{t.maps.uploadHint}</span>
          </span>
        )}
        {preview ? (
          <span className="glass absolute right-2 bottom-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-black/5">{t.maps.change}</span>
        ) : null}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="map-name">{t.maps.name}</Label>
          <Input id="map-name" value={name} maxLength={80} placeholder={t.maps.namePlaceholder} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="rounded-xl bg-primary/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{t.maps.timeNote}</p>
        <div className="mt-auto flex flex-col gap-2">
          <Button size="lg" disabled={!file || busy} onClick={submit}>
            {busy ? <Spinner /> : <MapIcon />}
            {busy ? t.maps.building : t.maps.build}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t.maps.free}</p>
        </div>
      </div>
    </div>
  );
}
