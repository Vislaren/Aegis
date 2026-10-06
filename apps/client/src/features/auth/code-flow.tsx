import { router } from 'expo-router';
import { useState } from 'react';
import { identity } from '@aegis/contracts';
import { Banner, Button, Card, Text, TextField } from '@aegis/ui';
import { messageFor } from '../../core/api-client';
import { api, clientDescriptor, loadContexts, useSession } from '../../services/session';

/** Second step of sign-in or invitation acceptance: enter the 6-digit code sent to the contact. */
export function CodeEntry({
  challengeId,
  destinationHint,
  onRestart,
}: {
  challengeId: string;
  destinationHint: string;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api.request('/api/v1/auth/otp/verify', {
        method: 'POST',
        body: { challengeId, code, client: clientDescriptor() },
        schema: identity.SessionResponse,
      });
      await useSession.getState().setFromResponse(response);
      if (!response.session.mfaRequiredForPrivilegedUse)
        await loadContexts().catch(() => undefined);
      router.replace('/');
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text>
        If {destinationHint} is registered with Aegis, a 6-digit code was sent to it. It expires in
        5 minutes.
      </Text>
      <TextField
        label="6-digit code"
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        error={error}
        onSubmitEditing={() => void verify()}
      />
      <Button
        label="Continue"
        busy={busy}
        disabled={code.length !== 6}
        onPress={() => void verify()}
      />
      <Button label="Use a different email or phone" variant="secondary" onPress={onRestart} />
    </Card>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <Banner
      tone="neutral"
      title="Aegis supports, and never replaces, your school's transport supervision and emergency procedures."
      message={text}
    />
  );
}
