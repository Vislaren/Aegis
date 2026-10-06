import { Stack, router } from 'expo-router';
import { Banner, Button, Screen, Text } from '@aegis/ui';

/**
 * Guardian home. Linked-child transport status, honest freshness, absence declarations, and
 * notifications arrive in Phase 5; until then nothing child-related is fetched or shown.
 */
export default function GuardianHome() {
  return (
    <Screen title="Guardian">
      <Stack.Screen options={{ title: 'Guardian' }} />
      <Banner
        tone="info"
        title="Transport status is not available yet"
        message="Your account is ready. Bus and trip updates for your linked children will appear here once your school enables live transport."
      />
      <Text tone="muted">For anything urgent, contact your school directly.</Text>
      <Button label="My account" variant="secondary" onPress={() => router.push('/account')} />
    </Screen>
  );
}
