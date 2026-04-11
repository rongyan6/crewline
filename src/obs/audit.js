import { appendJsonl } from '../shared/utils/jsonl.js';

export class AuditTrail {
  constructor({ filePath, clock = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
  }

  async record(event) {
    if (!this.filePath) return true;
    await appendJsonl(this.filePath, {
      at: this.clock(),
      ...event
    });
    return true;
  }
}
