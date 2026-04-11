import fs from 'node:fs/promises';
import { readJson, writeJson } from '../../shared/utils/jsonl.js';

export class RuntimeBindingStore {
  constructor(pathResolver) {
    this.pathResolver = pathResolver;
  }

  async get(conversationRef) {
    return readJson(this.pathResolver(conversationRef), null);
  }

  async set(conversationRef, value) {
    await writeJson(this.pathResolver(conversationRef), value);
  }

  async delete(conversationRef) {
    try {
      await fs.rm(this.pathResolver(conversationRef), { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
