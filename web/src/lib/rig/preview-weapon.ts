import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import type { Weapon } from "./rig";

/**
 * Viewer-only weapons held in a rigged character's hand, to check a clip's pose and reach. Nothing is saved.
 *
 * Weapon space: the grip at the origin, the weapon along +Y (blade, shaft, barrel) about one unit long, its flat
 * side along X and its top along +Z. At rest +Y points where the model faces and +Z points up.
 */
export type Side = "Left" | "Right";
export type PreviewKind = Exclude<Weapon, "none">;
/** `size` scales the default length; `tilt` (about the weapon's X) and `twist` (about its length) are degrees;
 * `grip` slides the weapon through the hand, in weapon lengths. */
export type WeaponPose = { size: number; tilt: number; twist: number; grip: number };
export const DEFAULT_POSE: WeaponPose = { size: 1, tilt: 0, twist: 0, grip: 0 };

/** Default length (fraction of the model's height) of each mock weapon; uploaded ones get the sword's. */
export const WEAPON_LENGTH: Record<PreviewKind, number> = {
  sword: 0.5,
  axe: 0.45,
  hammer: 0.45,
  spear: 1,
  shield: 0.35,
  bow: 0.7,
  crossbow: 0.4,
  pistol: 0.18,
  rifle: 0.6,
};

/** Where a weapon hangs in `side`'s hand: the rig's weapon socket (palm), else the hand bone. */
export function findHandAnchor(root: Object3D, side: Side): Object3D | null {
  const socket = root.getObjectByName(`WeaponSocket${side}`);
  if (socket) return socket;
  const s = side[0];
  const patterns = [
    new RegExp(`^(DEF-)?${side}Hand$`, "i"),
    new RegExp(`(^|[^a-z])${side}[_.\\s-]?hand|hand[_.\\s-]?${s}($|[^a-z])|^${s}[_.\\s-]hand`, "i"),
  ];
  for (const re of patterns) {
    let found: Object3D | null = null;
    root.traverse((o) => {
      if (!found && (o as { isBone?: boolean }).isBone && re.test(o.name)) found = o;
    });
    if (found) return found;
  }
  return null;
}

/**
 * Local matrix, under `anchor`, of a weapon holder: `anchorRest` is the anchor's matrix in the model's space at rest,
 * `forward` the model's facing in that space, `length` the weapon's length in model units.
 */
export function holderMatrix(anchorRest: Matrix4, forward: Vector3, length: number, pose: WeaponPose) {
  const f = forward.clone().setY(0).normalize();
  const up = new Vector3(0, 1, 0);
  const basis = new Matrix4().makeBasis(new Vector3().crossVectors(f, up), f, up);
  const origin = new Vector3().setFromMatrixPosition(anchorRest);
  const rad = Math.PI / 180;
  const inModel = new Matrix4()
    .makeTranslation(origin.x, origin.y, origin.z)
    .multiply(basis)
    .multiply(new Matrix4().makeRotationX(pose.tilt * rad))
    .multiply(new Matrix4().makeRotationY(pose.twist * rad))
    .multiply(new Matrix4().makeScale(length * pose.size, length * pose.size, length * pose.size))
    .multiply(new Matrix4().makeTranslation(0, -pose.grip, 0));
  return anchorRest.clone().invert().multiply(inModel);
}

const steel = () => new MeshStandardMaterial({ color: 0xc3c8d0, metalness: 0.85, roughness: 0.3 });
const wood = () => new MeshStandardMaterial({ color: 0x7a4e2d, metalness: 0, roughness: 0.75 });
const dark = () => new MeshStandardMaterial({ color: 0x2d2f36, metalness: 0.5, roughness: 0.45 });
const cord = () => new MeshStandardMaterial({ color: 0xe8e0c8, metalness: 0, roughness: 0.9 });

function part(g: Group, geometry: BufferGeometry, material: Material, [x, y, z]: number[], rotX = 0, rotZ = 0) {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rotX, 0, rotZ);
  m.castShadow = true;
  g.add(m);
  return m;
}
/** Shaft along Y from `from` to `to`. */
const shaft = (g: Group, r: number, from: number, to: number, mat: Material) =>
  part(g, new CylinderGeometry(r, r, to - from, 10), mat, [0, (from + to) / 2, 0]);
/** Flat four-sided point along +Y (a blade's or spearhead's tip). */
const point = (g: Group, r: number, h: number, y: number, mat: Material) => {
  const m = part(g, new ConeGeometry(r, h, 4), mat, [0, y + h / 2, 0]);
  m.rotation.y = Math.PI / 4;
  m.scale.set(1, 1, 0.25);
  return m;
};
const curve = (pts: [number, number, number][], r: number) =>
  new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p))), 24, r, 6);

