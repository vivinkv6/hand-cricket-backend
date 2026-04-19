export function isValidRoomId(roomId: unknown): roomId is string {
  if (typeof roomId !== 'string') {
    return false;
  }

  const normalized = roomId.trim();
  return (
    normalized.length > 0 &&
    normalized.toLowerCase() !== 'undefined' &&
    normalized.toLowerCase() !== 'null'
  );
}

export function normalizeRoomId(roomId: string) {
  return roomId.trim().toUpperCase();
}
