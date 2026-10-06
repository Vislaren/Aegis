import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Stack, router } from 'expo-router';
import { audit, identity } from '@aegis/contracts';
import { Banner, Button, Card, Heading, Screen, Text } from '@aegis/ui';
import { messageFor } from '../src/core/api-client';
import { api, signOut } from '../src/services/session';

/** Common capabilities for every role: own profile, sessions, security events, consents, sign out. */
export default function Account() {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.request('/api/v1/me', { schema: identity.MeResponse }),
  });
  const sessions = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.request('/api/v1/me/sessions', { schema: identity.SessionListResponse }),
  });
  const events = useQuery({
    queryKey: ['my-security-events'],
    queryFn: () =>
      api.request('/api/v1/me/security-events?limit=20', {
        schema: audit.SecurityEventListResponse,
      }),
  });
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () =>
      api.request('/api/v1/policies/current', { schema: identity.PolicyDocumentsResponse }),
  });
  const consents = useQuery({
    queryKey: ['my-consents'],
    queryFn: () => api.request('/api/v1/me/consents', { schema: identity.ConsentListResponse }),
  });

  const revoke = useMutation({
    mutationFn: (sessionId: string) =>
      api.request(`/api/v1/me/sessions/${sessionId}/revoke`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['my-sessions'] }),
  });
  const acknowledge = useMutation({
    mutationFn: (doc: { type: string; version: string }) =>
      api.request('/api/v1/me/consents', {
        method: 'POST',
        body: { documentType: doc.type, documentVersion: doc.version },
        schema: identity.ConsentRecordView,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['my-consents'] }),
  });

  const acknowledged = new Set(
    (consents.data?.items ?? []).map((c) => `${c.documentType}@${c.documentVersion}`),
  );

  return (
    <Screen title="My account">
      <Stack.Screen options={{ title: 'Account' }} />
      {me.data !== undefined ? (
        <Card>
          <Text variant="label">{me.data.displayName}</Text>
          <Text tone="muted">{me.data.email ?? me.data.phoneE164}</Text>
          <Text tone="muted" variant="caption">
            Multi-factor verification: {me.data.mfaEnrolled ? '✓ set up' : '• not set up'}
          </Text>
        </Card>
      ) : null}

      <Heading>Signed-in devices</Heading>
      {revoke.isError ? (
        <Banner
          tone="danger"
          title="Could not sign out that device"
          message={messageFor(revoke.error)}
          live
        />
      ) : null}
      {sessions.data?.items.map((s) => (
        <Card key={s.sessionId}>
          <Text variant="label">
            {s.deviceName ?? s.platform} {s.current ? '(this device)' : ''}
          </Text>
          <Text tone="muted" variant="caption">
            Last active {new Date(s.lastSeenAt).toLocaleString()}
          </Text>
          {s.current ? null : (
            <Button
              label="Sign out this device"
              variant="secondary"
              onPress={() => revoke.mutate(s.sessionId)}
            />
          )}
        </Card>
      ))}

      <Heading>Privacy and terms</Heading>
      {policies.data?.documents.map((doc) => (
        <Card key={doc.type}>
          <Text variant="label">
            {doc.title} (version {doc.version})
          </Text>
          {acknowledged.has(`${doc.type}@${doc.version}`) ? (
            <Text tone="muted">✓ Acknowledged</Text>
          ) : (
            <Button
              label={`Acknowledge ${doc.title}`}
              variant="secondary"
              onPress={() => acknowledge.mutate({ type: doc.type, version: doc.version })}
            />
          )}
        </Card>
      ))}

      <Heading>Recent security activity</Heading>
      {events.data?.items.map((e) => (
        <Text key={e.id} tone="muted" variant="caption">
          {new Date(e.occurredAt).toLocaleString()}: {e.eventType.replace(/_/g, ' ').toLowerCase()}{' '}
          ({e.outcome.toLowerCase()})
        </Text>
      ))}

      <Text tone="muted" variant="caption">
        App version {Constants.expoConfig?.version ?? 'unknown'}. Safety notifications required by
        your school cannot be turned off.
      </Text>
      <Button label="Switch role" variant="secondary" onPress={() => router.replace('/')} />
      <Button
        label="Sign out"
        variant="danger"
        onPress={() =>
          void signOut().then(() => {
            queryClient.clear();
            router.replace('/sign-in');
          })
        }
      />
    </Screen>
  );
}
