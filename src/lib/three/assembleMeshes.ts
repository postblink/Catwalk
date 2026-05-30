// Main-thread side of the worker-offloaded parse: turns the plain typed-array
// geometry a worker produced (3MF via parse3mfCore, STL/OBJ via the THREE
// loaders) back into a THREE.Group of meshes. This is the only step that
// touches THREE — it's cheap (a few BufferAttribute wraps, no parsing), so it
// stays on the main thread.

import * as THREE from "three";
import { makeMaterial } from "./loadModel";
import type { MeshBuffers } from "./parse3mfCore";

/**
 * Wrap worker-produced {@link MeshBuffers} in a THREE.Group. Painted meshes get
 * a vertex-colored standard material; plain meshes get the shared Dracula-purple
 * surface material so geometry-only models share one consistent look.
 *
 * The typed arrays were transferred from the worker (zero-copy), so this takes
 * ownership of them — do not reuse the buffers after calling.
 */
export function assembleMeshes(meshes: MeshBuffers[]): THREE.Group {
  const group = new THREE.Group();

  for (const m of meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));

    let material: THREE.Material;
    if (m.kind === "painted" && m.colors) {
      geo.setAttribute("color", new THREE.BufferAttribute(m.colors, 3));
      material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.1,
        roughness: 0.55,
        flatShading: false,
      });
    } else {
      if (m.index) geo.setIndex(new THREE.BufferAttribute(m.index, 1));
      material = makeMaterial();
    }

    group.add(new THREE.Mesh(geo, material));
  }

  return group;
}
