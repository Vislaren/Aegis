import { Redirect, Stack, router } from 'expo-router';
import { Button, Screen, Text } from '@aegis/ui';
import { availableContexts, routeFor } from '../src/core/navigation';
import { useSession } from '../src/services/session';

/** People with several roles pick one active context; nothing merges data between contexts. */
export default function Choose() {
  const contexts = useSession((s) => s.contexts);
  if (contexts === null) return <Redirect href="/" />;
  const options = availableContexts(contexts);
  return (
    <Screen title="Choose where to continue">
      <Stack.Screen options={{ title: 'Your roles' }} />
      <Text tone="muted">You can switch at any time from your account page.</Text>
      {options.map((option) => (
        <Button
          key={option.label}
          label={option.label}
          variant="secondary"
          onPress={() => router.push(routeFor(option) as never)}
        />
      ))}
      <Button label="My account" variant="secondary" onPress={() => router.push('/account')} />
    </Screen>
  );
}
