import { invoke } from "@tauri-apps/api/core";
import type * as THREE from "three";
import { parseModel, finalizeObject, disposeObject } from "./loadModel";
import { assembleMeshes } from "./assembleMeshes";
import type { Parse3mfResult } from "./parse3mfCore";
import { readCachedDecode, saveCachedDecode, hasCachedDecode } from "./decodeCache";

/**
 * Async preview loader sitting between the viewer and the parser.
 *
 * Goals:
 *  - Keep clicking a model from feeling dead: parsing runs in a Web Worker so
 *    the main thread (and the viewer's spinner) stays responsive.
 *  - Make revisiting a model instant via a small LRU cache of parsed objects.
 *  - Let callers prefetch on selection so the parse overlaps the metadata fetch.
 *
 * All three formats (STL/OBJ via the stock THREE loaders, 3MF via the THREE-free
 * parse3mfCore) parse in the worker, which returns plain typed-array geometry;
 * the main thread only wraps it in THREE objects (assembleMeshes). A 3MF that
 * uses a feature path the worker doesn't fast-path (textures/implicit) returns
 * { supported:false } and falls back to the full main-thread ThreeMFLoader, so
 * nothing regresses. Any worker failure also falls back to the main thread.
 */

export type Preview = {
  /** Parsed, centered, upright pivot object. Owned by the cache — do NOT dispose. */
  object: THREE.Object3D;
  radius: number;
};

/** How many parsed previews to keep resident. Each holds GPU geometry buffers. */
const CACHE_MAX = 6;

// Insertion order doubles as LRU recency: a cache hit re-inserts to the end, so
// the least-recently-used entry is always at the front for eviction.
const cache = new Map<string, Preview>();
const inflight = new Map<string, Promise<Preview>>();

function touch(id: string): Preview | undefined {
  const entry = cache.get(id);
  if (entry) {
    cache.delete(id);
    cache.set(id, entry); // move to most-recently-used
  }
  return entry;
}

function store(id: string, entry: Preview): void {
  cache.set(id, entry);
  // Evict oldest until within budget. The freshly stored (and any visible)
  // entry is most-recent, so eviction never targets what's on screen.
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) disposeObject(evicted.object);
  }
}

// --- parse worker -----------------------------------------------------------
// A single shared module worker parses every previewable format. Requests are
// keyed by a monotonic id so concurrent loads don't cross wires. We deliberately
// do NOT transfer the input buffer (structured-clone copies it) so the main
// thread keeps its own copy for the fallback path.

const WORKER_EXTS = new Set(["stl", "obj", "3mf"]);

type WorkerResponse =
  | { id: number; ok: true; result: Parse3mfResult }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<
  number,
  { resolve: (r: Parse3mfResult) => void; reject: (e: unknown) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./parseModel.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const req = pending.get(msg.id);
      if (!req) return;
      pending.delete(msg.id);
      if (msg.ok) req.resolve(msg.result);
      else req.reject(new Error(msg.error));
    };
    worker.onerror = (e) => {
      // A worker-level failure (a crash/uncaught error — normal parse failures
      // are caught inside the worker and returned as { ok: false }) rejects
      // every outstanding request so callers fall back to the main thread
      // rather than hang forever. The instance is now suspect, so tear it down;
      // the next request spawns a fresh worker via getWorker().
      const err = new Error(e.message || "parse worker error");
      for (const req of pending.values()) req.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function parseInWorker(ext: string, buffer: ArrayBuffer): Promise<Parse3mfResult> {
  const w = getWorker();
  const id = nextReqId++;
  return new Promise<Parse3mfResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ext, buffer });
  });
}

/** Wrap worker/cache mesh buffers in a centered, upright THREE pivot. Cheap. */
function buildFromMeshes(meshes: Parse3mfResult["meshes"], ext: string): Preview {
  return finalizeObject(assembleMeshes(meshes), ext);
}

async function doLoad(id: string, ext: string): Promise<Preview> {
  // L2 disk cache: a hit skips both the file read and the parse — we only do the
  // cheap assemble/center step. (The cheap step re-runs each load rather than
  // baking a transform into the cache, keeping the artifact format-correct.)
  if (WORKER_EXTS.has(ext)) {
    const cached = await readCachedDecode(id);
    if (cached) return buildFromMeshes(cached, ext);
  }

  // Raw bytes come back as an ArrayBuffer (the command returns a tauri Response).
  const buffer = await invoke<ArrayBuffer>("read_model_file", { modelId: id });

  if (WORKER_EXTS.has(ext)) {
    try {
      const result = await parseInWorker(ext, buffer);
      if (result.supported) {
        // Persist for next time (best-effort) before we hand ownership of the
        // buffers to THREE — serialization only reads them, so order is safe.
        saveCachedDecode(id, result.meshes);
        // Worker did the heavy parse off-thread; we only wrap typed arrays.
        return buildFromMeshes(result.meshes, ext);
      }
      // 3MF feature path the worker can't fast-path — fall through to the full
      // main-thread loader below, which understands it.
    } catch (e) {
      console.warn(`[previewLoader] ${ext} worker failed, using main thread`, e);
    }
  }

  // Main-thread parse (only on worker miss/fallback, or an unknown extension).
  // Yield a macrotask so a caller that flipped its loading flag can paint the
  // spinner before this synchronous parse seizes the main thread.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return parseModel(buffer, ext);
}

// --- Background warming ------------------------------------------------------
// Timestamp of the last user-initiated load, so the warmer can yield to active
// browsing (see warmer.ts). loadPreview updates it on every call.

let lastUserLoadAt = 0;

/** Milliseconds since the last user-initiated preview load. */
export function msSinceUserLoad(): number {
  return Date.now() - lastUserLoadAt;
}

/**
 * Decode a model purely to populate the disk cache (no LRU, no THREE objects).
 * Returns true if a cache entry now exists (already cached, or freshly written).
 * Used by the background warmer; reuses the same shared parse worker.
 */
export async function decodeForCache(id: string, ext: string): Promise<boolean> {
  if (!WORKER_EXTS.has(ext)) return false;
  if (await hasCachedDecode(id)) return true;

  let buffer: ArrayBuffer;
  try {
    buffer = await invoke<ArrayBuffer>("read_model_file", { modelId: id });
  } catch {
    return false;
  }

  try {
    const result = await parseInWorker(ext, buffer);
    if (result.supported) {
      saveCachedDecode(id, result.meshes);
      return true;
    }
    // Unsupported feature path (textures/implicit): leave it for the main-thread
    // fallback at view time — we deliberately don't cache those.
    return false;
  } catch {
    return false;
  }
}

/** Load (or return a cached) parsed preview for a model. */
export function loadPreview(id: string, ext: string): Promise<Preview> {
  lastUserLoadAt = Date.now(); // tell the warmer to yield to active browsing
  const cached = touch(id);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(id);
  if (existing) return existing;

  const p = doLoad(id, ext)
    .then((entry) => {
      inflight.delete(id);
      store(id, entry);
      return entry;
    })
    .catch((e) => {
      inflight.delete(id);
      throw e;
    });

  inflight.set(id, p);
  return p;
}

/**
 * Warm the cache for a model without awaiting it. Safe to call repeatedly; a
 * no-op when already cached or in flight. Errors are swallowed — the real load
 * (and its error surfacing) happens when the viewer mounts.
 */
export function prefetchPreview(id: string, ext: string): void {
  if (cache.has(id) || inflight.has(id)) return;
  loadPreview(id, ext).catch(() => {});
}
