export function normalizePlayerName(name: string) {
  return name.trim().replace(/\s+/g, ' ').slice(0, 24);
}

export function validatePlayerName(name: string) {
  const normalized = normalizePlayerName(name);
  if (!normalized) {
    throw new Error('Player name is required.');
  }

  return normalized;
}
