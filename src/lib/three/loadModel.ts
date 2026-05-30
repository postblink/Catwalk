import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ThreeMFLoader } from "./ThreeMFLoader.js";

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
 * Override the 3MFLoader's plain white default material with our surface
 * material, while leaving real per-object colors/textures (e.g. multi-color
 * Bambu prints) untouched — so geometry-only 3MF matches the STL/OBJ look but
 * colored prints keep their colors.
 */
function normalize3mfMeshes(root: THREE.Object3D): void {
  root.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return;

    // The 3MF loader only emits a position attribute — no normals. Our smooth
    // surface material (and any non-flat material) needs them, or lighting
    // resolves to solid black. Compute them once, matching the STL path.
    const geo = c.geometry as THREE.BufferGeometry;
    if (geo && !geo.getAttribute("normal")) geo.computeVertexNormals();

    const mat = c.material;
    if (Array.isArray(mat)) return; // multi-material: assume intentional
    const isLoaderDefault =
      mat instanceof THREE.MeshPhongMaterial &&
      !mat.map &&
      !mat.vertexColors &&
      mat.color.getHex() === 0xffffff;
    if (isLoaderDefault) c.material = makeMaterial();
  });
}

/**
 * Wrap a parsed Object3D in a pivot, reorient Z-up→Y-up for STL/3MF, and
 * recenter it on its bounding-sphere center. Shared by the synchronous
 * {@link parseModel} path and the worker-assembled 3MF path so framing and
 * orientation stay identical regardless of where the geometry was built.
 */
export function finalizeObject(parsed: THREE.Object3D, ext: string): LoadedModel {
  // Wrap in a pivot so we can reorient + recenter cleanly.
  const pivot = new THREE.Group();
  pivot.add(parsed);
  // STL and 3MF are authored Z-up for printing; convert to three.js Y-up so
  // models stand upright. (OBJ is already Y-up.)
  if (ext === "stl" || ext === "3mf") pivot.rotation.x = -Math.PI / 2;
  pivot.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(pivot);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // Shift so the bounding sphere center sits at the origin.
  pivot.position.sub(sphere.center);
  pivot.updateMatrixWorld(true);

  return { object: pivot, radius: sphere.radius || 1 };
}

/**
 * Parse STL/OBJ/3MF bytes into a centered, upright Object3D plus its framing
 * radius. Shared by the interactive viewer and the offscreen thumbnailer so the
 * camera framing and Z-up→Y-up correction stay identical.
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
  } else if (ext === "3mf") {
    // parse() unzips the container (via fflate) and returns a Group of meshes
    // with the build-item transforms already applied.
    parsed = new ThreeMFLoader().parse(buffer);
    normalize3mfMeshes(parsed);
  } else {
    throw new Error(`Preview not supported for .${ext}`);
  }

  return finalizeObject(parsed, ext);
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
