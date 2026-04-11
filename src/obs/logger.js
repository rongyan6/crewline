import util from 'node:util';

function formatArg(value) {
  if (typeof value === 'string') return value;
  return util.inspect(value, {
    depth: 8,
    compact: true,
    breakLength: Infinity,
    colors: false,
    maxArrayLength: 50
  });
}

function write(method, level, args) {
  const timestamp = new Date().toISOString();
  const rendered = args.map(formatArg).join(' ');
  method(`[${timestamp}] [${level.toUpperCase()}] ${rendered}`);
}

export function createLogger() {
  return {
    info: (...args) => write(console.log, 'info', args),
    warn: (...args) => write(console.warn, 'warn', args),
    error: (...args) => write(console.error, 'error', args),
    debug: (...args) => write(console.debug, 'debug', args)
  };
}
