export function startHeartbeat(task, { intervalMs = 3000, startDelayMs = 0 } = {}) {
  let tickInFlight = false;
  let stopped = false;
  let timer = null;

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      if (tickInFlight) {
        schedule(intervalMs);
        return;
      }
      tickInFlight = true;
      Promise.resolve()
        .then(() => task())
        .catch(() => {})
        .finally(() => {
          tickInFlight = false;
          schedule(intervalMs);
        });
    }, delayMs);
  };

  schedule(startDelayMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      tickInFlight = false;
    }
  };
}
