"use client";

import { ChevronDownIcon, ShrinkIcon } from "lucide-react";
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
import { COMPRESS_LEVELS, type CompressLevel } from "@/lib/config";
import type { GenerationDTO } from "@/server/generations";
import { useI18n } from "./i18n-provider";

/** Compresses `gen` on the server at the chosen level into a new version (lossy: textures and faces). */
export function CompressMenu({ gen, onCreated }: { gen: GenerationDTO; onCreated: (g: GenerationDTO) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function compress(level: CompressLevel) {
    setBusy(true);
    try {
      const res = await fetch(`/api/generations/${gen.id}/compress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t.common.requestFailed(res.status));
      onCreated(data as GenerationDTO);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.compress.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Spinner /> : <ShrinkIcon />}
          {t.compress.open}
          <ChevronDownIcon className="-mr-1 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t.compress.note}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {COMPRESS_LEVELS.map((level) => (
          <DropdownMenuItem key={level} onSelect={() => compress(level)}>
            <span className="flex flex-col">
              <span className="font-semibold">{t.compress.levels[level].label}</span>
              <span className="text-xs text-muted-foreground">{t.compress.levels[level].hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
