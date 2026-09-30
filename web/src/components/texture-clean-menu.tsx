"use client";

import { ChevronDownIcon, PaintBucketIcon } from "lucide-react";
import { useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { TEXTURE_CLEAN_LEVELS, type TextureCleanLevel } from "@/lib/config";
import type { GenerationDTO } from "@/server/generations";
import { useI18n } from "./i18n-provider";

/** Cleans `gen`'s textures on the worker at the chosen level into a new version. */
export function TextureCleanMenu({ gen, onCreated }: { gen: GenerationDTO; onCreated: (g: GenerationDTO) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function clean(level: TextureCleanLevel) {
    setBusy(true);
    try {
      const res = await fetch(`/api/generations/${gen.id}/clean-texture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      onCreated(data as GenerationDTO);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.textureClean.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Spinner /> : <PaintBucketIcon />}
          {busy ? t.textureClean.working : t.textureClean.open}
          <ChevronDownIcon className="-mr-1 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t.textureClean.note}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TEXTURE_CLEAN_LEVELS.map((level) => (
          <DropdownMenuItem key={level} onSelect={() => clean(level)}>
            <span className="flex flex-col">
              <span className="font-semibold">{t.textureClean.levels[level].label}</span>
              <span className="text-xs text-muted-foreground">{t.textureClean.levels[level].hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
