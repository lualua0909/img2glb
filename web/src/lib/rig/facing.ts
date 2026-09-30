import { Vector3, type Object3D } from "three";

/**
 * Horizontal unit vector the model faces, in the root's space. Models are not generated facing a fixed axis
 * (an animal photographed side-on comes out facing ±X), so movement must turn the model by its own forward.
 * Order: `forward` written into the scene extras by the rig editor, then the skeleton (Head ahead of Hips/Tail),
 * then +Z.
 */
export function modelForward(root: Object3D): Vector3 {
  const stored = root.userData.forward;
  if (Array.isArray(stored) && stored.length === 3) {
    const f = new Vector3().fromArray(stored as number[]).setY(0);
    if (f.lengthSq() > 1e-8) return f.normalize();
  }
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const bone = (re: RegExp) => {
    let found: Object3D | undefined;
    root.traverse((o) => {
      if (!found && (o as { isBone?: boolean }).isBone && re.test(o.name)) found = o;
    });
    return found && found.getWorldPosition(new Vector3()).applyMatrix4(inverse);
  };
  const head = bone(/^(DEF-)?Head$/i) ?? bone(/head/i);
  const back = bone(/^(DEF-)?Tail1$/i) ?? bone(/^(DEF-)?Hips$/i) ?? bone(/^(DEF-)?Root$/i);
  if (head && back) {
    const d = head.sub(back);
    const f = d.clone().setY(0);
    // Upright bodies (humanoids) have the head straight above the hips: that offset says nothing about facing.
    if (f.lengthSq() > 0.25 * d.lengthSq() && f.lengthSq() > 1e-8) return f.normalize();
  }
  return new Vector3(0, 0, 1);
}
