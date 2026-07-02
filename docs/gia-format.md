# .gia Decoration Format (reverse-engineered)

Findings from the seven sample files (engine version 6.7.0). All verified by
byte-level decoding; the writer in `engine/gia/gia-writer.js` reproduces the
samples byte-for-byte given the same inputs.

## File container

```
offset 0   uint32 BE   file_length - 4
offset 4   uint32 BE   1                (constant)
offset 8   uint32 BE   806              (constant, format/version code)
offset 12  uint32 BE   3                (constant, matches ResourceClass=OBJECT_ENTITY? unused)
offset 16  uint32 BE   payload_length   (= file_length - 24)
offset 20  bytes       AssetBundle protobuf payload
tail       uint32 BE   1657             (constant trailer)
```

## AssetBundle payload (proto3)

- field 1 (repeated) — object `ResourceEntry`, one per model. Multiple models
  per file are simply multiple field-1 entries (see Asset Pack sample).
- field 2 (repeated) — decoration `ResourceEntry`, all decorations of all
  objects, in object order.
- field 3 — export tag string: `{UID}-{UNIX_TIME}-{FILE_ID}-\{FILENAME}.gia`
  (sample: `600489258-1782952020-1073742021-\White Triangle.gia`)
- field 5 — engine version string `"6.7.0"`

## Object ResourceEntry (resource_class = 1, OBJECT)

```
1: identity        { 2:1, 3:1(PREFAB), 4: object_guid }
2: reference_list  repeated { 2:1, 3:14(DECORATION), 4: decoration_guid }
3: internal_name   string (model name)
5: resource_class  1
11: prefab {
  1: body {
    1: object_guid
    2: 10005018                  // "MPActionGroup" template id
    6: components (repeated, see below)
    7: entity components (repeated, see below)
    10: 1
  }
}
```

### Object body field 6 components (order matters for byte-exactness)

Envelope: `{ 1: type_id, <body_field>: body }` where body_field varies by type.

| type | body field | content |
|------|-----------|---------|
| 1    | 11 | `{1: name, 2: 1}` display name |
| 13   | 22 | `{4: 0xFFFFFFFF}` object tint ARGB |
| 14   | 23 | `{1: {3: "MPActionGroup"}}` |
| 38   | 48 | `{1: 1.0f}` |
| 40   | 50 | `{501: packed varint list of child decoration guids}` |
| 111  | 93 | empty msg |
| 61   | 65 | empty msg |
| 62   | 66 | empty msg |

### Object body field 7 components

| type | body field | content |
|------|-----------|---------|
| 1  | 11 | transform `{1: position Vec3f, 2: rotation (empty), 3: scale Vec3f = (0.1,0.1,0.1), 501: 0xFFFFFFFF}` |
| 2  | 12 | empty |
| 3  | 13 | empty |
| 4  | 14 | `{1:1}` |
| 5  | 15 | `{1:1, 2:1}` |
| 6  | 16 | empty |
| 7  | 17 | `{1:1000f, 3:500f, 4:1, 5:1, 6:{2:10200002}, 8..15: 0.1f}` |
| 8  | 18 | `{1:1, 501:1}` |
| 11 | 21 | `{1: {1:"GI_RootNode", 2:"", 3:"", 502:"Center Origin", 504:1, 505:"RootNode"}}` |
| 12 | 22 | `{501:1}` |
| 16 | 26 | empty |
| 17 | 27 | empty |
| 19 | 29 | `{1:1}` |
| 20 | 30 | empty |
| 22 | 32 | `{3: 0xFFFFFFFF, 4: 100f, 5: 0xFFFFFF, 6: 6700}` render params |

The object transform position is the scene placement at export time; scale is
always `(0.1, 0.1, 0.1)`. **All decoration-local coordinates are multiplied by
0.1 to get meters.**

### Collision (object entity component 5)

- Collision enabled (default): `{1:5, 15:{1:1, 2:1}}`
- Collision disabled: `{1:5, 15: <empty message>}`

(Confirmed by diffing `White Square.gia` vs `White Square No Collision.gia` —
this is the only structural difference.)

## Decoration ResourceEntry (resource_class = 28, DECORATION)

```
1: identity  { 2:1, 3:14, 4: dec_guid }
3: "Decoration_N"
5: 28
21: payload {
  1: body {
    1: dec_guid
    2: model_id         // 20002125 = right triangle, 10009001 = square
    3: 1
    4: components: {1:1, 11:{1:"Decoration_N"}}, {1:40, 50:{502: parent_object_guid}}, {1:111, 93: empty}
    5: components (in this order):
        {1:1,  11: {1: position Vec3f, 2: rotation Vec3f, 3: scale Vec3f}}
        {1:5,  15: {1:1, 2:1}}
        {1:2,  12: empty}
        {1:22, 32: {1:1, 3: color ARGB uint32, 4: 100f, 5: color RGB uint32, 6: 6700}}
    11: "" (empty)
  }
}
```

### Vec3f encoding

`{1: x float, 2: y float, 3: z float}`. For **position and rotation**, zero
components are omitted; an all-zero vector is an empty message. For **scale**
all three components are always written (even 1.0).

### Transform semantics

- Local units: 0.1 m (because the object node is scaled 0.1).
  `position_units = meters * 10`.
- Rotation: Euler angles in degrees, fields x/y/z. Samples show y=90, y=180,
  and (x=180, y=90). Application order assumed Unity-style intrinsic Y·X·Z
  (configurable in the converter as it cannot be fully determined from the
  samples alone).
- Scale: per-axis.
  - **Triangle (20002125)**: 0.5 m legs (5 local units) along local +Y and
    +Z at scale 1, right-angle corner at the local origin, thin along local
    X. `scale_yz = leg_meters * 2`. X scale controls thickness.
  - **Square (10009001)**: 0.1 m edges (1 local unit) along local X and Z at
    scale 1, centered at the local origin, thin along local Y.
    `scale_xz = edge_meters * 10` (White Square.gia: 1×1 m at scale
    (10, 0.01, 10)). Y scale controls thickness.

### Colors

Decoration color appears twice in component 22: field 3 = ARGB
(`0xAARRGGBB`), field 5 = RGB (`0xRRGGBB`). White `0xFFFFFFFF/0xFFFFFF`, red
`0xFFFF0000/0xFF0000`, green `0xFF00FF00/0x00FF00`.

### GUIDs

Object guids start at 1077936129 (0x40400001), decoration guids at
1073741837 (0x4000000D); unique within a file. The samples reuse guids across
files, so they only need to be file-unique.

### Limits

Max 999 decorations per object model. Split into multiple objects (multiple
field-1 entries at the same transform) when exceeding it.
