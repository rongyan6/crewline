import fs from 'node:fs/promises';
import { appendJsonl, readJsonl } from '../../shared/utils/jsonl.js';

export class ConversationLog {
  async append(entry) {
    const filePath = entry.path;
    const value = { ...entry };
    delete value.path;
    await appendJsonl(filePath, value);
  }

  async readAll(filePath) {
    return readJsonl(filePath);
  }

  async clear(filePath) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async countRole(filePath, role) {
    const entries = await this.readAll(filePath);
    return entries.filter((entry) => entry.role === role).length;
  }
}
