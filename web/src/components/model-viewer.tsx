"use client";

import { useEffect, useState } from "react";

export function ModelViewer({ src, poster, alt = "Generated 3D model" }: { src: string; poster?: string; alt?: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    import("@google/model-viewer").then(() => setReady(true));
  }, []);

  if (!ready) return <div className="size-full animate-pulse bg-muted" />;
  return (
    <model-viewer
      src={src}
      poster={poster}
      alt={alt}
      camera-controls
      auto-rotate
      ar
      shadow-intensity="1"
      shadow-softness="0.8"
      exposure="0.85"
      tone-mapping="neutral"
    />
  );
}
