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
const TRIANGLE_MODEL_ID = 20001925;    // right-triangle model (v2 reference,
                                       // legs 0.13 m +Y, 0.27 m -Z per zoom)
const LEGACY_TRIANGLE_MODEL_ID = 20002125; // old v1 triangle (0.5 m legs +Y/+Z)
const SQUARE_MODEL_ID = 10009001;      // square/cube decoration (0.1 m/axis @1)

// decoration model per primitive kind (all 0.1 m per scale unit, centered)
const PRIMITIVE_MODEL_IDS = {
  triangle: TRIANGLE_MODEL_ID,
  square: SQUARE_MODEL_ID,   // unit cube
  plane: 10009003,           // 1×1 m XZ plane at scale 10
  sphere: 10009002,          // 1 m diameter at scale 10
  cylinder: 10009008,        // 1 m dia × 1 m height at scale 10
  prism: 10009004,           // 1 m tall, 0.75 m equilateral side at scale 10
  cone: 10009009,            // 0.5 m radius × 1 m height at scale 10, centered
};
const OBJ_GUID_BASE = 1077936129;      // 0x40400001
const DEC_GUID_BASE = 1073741837;      // 0x4000000D
const GRAPH_GUID = 1073741825;         // 0x40000001 (node graph entity)
const HEADER_MAGIC = [1, 806, 3];
const TRAILER = 1657;
const RENDER_DIST = 6700;

// ---------- component writers ----------

// Devices carried by DYNAMIC unit prefabs (envelope: body field = type + 10).
function writeDeviceComponents(b, follow) {
  const effect = (m, field, label) => m.msg(field, (n) => {
    n.vint(3, 1); n.vint(4, 1); n.emptyMsg(5); n.emptyMsg(6); n.f32(7, 1);
    n.emptyMsg(8); n.emptyMsg(10); n.vint(11, 1); n.str(503, label); n.vint(507, 13);
  });
  b.msg(8, (c) => { c.vint(1, 18); c.vint(2, 1); c.msg(28, (m) => {
    effect(m, 9, 'Hit Effect');
    effect(m, 10, 'Knockdown Effect');
    m.str(11, 'GI_RootNode');
  }); });
  for (const [type, field] of [[1, 11], [3, 13], [19, 29], [6, 16], [14, 24]]) {
    b.msg(8, (c) => { c.vint(1, type); c.vint(2, 1); c.emptyMsg(field); });
  }
  if (follow) {
    b.msg(8, (c) => { c.vint(1, 9); c.vint(2, 1); c.msg(19, (m) => {
      m.str(2, 'GI_RootNode');
      m.msg(3, (v) => { v.f32(1, 1); v.f32(3, 1); });
      m.emptyMsg(4);
      m.vint(5, 1200);
      m.vint(6, 1100);
      m.msg(7, (n) => n.emptyMsg(11));
      m.str(502, 'Completely Follow');
    }); });
  }
}

