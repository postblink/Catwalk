// Persisted decode cache: the on-disk L2 behind previewLoader's in-memory LRU.
//
// The worker parses a model into plain `MeshBuffers[]` (typed arrays). This
// module serializes that into a compact binary blob, hands it to Rust to store
// content-addressed by the model's byte hash, and reads it back on a later load
// so we skip both the file read and the parse. The artifact is the *world-space
// geometry*, not a finalized THREE object — the cheap centering/upright step
// (finalizeObject) re-runs on load, so it stays format-correct without baking a
// camera-relative transform into the cache.
//
// Blob format "CWD1" (little-endian):
//   [0..4)   magic 'C''W''D''1'
//   [4..8)   u32 meshCount
//   then meshCount descriptors, 20 bytes each:
//     u32 kind (0=default, 1=painted)
//     u32 positions length (float count)
//     u32 normals   length (float count)
//     u32 colors    length (float count; 0 = none)
//     u32 index     length (uint count;  0 = none)
//   then the data section: each mesh's positions, normals, [colors], [index]
//   back to back (Float32 / Uint32). Header is 4-byte aligned and every array
//   is 4-byte elements, but reads use ArrayBuffer.slice() (which copies to a
//   fresh 0-offset buffer) so alignment is never an issue.

import { invoke } from "@tauri-apps/api/core";
import type { MeshBuffers } from "./parse3mfCore";

const MAGIC = [0x43, 0x57, 0x44, 0x31] as const; // "CWD1"
const HEADER_FIXED = 8; // magic + meshCount
const DESC_BYTES = 20; // 5 * u32 per mesh

/** Don't persist absurdly large decodes (e.g. a heavily subdivided painted mesh). */
const MAX_DECODE_BYTES = 96 * 1024 * 1024;

/** Serialize parsed mesh buffers into a single CWD1 ArrayBuffer. */
export function serializeDecode(meshes: MeshBuffers[]): ArrayBuffer {
  const headerBytes = HEADER_FIXED + meshes.length * DESC_BYTES;
  let dataBytes = 0;
  for (const m of meshes) {
    dataBytes += m.positions.byteLength + m.normals.byteLength;
    if (m.colors) dataBytes += m.colors.byteLength;
    if (m.index) dataBytes += m.index.byteLength;
  }

  const buf = new ArrayBuffer(headerBytes + dataBytes);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  for (let i = 0; i < MAGIC.length; i++) dv.setUint8(i, MAGIC[i]);
  dv.setUint32(4, meshes.length, true);

  let h = HEADER_FIXED;
  let off = headerBytes;
  const copy = (arr: Float32Array | Uint32Array) => {
    u8.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), off);
    off += arr.byteLength;
  };

  for (const m of meshes) {
    dv.setUint32(h, m.kind === "painted" ? 1 : 0, true);
    dv.setUint32(h + 4, m.positions.length, true);
    dv.setUint32(h + 8, m.normals.length, true);
    dv.setUint32(h + 12, m.colors ? m.colors.length : 0, true);
    dv.setUint32(h + 16, m.index ? m.index.length : 0, true);
    h += DESC_BYTES;

    copy(m.positions);
    copy(m.normals);
    if (m.colors) copy(m.colors);
    if (m.index) copy(m.index);
  }

  return buf;
}

/** Parse a CWD1 ArrayBuffer back into mesh buffers. Throws on a malformed blob. */
export function deserializeDecode(buf: ArrayBuffer): MeshBuffers[] {
  const dv = new DataView(buf);
  if (buf.byteLength < HEADER_FIXED) throw new Error("decode blob too small");
  for (let i = 0; i < MAGIC.length; i++) {
    if (dv.getUint8(i) !== MAGIC[i]) throw new Error("bad decode magic");
  }

  const count = dv.getUint32(4, true);
  const descs: { kind: number; pos: number; norm: number; col: number; idx: number }[] = [];
  let h = HEADER_FIXED;
  for (let i = 0; i < count; i++) {
    descs.push({
      kind: dv.getUint32(h, true),
      pos: dv.getUint32(h + 4, true),
      norm: dv.getUint32(h + 8, true),
      col: dv.getUint32(h + 12, true),
      idx: dv.getUint32(h + 16, true),
    });
    h += DESC_BYTES;
  }

  let off = HEADER_FIXED + count * DESC_BYTES;
  const meshes: MeshBuffers[] = [];
  const takeF32 = (len: number) => {
    const a = new Float32Array(buf.slice(off, off + len * 4));
    off += len * 4;
    return a;
  };
  const takeU32 = (len: number) => {
    const a = new Uint32Array(buf.slice(off, off + len * 4));
    off += len * 4;
    return a;
  };

  for (const d of descs) {
    const positions = takeF32(d.pos);
    const normals = takeF32(d.norm);
    const colors = d.col > 0 ? takeF32(d.col) : null;
    const index = d.idx > 0 ? takeU32(d.idx) : null;
    meshes.push({ kind: d.kind === 1 ? "painted" : "default", positions, normals, colors, index });
  }

  return meshes;
}

// --- Rust IPC wrappers ------------------------------------------------------

/** Fetch a model's cached decode, or null on a miss (NotFound) / any error. */
export async function readCachedDecode(modelId: string): Promise<MeshBuffers[] | null> {
  try {
    const buf = await invoke<ArrayBuffer>("read_cached_decode", { modelId });
    return deserializeDecode(buf);
  } catch {
    return null; // miss or corrupt blob — caller falls back to a fresh parse
  }
}

/** Persist a decode (best-effort, fire-and-forget). Oversized blobs are skipped. */
export function saveCachedDecode(modelId: string, meshes: MeshBuffers[]): void {
  let blob: ArrayBuffer;
  try {
    blob = serializeDecode(meshes);
  } catch {
    return;
  }
  if (blob.byteLength > MAX_DECODE_BYTES) return;
  // Tauri v2 transfers a Uint8Array arg as raw bytes (no JSON number[] bloat).
  invoke("save_cached_decode", { modelId, data: new Uint8Array(blob) }).catch(() => {});
}

/** Cheap existence check (Rust stats the file) for the background warmer. */
export async function hasCachedDecode(modelId: string): Promise<boolean> {
  try {
    return await invoke<boolean>("has_cached_decode", { modelId });
  } catch {
    return false;
  }
}
