import { appendJsonl, writeJson } from '../shared/utils/jsonl.js';

function buildKey(name, tags = {}) {
  const sorted = Object.entries(tags).sort(([left], [right]) => left.localeCompare(right));
  return `${name}|${sorted.map(([key, value]) => `${key}=${value}`).join(',')}`;
}

function normalizeTags(tags = {}) {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)])
  );
}

export class Metrics {
  constructor({ filePath, snapshotPath, clock = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.snapshotPath = snapshotPath;
    this.clock = clock;
    this.counters = new Map();
    this.timings = new Map();
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
      updatedAt: this.clock()
    };
  }

  async persistSnapshot() {
    if (!this.snapshotPath) return;
    await writeJson(this.snapshotPath, this.snapshot());
  }

  async appendEvent(event) {
    if (!this.filePath) return;
    await appendJsonl(this.filePath, event);
  }

  async increment(name, value = 1, tags = {}) {
    const normalizedTags = normalizeTags(tags);
    const key = buildKey(name, normalizedTags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    await this.appendEvent({
      at: this.clock(),
      type: 'counter',
      name,
      value,
      tags: normalizedTags
    });
    await this.persistSnapshot();
  }

  async timing(name, valueMs, tags = {}) {
    const normalizedTags = normalizeTags(tags);
    const key = buildKey(name, normalizedTags);
    const current = this.timings.get(key) ?? {
      count: 0,
      totalMs: 0,
      minMs: valueMs,
      maxMs: valueMs
    };
    current.count += 1;
    current.totalMs += valueMs;
    current.minMs = Math.min(current.minMs, valueMs);
    current.maxMs = Math.max(current.maxMs, valueMs);
    current.avgMs = Number((current.totalMs / current.count).toFixed(2));
    this.timings.set(key, current);
    await this.appendEvent({
      at: this.clock(),
      type: 'timing',
      name,
      valueMs,
      tags: normalizedTags
    });
    await this.persistSnapshot();
  }
}
