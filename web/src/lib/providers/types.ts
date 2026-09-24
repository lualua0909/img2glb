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
  /** Upload preprocessing (denoise, background removal, centering) -> PNG; null = no object found. Absent = used as uploaded. */
  preprocess?(image: Blob): Promise<Uint8Array<ArrayBuffer> | null>;
}
