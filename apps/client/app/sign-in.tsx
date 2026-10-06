import { Stack } from 'expo-router';
import { useState } from 'react';
import { identity } from '@aegis/contracts';
import { Button, Card, Screen, Text, TextField } from '@aegis/ui';
import { messageFor } from '../src/core/api-client';
import { CodeEntry, Notice } from '../src/features/auth/code-flow';
import { api } from '../src/services/session';

export default function SignIn() {
  const [identifier, setIdentifier] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const challenge = await api.request('/api/v1/auth/otp/start', {
        method: 'POST',
        body: { identifier },
        schema: identity.OtpChallengeResponse,
      });
      setChallengeId(challenge.challengeId);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Sign in to Aegis">
      <Stack.Screen options={{ title: 'Sign in' }} />
      {challengeId === null ? (
        <Card>
          <Text>
            Enter the email address or phone number your school or Aegis registered for you.
            Accounts are created by invitation only.
          </Text>
          <TextField
            label="Email or phone (+country code)"
            value={identifier}
            onChangeText={setIdentifier}
            autoComplete="email"
            keyboardType="email-address"
            error={error}
            onSubmitEditing={() => void start()}
          />
          <Button
            label="Send me a code"
            busy={busy}
            disabled={identifier.trim().length < 3}
            onPress={() => void start()}
          />
        </Card>
      ) : (
        <CodeEntry
          challengeId={challengeId}
          destinationHint={identifier}
          onRestart={() => setChallengeId(null)}
        />
      )}
      <Notice text="Never share your code. Aegis staff will never ask for it." />
    </Screen>
  );
}
