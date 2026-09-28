import { Color, type MeshStandardMaterial } from "three";

export type EmissionSettings = { enabled: boolean; color: string; intensity: number };
export const DEFAULT_EMISSION: EmissionSettings = { enabled: false, color: "#65ffb5", intensity: 3 };

export function readEmission(material: MeshStandardMaterial): EmissionSettings {
  const saved = material.userData.formaEmission as EmissionSettings | undefined;
  if (saved && typeof saved.enabled === "boolean" && /^#[\da-f]{6}$/i.test(saved.color) && Number.isFinite(saved.intensity))
    return { ...saved, intensity: Math.max(0, Math.min(20, saved.intensity)) };
  const enabled = material.emissive.getHex() !== 0 && material.emissiveIntensity > 0;
  return enabled
    ? { enabled, color: `#${material.emissive.getHexString()}`, intensity: material.emissiveIntensity }
    : { ...DEFAULT_EMISSION };
}

/** Keep the map attached even when disabled so GLB export retains the painted regions. */
export function applyEmission(material: MeshStandardMaterial, settings: EmissionSettings) {
  material.userData.formaEmission = { ...settings };
  material.emissive.copy(new Color(settings.color));
  material.emissiveIntensity = settings.enabled ? settings.intensity : 0;
}

export function colorMatches(r: number, g: number, b: number, target: readonly number[], tolerance: number) {
  return Math.hypot(r - target[0], g - target[1], b - target[2]) <= tolerance * Math.sqrt(3) * 255;
}
