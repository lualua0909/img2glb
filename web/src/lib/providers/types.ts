export type ProviderState = Record<string, unknown>;

export type StartInput = {
  /** Publicly fetchable (pre-signed) URL of the input image. Absent in text mode. */
  imageUrl?: string;
  prompt?: string;
  textured: boolean;
  steps: number;
  octreeResolution: number;
  faceCount: number;
  /** Texture size cap in px; omitted = engine native size. */
  textureSize?: number;
  /** Faceted (low poly style) shading. */
  flatShading: boolean;
  seed: number;
  /** Omitted = provider default. */
  guidanceScale?: number;
  /** Refine an earlier result: edit the reference image (`imageUrl`) with an instruction, then rebuild. */
  refine?: {
    /** Instruction in any language (the worker translates it to English). */
    prompt: string;
    /** Edit image guidance: higher keeps more of the reference image. */
    imageGuidance: number;
    /** Keep this mesh and only repaint its texture. */
    meshUrl?: string;
  };
  /** Extra views of the object in `imageUrl` (fetchable URLs by view name) and how to use them. */
  multiview?: {
    viewUrls: Record<string, string>;
    /** Shapes generated; the one matching the views best is kept. */
    candidates: number;
    /** Also generate a Hunyuan3D-Omni shape conditioned on the views' visual hull. */
    omni: boolean;
    /** Give the views to the texture model as extra references. */
    paintAllViews: boolean;
    /** Replace membrane wings by thin double-sided sheets textured from the image(s). */
    wingSheets: boolean;
  };
};

type Download = { url: string; headers?: Record<string, string> };

export type PollResult =
  | { type: "running"; state: ProviderState; message: string; /** Estimated percent done, when known. */ progress?: number }
  | { type: "completed"; model: Download; conceptImage?: Download; stats?: Record<string, number> }
  | { type: "failed"; error: string };

export interface GenerationProvider {
  readonly name: string;
  start(input: StartInput): Promise<ProviderState>;
  poll(state: ProviderState): Promise<PollResult>;
  /** Stop a queued or running job. */
  cancel(state: ProviderState): Promise<void>;
  /** Upload preprocessing (denoise, background removal, centering) -> PNG; null = no object found. Absent = used as uploaded. */
  preprocess?(image: Blob): Promise<Uint8Array<ArrayBuffer> | null>;
}
