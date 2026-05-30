// Web Worker that runs model parsing off the main thread, removing the UI
// freeze big files used to cause. It handles all three previewable formats and
// ships geometry back as transferable typed-array buffers (zero-copy); the main
// thread wraps them in THREE objects via assembleMeshes().
//
//  - 3MF: the THREE-free core parser (parse3mfCore). Returns { supported:false }
//    for feature paths it doesn't fast-path (textures/implicit), so the caller
//    falls back to the main-thread ThreeMFLoader.
//  - STL/OBJ: the stock THREE loaders (DOM-free, so worker-safe). We run them
//    here and extract plain arrays — THREE objects can't cross the boundary.

import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { parse3mf, type Parse3mfResult, type MeshBuffers } from "./parse3mfCore";

interface RequestMsg {
  id: number;
  ext: string;
  buffer: ArrayBuffer;
}

type ResponseMsg =
  | { id: number; ok: true; result: Parse3mfResult }
  | { id: number; ok: false; error: string };

/**
 * Extract a standalone (transferable) MeshBuffers from a THREE geometry. We copy
 * each attribute into a fresh typed array so its backing buffer can transfer
 * without detaching anything THREE still references.
 */
function geometryToBuffers(geo: THREE.BufferGeometry, forceNormals: boolean): MeshBuffers {
  if (forceNormals || !geo.getAttribute("normal")) geo.computeVertexNormals();
  const positions = new Float32Array(geo.getAttribute("position").array as ArrayLike<number>);
  const normals = new Float32Array(geo.getAttribute("normal").array as ArrayLike<number>);
  let index: Uint32Array | null = null;
  if (geo.index) index = new Uint32Array(geo.index.array as ArrayLike<number>);
  return { kind: "default", positions, normals, colors: null, index };
}

function parseStl(buffer: ArrayBuffer): Parse3mfResult {
  // STL ships per-face normals; recompute smooth vertex normals to match the
  // main-thread path (loadModel.parseModel does the same).
  const geo = new STLLoader().parse(buffer);
  return { supported: true, meshes: [geometryToBuffers(geo, true)] };
}

function parseObj(buffer: ArrayBuffer): Parse3mfResult {
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const group = new OBJLoader().parse(text);
  const meshes: MeshBuffers[] = [];
  group.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      meshes.push(geometryToBuffers((c as THREE.Mesh).geometry as THREE.BufferGeometry, false));
    }
  });
  return { supported: true, meshes };
}

/** Collect every backing ArrayBuffer in the result so it transfers zero-copy. */
function collectTransfers(result: Parse3mfResult): Transferable[] {
  const transfers: Transferable[] = [];
  for (const m of result.meshes) {
    transfers.push(m.positions.buffer, m.normals.buffer);
    if (m.colors) transfers.push(m.colors.buffer);
    if (m.index) transfers.push(m.index.buffer);
  }
  return transfers;
}

self.onmessage = (e: MessageEvent<RequestMsg>) => {
  const { id, ext, buffer } = e.data;
  try {
    let result: Parse3mfResult;
    if (ext === "3mf") result = parse3mf(buffer);
    else if (ext === "stl") result = parseStl(buffer);
    else if (ext === "obj") result = parseObj(buffer);
    else throw new Error(`worker: unsupported extension .${ext}`);

    const msg: ResponseMsg = { id, ok: true, result };
    (self as unknown as Worker).postMessage(msg, collectTransfers(result));
  } catch (err) {
    const msg: ResponseMsg = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(msg);
  }
};
