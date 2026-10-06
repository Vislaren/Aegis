import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { identity } from '@aegis/contracts';
import { Banner, Button, Screen } from '@aegis/ui';
import { messageFor } from '../src/core/api-client';
import { CodeEntry } from '../src/features/auth/code-flow';
import { api } from '../src/services/session';

/**
 * Invitation links carry the token in the URL fragment (`/invite#token=...`) so it never reaches
 * server logs. Native deep links may pass it as a query parameter instead.
 */
function readToken(param: string | undefined, url: string | null): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (fromHash !== null) {
      // Remove the token from the address bar and history once read.
      window.history.replaceState(null, '', window.location.pathname);
      return fromHash;
    }
  }
  if (param !== undefined) return param;
  if (url === null) return null;
  const hash = url.split('#')[1];
  return hash === undefined ? null : new URLSearchParams(hash).get('token');
}

export default function Invite() {
  const params = useLocalSearchParams<{ token?: string }>();
  const url = Linking.useURL();
  const [token] = useState(() => readToken(params.token, url));
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function redeem(): Promise<void> {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await api.request('/api/v1/auth/invitations/redeem', {
        method: 'POST',
        body: { token },
        schema: identity.OtpChallengeResponse,
      });
      setChallengeId(challenge.challengeId);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void redeem();
    // Redeem exactly once per mounted link.
  }, []);

  return (
    <Screen title="Accept your invitation">
      <Stack.Screen options={{ title: 'Invitation' }} />
      {token === null ? (
        <Banner
          tone="danger"
          title="This invitation link is incomplete"
          message="Open the link from your invitation message again, or ask your administrator for a new invitation."
        />
      ) : null}
      {error !== null ? (
        <>
          <Banner tone="danger" title="This invitation cannot be used" message={error} live />
          <Button label="Try again" busy={busy} onPress={() => void redeem()} />
        </>
      ) : null}
      {challengeId !== null ? (
        <CodeEntry
          challengeId={challengeId}
          destinationHint="your invited email or phone"
          onRestart={() => void redeem()}
        />
      ) : null}
    </Screen>
  );
}
