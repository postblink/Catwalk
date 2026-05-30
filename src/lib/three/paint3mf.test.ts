import { describe, it, expect } from "vitest";
import { decodePaintedTriangle, type LeafSink } from "./paint3mf";

/** Collect every leaf the decoder emits as {corners, state} for assertions. */
function collectLeaves(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  code: string | undefined,
) {
  const leaves: { corners: number[]; state: number }[] = [];
  const sink: LeafSink = (x0, y0, z0, x1, y1, z1, x2, y2, z2, state) => {
    leaves.push({ corners: [x0, y0, z0, x1, y1, z1, x2, y2, z2], state });
  };
  decodePaintedTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, code, sink);
  return leaves;
}

// Unit triangle reused across the simple state-decode cases.
const A = [0, 0, 0] as const;
const B = [1, 0, 0] as const;
const C = [0, 1, 0] as const;

function statesFor(code: string | undefined): number[] {
  return collectLeaves(...A, ...B, ...C, code).map((l) => l.state);
}

describe("decodePaintedTriangle — leaf state decoding", () => {
  it("emits the whole facet at state 0 for an absent code", () => {
    const leaves = collectLeaves(...A, ...B, ...C, undefined);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].state).toBe(0);
    expect(leaves[0].corners).toEqual([...A, ...B, ...C]);
  });

  it("emits the whole facet at state 0 for an empty code", () => {
    expect(statesFor("")).toEqual([0]);
  });

  it("decodes a low state via code>>2 (code '4' -> state 1)", () => {
    expect(statesFor("4")).toEqual([1]);
  });

  it("decodes code '8' -> state 2", () => {
    expect(statesFor("8")).toEqual([2]);
  });

  it("decodes code '0' -> state 0", () => {
    expect(statesFor("0")).toEqual([0]);
  });

  it("decodes the 0b1100 escape into states 3-16 (code '5C' -> state 8)", () => {
    // last-to-first nibbles: [C=12, 5]. c=12 hits the escape, z=5 -> 5+3=8.
    expect(statesFor("5C")).toEqual([8]);
  });

  it("decodes the extended two-nibble escape into states 17+ (code '21EC' -> state 50)", () => {
    // nibbles [C=12, E=14, 1, 2]: c=12 escape, z=14 extends, lo=1 hi=2 -> (1|32)+17=50.
    expect(statesFor("21EC")).toEqual([50]);
  });
});

describe("decodePaintedTriangle — subdivision geometry", () => {
  it("splits one side and emits two leaves with the shared midpoint", () => {
    // code '401' -> nibbles [1, 0, 4]: root splits side 1 (special=0), then its
    // two children are leaves with states 0 then 1 (reverse-serialized).
    const leaves = collectLeaves(...A, ...B, ...C, "401");
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.state)).toEqual([0, 1]);

    // M = midpoint(C, B) = (0.5, 0.5, 0); both children reference it.
    const M = [0.5, 0.5, 0];
    // child 1 (visited first): (M, C, A)
    expect(leaves[0].corners).toEqual([...M, ...C, ...A]);
    // child 0 (visited second): (A, B, M)
    expect(leaves[1].corners).toEqual([...A, ...B, ...M]);
  });
});
