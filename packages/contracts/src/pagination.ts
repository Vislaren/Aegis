/**
 * Opaque keyset cursors: base64url of `<ISO timestamp>|<uuid>`. Cursors are not authorization;
 * every query re-applies the caller's scope.
 */
export interface CursorPosition {
  at: Date;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.at.toISOString()}|${position.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorPosition | null {
  if (cursor === undefined) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [at, id] = raw.split('|');
  if (at === undefined || id === undefined) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at: date, id };
}
