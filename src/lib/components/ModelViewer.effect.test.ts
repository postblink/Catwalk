// Guards the ModelViewer load effect against re-introducing an infinite loop.
//
// The bug: $effect called load(), whose synchronous prefix calls revokeThumb(),
// which READS thumbUrl as well as writing it. That made thumbUrl a dependency of
// an effect that also mutates it, so every thumbnail that landed re-ran the
// effect, which nulled the thumbnail and kicked off another read_thumbnail and
// another loadPreview — forever.
//
// It was invisible on the happy path, because a successful parse sets `object`
// and the thumbnail's own `|| object` guard drops the URL before it is assigned.
// It only fires when the parse FAILS and the catch keeps the thumbnail as a
// fallback — which is every model at once when a library root has moved or its
// drive is unplugged.
//
// This is a source assertion rather than a component test: there is no DOM
// environment or testing-library in this project, and adding one to cover a
// single effect would cost more than it returns. It reads the real file, so
// deleting the untrack breaks the suite.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./ModelViewer.svelte", import.meta.url)),
  "utf8",
);

describe("ModelViewer load effect", () => {
  it("runs load() untracked so thumbUrl cannot re-trigger the effect", () => {
    expect(source).toMatch(/import\s*\{[^}]*\buntrack\b[^}]*\}\s*from\s*["']svelte["']/);
    // The load call itself must be inside untrack(...), not merely imported.
    expect(source).toMatch(/untrack\(\s*\(\)\s*=>\s*load\(/);
  });

  it("still reads modelId and extension as real dependencies", () => {
    // untrack must wrap only the call. If the props were read inside it too, the
    // viewer would stop reloading when the selected model changed.
    const effectBody = source.slice(source.indexOf("$effect(() => {"));
    const untrackIdx = effectBody.indexOf("untrack(");
    const modelIdIdx = effectBody.indexOf("modelId");
    const extensionIdx = effectBody.indexOf("extension");
    expect(modelIdIdx).toBeGreaterThan(-1);
    expect(extensionIdx).toBeGreaterThan(-1);
    expect(modelIdIdx).toBeLessThan(untrackIdx);
    expect(extensionIdx).toBeLessThan(untrackIdx);
  });

  it("keeps revokeThumb reading thumbUrl — the read is fine once untracked", () => {
    // Documents WHY untrack is required. If someone rewrites revokeThumb to stop
    // reading reactive state, the untrack becomes redundant and this test should
    // be revisited deliberately rather than silently.
    expect(source).toMatch(/function revokeThumb\(\)\s*\{\s*if \(thumbUrl\)/);
  });
});
