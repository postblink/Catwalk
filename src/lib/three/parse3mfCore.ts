// THREE-free 3MF parser for the common (painted + plain) mesh paths, designed
// to run inside a Web Worker. It replaces the vendored ThreeMFLoader's
// DOMParser + querySelectorAll node-walk (a 2-3s main-thread freeze on big
// files — ~91% of parse time, per measurement) with txml, a worker-safe
// streaming XML parser, and emits plain typed-array geometry buffers that the
// main thread cheaply wraps in THREE objects.
//
// Scope: meshes that are (a) painted with a filament/extruder palette (Bambu
// `paint_color` / Prusa `slic3rpe:mmu_segmentation`), (b) plain geometry, (c)
// colored by a `<m:colorgroup>` (per-vertex) or `<basematerials>` (per-triangle
// solid color). Textured meshes (`<m:texture2dgroup>`) and implicit functions
// return `{ supported: false }`, so the caller falls back to the full
// main-thread loader. Correctness is never sacrificed — we only fast-path what
// we fully understand.

// @ts-ignore - three's bundled fflate ships no type declarations
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
// Import the parser-only subpath (`txml/txml`), not the package root: the root
// (`txml`) re-exports a Transform stream that pulls in `node:stream`, which the
// production/worker bundle can't resolve for the browser (the build fails). The
// subpath is the same parser with zero Node built-in imports.
import { parse as parseXml, type TNode } from "txml/txml";
import { decodePaintedTriangle } from "./paint3mf";

export type MeshKind = "painted" | "default";

/** One renderable mesh's geometry, in world space, ready to wrap in THREE. */
export interface MeshBuffers {
  kind: MeshKind;
  positions: Float32Array;
  normals: Float32Array;
  /** Per-vertex linear RGB; present only for painted meshes. */
  colors: Float32Array | null;
  /** Triangle indices; present only for plain (indexed) meshes. */
  index: Uint32Array | null;
}

export interface Parse3mfResult {
  supported: boolean;
  /** Why the fast path bailed (for logging); set when supported === false. */
  reason?: string;
  meshes: MeshBuffers[];
}

// ---------------------------------------------------------------------------
// txml tree helpers
// ---------------------------------------------------------------------------

const isEl = (n: TNode | string): n is TNode => typeof n !== "string";

/**
 * Local (namespace-stripped), lower-cased tag name. 3MF uses prefixes for the
 * material extension (e.g. `m:colorgroup`, `m:color`), so we match on the local
 * name to stay namespace-agnostic. `tag` arguments are always local + lower.
 */
function localName(tagName: string): string {
  const i = tagName.indexOf(":");
  return (i >= 0 ? tagName.slice(i + 1) : tagName).toLowerCase();
}

/** Direct element children with a given (namespace-stripped) tag name. */
function childrenByTag(node: TNode, tag: string): TNode[] {
  const out: TNode[] = [];
  for (const c of node.children) {
    if (isEl(c) && localName(c.tagName) === tag) out.push(c);
  }
  return out;
}

/** First direct element child with a given tag name, or null. */
function firstByTag(node: TNode, tag: string): TNode | null {
  for (const c of node.children) {
    if (isEl(c) && localName(c.tagName) === tag) return c;
  }
  return null;
}

