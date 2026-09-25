import {
  type AnimationAction,
  AnimationMixer,
  type AnimationClip,
  ArrowHelper,
  Bone,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  DirectionalLight,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
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
import { gltfLoader } from "@/lib/gltf-loader";
import type { Attack } from "./clips";
import type { Hitbox } from "./hitbox";
import { buildModelData, type ModelData } from "./model";
import type { Door, RigPlan } from "./rig";
import type { Skin } from "./skin";

export type Stage = {
  model: ModelData;
  /** Marker step: orthographic view looking down -axis (null: keep the last one), model shown x-ray. The user can
   * orbit it freely. */
  showMarkers(axis: Vector3 | null): void;
  /** Marker step: unit vector from the view target toward the camera (follows the user's orbit). */
  viewAxis(): Vector3;
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
  /** `attack`: its hitboxes light up while it hits. */
  play(clip: AnimationClip | null, attack?: Attack): void;
  /** Hitbox capsules on their bones (null hides them). */
  setHitboxes(boxes: Hitbox[] | null): void;
  setShowBones(on: boolean): void;
  /** `extras` go into the glTF scene's extras (animation extras come from each clip's `userData`). */
  exportGlb(clips: AnimationClip[], extras?: Record<string, unknown>): Promise<ArrayBuffer>;
  /** Called after each rendered frame (to move DOM overlays). */
  onFrame(cb: (() => void) | null): void;
  dispose(): void;
};

const UP = new Vector3(0, 1, 0);

/**
 * Rigid skins with parts that open (a door): each triangle goes whole to the part most of its corners are in, and
 * its other corners are copied, so the part comes away cleanly instead of stretching the triangles along its edge.
 * Returns the part of every vertex, copies included.
 */
function splitParts(geometry: BufferGeometry, partOf: (i: number) => number) {
  const count = geometry.getAttribute("position").count;
  const index = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: count }, (_, i) => i);
  const parts = Array.from({ length: count }, (_, i) => partOf(i));
  const source: number[] = [];
  const copies = new Map<string, number>();
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => parts[index[t + k]]);
    const major = a === b || a === c ? a : b === c ? b : a;
    for (let k = 0; k < 3; k++) {
      const v = index[t + k];
      if (parts[v] === major) continue;
      const key = `${v},${major}`;
      let copy = copies.get(key);
      if (copy === undefined) {
        copy = count + source.length;
        copies.set(key, copy);
        source.push(v);
        parts.push(major);
      }
      index[t + k] = copy;
    }
  }
  if (!source.length) return parts;
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const flat = "isInterleavedBufferAttribute" in attr ? attr.clone() : attr;
    const n = flat.itemSize;
    const array = new (flat.array.constructor as Float32ArrayConstructor)((count + source.length) * n);
    array.set(flat.array);
    source.forEach((v, j) => array.set(flat.array.subarray(v * n, v * n + n), (count + j) * n));
    geometry.setAttribute(name, new BufferAttribute(array, n, flat.normalized));
  }
  geometry.setIndex(index);
  return parts;
}

/**
 * Dark recess behind a door, attached to the body: generated models are closed shells, so an open door would show
 * the inside faces (culled: see-through) instead of a doorway.
 */
function doorway(d: Door) {
  const back = d.normal.clone().multiplyScalar(-(d.depth + 0.3 * d.width.length()));
  const up = UP.clone().multiplyScalar(d.height);
  // Front corners on the door plane, counterclockwise seen from the front, then the same ones at the back.
  const front = [d.hinge.clone(), d.hinge.clone().add(d.width), d.hinge.clone().add(d.width).add(up), d.hinge.clone().add(up)];
  const corners = [...front, ...front.map((p) => p.clone().add(back))];
  const quads = [
    [4, 5, 6, 7], // back
    [0, 1, 5, 4], // floor
    [3, 7, 6, 2], // lintel
    [0, 4, 7, 3], // hinge side
    [1, 2, 6, 5], // opening side
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(corners.flatMap((p) => p.toArray()), 3));
  geometry.setIndex(quads.flatMap(([a, b, c, e]) => [a, b, c, a, c, e]));
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0x1c1410, roughness: 1, side: DoubleSide }));
  mesh.name = "Doorway";
  return mesh;
}

