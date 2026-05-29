import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

/** The shared surface material for previewed meshes (Dracula purple). */
export function makeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xbd93f9,
    metalness: 0.1,
    roughness: 0.55,
    flatShading: false,
  });
}

export type LoadedModel = {
  /** A pivot Group, recentered so its bounding-sphere center sits at the origin. */
  object: THREE.Object3D;
  /** Bounding-sphere radius, for framing the camera. */
  radius: number;
};

/**
 * Parse STL/OBJ bytes into a centered, upright Object3D plus its framing radius.
 * Shared by the interactive viewer and the offscreen thumbnailer so the camera
 * framing and Z-up→Y-up correction stay identical.
 */
export function parseModel(buffer: ArrayBuffer, ext: string): LoadedModel {
  let parsed: THREE.Object3D;
  if (ext === "stl") {
    const geo = new STLLoader().parse(buffer);
    geo.computeVertexNormals();
    parsed = new THREE.Mesh(geo, makeMaterial());
  } else if (ext === "obj") {
    const text = new TextDecoder().decode(buffer);
    parsed = new OBJLoader().parse(text);
    parsed.traverse((c) => {
      if (c instanceof THREE.Mesh) c.material = makeMaterial();
    });
  } else {
    throw new Error(`Preview not supported for .${ext}`);
  }

  // Wrap in a pivot so we can reorient + recenter cleanly.
  const pivot = new THREE.Group();
  pivot.add(parsed);
  // STLs from slicers are Z-up; convert to three.js Y-up so models stand up.
  if (ext === "stl") pivot.rotation.x = -Math.PI / 2;
  pivot.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(pivot);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // Shift so the bounding sphere center sits at the origin.
  pivot.position.sub(sphere.center);
  pivot.updateMatrixWorld(true);

  return { object: pivot, radius: sphere.radius || 1 };
}

/** Recursively dispose all geometries/materials under an object. */
export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}
