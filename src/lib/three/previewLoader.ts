import { invoke } from "@tauri-apps/api/core";
import type * as THREE from "three";
import { parseModel, finalizeObject, disposeObject } from "./loadModel";
import { assemble3mf } from "./assemble3mf";
import type { Parse3mfResult } from "./parse3mfCore";

/**
 * Async preview loader sitting between the viewer and the synchronous parser.
 *
 * Goals:
 *  - Keep clicking a model from feeling dead: we yield to the event loop before
 *    the parse so the viewer's spinner paints first.
 *  - Make revisiting a model instant via a small LRU cache of parsed objects.
 *  - Let callers prefetch on selection so the parse overlaps the metadata fetch.
 *
 * 3MF parsing (the worst offender — a 2-3s main-thread freeze on big painted
 * files) runs in a Web Worker via parse3mfCore.ts; the main thread only wraps
 * the returned typed-array geometry in THREE objects. Files using feature paths
 * the worker doesn't fast-path (textures/basematerials/colorgroups/implicit)
 * fall back to the full main-thread ThreeMFLoader, so nothing regresses. STL/OBJ
 * still parse on the main thread (cheap; could move to a worker later).
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

// --- 3MF parse worker -------------------------------------------------------
// A single shared module worker handles all 3MF parses. Requests are keyed by a
// monotonic id so concurrent loads don't cross wires. We deliberately do NOT
// transfer the input buffer (structured-clone copies it) so the main thread
// keeps its own copy for the fallback path.

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
    worker = new Worker(new URL("./parse3mf.worker.ts", import.meta.url), {
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
      const err = new Error(e.message || "3mf worker error");
      for (const req of pending.values()) req.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function parse3mfInWorker(buffer: ArrayBuffer): Promise<Parse3mfResult> {
  const w = getWorker();
  const id = nextReqId++;
  return new Promise<Parse3mfResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, buffer });
  });
}

async function doLoad(id: string, ext: string): Promise<Preview> {
  // Raw bytes come back as an ArrayBuffer (the command returns a tauri Response).
  const buffer = await invoke<ArrayBuffer>("read_model_file", { modelId: id });

  if (ext === "3mf") {
    try {
      const result = await parse3mfInWorker(buffer);
      if (result.supported) {
        // Worker did the heavy parse off-thread; we only wrap typed arrays.
        const group = assemble3mf(result.meshes);
        return finalizeObject(group, "3mf");
      }
      // Feature path the worker can't fast-path — fall through to the full
      // main-thread loader below, which understands it.
    } catch (e) {
      console.warn("[previewLoader] 3mf worker failed, using main thread", e);
    }
  }

  // Main-thread parse (STL/OBJ always; 3MF only on worker miss/fallback).
  // Yield a macrotask so a caller that flipped its loading flag can paint the
  // spinner before this synchronous parse seizes the main thread.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return parseModel(buffer, ext);
}

/** Load (or return a cached) parsed preview for a model. */
export function loadPreview(id: string, ext: string): Promise<Preview> {
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
