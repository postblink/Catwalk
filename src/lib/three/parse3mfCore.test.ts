import { describe, it, expect } from "vitest";
// @ts-ignore - three's bundled fflate ships no type declarations
import { zipSync, strToU8 } from "three/examples/jsm/libs/fflate.module.js";
import { parse3mf } from "./parse3mfCore";

// ---------------------------------------------------------------------------
// In-memory 3MF zip builder. A 3MF is an OPC zip: a `_rels/.rels` part points
// at the root model, which lives under `3D/`. We build the minimum the parser
// needs and let callers drop in extra parts (e.g. slicer config for palettes).
// ---------------------------------------------------------------------------

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function build3mf(modelXml: string, extra: Record<string, string> = {}): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(RELS),
    "3D/3dmodel.model": strToU8(modelXml),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  const zipped: Uint8Array = zipSync(files);
  // Return a clean ArrayBuffer slice (parse3mf wraps it in a Uint8Array).
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

/** Wrap a <model> around resources + build, with the material extension ns declared. */
function model(resources: string, build: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"
       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>${resources}</resources>
  <build>${build}</build>
</model>`;
}

// A single right-triangle mesh: v0=(0,0,0) v1=(1,0,0) v2=(0,1,0).
const TRI_VERTICES = `<vertices>
  <vertex x="0" y="0" z="0"/>
  <vertex x="1" y="0" z="0"/>
  <vertex x="0" y="1" z="0"/>
</vertices>`;

describe("parse3mf — plain geometry", () => {
  it("parses a plain indexed mesh as a 'default' mesh", () => {
    const xml = model(
      `<object id="1" type="model"><mesh>
        ${TRI_VERTICES}
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(true);
    expect(res.meshes).toHaveLength(1);

    const m = res.meshes[0];
    expect(m.kind).toBe("default");
    expect(m.colors).toBeNull();
    expect(Array.from(m.index!)).toEqual([0, 1, 2]);
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("applies the build item's transform to vertices", () => {
    // Column-major identity rotation + translation (5,0,0).
    const xml = model(
      `<object id="1" type="model"><mesh>
        ${TRI_VERTICES}
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>`,
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(true);
    const p = res.meshes[0].positions;
    // v0 (0,0,0) shifts to (5,0,0).
    expect(p[0]).toBeCloseTo(5);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(0);
    // v1 (1,0,0) shifts to (6,0,0).
    expect(p[3]).toBeCloseTo(6);
  });
});

describe("parse3mf — colorgroup (per-vertex)", () => {
  it("colors vertices from p1/p2/p3 indices into the colorgroup palette", () => {
    const xml = model(
      `<m:colorgroup id="2">
         <m:color color="#ff0000"/>
         <m:color color="#00ff00"/>
       </m:colorgroup>
       <object id="1" type="model"><mesh>
         ${TRI_VERTICES}
         <triangles><triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="0"/></triangles>
       </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(true);
    expect(res.meshes).toHaveLength(1);

    const m = res.meshes[0];
    expect(m.kind).toBe("painted");
    const c = m.colors!;
    // v1 -> p1=0 -> red(1,0,0), v2 -> p2=1 -> green(0,1,0), v3 -> p3=0 -> red.
    expect(Array.from(c.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(c.slice(3, 6))).toEqual([0, 1, 0]);
    expect(Array.from(c.slice(6, 9))).toEqual([1, 0, 0]);
  });
});

describe("parse3mf — basematerials (per-triangle solid)", () => {
  it("fills all three vertices with the object's pindex material color", () => {
    const xml = model(
      `<basematerials id="3">
         <base name="blue" displaycolor="#0000ff"/>
       </basematerials>
       <object id="1" type="model" pid="3" pindex="0"><mesh>
         ${TRI_VERTICES}
         <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
       </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(true);
    const m = res.meshes[0];
    expect(m.kind).toBe("painted");
    const c = m.colors!;
    // All three vertices blue (0,0,1).
    expect(Array.from(c.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(c.slice(3, 6))).toEqual([0, 0, 1]);
    expect(Array.from(c.slice(6, 9))).toEqual([0, 0, 1]);
  });
});

describe("parse3mf — proprietary paint", () => {
  it("decodes paint_color against a Bambu filament palette", () => {
    const xml = model(
      `<object id="1" type="model"><mesh>
        ${TRI_VERTICES}
        <triangles><triangle v1="0" v2="1" v3="2" paint_color="4"/></triangles>
      </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const palette = JSON.stringify({ filament_colour: ["#ff0000", "#00ff00"] });
    const res = parse3mf(build3mf(xml, { "Metadata/project_settings.config": palette }));
    expect(res.supported).toBe(true);
    const m = res.meshes[0];
    expect(m.kind).toBe("painted");
    // paint code '4' -> state 1 -> palette index 0 -> red, for all 3 vertices.
    const c = m.colors!;
    expect(Array.from(c.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(c.slice(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(c.slice(6, 9))).toEqual([1, 0, 0]);
  });
});

describe("parse3mf — unsupported feature fallback", () => {
  it("returns supported:false for a textured mesh (texture2dgroup)", () => {
    const xml = model(
      `<m:texture2dgroup id="4" texid="5">
         <m:tex2coord u="0" v="0"/>
       </m:texture2dgroup>
       <object id="1" type="model" pid="4"><mesh>
         ${TRI_VERTICES}
         <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
       </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/textured/i);
  });

  it("returns supported:false for implicit functions", () => {
    const xml = model(
      `<implicitfunction id="9"/>
       <object id="1" type="model"><mesh>
         ${TRI_VERTICES}
         <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
       </mesh></object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/implicit/i);
  });
});

describe("parse3mf — components", () => {
  it("recurses into component references with composed transforms", () => {
    // Object 2 is a mesh; object 1 references it via a component translated +5 in x.
    const xml = model(
      `<object id="2" type="model"><mesh>
         ${TRI_VERTICES}
         <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
       </mesh></object>
       <object id="1" type="model">
         <components>
           <component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
         </components>
       </object>`,
      `<item objectid="1"/>`,
    );
    const res = parse3mf(build3mf(xml));
    expect(res.supported).toBe(true);
    expect(res.meshes).toHaveLength(1);
    // v0 (0,0,0) shifted by the component transform to (5,0,0).
    expect(res.meshes[0].positions[0]).toBeCloseTo(5);
  });
});
