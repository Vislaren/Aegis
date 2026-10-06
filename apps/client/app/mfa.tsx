import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { identity } from '@aegis/contracts';
import { Banner, Button, Card, Screen, Text, TextField } from '@aegis/ui';
import { messageFor } from '../src/core/api-client';
import { api, loadContexts, useSession } from '../src/services/session';

/** Authenticator (TOTP) enrollment and verification. Required for every administration operator. */
export default function Mfa() {
  const { mode } = useLocalSearchParams<{ mode?: 'enroll' | 'verify' }>();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'enroll') return;
    api
      .request('/api/v1/auth/mfa/totp/enroll', {
        method: 'POST',
        schema: identity.TotpEnrollResponse,
      })
      .then(setEnrollment)
      .catch((e: unknown) => setError(messageFor(e)));
  }, [mode]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'enroll' ? '/api/v1/auth/mfa/totp/activate' : '/api/v1/auth/mfa/verify';
      const response = await api.request(path, {
        method: 'POST',
        body: { code },
        schema: identity.SessionResponse,
      });
      await useSession.getState().setFromResponse(response);
      await loadContexts();
      router.replace('/');
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={mode === 'enroll' ? 'Set up your authenticator' : 'Confirm with your authenticator'}
    >
      <Stack.Screen options={{ title: 'Multi-factor verification' }} />
      <Banner
        tone="info"
        title="Administration requires multi-factor verification"
        message="This protects school and child data if your email or phone is ever compromised."
      />
      {mode === 'enroll' && enrollment !== null ? (
        <Card>
          <Text>
            Add Aegis to an authenticator app (for example, one approved by your organization).
            Enter this setup key manually; do not share it or take screenshots of it.
          </Text>
          <Text variant="label">{enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}</Text>
        </Card>
      ) : null}
      <Card>
        <TextField
          label="6-digit authenticator code"
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          error={error}
          onSubmitEditing={() => void submit()}
        />
        <Button
          label="Verify"
          busy={busy}
          disabled={code.length !== 6}
          onPress={() => void submit()}
        />
      </Card>
    </Screen>
  );
}