function writeObjectEntry(w, obj) {
  w.msg(1, (e) => {
    e.msg(1, (id) => { id.vint(2, 1); id.vint(3, 1); id.vint(4, obj.guid); });
    for (const d of obj.decorations) {
      e.msg(2, (id) => { id.vint(2, 1); id.vint(3, 14); id.vint(4, d.guid); });
    }
    // the main auto-assemble object owns the node graph entity
    if (obj.graphGuid) e.msg(2, (id) => { id.vint(2, 5); id.vint(4, obj.graphGuid); });
    e.str(3, obj.name);
    e.vint(5, 1);
    e.msg(11, (p) => p.msg(1, (b) => {
      b.vint(1, obj.guid);
      b.vint(2, OBJECT_TEMPLATE_ID);
      // --- field 6 components ---
      // name flag 2:1 marks a STATIC unit prefab; dynamic prefabs omit it
      b.msg(6, (c) => { c.vint(1, 1); c.msg(11, (m) => {
        m.str(1, obj.name);
        if (!obj.dynamic) m.vint(2, 1);
      }); });
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
      // component 3 BINDS the object's node graph: without this body the
      // graph entity is only referenced, not attached (Main object only)
      b.msg(7, (c) => {
        c.vint(1, 3);
        if (obj.graphGuid) {
          c.msg(13, (m) => m.msg(1, (n) => n.msg(1, (k) => {
            k.vint(1, 1);
            k.vint(2, obj.graphGuid);
            k.vint(501, 20000);
          })));
        } else {
          c.emptyMsg(13);
        }
      });
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
      // load optimization: {501:1} = "Do Not Run If Out Of Range" (enabled),
      // {1:1} = "Run If Out Of Range" (disabled; required for auto-assembly)
      b.msg(7, (c) => { c.vint(1, 12); c.msg(22, (m) => {
        if (obj.loadOptimization === false) m.vint(1, 1);
        else m.vint(501, 1);
      }); });
      b.msg(7, (c) => { c.vint(1, 16); c.emptyMsg(26); });
      b.msg(7, (c) => { c.vint(1, 17); c.emptyMsg(27); });
      b.msg(7, (c) => { c.vint(1, 19); c.msg(29, (m) => m.vint(1, 1)); });
      b.msg(7, (c) => { c.vint(1, 20); c.emptyMsg(30); });
      b.msg(7, (c) => { c.vint(1, 22); c.msg(32, (m) => {
        m.vint(3, 0xFFFFFFFF); m.f32(4, 100); m.vint(5, 0xFFFFFF); m.vint(6, RENDER_DIST);
      }); });
      // --- field 8 devices (dynamic unit prefabs only) ---
      if (obj.dynamic) writeDeviceComponents(b, obj.follow);
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
      b.vint(2, PRIMITIVE_MODEL_IDS[dec.kind] ?? TRIANGLE_MODEL_ID);
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

// ---------- node graph (auto-assembly) ----------
//
// Reverse-engineered from the Auto-Assemble samples. The graph is a top-level
// entry of resource_class 9 whose payload (entry field 13) holds a node
// canvas. Node types:
//   71  When Entity Is Created     73  Self Entity
//   99  entity transform getter    252 Create Prefab
//   668 Switch Follow Motion Device Target by Entity
// Exec chain: 71 -> 252 -> 668 -> 252 -> 668 ... (exec-out {1:2} to exec-in
// {1:1}). Data links are stored on the consuming pin and reference the
// producer's output pin ({1:4} / {1:4,2:1}).

const NODE_WHEN_CREATED = 71;
const NODE_SELF_ENTITY = 73;
const NODE_GET_TRANSFORM = 99;
const NODE_CREATE_PREFAB = 252;
const NODE_SWITCH_FOLLOW = 668;

function writeNodeType(n, field, typeId) {
  n.msg(field, (t) => { t.vint(1, 10001); t.vint(2, 20000); t.vint(3, 22000); t.vint(5, typeId); });
}

function writePinId(p, field, id) {
  p.msg(field, (m) => { m.vint(1, id[0]); if (id[1]) m.vint(2, id[1]); });
}

// pin: { id: [g, i], id2?, value?: {cls, dtype, write(v)}, dataType?, link?: {node, pin:[g,i]} }
function writePin(n, pin) {
  n.msg(4, (p) => {
    writePinId(p, 1, pin.id);
    writePinId(p, 2, pin.id2 ?? pin.id);
    if (pin.value) {
      p.msg(3, (v) => {
        v.vint(1, pin.value.cls);
        v.vint(2, 1);
        v.msg(4, (t) => { t.vint(1, 1); t.msg(100, (d) => d.vint(1, pin.value.dtype)); });
        pin.value.write(v);
      });
    }
    if (pin.dataType != null) p.vint(4, pin.dataType);
    if (pin.link) {
      p.msg(5, (l) => {
        l.vint(1, pin.link.node);
        writePinId(l, 2, pin.link.pin);
        writePinId(l, 3, pin.link.pin);
      });
    }
  });
}

const pinPrefab = (guid) => ({ cls: 1, dtype: 21, write: (v) => v.msg(101, (m) => m.vint(1, guid)) });
const pinString = (s) => ({ cls: 5, dtype: 6, write: (v) => v.msg(105, (m) => m.str(1, s)) });
const pinInt = (val) => ({ cls: 6, dtype: 14, write: (v) => v.msg(106, (m) => m.vint(1, val)) });
const pinIntEmpty = { cls: 6, dtype: 4, write: (v) => v.emptyMsg(106) };
const pinEntityEmpty = { cls: 7, dtype: 12, write: (v) => v.msg(107, (m) => m.emptyMsg(1)) };

function writeNode(g, { id, type, pins, x, y }) {
  g.msg(3, (n) => {
    n.vint(1, id);
    writeNodeType(n, 2, type);
    writeNodeType(n, 3, type);
    for (const pin of pins ?? []) writePin(n, pin);
    n.f32(5, x);
    n.f32(6, y);
  });
}

// Auto-assembly graph: spawn each follower prefab and switch its Follow
// Motion Device target to the main entity.
function writeNodeGraphEntry(w, { guid, name, followerGuids }) {
  w.msg(2, (e) => {
    e.msg(1, (id) => { id.vint(2, 5); id.vint(4, guid); });
    e.str(3, name);
    e.vint(5, 9);
    e.msg(13, (f) => f.msg(1, (c) => c.msg(1, (g) => {
      g.msg(1, (h) => { h.vint(1, 10000); h.vint(2, 20000); h.vint(3, 21001); h.vint(5, guid); });
      g.str(2, name);

      const SELF = 4, GET = 5;
      // node ids: mirror the sample layout (first pair uses ids 2/1)
      const cpId = (k) => (k === 0 ? 2 : SELF + 2 * k);
      const swId = (k) => (k === 0 ? 1 : SELF + 2 * k + 1);
      const n = followerGuids.length;

      // event + shared data sources
      writeNode(g, {
        id: 3, type: NODE_WHEN_CREATED, x: -1235, y: -321,
        pins: n ? [{ id: [2], link: { node: cpId(0), pin: [1] } }] : [],
      });
      writeNode(g, { id: SELF, type: NODE_SELF_ENTITY, x: -1184, y: 48, pins: [] });
      writeNode(g, {
        id: GET, type: NODE_GET_TRANSFORM, x: -1334, y: -96,
        pins: [{ id: [3], dataType: 1, link: { node: SELF, pin: [4] } }],
      });

      for (let k = 0; k < n; k++) {
        const x = -844 + k * 1130;
        writeNode(g, {
          id: cpId(k), type: NODE_CREATE_PREFAB, x, y: -260,
          pins: [
            { id: [2], link: { node: swId(k), pin: [1] } },
            { id: [3], value: pinPrefab(followerGuids[k]), dataType: 21 },
            { id: [3, 1], dataType: 12, link: { node: GET, pin: [4] } },
            { id: [3, 2], value: pinEntityEmpty, dataType: 12, link: { node: GET, pin: [4, 1] } },
            { id: [3, 3], dataType: 1, link: { node: SELF, pin: [4] } },
            { id: [3, 5], id2: [3, 7], value: pinIntEmpty, dataType: 4 },
          ],
        });
        const swPins = [
          { id: [3], dataType: 1, link: { node: cpId(k), pin: [4] } },
          { id: [3, 1], dataType: 1, link: { node: SELF, pin: [4] } },
          { id: [3, 2], value: pinString('GI_RootNode'), dataType: 6 },
          { id: [3, 3], value: pinEntityEmpty, dataType: 12 },
          { id: [3, 4], value: pinEntityEmpty, dataType: 12 },
          { id: [3, 5], value: pinInt(1200), dataType: 14 },
          { id: [3, 6], value: pinInt(1100), dataType: 14 },
        ];
        if (k + 1 < n) swPins.unshift({ id: [2], link: { node: cpId(k + 1), pin: [1] } });
        writeNode(g, { id: swId(k), type: NODE_SWITCH_FOLLOW, x: x + 527, y: -259, pins: swPins });
      }
    })));
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
    autoAssemble = false,
  } = opts;

  // assign guids
  let objGuid = opts.objGuidBase ?? OBJ_GUID_BASE;
  let decGuid = opts.decGuidBase ?? DEC_GUID_BASE;
  const prepared = models.map((m, mi) => {
    const main = autoAssemble && mi === 0;
    const obj = {
      name: main ? `(Main) ${m.name}` : m.name,
      position: m.position,
      collision: m.collision ?? collision,
      guid: m.guid ?? objGuid++,
      // auto-assembly: every object is a DYNAMIC unit prefab with load
      // optimization disabled; followers carry a Follow Motion Device.
      // The Main (first) object always owns the node graph.
      dynamic: autoAssemble,
      follow: autoAssemble && !main,
      loadOptimization: autoAssemble ? false : undefined,
      graphGuid: main ? GRAPH_GUID : undefined,
      decorations: m.decorations.map((d, i) => ({
        ...d,
        name: d.name ?? `Decoration_${i + 1}`,
        guid: d.guid ?? decGuid++,
      })),
    };
    return obj;
  });

  const w = new W();
  // the samples list the main auto-assemble object LAST
  const objectOrder = autoAssemble
    ? [...prepared.slice(1), prepared[0]]
    : prepared;
  for (const obj of objectOrder) writeObjectEntry(w, obj);
  for (const obj of prepared) {
    for (const d of obj.decorations) writeDecorationEntry(w, d, obj.guid);
  }
  if (autoAssemble && prepared.length) {
    // always written and attached to the Main object — with a single object
    // the graph simply contains no Create Prefab chains
    writeNodeGraphEntry(w, {
      guid: GRAPH_GUID,
      name: `${exportName} Assemble`,
      followerGuids: prepared.slice(1).map((o) => o.guid),
    });
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
  OBJECT_TEMPLATE_ID, TRIANGLE_MODEL_ID, LEGACY_TRIANGLE_MODEL_ID,
  SQUARE_MODEL_ID, PRIMITIVE_MODEL_IDS, OBJ_GUID_BASE, DEC_GUID_BASE,
  MAX_DECORATIONS_PER_MODEL: 999 };
})();

export const { buildGia, splitIntoModels, MAX_DECORATIONS_PER_MODEL,
  TRIANGLE_MODEL_ID, LEGACY_TRIANGLE_MODEL_ID, SQUARE_MODEL_ID,
  PRIMITIVE_MODEL_IDS, DEC_GUID_BASE } = GIA;
export default GIA;
