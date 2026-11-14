/** The moment a key issued at `from` stops working, for a lifetime in days. */
export function expiryFrom(ttlDays: number | null | undefined, from = new Date()): string | null {
  return ttlDays ? new Date(from.getTime() + ttlDays * 86_400_000).toISOString() : null;
}

export function keyExpired(expiresAt: string | null, now = new Date()): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
}
