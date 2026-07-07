// Undo/redo history for reconstruction edits.
//
// Snapshot-based: each entry deep-copies the decoration array of one
// reconstruction. Snapshots are labeled and keyed by reconstruction id, so
// undoing never applies a snapshot to the wrong reconstruction.

const LIMIT = 50;

export function cloneDecorations(decorations) {
  return decorations.map((d) => ({
    ...d,
    position: { ...d.position },
    rotationDeg: { ...d.rotationDeg },
    scale: { ...d.scale },
  }));
}

export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  // Capture the current state BEFORE a mutation.
  push(reconId, decorations, label = "edit") {
    this.undoStack.push({ reconId, label, decorations: cloneDecorations(decorations) });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(reconId) {
    return this.undoStack.length > 0 && this.undoStack.at(-1).reconId === reconId;
  }

  canRedo(reconId) {
    return this.redoStack.length > 0 && this.redoStack.at(-1).reconId === reconId;
  }

  // Both return the decoration array to restore (or null). The caller passes
  // the CURRENT decorations so the inverse operation can be recorded.
  undo(reconId, currentDecorations) {
    if (!this.canUndo(reconId)) return null;
    const snap = this.undoStack.pop();
    this.redoStack.push({ reconId, label: snap.label, decorations: cloneDecorations(currentDecorations) });
    return snap.decorations;
  }

  redo(reconId, currentDecorations) {
    if (!this.canRedo(reconId)) return null;
    const snap = this.redoStack.pop();
    this.undoStack.push({ reconId, label: snap.label, decorations: cloneDecorations(currentDecorations) });
    return snap.decorations;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