export async function createStage(el: HTMLElement, src: string): Promise<Stage> {
  const gltf = await gltfLoader().loadAsync(src);
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
  pan.enabled = false;
  let camera: PerspectiveCamera | OrthographicCamera = persp;
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
  // Colored like the markers: left blue, right orange, center green.
  const previewLines = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
  );
  const previewJoints = new Points(
    new BufferGeometry(),
    new PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }),
  );
  const sideColor = (name: string) => new Color(/L$/.test(name) ? 0x0071e3 : /R$/.test(name) ? 0xff9500 : 0x34c759).toArray();
  previewLines.renderOrder = previewJoints.renderOrder = 998;
  let arrow: ArrowHelper | null = null;
  scene.add(previewLines, previewJoints);

  // ---- rigged model ----
  let rig: { group: Scene; bones: Bone[]; rest: { p: Vector3; q: Quaternion; s: Vector3 }[]; helper: SkeletonHelper } | null =
    null;
  let mixer: AnimationMixer | null = null;
  let showBones = false;
  // ---- hitboxes: capsules parented to their bones; red while the playing attack hits with them ----
  const hitIdle = new MeshBasicMaterial({ color: 0xff9500, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
  const hitActive = new MeshBasicMaterial({ color: 0xff3b30, wireframe: true, transparent: true, opacity: 0.9, depthTest: false });
  let capsules: Mesh[] = [];
  let playing: { action: AnimationAction; attack?: Attack } | null = null;
  const clearHitboxes = () => {
    capsules.forEach((c) => {
      c.removeFromParent();
      c.geometry.dispose();
    });
    capsules = [];
  };
  const clearRig = () => {
    if (!rig) return;
    clearHitboxes();
    playing = null;
    mixer?.stopAllAction();
    mixer = null;
    scene.remove(rig.group, rig.helper);
    rig.group.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).geometry.dispose();
      if (o.name === "Doorway") {
        (o as Mesh).geometry.dispose();
        ((o as Mesh).material as Material).dispose();
      }
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
    if (capsules.length) {
      const a = playing?.attack;
      const t = playing?.action.time ?? 0;
      const on = !!a && t >= a.active[0] && t <= a.active[1];
      for (const c of capsules) c.material = on && a!.bones.includes(c.name) ? hitActive : hitIdle;
    }
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
      camera = ortho;
      orbit.enabled = false;
      pan.enabled = true;
      if (!axis) return;
      const top = Math.abs(axis.y) > 0.9;
      // Straight down, nudged toward +z so the camera keeps +Y up (screen up = -z) and can orbit from there.
      const viewAxis = top ? new Vector3(0, 1, 1e-3).normalize() : axis.clone().normalize();
      const up = top ? new Vector3(0, 0, -1) : UP.clone();
      const right = up.clone().cross(top ? UP : viewAxis).normalize();
      viewExtent = {
        w: Math.abs(size.x * right.x) + Math.abs(size.y * right.y) + Math.abs(size.z * right.z),
        h: Math.abs(size.x * up.x) + Math.abs(size.y * up.y) + Math.abs(size.z * up.z),
      };
      ortho.position.copy(center).addScaledVector(viewAxis, radius * 4);
      ortho.zoom = 1;
      pan.target.copy(center);
      ortho.lookAt(center);
      fitOrtho();
      pan.update();
      grid.visible = !top;
    },
    viewAxis() {
      return camera.getWorldDirection(new Vector3()).negate();
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
      const segColor: number[] = [];
      const joints: number[] = [];
      const jointColor: number[] = [];
      for (const b of plan.bones) {
        if (!b.deform) continue;
        const c = sideColor(b.name);
        seg.push(...b.head.toArray(), ...b.tail.toArray());
        segColor.push(...c, ...c);
        joints.push(...b.head.toArray());
        jointColor.push(...c);
      }
      previewLines.geometry.setAttribute("position", new Float32BufferAttribute(seg, 3));
      previewLines.geometry.setAttribute("color", new Float32BufferAttribute(segColor, 3));
      previewJoints.geometry.setAttribute("position", new Float32BufferAttribute(joints, 3));
      previewJoints.geometry.setAttribute("color", new Float32BufferAttribute(jointColor, 3));
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
      const axis = stage.viewAxis();
      const v = new Vector3((x / el.clientWidth) * 2 - 1, 1 - (y / el.clientHeight) * 2, 0).unproject(camera);
      return v.addScaledVector(axis, depthOf.clone().sub(v).dot(axis));
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
      const doors = plan.skin.mode === "rigid" ? (plan.skin.doors ?? []) : [];
      meshes.forEach((mesh, k) => {
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const map = model.maps[k];
        // Rigid skins weigh every vertex fully to one bone: its first influence.
        const parts = doors.length ? splitParts(geometry, (i) => skin.index[map[i] * 4]) : null;
        const n = parts?.length ?? map.length;
        const index = new Uint16Array(n * 4);
        const weight = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          if (parts) {
            index[i * 4] = parts[i];
            weight[i * 4] = 1;
            continue;
          }
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
      const rigid = plan.skin;
      if (rigid.mode === "rigid") {
        const body = plan.bones.findIndex((b) => b.name === rigid.body);
        for (const d of doors) {
          const recess = doorway(d);
          // Bones have no rest rotation: the body bone's frame is the world frame moved to its head.
          recess.position.copy(plan.bones[body].head).negate();
          bones[body].add(recess);
        }
      }
      showRig(group, bones, plan.frame);
    },
    async applyAutoRig(glb, plan) {
      const loaded = (await gltfLoader().parseAsync(glb, "")).scene;
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
    play(clip, attack) {
      if (!mixer) return;
      mixer.stopAllAction();
      restPose();
      playing = clip ? { action: mixer.clipAction(clip).reset().play(), attack } : null;
    },
    setHitboxes(boxes) {
      clearHitboxes();
      if (!rig || !boxes) return;
      for (const h of boxes) {
        const bone = rig.bones.find((b) => b.name === h.bone);
        if (!bone) continue;
        // CapsuleGeometry runs along +Y, centered: turn it onto the bone and slide it out half its length.
        const axis = new Vector3(...h.axis);
        const c = new Mesh(new CapsuleGeometry(h.radius, Math.max(h.length - 2 * h.radius, 0), 4, 12), hitIdle);
        c.name = h.bone;
        c.quaternion.setFromUnitVectors(UP, axis);
        c.position.copy(axis).multiplyScalar(h.start + h.length / 2);
        c.renderOrder = 997;
        bone.add(c);
        capsules.push(c);
      }
    },
    setShowBones(on) {
      showBones = on;
      if (rig) rig.helper.visible = on;
    },
    async exportGlb(clips, extras = {}) {
      if (!rig) throw new Error("Not rigged");
      mixer?.stopAllAction();
      restPose();
      rig.group.updateMatrixWorld(true);
      const skinned = rig.group.children.filter((o): o is SkinnedMesh => (o as SkinnedMesh).isSkinnedMesh);
      skinned.forEach((m, k) => (m.material = materials[k]));
      rig.group.userData = extras;
      // Hitbox capsules are only a preview: hidden objects are left out of the file.
      capsules.forEach((c) => (c.visible = false));
      try {
        return (await new GLTFExporter().parseAsync(rig.group, { binary: true, animations: clips })) as ArrayBuffer;
      } finally {
        rig.group.userData = {};
        capsules.forEach((c) => (c.visible = true));
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
      [xray, clay, hitIdle, hitActive, previewLines.material, previewJoints.material].forEach((m) => (m as Material).dispose());
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
