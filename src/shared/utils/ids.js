import crypto from 'node:crypto';

export function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}