/** Find the first descendant (any depth) with a given tag name. */
function findDeep(nodes: (TNode | string)[], tag: string): TNode | null {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (localName(n.tagName) === tag) return n;
    const inner = findDeep(n.children, tag);
    if (inner) return inner;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Color: sRGB hex -> linear (mirrors three's Color.setStyle with SRGBColorSpace)
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Parse "#rrggbb" (or longer) to a linear RGB triplet, or null if malformed. */
function hexToLinear(hex: string): [number, number, number] | null {
  const h = hex.trim();
  if (h.length < 7 || h.charAt(0) !== "#") return null;
  const r = parseInt(h.substring(1, 3), 16);
  const g = parseInt(h.substring(3, 5), 16);
  const b = parseInt(h.substring(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
}

/**
 * Extract the filament/extruder palette as a flat linear-RGB Float32Array
 * (index 0 == filament/extruder 1), matching ThreeMFLoader.parsePalette.
 */
function parsePalette(zip: Record<string, Uint8Array>, dec: TextDecoder): Float32Array | null {
  const toTriplets = (hexes: unknown[]): Float32Array | null => {
    const out: number[] = [];
    for (const hx of hexes) {
      const lin = hexToLinear(String(hx).substring(0, 7));
      if (lin) out.push(lin[0], lin[1], lin[2]);
    }
    return out.length ? new Float32Array(out) : null;
  };

  // Bambu Studio / OrcaSlicer: JSON project settings with filament_colour.
  const bambu = zip["Metadata/project_settings.config"];
  if (bambu) {
    try {
      const json = JSON.parse(dec.decode(bambu));
      if (Array.isArray(json.filament_colour)) return toTriplets(json.filament_colour);
    } catch {
      /* fall through */
    }
  }

  // PrusaSlicer: INI-style; prefer extruder_colour, fall back to filament_colour.
  const prusa = zip["Metadata/Slic3r_PE.config"];
  if (prusa) {
    const text = dec.decode(prusa);
    const readKey = (key: string): string[] | null => {
      const m = text.match(new RegExp("^[;\\s]*" + key + "\\s*=\\s*(.+)$", "m"));
      if (!m) return null;
      const parts = m[1].split(";").map((s) => s.trim()).filter((s) => s.length);
      return parts.length ? parts : null;
    };
    const colours = readKey("extruder_colour") || readKey("filament_colour");
    if (colours) return toTriplets(colours);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Affine transforms (3x4, row-major: x' = a*x + b*y + c*z + d, ...)
// ---------------------------------------------------------------------------

type Affine = Float64Array; // length 12: [a b c d  e f g h  i j k l]

const IDENTITY: Affine = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** Parse a 3MF `transform` (12 space-separated, column-major) into our affine. */
function parseTransform(s: string): Affine {
  const t = s.trim().split(/\s+/).map(parseFloat);
  // 3MF lists the matrix column-major (m00 m01 m02, m10 m11 m12, ...); the
  // vendored loader maps it to rows [t0 t3 t6 t9; t1 t4 t7 t10; t2 t5 t8 t11].
  return new Float64Array([
    t[0], t[3], t[6], t[9],
    t[1], t[4], t[7], t[10],
    t[2], t[5], t[8], t[11],
  ]);
}

/** Compose two affines: result(v) = A(B(v)). */
function multiplyAffine(A: Affine, B: Affine): Affine {
  const r = new Float64Array(12);
  for (let row = 0; row < 3; row++) {
    const a0 = A[row * 4], a1 = A[row * 4 + 1], a2 = A[row * 4 + 2], a3 = A[row * 4 + 3];
    // columns of B for x,y,z plus translation
    r[row * 4 + 0] = a0 * B[0] + a1 * B[4] + a2 * B[8];
    r[row * 4 + 1] = a0 * B[1] + a1 * B[5] + a2 * B[9];
    r[row * 4 + 2] = a0 * B[2] + a1 * B[6] + a2 * B[10];
    r[row * 4 + 3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + a3;
  }
  return r;
}

function isIdentity(m: Affine): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 &&
    m[4] === 0 && m[5] === 1 && m[6] === 0 && m[7] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0
  );
}

/** Apply an affine to a flat vertex array, returning a new world-space array. */
function transformVertices(verts: Float32Array, m: Affine): Float32Array {
  if (isIdentity(m)) return verts;
  const out = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vertex normals (mirrors THREE.BufferGeometry.computeVertexNormals)
// ---------------------------------------------------------------------------

function computeNormals(positions: Float32Array, index: Uint32Array | null): Float32Array {
  const normals = new Float32Array(positions.length);
  const triCount = index ? index.length / 3 : positions.length / 9;

  for (let t = 0; t < triCount; t++) {
    let ia: number, ib: number, ic: number;
    if (index) {
      ia = index[t * 3] * 3;
      ib = index[t * 3 + 1] * 3;
      ic = index[t * 3 + 2] * 3;
    } else {
      ia = t * 9;
      ib = t * 9 + 3;
      ic = t * 9 + 6;
    }
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i] = x / len;
    normals[i + 1] = y / len;
    normals[i + 2] = z / len;
  }
  return normals;
}

// ---------------------------------------------------------------------------
// Parsed model representation
// ---------------------------------------------------------------------------

interface TriProp {
  v1: number;
  v2: number;
  v3: number;
  /** Per-vertex property indices into the triangle's resource group. */
  p1?: number;
  p2?: number;
  p3?: number;
  pid?: string;
  pc?: string; // paint code
}

interface MeshData {
  vertices: Float32Array;
  triangles: Uint32Array;
  props: TriProp[];
  hasPaint: boolean;
  /** true if any triangle (or the object) references a non-default resource. */
  usesResources: boolean;
}

interface ObjectData {
  id: string;
  pid?: string;
  /** Object-level default property index (used when a triangle omits p1). */
  pindex?: number;
  mesh?: MeshData;
  components?: { objectId: string; path: string | null; transform: Affine | null }[];
}

interface ModelPart {
  objects: Map<string, ObjectData>;
  /** resource ids that map to material/color/texture groups. */
  resourceIds: Set<string>;
  /** colorgroup id -> flat linear-RGB colors (per-index). */
  colorgroups: Map<string, Float32Array>;
  /** basematerials id -> flat linear-RGB displaycolors (per material index). */
  basematerials: Map<string, Float32Array>;
  /** texture2dgroup ids — meshes using these fall back to the main thread. */
  textureGroupIds: Set<string>;
  build: { objectId: string; path: string | null; transform: Affine | null }[];
}

class UnsupportedError extends Error {}

function parseMesh(meshNode: TNode, resourceIds: Set<string>, objectPid: string | undefined): MeshData {
  const verticesNode = firstByTag(meshNode, "vertices");
  const vertexNodes = verticesNode ? childrenByTag(verticesNode, "vertex") : [];
  const vertices = new Float32Array(vertexNodes.length * 3);
  for (let i = 0; i < vertexNodes.length; i++) {
    const a = vertexNodes[i].attributes;
    vertices[i * 3] = parseFloat(a.x as string);
    vertices[i * 3 + 1] = parseFloat(a.y as string);
    vertices[i * 3 + 2] = parseFloat(a.z as string);
  }

  const trianglesNode = firstByTag(meshNode, "triangles");
  const triangleNodes = trianglesNode ? childrenByTag(trianglesNode, "triangle") : [];
  const triangles = new Uint32Array(triangleNodes.length * 3);
  const props: TriProp[] = new Array(triangleNodes.length);

  let hasPaint = false;
  let usesResources = false;

  for (let i = 0; i < triangleNodes.length; i++) {
    const a = triangleNodes[i].attributes;
    const v1 = parseInt(a.v1 as string, 10);
    const v2 = parseInt(a.v2 as string, 10);
    const v3 = parseInt(a.v3 as string, 10);
    triangles[i * 3] = v1;
    triangles[i * 3 + 1] = v2;
    triangles[i * 3 + 2] = v3;

    const prop: TriProp = { v1, v2, v3 };

    // Per-vertex property indices into the resource group (optional).
    if (a.p1 != null) {
      const p1 = parseInt(a.p1 as string, 10);
      if (!Number.isNaN(p1)) prop.p1 = p1;
    }
    if (a.p2 != null) {
      const p2 = parseInt(a.p2 as string, 10);
      if (!Number.isNaN(p2)) prop.p2 = p2;
    }
    if (a.p3 != null) {
      const p3 = parseInt(a.p3 as string, 10);
      if (!Number.isNaN(p3)) prop.p3 = p3;
    }

    const pid = (a.pid as string) ?? undefined;
    if (pid !== undefined) prop.pid = pid;

    // Proprietary per-triangle paint (Bambu/Orca + Prusa variants).
    const paint =
      (a.paint_color as string) ||
      (a["slic3rpe:mmu_segmentation"] as string) ||
      (a.mmu_segmentation as string);
    if (paint) {
      prop.pc = paint;
      hasPaint = true;
    }

    // Effective resource id: triangle pid, else object pid. If it names a
    // material/color/texture group, this mesh needs the slow path.
    const effective = pid ?? objectPid;
    if (effective !== undefined && resourceIds.has(effective)) usesResources = true;

    props[i] = prop;
  }

  return { vertices, triangles, props, hasPaint, usesResources };
}

function parseObject(objectNode: TNode, resourceIds: Set<string>): ObjectData {
  const attrs = objectNode.attributes;
  const id = attrs.id as string;
  const pid = (attrs.pid as string) ?? undefined;
  const data: ObjectData = { id, pid };
  if (attrs.pindex != null) {
    const pindex = parseInt(attrs.pindex as string, 10);
    if (!Number.isNaN(pindex)) data.pindex = pindex;
  }

  const meshNode = firstByTag(objectNode, "mesh");
  if (meshNode) {
    data.mesh = parseMesh(meshNode, resourceIds, pid);
    return data;
  }

  const componentsNode = firstByTag(objectNode, "components");
  if (componentsNode) {
    data.components = childrenByTag(componentsNode, "component").map((c) => {
      const ca = c.attributes;
      const tf = ca.transform as string | undefined;
      return {
        objectId: ca.objectid as string,
        path: (ca["p:path"] as string) ?? null,
        transform: tf ? parseTransform(tf) : null,
      };
    });
  }
  return data;
}

function parseModelPart(xmlText: string): ModelPart {
  const roots = parseXml(xmlText, { keepComments: false, keepWhitespace: false });
  const modelNode = roots.find((n): n is TNode => isEl(n) && localName(n.tagName) === "model");
  if (!modelNode) throw new Error("3MF: no <model> root");

  const resourceIds = new Set<string>();
  const objects = new Map<string, ObjectData>();
  const colorgroups = new Map<string, Float32Array>();
  const basematerials = new Map<string, Float32Array>();
  const textureGroupIds = new Set<string>();

  const resourcesNode = firstByTag(modelNode, "resources");
  if (resourcesNode) {
    // colorgroup: a palette of <m:color> entries indexed by p1/p2/p3.
    for (const n of childrenByTag(resourcesNode, "colorgroup")) {
      const id = n.attributes.id as string | undefined;
      if (id === undefined) continue;
      resourceIds.add(id);
      const cols: number[] = [];
      for (const c of childrenByTag(n, "color")) {
        const lin = hexToLinear(String(c.attributes.color ?? "").substring(0, 7));
        cols.push(lin?.[0] ?? 0, lin?.[1] ?? 0, lin?.[2] ?? 0);
      }
      colorgroups.set(id, new Float32Array(cols));
    }

    // basematerials: <base displaycolor> entries indexed by p1 (implicit order).
    for (const n of childrenByTag(resourcesNode, "basematerials")) {
      const id = n.attributes.id as string | undefined;
      if (id === undefined) continue;
      resourceIds.add(id);
      const cols: number[] = [];
      for (const b of childrenByTag(n, "base")) {
        const lin = hexToLinear(String(b.attributes.displaycolor ?? "").substring(0, 7));
        cols.push(lin?.[0] ?? 0, lin?.[1] ?? 0, lin?.[2] ?? 0);
      }
      basematerials.set(id, new Float32Array(cols));
    }

    // texture2dgroup: recorded so meshes that use one fall back (textures stay
    // on the main-thread loader — see parse3mf's emit()).
    for (const n of childrenByTag(resourcesNode, "texture2dgroup")) {
      const id = n.attributes.id as string | undefined;
      if (id === undefined) continue;
      resourceIds.add(id);
      textureGroupIds.add(id);
    }

    if (firstByTag(resourcesNode, "implicitfunction")) {
      throw new UnsupportedError("implicit functions");
    }
    for (const objNode of childrenByTag(resourcesNode, "object")) {
      const obj = parseObject(objNode, resourceIds);
      objects.set(obj.id, obj);
    }
  }

  const build: ModelPart["build"] = [];
  const buildNode = firstByTag(modelNode, "build");
  if (buildNode) {
    for (const item of childrenByTag(buildNode, "item")) {
      const ia = item.attributes;
      const tf = ia.transform as string | undefined;
      build.push({
        objectId: ia.objectid as string,
        path: (ia["p:path"] as string) ?? null,
        transform: tf ? parseTransform(tf) : null,
      });
    }
  }

  return { objects, resourceIds, colorgroups, basematerials, textureGroupIds, build };
}

// ---------------------------------------------------------------------------
// Mesh assembly into world-space buffers
// ---------------------------------------------------------------------------

function buildPainted(mesh: MeshData, worldVerts: Float32Array, palette: Float32Array): MeshBuffers {
  const positions: number[] = [];
  const colors: number[] = [];
  const paletteLen = palette.length / 3;
  const baseR = palette[0], baseG = palette[1], baseB = palette[2];

  const sink = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    state: number,
  ) => {
    const idx = state - 1;
    let r = baseR, g = baseG, b = baseB;
    if (idx >= 0 && idx < paletteLen) {
      r = palette[idx * 3];
      g = palette[idx * 3 + 1];
      b = palette[idx * 3 + 2];
    }
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    colors.push(r, g, b, r, g, b, r, g, b);
  };

  const props = mesh.props;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const a = p.v1 * 3, b = p.v2 * 3, c = p.v3 * 3;
    decodePaintedTriangle(
      worldVerts[a], worldVerts[a + 1], worldVerts[a + 2],
      worldVerts[b], worldVerts[b + 1], worldVerts[b + 2],
      worldVerts[c], worldVerts[c + 1], worldVerts[c + 2],
      p.pc,
      sink,
    );
  }

  const pos = new Float32Array(positions);
  return {
    kind: "painted",
    positions: pos,
    colors: new Float32Array(colors),
    normals: computeNormals(pos, null),
    index: null,
  };
}

function buildDefault(mesh: MeshData, worldVerts: Float32Array): MeshBuffers {
  return {
    kind: "default",
    positions: worldVerts,
    colors: null,
    index: mesh.triangles,
    normals: computeNormals(worldVerts, mesh.triangles),
  };
}

/** Push triangle `p`'s three world-space vertices into `out`. */
function pushTriangle(out: number[], worldVerts: Float32Array, p: TriProp): void {
  const a = p.v1 * 3, b = p.v2 * 3, c = p.v3 * 3;
  out.push(
    worldVerts[a], worldVerts[a + 1], worldVerts[a + 2],
    worldVerts[b], worldVerts[b + 1], worldVerts[b + 2],
    worldVerts[c], worldVerts[c + 1], worldVerts[c + 2],
  );
}

/**
 * `<m:colorgroup>` path: each triangle's p1/p2/p3 select a per-vertex color
 * (p2/p3 default to p1, p1 to the object's pindex), giving smooth/flat vertex
 * coloring. Mirrors ThreeMFLoader.buildVertexColorMesh.
 */
function buildVertexColorGroup(
  props: TriProp[], worldVerts: Float32Array, colors: Float32Array, objectPindex: number | undefined,
): MeshBuffers {
  const positions: number[] = [];
  const colorData: number[] = [];
  const n = colors.length / 3;
  const colorAt = (idx: number | undefined) => {
    const i = idx !== undefined && idx >= 0 && idx < n ? idx : 0;
    colorData.push(colors[i * 3] ?? 0, colors[i * 3 + 1] ?? 0, colors[i * 3 + 2] ?? 0);
  };

  for (const p of props) {
    pushTriangle(positions, worldVerts, p);
    const i1 = p.p1 ?? objectPindex;
    colorAt(i1);
    colorAt(p.p2 ?? i1);
    colorAt(p.p3 ?? i1);
  }

  const pos = new Float32Array(positions);
  return { kind: "painted", positions: pos, colors: new Float32Array(colorData), normals: computeNormals(pos, null), index: null };
}

/**
 * `<basematerials>` path: each triangle's p1 (else the object's pindex) selects
 * a material whose displaycolor fills all three vertices — a per-triangle solid
 * color. Alpha on 8-digit displaycolors is ignored (opaque preview).
 */
function buildBasematerialGroup(
  props: TriProp[], worldVerts: Float32Array, baseColors: Float32Array, objectPindex: number | undefined,
): MeshBuffers {
  const positions: number[] = [];
  const colorData: number[] = [];
  const n = baseColors.length / 3;

  for (const p of props) {
    pushTriangle(positions, worldVerts, p);
    const raw = p.p1 ?? objectPindex ?? 0;
    const i = raw >= 0 && raw < n ? raw : 0;
    const r = baseColors[i * 3] ?? 0, g = baseColors[i * 3 + 1] ?? 0, b = baseColors[i * 3 + 2] ?? 0;
    colorData.push(r, g, b, r, g, b, r, g, b);
  }

  const pos = new Float32Array(positions);
  return { kind: "painted", positions: pos, colors: new Float32Array(colorData), normals: computeNormals(pos, null), index: null };
}

/** A subset of triangles with no (recognized) resource: plain purple geometry. */
function buildDefaultGroup(props: TriProp[], worldVerts: Float32Array): MeshBuffers {
  const positions: number[] = [];
  for (const p of props) pushTriangle(positions, worldVerts, p);
  const pos = new Float32Array(positions);
  return { kind: "default", positions: pos, colors: null, normals: computeNormals(pos, null), index: null };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

function resolvePartPath(path: string | null, current: string): string {
  if (!path) return current;
  return path.charAt(0) === "/" ? path.substring(1) : path;
}

function fetchRootModelPath(relsText: string): string | null {
  const roots = parseXml(relsText, { keepWhitespace: false });
  const rels = (findDeep(roots, "relationships")?.children ?? roots) as (TNode | string)[];
  for (const n of rels) {
    if (!isEl(n) || localName(n.tagName) !== "relationship") continue;
    const target = n.attributes.Target as string | undefined;
    if (target && target.split(".").pop()?.toLowerCase() === "model") {
      return target.charAt(0) === "/" ? target.substring(1) : target;
    }
  }
  return null;
}

/**
 * Parse a 3MF ArrayBuffer into world-space mesh buffers via the fast path.
 * Returns `{ supported: false }` (rather than throwing) when the file uses
 * features outside scope (textures, implicit functions), so the caller can fall
 * back to the main-thread loader gracefully.
 */
export function parse3mf(buffer: ArrayBuffer): Parse3mfResult {
  const dec = new TextDecoder();
  const zip = unzipSync(new Uint8Array(buffer)) as Record<string, Uint8Array>;

  // Locate parts.
  let relsName: string | undefined;
  const modelPartNames: string[] = [];
  for (const file of Object.keys(zip)) {
    if (/_rels\/.rels$/.test(file)) relsName = file;
    else if (/^3D\/.*\.model$/.test(file)) modelPartNames.push(file);
  }
  if (!relsName) return { supported: false, reason: "no .rels", meshes: [] };

  const rootPath = fetchRootModelPath(dec.decode(zip[relsName]));
  if (!rootPath || !zip[rootPath]) {
    return { supported: false, reason: "no root model part", meshes: [] };
  }

  const palette = parsePalette(zip, dec);

  try {
    // Parse every model part (production extension: cross-part references).
    const parts = new Map<string, ModelPart>();
    for (const name of modelPartNames) {
      parts.set(name, parseModelPart(dec.decode(zip[name])));
    }
    const rootPart = parts.get(rootPath);
    if (!rootPart) return { supported: false, reason: "root part missing", meshes: [] };

    const meshes: MeshBuffers[] = [];

    const emit = (partPath: string, objectId: string, matrix: Affine) => {
      const part = parts.get(partPath);
      if (!part) throw new UnsupportedError("missing part " + partPath);
      const obj = part.objects.get(objectId);
      if (!obj) throw new UnsupportedError("missing object " + objectId);

      if (obj.mesh) {
        const mesh = obj.mesh;
        const worldVerts = transformVertices(mesh.vertices, matrix);

        // Proprietary paint takes precedence (matches ThreeMFLoader.buildGroup).
        if (palette !== null && mesh.hasPaint) {
          meshes.push(buildPainted(mesh, worldVerts, palette));
          return;
        }
        // Plain geometry, no per-triangle resources.
        if (!mesh.usesResources) {
          meshes.push(buildDefault(mesh, worldVerts));
          return;
        }

        // Resource path: group triangles by effective pid (triangle pid, else
        // object pid, else "default"), then build per group — mirroring
        // ThreeMFLoader.analyzeObject + buildMeshes.
        const groups = new Map<string, TriProp[]>();
        for (const p of mesh.props) {
          const pid = p.pid ?? obj.pid ?? "default";
          let arr = groups.get(pid);
          if (!arr) groups.set(pid, (arr = []));
          arr.push(p);
        }
        for (const [pid, props] of groups) {
          const colors = part.colorgroups.get(pid);
          const bases = part.basematerials.get(pid);
          if (colors) {
            meshes.push(buildVertexColorGroup(props, worldVerts, colors, obj.pindex));
          } else if (bases) {
            meshes.push(buildBasematerialGroup(props, worldVerts, bases, obj.pindex));
          } else if (part.textureGroupIds.has(pid)) {
            // Textured meshes stay on the main-thread loader.
            throw new UnsupportedError("textured mesh");
          } else {
            meshes.push(buildDefaultGroup(props, worldVerts));
          }
        }
        return;
      }

      if (obj.components) {
        for (const comp of obj.components) {
          const childPath = resolvePartPath(comp.path, partPath);
          const childMatrix = comp.transform ? multiplyAffine(matrix, comp.transform) : matrix;
          emit(childPath, comp.objectId, childMatrix);
        }
        return;
      }
      // Object with neither mesh nor components: nothing to draw.
    };

    for (const item of rootPart.build) {
      const refPath = resolvePartPath(item.path, rootPath);
      const matrix = item.transform ?? IDENTITY;
      emit(refPath, item.objectId, matrix);
    }

    if (meshes.length === 0) return { supported: false, reason: "no meshes emitted", meshes: [] };
    return { supported: true, meshes };
  } catch (e) {
    if (e instanceof UnsupportedError) {
      return { supported: false, reason: e.message, meshes: [] };
    }
    throw e;
  }
}
