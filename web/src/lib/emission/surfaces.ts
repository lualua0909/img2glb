import { CanvasTexture, Matrix3, MeshStandardMaterial, SRGBColorSpace, Vector2, type Mesh, type Texture } from "three";
import { applyEmission, colorMatches, readEmission, type EmissionSettings } from "./settings";

export type Surface = ReturnType<typeof createSurface>;
function canvasOf(texture?: Texture | null) {
  const image = texture?.image as CanvasImageSource & { width: number; height: number } | undefined;
  const canvas = document.createElement("canvas");
  const scale = image ? Math.min(1, 1024 / Math.max(image.width, image.height)) : 1;
  canvas.width = image ? Math.max(1, Math.round(image.width * scale)) : 1024;
  canvas.height = image ? Math.max(1, Math.round(image.height * scale)) : 1024;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function createSurface(material: MeshStandardMaterial) {
  const settings = readEmission(material);
  const prior = material.emissiveMap;
  const { canvas, ctx } = canvasOf(prior);
  if (!prior) {
    ctx.fillStyle = settings.enabled ? "white" : "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  const template = prior ?? material.map;
  texture.flipY = template?.flipY ?? false;
  texture.colorSpace = SRGBColorSpace;
  if (template) {
    texture.channel = template.channel;
    texture.wrapS = template.wrapS; texture.wrapT = template.wrapT;
    texture.offset.copy(template.offset); texture.repeat.copy(template.repeat);
    texture.center.copy(template.center); texture.rotation = template.rotation;
    texture.matrixAutoUpdate = template.matrixAutoUpdate;
    texture.matrix.copy(template.matrix);
  }
  const base = material.map ? canvasOf(material.map) : null;
  const basePixels = base?.ctx.getImageData(0, 0, base.canvas.width, base.canvas.height);
  let attached = false;
  return {
    material, settings, canvas, ctx, texture, base, basePixels,
    attach() {
      if (!attached) { material.emissiveMap = texture; material.needsUpdate = true; attached = true; }
      texture.needsUpdate = true;
      applyEmission(material, settings);
    },
    update(next: Partial<EmissionSettings>) {
      Object.assign(settings, next);
      this.attach();
    },
    select(target: number[], tolerance: number) {
      if (!base || !basePixels || !material.map || material.map.channel !== texture.channel) return false;
      if (texture.matrixAutoUpdate) texture.updateMatrix();
      const inverse = new Matrix3().copy(texture.matrix).invert();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const uv = new Vector2();
      if (material.map.matrixAutoUpdate) material.map.updateMatrix();
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        uv.set((x + 0.5) / canvas.width, (y + 0.5) / canvas.height);
        if (texture.flipY) uv.y = 1 - uv.y;
        uv.applyMatrix3(inverse);
        material.map.transformUv(uv);
        const bx = Math.min(base.canvas.width - 1, Math.max(0, Math.floor(uv.x * base.canvas.width)));
        const by = Math.min(base.canvas.height - 1, Math.max(0, Math.floor(uv.y * base.canvas.height)));
        const bi = (by * base.canvas.width + bx) * 4;
        const i = (y * canvas.width + x) * 4;
        const match = colorMatches(basePixels.data[bi], basePixels.data[bi + 1], basePixels.data[bi + 2], target, tolerance);
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = match ? 255 : 0;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0); this.attach(); return true;
    },
  };
}

export function emissionSurfaces(meshes: Mesh[]) {
  const surfaces = new Map<MeshStandardMaterial, Surface>();
  for (const mesh of meshes) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    if (!(material instanceof MeshStandardMaterial) || surfaces.has(material)) continue;
    const channel = material.emissiveMap?.channel ?? material.map?.channel ?? 0;
    if (!mesh.geometry.hasAttribute(channel === 0 ? "uv" : `uv${channel}`)) continue;
    surfaces.set(material, createSurface(material));
  }
  return surfaces;
}
