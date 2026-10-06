import Constants from 'expo-constants';
import { Stack, router } from 'expo-router';
import { Platform } from 'react-native';
import { Banner, Button, Card, Heading, Screen, Text } from '@aegis/ui';
import { driverCapability } from '../../src/core/capability';

/**
 * Driver home. Phase 1 shows device capability honestly; assigned trips, the manifest, offline
 * events, and the end-of-trip sweep arrive with trip-service in Phase 3.
 */
export default function DriverHome() {
  const capability = driverCapability({
    os:
      Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web'
        ? Platform.OS
        : 'other',
    executionEnvironment: Constants.executionEnvironment ?? null,
  });
  return (
    <Screen title="Driver">
      <Stack.Screen options={{ title: 'Driver' }} />
      {capability.canOperateTrips ? (
        <Banner tone="success" title="This phone can operate trips" />
      ) : (
        <Banner
          tone="warning"
          title="Trips cannot be started on this device"
          message="Use the installed Aegis app on your assigned Android or iOS phone."
        />
      )}
      <Heading>Device checks</Heading>
      {capability.checks.map((check) => (
        <Card key={check.id}>
          <Text variant="label">{check.ok ? '✓ Ready' : '✕ Not ready'}</Text>
          <Text>{check.message}</Text>
        </Card>
      ))}
      <Banner
        tone="info"
        title="No trips are available yet"
        message="Trip operation is not enabled in this version. Follow your school's paper manifest and procedures."
      />
      <Button
        label="My account"
        variant="secondary"
        size="driver"
        onPress={() => router.push('/account')}
      />
    </Screen>
  );
}
