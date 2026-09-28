import { Vector2, type Camera, type Scene, type WebGLRenderer } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export function createBloom(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
  const composer = new EffectComposer(renderer);
  const render = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.7, 0.4, 1.1);
  const output = new OutputPass();
  composer.addPass(render);
  composer.addPass(bloom);
  composer.addPass(output);
  return {
    render: () => composer.render(),
    resize: (w: number, h: number) => composer.setSize(Math.max(1, w), Math.max(1, h)),
    dispose() { bloom.dispose(); output.dispose(); render.dispose(); composer.dispose(); },
  };
}
