"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const PX = 224; // 2× the displayed 112px, for retina
/** Real meshes cover a whole object; the preview blob gets a proportional slice so density stays legible. */
const FACES_PER_PREVIEW_FACE = 50;

/** A lumpy blob whose triangle count tracks `faceCount`, lit and wireframed so density and faceting read at a glance. */
export default function MeshPreview({
  faceCount,
  flat,
}: {
  faceCount: number;
  flat: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({
      canvas: el,
      antialias: true,
      alpha: true,
    });
    renderer.setSize(PX, PX, false);

    // Icosphere faces = 20·(detail+1)².
    const detail = Math.max(
      0,
      Math.round(Math.sqrt(faceCount / FACES_PER_PREVIEW_FACE / 20)) - 1,
    );
    let geometry: THREE.BufferGeometry = new THREE.IcosahedronGeometry(
      1,
      detail,
    );
    const pos = geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const r =
        1 +
        0.12 *
          Math.sin(3 * v.x + 1) *
          Math.sin(3 * v.y) *
          Math.sin(3 * v.z + 2) +
        0.05 * Math.sin(7 * v.y);
      v.multiplyScalar(r);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    if (!flat) geometry = mergeVertices(geometry);
    geometry.computeVertexNormals();

    const scene = new THREE.Scene();
    const solid = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0xd9dde4,
        roughness: 0.6,
        flatShading: flat,
        polygonOffset: true,
        polygonOffsetFactor: 1,
      }),
    );
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: 0x3b82f6,
        transparent: true,
        opacity: 0.35,
      }),
    );
    const group = new THREE.Group().add(solid, wire);
    group.rotation.set(0.35, -0.5, 0);
    scene.add(group, new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(2, 3, 4);
    scene.add(key);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 0, 4.6);
    renderer.render(scene, camera);

    return () => {
      geometry.dispose();
      wire.geometry.dispose();
      solid.material.dispose();
      wire.material.dispose();
      renderer.dispose();
    };
  }, [faceCount, flat]);
  return (
    <canvas
      ref={canvas}
      className="size-28 shrink-0 rounded-xl bg-stage"
      aria-hidden
    />
  );
}
