// .gia file writer — reverse-engineered from sample files (engine 6.7.0).
// Dependency-free; runs in browsers, workers, and Node.
// See docs/gia-format.md for the format specification.
//
// Public API:
//   buildGia({ models, exportName, uid, timestamp, fileId, engineVersion }) -> Uint8Array
//
//   models: [{
//     name: string,
//     position: {x,y,z},          // object scene position in METERS (optional)
//     collision: boolean,         // optional, default true
//     decorations: [{
//       kind: 'triangle'|'square',// primitive (default 'triangle')
//       position: {x,y,z},        // decoration-local units (meters * 10)
//       rotationDeg: {x,y,z},     // Euler degrees
//       scale: {x,y,z},           // per-axis; triangle: legs*2 on y/z (thin x)
//                                 // square: edges*10 on x/z (thin y)
//       color: 0xRRGGBB,          // 24-bit RGB
//       alpha: 0..255,            // optional, default 255
//     }]
//   }]
//   buildGia opts.collision: default for models that don't specify it.

const GIA = (() => {

// ---------- low-level protobuf writer ----------

class W {
  constructor() { this.parts = []; this.len = 0; }
  push(bytes) { this.parts.push(bytes); this.len += bytes.length; }
  varint(v) {
    // v: number or BigInt, non-negative
    let n = typeof v === 'bigint' ? v : BigInt(Math.round(v));
    const out = [];
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      out.push(b);
    } while (n > 0n);
    this.push(Uint8Array.from(out));
  }
  tag(field, wire) { this.varint(BigInt(field) << 3n | BigInt(wire)); }
  vint(field, v) { this.tag(field, 0); this.varint(v); }
  f32(field, v) {
    this.tag(field, 5);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.push(b);
  }
  bytes(field, u8) { this.tag(field, 2); this.varint(u8.length); this.push(u8); }
  str(field, s) { this.bytes(field, new TextEncoder().encode(s)); }
  msg(field, fn) { const w = new W(); fn(w); this.bytes(field, w.finish()); }
  emptyMsg(field) { this.bytes(field, new Uint8Array(0)); }
  finish() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function packedVarints(values) {
  const w = new W();
  for (const v of values) w.varint(v);
  return w.finish();
}

// Vec3 message {1:x, 2:y, 3:z} float. skipZero: omit 0 fields (position,
// rotation). Otherwise always writes all three (scale).
function vec3(w, field, v, skipZero) {
  w.msg(field, (m) => {
    if (!skipZero || v.x !== 0) m.f32(1, v.x);
    if (!skipZero || v.y !== 0) m.f32(2, v.y);
    if (!skipZero || v.z !== 0) m.f32(3, v.z);
  });
}

// ---------- constants ----------

const OBJECT_TEMPLATE_ID = 10005018;   // MPActionGroup
const TRIANGLE_MODEL_ID = 20002125;    // right-triangle decoration asset
const SQUARE_MODEL_ID = 10009001;      // square decoration asset (thin Y)
const OBJ_GUID_BASE = 1077936129;      // 0x40400001
const DEC_GUID_BASE = 1073741837;      // 0x4000000D
const HEADER_MAGIC = [1, 806, 3];
const TRAILER = 1657;
const RENDER_DIST = 6700;

// ---------- component writers ----------

function writeObjectEntry(w, obj) {
  w.msg(1, (e) => {
    e.msg(1, (id) => { id.vint(2, 1); id.vint(3, 1); id.vint(4, obj.guid); });
    for (const d of obj.decorations) {
      e.msg(2, (id) => { id.vint(2, 1); id.vint(3, 14); id.vint(4, d.guid); });
    }
    e.str(3, obj.name);
    e.vint(5, 1);
    e.msg(11, (p) => p.msg(1, (b) => {
      b.vint(1, obj.guid);
      b.vint(2, OBJECT_TEMPLATE_ID);
      // --- field 6 components ---
      b.msg(6, (c) => { c.vint(1, 1); c.msg(11, (m) => { m.str(1, obj.name); m.vint(2, 1); }); });
      b.msg(6, (c) => { c.vint(1, 13); c.msg(22, (m) => m.vint(4, 0xFFFFFFFF)); });
      b.msg(6, (c) => { c.vint(1, 14); c.msg(23, (m) => m.msg(1, (n) => n.str(3, 'MPActionGroup'))); });
      b.msg(6, (c) => { c.vint(1, 38); c.msg(48, (m) => m.f32(1, 1)); });
      b.msg(6, (c) => { c.vint(1, 40); c.msg(50, (m) => m.bytes(501, packedVarints(obj.decorations.map(d => d.guid)))); });
      b.msg(6, (c) => { c.vint(1, 111); c.emptyMsg(93); });
      b.msg(6, (c) => { c.vint(1, 61); c.emptyMsg(65); });
      b.msg(6, (c) => { c.vint(1, 62); c.emptyMsg(66); });
      // --- field 7 components ---
      b.msg(7, (c) => { c.vint(1, 1); c.msg(11, (m) => {
        vec3(m, 1, obj.position ?? { x: 0, y: 0, z: 0 }, true);
        m.emptyMsg(2);
        vec3(m, 3, { x: 0.1, y: 0.1, z: 0.1 }, false);
        m.vint(501, 0xFFFFFFFF);
      }); });
      b.msg(7, (c) => { c.vint(1, 2); c.emptyMsg(12); });
      b.msg(7, (c) => { c.vint(1, 3); c.emptyMsg(13); });
      b.msg(7, (c) => { c.vint(1, 4); c.msg(14, (m) => m.vint(1, 1)); });
      // component 5 = collision: {1:1, 2:1} enabled, empty body disabled
      b.msg(7, (c) => {
        c.vint(1, 5);
        if (obj.collision === false) c.emptyMsg(15);
        else c.msg(15, (m) => { m.vint(1, 1); m.vint(2, 1); });
      });
      b.msg(7, (c) => { c.vint(1, 6); c.emptyMsg(16); });
      b.msg(7, (c) => { c.vint(1, 7); c.msg(17, (m) => {
        m.f32(1, 1000); m.f32(3, 500); m.vint(4, 1); m.vint(5, 1);
        m.msg(6, (n) => n.vint(2, 10200002));
        for (let f = 8; f <= 15; f++) m.f32(f, 0.1);
      }); });
      b.msg(7, (c) => { c.vint(1, 8); c.msg(18, (m) => { m.vint(1, 1); m.vint(501, 1); }); });
      b.msg(7, (c) => { c.vint(1, 11); c.msg(21, (m) => m.msg(1, (n) => {
        n.str(1, 'GI_RootNode'); n.str(2, ''); n.str(3, '');
        n.str(502, 'Center Origin'); n.vint(504, 1); n.str(505, 'RootNode');
      })); });
      b.msg(7, (c) => { c.vint(1, 12); c.msg(22, (m) => m.vint(501, 1)); });
      b.msg(7, (c) => { c.vint(1, 16); c.emptyMsg(26); });
      b.msg(7, (c) => { c.vint(1, 17); c.emptyMsg(27); });
      b.msg(7, (c) => { c.vint(1, 19); c.msg(29, (m) => m.vint(1, 1)); });
      b.msg(7, (c) => { c.vint(1, 20); c.emptyMsg(30); });
      b.msg(7, (c) => { c.vint(1, 22); c.msg(32, (m) => {
        m.vint(3, 0xFFFFFFFF); m.f32(4, 100); m.vint(5, 0xFFFFFF); m.vint(6, RENDER_DIST);
      }); });
      b.vint(10, 1);
    }));
  });
}

function writeDecorationEntry(w, dec, parentGuid) {
  const rgb = dec.color & 0xFFFFFF;
  const alpha = dec.alpha ?? 255;
  const argb = (BigInt(alpha) << 24n | BigInt(rgb)) & 0xFFFFFFFFn;
  w.msg(2, (e) => {
    e.msg(1, (id) => { id.vint(2, 1); id.vint(3, 14); id.vint(4, dec.guid); });
    e.str(3, dec.name);
    e.vint(5, 28);
    e.msg(21, (p) => p.msg(1, (b) => {
      b.vint(1, dec.guid);
      b.vint(2, dec.kind === 'square' ? SQUARE_MODEL_ID : TRIANGLE_MODEL_ID);
      b.vint(3, 1);
      // --- field 4 components ---
      b.msg(4, (c) => { c.vint(1, 1); c.msg(11, (m) => m.str(1, dec.name)); });
      b.msg(4, (c) => { c.vint(1, 40); c.msg(50, (m) => m.vint(502, parentGuid)); });
      b.msg(4, (c) => { c.vint(1, 111); c.emptyMsg(93); });
      // --- field 5 components (order: 1, 5, 2, 22) ---
      b.msg(5, (c) => { c.vint(1, 1); c.msg(11, (m) => {
        vec3(m, 1, dec.position ?? { x: 0, y: 0, z: 0 }, true);
        vec3(m, 2, dec.rotationDeg ?? { x: 0, y: 0, z: 0 }, true);
        vec3(m, 3, dec.scale ?? { x: 1, y: 1, z: 1 }, false);
      }); });
      b.msg(5, (c) => { c.vint(1, 5); c.msg(15, (m) => { m.vint(1, 1); m.vint(2, 1); }); });
      b.msg(5, (c) => { c.vint(1, 2); c.emptyMsg(12); });
      b.msg(5, (c) => { c.vint(1, 22); c.msg(32, (m) => {
        m.vint(1, 1); m.vint(3, argb); m.f32(4, 100); m.vint(5, rgb); m.vint(6, RENDER_DIST);
      }); });
      b.emptyMsg(11);
    }));
  });
}

// ---------- top level ----------

function buildGia(opts) {
  const {
    models,
    exportName = 'export',
    uid = 600489258,
    timestamp = Math.floor(Date.now() / 1000),
    fileId = 1073742021,
    engineVersion = '6.7.0',
    collision = true,
  } = opts;

  // assign guids
  let objGuid = opts.objGuidBase ?? OBJ_GUID_BASE;
  let decGuid = opts.decGuidBase ?? DEC_GUID_BASE;
  const prepared = models.map((m) => {
    const obj = {
      name: m.name,
      position: m.position,
      collision: m.collision ?? collision,
      guid: m.guid ?? objGuid++,
      decorations: m.decorations.map((d, i) => ({
        ...d,
        name: d.name ?? `Decoration_${i + 1}`,
        guid: d.guid ?? decGuid++,
      })),
    };
    return obj;
  });

  const w = new W();
  for (const obj of prepared) writeObjectEntry(w, obj);
  for (const obj of prepared) {
    for (const d of obj.decorations) writeDecorationEntry(w, d, obj.guid);
  }
  w.str(3, `${uid}-${timestamp}-${fileId}-\\${exportName}.gia`);
  w.str(5, engineVersion);
  const payload = w.finish();

  const total = 20 + payload.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total - 4, false);
  dv.setUint32(4, HEADER_MAGIC[0], false);
  dv.setUint32(8, HEADER_MAGIC[1], false);
  dv.setUint32(12, HEADER_MAGIC[2], false);
  dv.setUint32(16, payload.length, false);
  out.set(payload, 20);
  dv.setUint32(total - 4, TRAILER, false);
  return out;
}

// Split a flat decoration list into models of <= maxPerModel decorations.
function splitIntoModels(name, decorations, maxPerModel = 999, position) {
  const models = [];
  if (decorations.length === 0) return models;
  const count = Math.ceil(decorations.length / maxPerModel);
  for (let i = 0; i < count; i++) {
    models.push({
      name: count > 1 ? `${name}_${i + 1}` : name,
      position,
      decorations: decorations.slice(i * maxPerModel, (i + 1) * maxPerModel),
    });
  }
  return models;
}

return { buildGia, splitIntoModels, W, packedVarints,
  OBJECT_TEMPLATE_ID, TRIANGLE_MODEL_ID, SQUARE_MODEL_ID,
  MAX_DECORATIONS_PER_MODEL: 999 };
})();

export const { buildGia, splitIntoModels, MAX_DECORATIONS_PER_MODEL,
  TRIANGLE_MODEL_ID, SQUARE_MODEL_ID } = GIA;
export default GIA;
