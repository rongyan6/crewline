export class AsyncTextStream {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    if (this.waiters.length) {
      const resolve = this.waiters.shift();
      resolve({ value, done: false });
      return;
    }
    this.queue.push(value);
  }

  close() {
    this.closed = true;
    while (this.waiters.length) {
      const resolve = this.waiters.shift();
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}
