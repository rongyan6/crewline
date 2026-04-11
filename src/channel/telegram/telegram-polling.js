function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramPollingLoop {
  constructor({ fetchUpdates, onError, idleDelayMs = 250, retryDelayMs = 3_000 }) {
    this.fetchUpdates = fetchUpdates;
    this.onError = onError;
    this.idleDelayMs = idleDelayMs;
    this.retryDelayMs = retryDelayMs;
    this.running = false;
    this.task = null;
  }

  async start(onUpdate) {
    if (this.task) return this.task;
    this.running = true;
    this.task = (async () => {
      while (this.running) {
        try {
          const updates = await this.fetchUpdates();
          for (const update of updates) {
            if (!this.running) break;
            await onUpdate(update);
          }
          if (!updates.length) {
            await delay(this.idleDelayMs);
          }
        } catch (error) {
          await this.onError?.(error);
          if (!this.running) break;
          await delay(this.retryDelayMs);
        }
      }
    })();
    return this.task;
  }

  stop() {
    this.running = false;
    return this.task;
  }
}
