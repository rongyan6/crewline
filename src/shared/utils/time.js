function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function extractOffset(timeZoneName) {
  if (!timeZoneName || timeZoneName === 'GMT' || timeZoneName === 'UTC') return '+00:00';
  const normalized = timeZoneName.replace(/^GMT/, '').replace(/^UTC/, '');
  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return '+00:00';
  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

export function formatLocalTimestamp(value = new Date(), timeZone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  const parts = zonedParts(date, timeZone);
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const timeZoneName = offsetParts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  const offset = extractOffset(timeZoneName);
  const milliseconds = pad(date.getMilliseconds(), 3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${offset}`;
}

export function nowIso(timeZone = 'UTC') {
  return formatLocalTimestamp(new Date(), timeZone);
}
