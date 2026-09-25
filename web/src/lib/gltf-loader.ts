import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let draco: DRACOLoader | undefined;

/** GLTFLoader that also reads compressed models (Draco decoder copied from three into public/draco). */
export function gltfLoader() {
  draco ??= new DRACOLoader().setDecoderPath("/draco/");
  return new GLTFLoader().setDRACOLoader(draco);
}
