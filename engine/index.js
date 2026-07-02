// Reusable conversion engine — no DOM or three.js dependencies.
// Usable from the website, Node.js scripts, or other tools:
//
//   import { convert, buildGia, splitIntoModels } from './engine/index.js';
//   const { decorations, stats } = convert(meshes, { colorTolerance: 30 });
//   const bytes = buildGia({ models: splitIntoModels('My Model', decorations),
//                            exportName: 'My Model' });
//   fs.writeFileSync('My Model.gia', bytes);

export { convert, DEFAULT_PARAMS, PRESETS, placementToDecoration } from './convert/converter.js';
export { decomposeTriangle, placementFromRightTriangle, DEFAULT_CANONICAL } from './convert/right-triangles.js';
export { mergeCoplanarTriangles } from './convert/mesh-ops.js';
export { colorDistance, sampleTriangleColor, colorToRgbInt } from './convert/color.js';
export { pairIntoSquares, squarePlacement } from './convert/squares.js';
export { coalesceSquares } from './convert/coalesce.js';
export { decimateTriangles } from './convert/decimate.js';
export { spriteToTriangles } from './convert/sprite.js';
export { buildGia, splitIntoModels, MAX_DECORATIONS_PER_MODEL,
  TRIANGLE_MODEL_ID, SQUARE_MODEL_ID } from './gia/gia-writer.js';
export * as vec3 from './convert/vec3.js';
