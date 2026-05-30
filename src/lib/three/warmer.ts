// Background decode warmer: after a scan, trickle every previewable model
// through the parse worker to populate the on-disk decode cache, so the whole
// library opens instantly — not just the handful you've clicked this session.
//
// It reuses previewLoader's shared worker and disk cache (decodeForCache skips
// models that are already cached), and yields to the user: while previews are
// being actively opened it pauses, so warming never makes a click feel slow.

import { decodeForCache, msSinceUserLoad } from "./previewLoader";

const PREVIEWABLE = new Set(["stl", "obj", "3mf"]);

/** Pause warming while the user has loaded a preview within this window. */
const QUIET_MS = 1200;
/** A short breather between items so we never monopolize the worker. */
const YIELD_MS = 60;

export type WarmItem = { id: string; ext: string };

// The queue is a module-level reference the drain loop reads each iteration, so
// replacing it (a new scan) is picked up live by an already-running loop.
let queue: WarmItem[] = [];
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drain(): Promise<void> {
  running = true;
  try {
    while (queue.length > 0) {
      // Yield to active browsing: if the user loaded a preview recently, wait
      // out the quiet window before resuming background work.
      let since = msSinceUserLoad();
      while (since < QUIET_MS) {
        await sleep(QUIET_MS - since + 25);
        since = msSinceUserLoad();
      }

      const item = queue.shift();
      if (!item) break;
      try {
        await decodeForCache(item.id, item.ext);
      } catch {
        /* best-effort: a single model failing never stops the queue */
      }
      await sleep(YIELD_MS);
    }
  } finally {
    running = false;
  }
}

/**
 * Queue a library's previewable models for background decode-to-disk. Replaces
 * any prior queue (a fresh scan supersedes the old set) and kicks off the drain
 * loop if it isn't already running. Safe to call repeatedly.
 */
export function warmLibrary(models: WarmItem[]): void {
  queue = models.filter((m) => PREVIEWABLE.has(m.ext.toLowerCase()));
  if (!running && queue.length > 0) void drain();
}

/** Cancel any pending background warming (e.g. on library switch / unmount). */
export function stopWarming(): void {
  queue = [];
}
