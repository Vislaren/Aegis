export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function secondsBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / 1000;
}

/** A clock port so services and tests can control time explicitly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
