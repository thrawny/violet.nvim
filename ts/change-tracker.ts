export type BufferChange = {
  filePath: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  oldText: string;
  newText: string;
  timestamp: number;
};

export class ChangeTracker {
  private changes: BufferChange[] = [];
  private maxChanges: number;

  constructor(maxChanges = 200) {
    this.maxChanges = maxChanges;
  }

  addChange(change: Omit<BufferChange, "timestamp">): void {
    if (!change.filePath) {
      return;
    }

    this.changes.push({
      ...change,
      timestamp: Date.now(),
    });

    if (this.changes.length > this.maxChanges) {
      this.changes.splice(0, this.changes.length - this.maxChanges);
    }
  }

  getChanges(): BufferChange[] {
    return this.changes;
  }
}
