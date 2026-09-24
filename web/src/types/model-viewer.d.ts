import type { ModelViewerElement } from "@google/model-viewer";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<HTMLAttributes<ModelViewerElement>, ModelViewerElement> & {
        src?: string;
        alt?: string;
        poster?: string;
        ar?: boolean;
        "camera-controls"?: boolean;
        "auto-rotate"?: boolean;
        "shadow-intensity"?: string;
        "shadow-softness"?: string;
        exposure?: string;
        "environment-image"?: string;
        "tone-mapping"?: string;
      };
    }
  }
}
