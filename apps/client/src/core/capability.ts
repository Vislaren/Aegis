/**
 * Driver trip capability. Background location needs a native development or production build;
 * the web client and Expo Go cannot provide the guarantees, so trips must not start there.
 * Phase 3 adds permission, GPS, time-sync, battery, and local-database checks to this list.
 */
export interface PlatformFacts {
  os: 'ios' | 'android' | 'web' | 'other';
  /** expo-constants executionEnvironment: 'bare' | 'standalone' | 'storeClient' (Expo Go). */
  executionEnvironment: string | null;
}

export type CapabilityCheck = { id: string; ok: boolean; message: string };

export function driverCapability(facts: PlatformFacts): {
  canOperateTrips: boolean;
  checks: CapabilityCheck[];
} {
  const native = facts.os === 'ios' || facts.os === 'android';
  const realBuild =
    facts.executionEnvironment === 'bare' || facts.executionEnvironment === 'standalone';
  const checks: CapabilityCheck[] = [
    {
      id: 'native-platform',
      ok: native,
      message: native
        ? 'Running on a phone.'
        : 'Trips can only be operated from the Aegis app on an Android or iOS phone. The web version cannot track the bus in the background.',
    },
    {
      id: 'native-build',
      ok: native && realBuild,
      message: realBuild
        ? 'Installed Aegis app build.'
        : 'This preview app cannot keep tracking when the screen is locked. Install the official Aegis app.',
    },
  ];
  return { canOperateTrips: checks.every((c) => c.ok), checks };
}
