import {
  AnimationMixer,
  type AnimationClip,
  ArrowHelper,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  DirectionalLight,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  Skeleton,
  SkeletonHelper,
  SkinnedMesh,
  Timer,
  Uint16BufferAttribute,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildModelData, type ModelData } from "./model";
import type { RigPlan } from "./rig";
import type { Skin } from "./skin";

export type Stage = {
  model: ModelData;
  /** Marker step: orthographic view looking down -axis, model shown x-ray. */
  showMarkers(axis: Vector3): void;
  /** Skeleton + forward arrow preview while placing markers. */
  setPreview(plan: RigPlan | null): void;
  /** Canvas pixel position of a world point. */
  project(p: Vector3): { x: number; y: number };
  /** World point under a canvas pixel, at the depth (along the view axis) of `depthOf`. */
  unproject(x: number, y: number, depthOf: Vector3): Vector3;
  /** Animate step: replaces the static model with a skinned one. */
  applyRig(plan: RigPlan, skin: Skin): void;
  /** Animate step for a model rigged by the AI auto-rigger (GLB); `plan` is `autoRigPlan(model)`. */
  applyAutoRig(glb: ArrayBuffer, plan: RigPlan): Promise<void>;
  play(clip: AnimationClip | null): void;
  setShowBones(on: boolean): void;
  exportGlb(clips: AnimationClip[]): Promise<ArrayBuffer>;
  /** Called after each rendered frame (to move DOM overlays). */
  onFrame(cb: (() => void) | null): void;
  dispose(): void;
};

const UP = new Vector3(0, 1, 0);

