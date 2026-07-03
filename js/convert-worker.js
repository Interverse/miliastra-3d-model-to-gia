// Web Worker: runs the conversion pipeline off the main thread.
import { convert } from '../engine/convert/converter.js';
import { buildPreview } from './preview-mesh.js';

self.onmessage = (ev) => {
  const { meshes, sprite, params, jobId } = ev.data;
  try {
    const result = convert(sprite ? { sprite } : { meshes }, params);
    // Build preview geometry from the QUANTIZED decoration records so the
    // overlay shows exactly what the .gia file will contain.
    const { positions, colors, owners } = buildPreview(result.decorations, result.params);
    self.postMessage({
      jobId,
      ok: true,
      decorations: result.decorations,
      stats: result.stats,
      positions,
      colors,
      owners,
    }, [positions.buffer, colors.buffer, owners.buffer]);
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String(err && err.stack || err) });
  }
};
