// Decoder for the per-triangle paint format used by PrusaSlicer's TriangleSelector,
// reused verbatim by Bambu Studio / OrcaSlicer (attribute `paint_color`) and
// PrusaSlicer (attribute `slic3rpe:mmu_segmentation`). Each painted triangle stores
// a hex string that encodes a recursive subdivision of the facet plus a paint
// "state" (extruder/filament index) per leaf. We decode that into colored
// sub-triangles so the interactive preview matches the slicer's multicolor view.
//
// Format (from PrusaSlicer src/libslic3r/TriangleSelector.cpp):
//   - The hex string is consumed from LAST char to FIRST; each char is one nibble.
//   - next_nibble() reads 4 bits LSB-first, so each char's hex value (0-15) is a nibble.
//   - Per node: code = nibble. split_sides = code & 0b11.
//       split_sides == 0  -> leaf; decode its state (see decodeLeafState).
//       split_sides  > 0  -> special_side = (code >> 2) & 0b11; the node has
//                            (split_sides + 1) children, serialized in REVERSE
//                            (highest child index first).
//   - Leaf state: if (code & 0b1100) != 0b1100 -> state = code >> 2 (states 0-2);
//       else read a nibble z: if z != 0b1110 -> state = z + 3 (states 3-16);
//       else read lo,hi nibbles -> state = (lo | (hi << 4)) + 17 (states 17-255).
//   - State n maps to extruder/filament index (n - 1), 0-based; state 0 is the
//     unpainted default (object's base extruder, i.e. palette index 0).
//
// Subdivision geometry (barycentric; corners rotated so special_side is first):
//   split 1: M = mid(C,B);          children [(A,B,M),(M,C,A)]
//   split 2: P = mid(B,A),Q=mid(A,C);children [(A,P,Q),(P,B,Q),(B,C,Q)]
//   split 3: P = mid(B,A),R=mid(C,B),S=mid(A,C); children [(A,P,S),(P,B,R),(R,C,S),(P,R,S)]

function hexToNibblesReversed(code: string): number[] {
  const out: number[] = [];
  for (let i = code.length - 1; i >= 0; i--) {
    const ch = code.charCodeAt(i);
    let d: number;
    if (ch >= 48 && ch <= 57) d = ch - 48; // 0-9
    else if (ch >= 65 && ch <= 70) d = 10 + ch - 65; // A-F
    else if (ch >= 97 && ch <= 102) d = 10 + ch - 97; // a-f
    else continue;
    out.push(d);
  }
  return out;
}

/** A sink that receives a finished sub-triangle's three corners (xyz) and paint state. */
export type LeafSink = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  state: number,
) => void;

/**
 * Decode one triangle's paint code and emit its colored leaf sub-triangles via
 * `sink`. An empty/absent code emits the whole facet at state 0 (base color).
 * Corners are the facet's three world-space vertices in (v1, v2, v3) order.
 */
export function decodePaintedTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  code: string | undefined,
  sink: LeafSink,
): void {
  if (!code) {
    sink(ax, ay, az, bx, by, bz, cx, cy, cz, 0);
    return;
  }

  const nibbles = hexToNibblesReversed(code);
  let ptr = 0;
  const next = (): number => (ptr < nibbles.length ? nibbles[ptr++] : 0);

  const decodeLeafState = (c: number): number => {
    if ((c & 0b1100) !== 0b1100) return c >> 2;
    const z = next();
    if (z !== 0b1110) return z + 3;
    const lo = next();
    const hi = next();
    return (lo | (hi << 4)) + 17;
  };

  const recurse = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ): void => {
    const c = next();
    const splitSides = c & 0b11;
    if (splitSides === 0) {
      sink(x0, y0, z0, x1, y1, z1, x2, y2, z2, decodeLeafState(c));
      return;
    }

    // Rotate corners so the special side starts at A.
    const special = (c >> 2) & 0b11;
    let Ax = x0, Ay = y0, Az = z0;
    let Bx = x1, By = y1, Bz = z1;
    let Cx = x2, Cy = y2, Cz = z2;
    if (special === 1) {
      Ax = x1; Ay = y1; Az = z1; Bx = x2; By = y2; Bz = z2; Cx = x0; Cy = y0; Cz = z0;
    } else if (special === 2) {
      Ax = x2; Ay = y2; Az = z2; Bx = x0; By = y0; Bz = z0; Cx = x1; Cy = y1; Cz = z1;
    }

    // Children are serialized highest-index-first, so visit them in reverse.
    if (splitSides === 1) {
      const Mx = (Cx + Bx) / 2, My = (Cy + By) / 2, Mz = (Cz + Bz) / 2;
      // children: [0]=(A,B,M) [1]=(M,C,A); reverse visit order: 1, 0
      recurse(Mx, My, Mz, Cx, Cy, Cz, Ax, Ay, Az);
      recurse(Ax, Ay, Az, Bx, By, Bz, Mx, My, Mz);
    } else if (splitSides === 2) {
      const Px = (Bx + Ax) / 2, Py = (By + Ay) / 2, Pz = (Bz + Az) / 2;
      const Qx = (Ax + Cx) / 2, Qy = (Ay + Cy) / 2, Qz = (Az + Cz) / 2;
      // children: [0]=(A,P,Q) [1]=(P,B,Q) [2]=(B,C,Q); reverse: 2,1,0
      recurse(Bx, By, Bz, Cx, Cy, Cz, Qx, Qy, Qz);
      recurse(Px, Py, Pz, Bx, By, Bz, Qx, Qy, Qz);
      recurse(Ax, Ay, Az, Px, Py, Pz, Qx, Qy, Qz);
    } else {
      const Px = (Bx + Ax) / 2, Py = (By + Ay) / 2, Pz = (Bz + Az) / 2;
      const Rx = (Cx + Bx) / 2, Ry = (Cy + By) / 2, Rz = (Cz + Bz) / 2;
      const Sx = (Ax + Cx) / 2, Sy = (Ay + Cy) / 2, Sz = (Az + Cz) / 2;
      // children: [0]=(A,P,S) [1]=(P,B,R) [2]=(R,C,S) [3]=(P,R,S); reverse: 3,2,1,0
      recurse(Px, Py, Pz, Rx, Ry, Rz, Sx, Sy, Sz);
      recurse(Rx, Ry, Rz, Cx, Cy, Cz, Sx, Sy, Sz);
      recurse(Px, Py, Pz, Bx, By, Bz, Rx, Ry, Rz);
      recurse(Ax, Ay, Az, Px, Py, Pz, Sx, Sy, Sz);
    }
  };

  recurse(ax, ay, az, bx, by, bz, cx, cy, cz);
}
