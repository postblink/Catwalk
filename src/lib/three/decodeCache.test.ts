import { describe, it, expect } from "vitest";
import { serializeDecode, deserializeDecode } from "./decodeCache";
import type { MeshBuffers } from "./parse3mfCore";

function defaultMesh(): MeshBuffers {
  return {
    kind: "default",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: null,
    index: new Uint32Array([0, 1, 2]),
  };
}

function paintedMesh(): MeshBuffers {
  return {
    kind: "painted",
    positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    index: null,
  };
}

function expectMeshEqual(a: MeshBuffers, b: MeshBuffers) {
  expect(a.kind).toBe(b.kind);
  expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
  expect(a.colors ? Array.from(a.colors) : null).toEqual(b.colors ? Array.from(b.colors) : null);
  expect(a.index ? Array.from(a.index) : null).toEqual(b.index ? Array.from(b.index) : null);
}

describe("decodeCache serialize/deserialize", () => {
  it("round-trips a plain indexed mesh (no colors)", () => {
    const src = [defaultMesh()];
    const out = deserializeDecode(serializeDecode(src));
    expect(out).toHaveLength(1);
    expectMeshEqual(out[0], src[0]);
    expect(out[0].colors).toBeNull();
    expect(out[0].index).not.toBeNull();
  });

  it("round-trips a painted mesh (colors, no index)", () => {
    const src = [paintedMesh()];
    const out = deserializeDecode(serializeDecode(src));
    expectMeshEqual(out[0], src[0]);
    expect(out[0].colors).not.toBeNull();
    expect(out[0].index).toBeNull();
  });

  it("round-trips multiple mixed meshes preserving order", () => {
    const src = [defaultMesh(), paintedMesh(), defaultMesh()];
    const out = deserializeDecode(serializeDecode(src));
    expect(out).toHaveLength(3);
    src.forEach((m, i) => expectMeshEqual(out[i], m));
  });

  it("round-trips an empty mesh list", () => {
    const out = deserializeDecode(serializeDecode([]));
    expect(out).toEqual([]);
  });

  it("writes the CWD1 magic header", () => {
    const bytes = new Uint8Array(serializeDecode([defaultMesh()]));
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x43, 0x57, 0x44, 0x31]);
  });

  it("rejects a blob with a bad magic header", () => {
    const bad = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer;
    expect(() => deserializeDecode(bad)).toThrow(/magic/i);
  });

  it("returns independent buffers not aliasing the source blob", () => {
    const blob = serializeDecode([defaultMesh()]);
    const out = deserializeDecode(blob);
    // Mutating the decoded array must not touch the original blob bytes.
    out[0].positions[0] = 999;
    const reparsed = deserializeDecode(blob);
    expect(reparsed[0].positions[0]).toBe(0);
  });
});
