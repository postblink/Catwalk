import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import type { ModelRow } from "$lib/types";
import { parseModel, disposeObject } from "./loadModel";

/**
 * Offscreen thumbnail generator for STL/OBJ meshes, which (unlike 3MF) carry no
 * embedded preview. We render one frame with a shared WebGL renderer, hand the
 * PNG back to Rust to cache, and return an object URL for immediate display.
 *
 * Renders are serialized through a queue: one GL context, one heavy parse/upload
 * at a time, so opening a large library doesn't spike GPU memory.
 */

const SIZE = 384;

/** Skip auto-rendering meshes larger than this — too slow/heavy for a grid tile. */
const MAX_RENDER_BYTES = 96 * 1024 * 1024;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function ensureRenderer(): {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
} {
  if (renderer && scene && camera) return { renderer, scene, camera };

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true, // transparent background so it sits on the grid surface
    preserveDrawingBuffer: true, // required to read pixels back via toBlob
  });
  renderer.setSize(SIZE, SIZE, false);

  scene = new THREE.Scene();
  // Lighting mirrors ViewerScene so thumbnails match the live preview.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xbd93f9, 0x282a36, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(1, 1.5, 0.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-1, 0.5, -1);
  scene.add(fill);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);

  return { renderer, scene, camera };
}

function renderToBlob(object: THREE.Object3D, radius: number): Promise<Blob> {
  const { renderer, scene, camera } = ensureRenderer();

  const dist = Math.max(radius * 2.6, 1);
  camera.position.set(dist, dist * 0.8, dist);
  camera.lookAt(0, 0, 0);
  camera.near = dist * 0.01;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();

  scene.add(object);
  renderer.render(scene, camera);
  scene.remove(object);

  return new Promise((resolve, reject) => {
    renderer.domElement.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/png",
    );
  });
}

// --- Serial queue --------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  // Keep the chain alive regardless of individual task failures.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function blobToBytes(blob: Blob): Promise<number[]> {
  const buf = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buf));
}

/**
 * Render and persist a thumbnail for an STL/OBJ model. Returns an object URL the
 * caller owns (and must revoke), or `null` if the model is too large or not a
 * renderable mesh. Persistence failures are swallowed — the URL is still shown.
 */
export function generateThumbnail(model: ModelRow): Promise<string | null> {
  if (model.extension !== "stl" && model.extension !== "obj") {
    return Promise.resolve(null);
  }
  if (model.size_bytes > MAX_RENDER_BYTES) {
    return Promise.resolve(null);
  }

  return enqueue(async () => {
    let object: THREE.Object3D | null = null;
    try {
      const buffer = await invoke<ArrayBuffer>("read_model_file", {
        modelId: model.id,
      });
      const loaded = parseModel(buffer, model.extension);
      object = loaded.object;
      const blob = await renderToBlob(object, loaded.radius);

      // Persist to the cache (best-effort) so future loads skip rendering.
      blobToBytes(blob)
        .then((png) => invoke("save_thumbnail", { modelId: model.id, png }))
        .catch(() => {});

      return URL.createObjectURL(blob);
    } catch {
      return null;
    } finally {
      if (object) disposeObject(object);
    }
  });
}
