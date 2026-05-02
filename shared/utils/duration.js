const DURATION_PATTERN = /^(\d+)([smhd])$/i;
const UNIT_TO_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function durationToMs(value, fallbackMs) {
  if (!value) {
    return fallbackMs;
  }

  const match = String(value).trim().match(DURATION_PATTERN);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * UNIT_TO_MS[unit];
}

function durationToSeconds(value, fallbackSeconds) {
  return Math.floor(durationToMs(value, fallbackSeconds * 1000) / 1000);
}

module.exports = {
  durationToMs,
  durationToSeconds,
};
