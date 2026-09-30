"use client";

import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "./i18n-provider";

type Format = "stl" | "obj" | "usdz";

const FORMATS: Format[] = ["stl", "obj", "usdz"];

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function FormatItem({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex flex-col">
      <span className="font-semibold">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </span>
  );
}

/**
 * GLB is served as-is; other formats are converted in the browser with three.js exporters. `withWeapons` (a weapon
 * attached in the viewer): every format is made from the viewer's export instead, weapon included.
 */
export function ExportMenu({
  modelUrl,
  downloadUrl,
  baseName,
  withWeapons,
}: {
  modelUrl: string;
  downloadUrl: string;
  baseName: string;
  withWeapons?: (() => Promise<ArrayBuffer>) | null;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<Format | "glb" | null>(null);

  async function convert(format: Format | "glb") {
    setBusy(format);
    try {
      const { gltfLoader } = await import("@/lib/gltf-loader");
      const armed = withWeapons ? await withWeapons() : null;
      if (format === "glb") {
        if (armed) save(new Blob([armed], { type: "model/gltf-binary" }), `${baseName}.glb`);
        return;
      }
      const gltf = armed ? await gltfLoader().parseAsync(armed, "") : await gltfLoader().loadAsync(modelUrl);
      const scene = gltf.scene;
      if (format === "stl") {
        const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
        const data = new STLExporter().parse(scene, { binary: true }) as DataView;
        save(new Blob([data.buffer as ArrayBuffer], { type: "model/stl" }), `${baseName}.stl`);
      } else if (format === "obj") {
        const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
        save(new Blob([new OBJExporter().parse(scene)], { type: "text/plain" }), `${baseName}.obj`);
      } else {
        const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
        const data = await new USDZExporter().parseAsync(scene);
        save(new Blob([data.buffer as ArrayBuffer], { type: "model/vnd.usdz+zip" }), `${baseName}.usdz`);
      }
    } catch (e) {
      console.error(e);
      toast.error(t.gen.exportFailed(format.toUpperCase()));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={busy !== null}>
          {busy ? <Spinner /> : <DownloadIcon />}
          {t.common.download}
          <ChevronDownIcon className="-mr-1 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {withWeapons ? (
          <DropdownMenuItem onSelect={() => convert("glb")}>
            <FormatItem label="GLB" hint={t.gen.withWeapon} />
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <a href={downloadUrl}>
              <FormatItem label="GLB" hint={t.gen.formats.glb} />
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f} onSelect={() => convert(f)}>
            <FormatItem label={f.toUpperCase()} hint={t.gen.formats[f]} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
