// Web Worker that runs the THREE-free 3MF core parser off the main thread,
// removing the 2-3s UI freeze big painted files used to cause. It receives the
// raw .3mf bytes, parses them with parse3mf(), and ships the resulting geometry
// back as transferable typed-array buffers (zero-copy). The main thread wraps
// them in THREE objects via assemble3mf().

import { parse3mf, type Parse3mfResult } from "./parse3mfCore";

interface RequestMsg {
  id: number;
  buffer: ArrayBuffer;
}

type ResponseMsg =
  | { id: number; ok: true; result: Parse3mfResult }
  | { id: number; ok: false; error: string };

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
  const { id, buffer } = e.data;
  try {
    const result = parse3mf(buffer);
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