export async function createStage(el: HTMLElement, src: string): Promise<Stage> {
  const gltf = await new GLTFLoader().loadAsync(src);
  const original = gltf.scene;
  original.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  original.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh);
  });
  const materials = meshes.map((m) => m.material);
  const clay = new MeshStandardMaterial({ color: 0x9d9da6, roughness: 0.7, metalness: 0 });
  // Untextured (shape-only) models are plain white and wash out under the studio light: show them as clay.
  // Exports always use the model's own materials.
  const display = meshes.map((m, i) => {
    const mat = materials[i] as MeshStandardMaterial;
    return !Array.isArray(mat) && !mat.map && !m.geometry.getAttribute("color") ? clay : materials[i];
  });
  const model = buildModelData(meshes);
  const { size, center, box } = model;
  const radius = Math.max(size.length() / 2, 1e-3);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = NeutralToneMapping;
  const canvas = renderer.domElement;
  canvas.style.touchAction = "none";
  el.appendChild(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.copy(center).add(new Vector3(1.2, 2.2, 1.6).multiplyScalar(radius * 2));
  scene.add(new HemisphereLight(0xffffff, 0x8d8d95, 0.4), key);
  const grid = new GridHelper(radius * 6, 24, 0xa1a1a8, 0xc8c8ce);
  (grid.material as Material).transparent = true;
  (grid.material as Material).opacity = 0.6;
  grid.position.set(center.x, box.min.y - radius * 0.002, center.z);
  scene.add(grid, original);

  const xray = new MeshStandardMaterial({ color: 0x9d9da6, transparent: true, opacity: 0.4, depthWrite: false });

  // ---- cameras ----
  const persp = new PerspectiveCamera(35, 1, radius / 100, radius * 100);
  persp.position.copy(center).add(new Vector3(0.55, 0.35, 1).normalize().multiplyScalar(radius * 3.2));
  const orbit = new OrbitControls(persp, canvas);
  orbit.enableDamping = true;
  orbit.target.copy(center);
  orbit.update();
  const ortho = new OrthographicCamera(-1, 1, 1, -1, radius / 100, radius * 100);
  const pan = new OrbitControls(ortho, canvas);
  pan.enableRotate = false;
  pan.enabled = false;
  let camera: PerspectiveCamera | OrthographicCamera = persp;
  let viewAxis = new Vector3(0, 0, 1);
  let viewExtent = { w: 1, h: 1 };

  const fitOrtho = () => {
    const aspect = el.clientWidth / Math.max(el.clientHeight, 1);
    const half = Math.max(viewExtent.h, viewExtent.w / aspect) * 0.62;
    Object.assign(ortho, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    ortho.updateProjectionMatrix();
  };
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = el;
    renderer.setSize(w, h);
    persp.aspect = w / Math.max(h, 1);
    persp.updateProjectionMatrix();
    fitOrtho();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  // ---- marker-step preview ----
  const previewLines = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({ color: 0x0071e3, depthTest: false, transparent: true }),
  );
  const previewJoints = new Points(
    new BufferGeometry(),
    new PointsMaterial({ color: 0x0071e3, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }),
  );
  previewLines.renderOrder = previewJoints.renderOrder = 998;
  let arrow: ArrowHelper | null = null;
  scene.add(previewLines, previewJoints);

  // ---- rigged model ----
  let rig: { group: Scene; bones: Bone[]; rest: { p: Vector3; q: Quaternion; s: Vector3 }[]; helper: SkeletonHelper } | null =
    null;
  let mixer: AnimationMixer | null = null;
  let showBones = false;
  const clearRig = () => {
    if (!rig) return;
    mixer?.stopAllAction();
    mixer = null;
    scene.remove(rig.group, rig.helper);
    rig.group.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).geometry.dispose();
    });
    rig.helper.dispose();
    rig = null;
  };
  const restPose = () =>
    rig?.bones.forEach((b, i) => {
      b.position.copy(rig!.rest[i].p);
      b.quaternion.copy(rig!.rest[i].q);
      b.scale.copy(rig!.rest[i].s);
    });

  const timer = new Timer();
  let frameCb: (() => void) | null = null;
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    mixer?.update(dt);
    (camera === persp ? orbit : pan).update();
    renderer.render(scene, camera);
    frameCb?.();
  });

  const showRig = (group: Scene, bones: Bone[], frame: RigPlan["frame"]) => {
    const helper = new SkeletonHelper(group);
    (helper.material as Material).depthTest = false;
    helper.renderOrder = 999;
    helper.visible = showBones;
    scene.add(group, helper);
    rig = {
      group,
      bones,
      rest: bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() })),
      helper,
    };
    mixer = new AnimationMixer(group);

    // Three-quarter view from the object's left-front, so gaits and wheels are visible.
    const { forward, lateral } = frame;
    persp.position
      .copy(center)
      .add(lateral.clone().add(forward.clone().multiplyScalar(0.6)).setY(0.35).normalize().multiplyScalar(radius * 3.2));
    orbit.target.copy(center);
    orbit.update();
    camera = persp;
    pan.enabled = false;
    orbit.enabled = true;
    grid.visible = true;
  };

  const setMaterials = (m: Material | null) =>
    meshes.forEach((mesh, i) => {
      mesh.material = m ?? materials[i];
    });

  const stage: Stage = {
    model,
    showMarkers(axis) {
      clearRig();
      if (!original.parent) scene.add(original);
      setMaterials(xray);
      viewAxis = axis.clone().normalize();
      const up = Math.abs(viewAxis.y) > 0.9 ? new Vector3(0, 0, -1) : UP.clone();
      const right = up.clone().cross(viewAxis).normalize();
      viewExtent = {
        w: Math.abs(size.x * right.x) + Math.abs(size.y * right.y) + Math.abs(size.z * right.z),
        h: Math.abs(size.x * up.x) + Math.abs(size.y * up.y) + Math.abs(size.z * up.z),
      };
      ortho.up.copy(up);
      ortho.position.copy(center).addScaledVector(viewAxis, radius * 4);
      ortho.zoom = 1;
      pan.target.copy(center);
      ortho.lookAt(center);
      fitOrtho();
      pan.update();
      camera = ortho;
      orbit.enabled = false;
      pan.enabled = true;
      grid.visible = Math.abs(viewAxis.y) < 0.9;
    },
    setPreview(plan) {
      if (arrow) {
        scene.remove(arrow);
        arrow.dispose();
        arrow = null;
      }
      if (!plan) {
        previewLines.visible = previewJoints.visible = false;
        return;
      }
      const seg: number[] = [];
      const joints: number[] = [];
      for (const b of plan.bones) {
        if (!b.deform) continue;
        seg.push(...b.head.toArray(), ...b.tail.toArray());
        joints.push(...b.head.toArray());
      }
      previewLines.geometry.setAttribute("position", new Float32BufferAttribute(seg, 3));
      previewJoints.geometry.setAttribute("position", new Float32BufferAttribute(joints, 3));
      previewLines.visible = previewJoints.visible = true;
      const base = center.clone().setY(box.min.y + 0.02 * size.y);
      arrow = new ArrowHelper(plan.frame.forward, base, 0.45 * Math.max(plan.length, size.y), 0xff9500, 0.08 * radius, 0.05 * radius);
      (arrow.line.material as Material).depthTest = false;
      (arrow.cone.material as Material).depthTest = false;
      arrow.renderOrder = 999;
      scene.add(arrow);
    },
    project(p) {
      const v = p.clone().project(camera);
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
    },
    unproject(x, y, depthOf) {
      const v = new Vector3((x / el.clientWidth) * 2 - 1, 1 - (y / el.clientHeight) * 2, 0).unproject(camera);
      return v.addScaledVector(viewAxis, depthOf.clone().sub(v).dot(viewAxis));
    },
    applyRig(plan, skin) {
      clearRig();
      scene.remove(original);
      setMaterials(null);
      stage.setPreview(null);

      // A Scene (not a Group) so the exporter writes bones and skinned meshes as root nodes: glTF ignores the
      // parent transform of a skinned mesh.
      const group = new Scene();
      group.name = "Model";
      const bones = plan.bones.map((b) => Object.assign(new Bone(), { name: b.name }));
      plan.bones.forEach((b, i) => {
        const parent = b.parent ? plan.bones.findIndex((p) => p.name === b.parent) : -1;
        bones[i].position.copy(parent >= 0 ? b.head.clone().sub(plan.bones[parent].head) : b.head);
        (parent >= 0 ? bones[parent] : group).add(bones[i]);
      });
      group.updateMatrixWorld(true);
      const skeleton = new Skeleton(bones);
      meshes.forEach((mesh, k) => {
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const map = model.maps[k];
        const index = new Uint16Array(map.length * 4);
        const weight = new Float32Array(map.length * 4);
        for (let i = 0; i < map.length; i++) {
          index.set(skin.index.subarray(map[i] * 4, map[i] * 4 + 4), i * 4);
          weight.set(skin.weight.subarray(map[i] * 4, map[i] * 4 + 4), i * 4);
        }
        geometry.setAttribute("skinIndex", new Uint16BufferAttribute(index, 4));
        geometry.setAttribute("skinWeight", new BufferAttribute(weight, 4));
        const skinned = new SkinnedMesh(geometry, display[k]);
        skinned.name = mesh.name || `Mesh${k}`;
        group.add(skinned);
        skinned.bind(skeleton, new Matrix4());
      });
      showRig(group, bones, plan.frame);
    },
    async applyAutoRig(glb, plan) {
      const loaded = (await new GLTFLoader().parseAsync(glb, "")).scene;
      clearRig();
      scene.remove(original);
      stage.setPreview(null);
      // The clips drive a bone named "Root": keep that name for ours.
      loaded.traverse((o) => {
        if (o.name === "Root") o.name = "Root_";
      });
      const group = new Scene();
      group.name = "Model";
      const root = Object.assign(new Bone(), { name: "Root" });
      root.position.copy(plan.bones[0].head);
      loaded.position.sub(plan.bones[0].head);
      root.add(loaded);
      group.add(root);
      const bones: Bone[] = [root];
      loaded.traverse((o) => {
        if ((o as Bone).isBone) bones.push(o as Bone);
      });
      group.updateMatrixWorld(true);
      showRig(group, bones, plan.frame);
    },
    play(clip) {
      if (!mixer) return;
      mixer.stopAllAction();
      restPose();
      if (clip) mixer.clipAction(clip).reset().play();
    },
    setShowBones(on) {
      showBones = on;
      if (rig) rig.helper.visible = on;
    },
    async exportGlb(clips) {
      if (!rig) throw new Error("Not rigged");
      mixer?.stopAllAction();
      restPose();
      rig.group.updateMatrixWorld(true);
      const skinned = rig.group.children.filter((o): o is SkinnedMesh => (o as SkinnedMesh).isSkinnedMesh);
      skinned.forEach((m, k) => (m.material = materials[k]));
      try {
        return (await new GLTFExporter().parseAsync(rig.group, { binary: true, animations: clips })) as ArrayBuffer;
      } finally {
        skinned.forEach((m, k) => (m.material = display[k]));
      }
    },
    onFrame(cb) {
      frameCb = cb;
    },
    dispose() {
      frameCb = null;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      orbit.dispose();
      pan.dispose();
      clearRig();
      const disposeTree = (o: Object3D) =>
        o.traverse((c) => {
          const m = c as Mesh;
          if (m.isMesh) m.geometry.dispose();
        });
      disposeTree(original);
      materials.flat().forEach((m) => m.dispose());
      [xray, clay, previewLines.material, previewJoints.material].forEach((m) => (m as Material).dispose());
      previewLines.geometry.dispose();
      previewJoints.geometry.dispose();
      arrow?.dispose();
      grid.dispose();
      envMap.dispose();
      pmrem.dispose();
      model.bvh.geometry.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  return stage;
}