/** Mock weapon in weapon space, about one unit long. */
export function buildMockWeapon(kind: PreviewKind): Group {
  const g = new Group();
  g.name = `PreviewWeapon_${kind}`;
  switch (kind) {
    case "sword": {
      const s = steel();
      part(g, new SphereGeometry(0.03, 10, 8), s, [0, -0.13, 0]);
      shaft(g, 0.02, -0.12, 0.06, wood());
      part(g, new BoxGeometry(0.22, 0.03, 0.05), s, [0, 0.075, 0]);
      part(g, new BoxGeometry(0.07, 0.72, 0.012), s, [0, 0.45, 0]);
      point(g, 0.05, 0.1, 0.81, s);
      break;
    }
    case "axe": {
      shaft(g, 0.022, -0.15, 0.85, wood());
      part(g, new BoxGeometry(0.2, 0.22, 0.02), steel(), [0.11, 0.72, 0]);
      break;
    }
    case "hammer": {
      shaft(g, 0.025, -0.15, 0.72, wood());
      part(g, new BoxGeometry(0.34, 0.17, 0.17), dark(), [0, 0.78, 0]);
      break;
    }
    case "spear": {
      shaft(g, 0.013, -0.4, 0.5, wood());
      point(g, 0.04, 0.14, 0.5, steel());
      break;
    }
    case "shield": {
      // Face toward +Y (forward), strapped to the forearm behind it.
      part(g, new CylinderGeometry(0.5, 0.5, 0.04, 32), wood(), [0, 0.06, 0]);
      part(g, new CylinderGeometry(0.51, 0.51, 0.03, 32, 1, true), steel(), [0, 0.06, 0]);
      const boss = part(g, new SphereGeometry(0.1, 16, 10), steel(), [0, 0.08, 0]);
      boss.scale.set(1, 0.6, 1);
      break;
    }
    case "bow": {
      // Upright (limbs along Z), bellied forward, the string at the hand.
      const tips: [number, number, number][] = [[0, 0.05, -0.5], [0, 0.2, -0.25], [0, 0.26, 0], [0, 0.2, 0.25], [0, 0.05, 0.5]];
      part(g, curve(tips.map(([x, y, z]) => [x, y - 0.2, z]), 0.016), wood(), [0, 0, 0]);
      part(g, new CylinderGeometry(0.004, 0.004, 1, 4), cord(), [0, -0.15, 0], Math.PI / 2);
      break;
    }
    case "crossbow": {
      part(g, new BoxGeometry(0.05, 0.75, 0.06), wood(), [0, 0.12, 0.04]);
      part(g, new BoxGeometry(0.035, 0.12, 0.2), wood(), [0, -0.02, -0.07], -0.3);
      part(g, curve([[-0.32, 0.36, 0.06], [-0.16, 0.44, 0.06], [0, 0.47, 0.06], [0.16, 0.44, 0.06], [0.32, 0.36, 0.06]], 0.014), dark(), [0, 0, 0]);
      part(g, new CylinderGeometry(0.004, 0.004, 0.64, 4), cord(), [0, 0.36, 0.06], 0, Math.PI / 2);
      break;
    }
    case "pistol": {
      part(g, new BoxGeometry(0.1, 0.75, 0.16), dark(), [0, 0.28, 0.16]);
      part(g, new BoxGeometry(0.09, 0.16, 0.42), dark(), [0, -0.02, -0.06], -0.3);
      break;
    }
    case "rifle": {
      part(g, new BoxGeometry(0.06, 0.32, 0.14), wood(), [0, -0.2, -0.02]);
      part(g, new BoxGeometry(0.06, 0.45, 0.09), dark(), [0, 0.2, 0.03]);
      part(g, new BoxGeometry(0.045, 0.08, 0.14), dark(), [0, 0.02, -0.08], -0.2);
      part(g, new BoxGeometry(0.04, 0.07, 0.1), dark(), [0, 0.22, -0.07]);
      part(g, new CylinderGeometry(0.014, 0.014, 0.25, 8), dark(), [0, 0.54, 0.05]);
      break;
    }
  }
  return g;
}

/**
 * An uploaded weapon model turned into weapon space: its longest side along +Y, its thinnest along Z, one unit long,
 * gripped 15% of the way up (the user slides the grip and tilts it 180° when the other end is the handle).
 */
export function normalizeWeapon(scene: Object3D): Group {
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const order = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  // Rows of the rotation: the model's axis that becomes weapon X, Y, Z.
  const [y, x, z] = order.map((i) => axes[i].clone());
  if (new Vector3().crossVectors(x, y).dot(z) < 0) z.negate();
  const rotate = new Matrix4().makeBasis(x, y, z).transpose();
  const len = Math.max(size.getComponent(order[0]), 1e-6);
  const inner = new Group();
  inner.add(scene);
  inner.position.copy(center).applyMatrix4(rotate).negate();
  inner.position.y += 0.35 * len;
  inner.quaternion.setFromRotationMatrix(rotate);
  const outer = new Group();
  outer.name = "PreviewWeapon_upload";
  outer.scale.setScalar(1 / len);
  outer.add(inner);
  outer.traverse((o) => {
    if ((o as Mesh).isMesh) o.castShadow = true;
  });
  return outer;
}

/** Frees a weapon's geometries and materials (mock or uploaded). */
export function disposeWeapon(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat)) if ((v as { isTexture?: boolean })?.isTexture) (v as { dispose(): void }).dispose();
      mat.dispose();
    }
  });
}
