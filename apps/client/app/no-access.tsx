import { Stack, router } from 'expo-router';
import { Banner, Button, Screen } from '@aegis/ui';
import { signOut } from '../src/services/session';

export default function NoAccess() {
  return (
    <Screen title="No active access">
      <Stack.Screen options={{ title: 'Aegis' }} />
      <Banner
        tone="neutral"
        title="Your account has no active role yet"
        message="If you were just invited, finish accepting the invitation from its link. Otherwise contact your school's transport office."
      />
      <Button label="My account" variant="secondary" onPress={() => router.push('/account')} />
      <Button
        label="Sign out"
        variant="secondary"
        onPress={() => void signOut().then(() => router.replace('/sign-in'))}
      />
    </Screen>
  );
}
