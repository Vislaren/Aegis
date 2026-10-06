import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { administration } from '@aegis/contracts';
import { Banner, Button, Card, Heading, Row, Text, TextField } from '@aegis/ui';
import { messageFor } from '../../../src/core/api-client';
import { WorkspaceGate } from '../../../src/features/admin/workspace';
import { api } from '../../../src/services/session';

/** School console: people of this school only. The server binds every write to this school. */
export default function SchoolHome() {
  const { schoolId } = useLocalSearchParams<{ schoolId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'School administration' }} />
      <WorkspaceGate workspace={{ type: 'SCHOOL', schoolId }} title="People">
        {(lease) => (
          <People schoolId={schoolId} schoolName={lease.workspace.schoolName ?? 'your school'} />
        )}
      </WorkspaceGate>
    </>
  );
}

const ROLES = [
  { value: 'DRIVER', label: 'Driver' },
  { value: 'GUARDIAN', label: 'Guardian' },
] as const;

function People({ schoolId, schoolName }: { schoolId: string; schoolName: string }) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['memberships', schoolId],
    queryFn: () =>
      api.request(`/api/v1/schools/${schoolId}/memberships?limit=100`, {
        schema: administration.MembershipListResponse,
      }),
  });
  const [displayName, setDisplayName] = useState('');
  const [contact, setContact] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]['value']>('DRIVER');
  const [reason, setReason] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['memberships', schoolId] });

  const invite = useMutation({
    mutationFn: () =>
      api.request(`/api/v1/schools/${schoolId}/user-invitations`, {
        method: 'POST',
        idempotent: true,
        body: { displayName, contact, role },
        schema: administration.MembershipView,
      }),
    onSuccess: refresh,
  });
  const changeStatus = useMutation({
    mutationFn: (input: { membershipId: string; action: 'suspend' | 'reactivate' }) =>
      api.request(`/api/v1/schools/${schoolId}/memberships/${input.membershipId}/${input.action}`, {
        method: 'POST',
        body: { reason },
        schema: administration.MembershipView,
      }),
    onSuccess: refresh,
  });

  return (
    <>
      <Row>
        <Button
          label="Administrators"
          variant="secondary"
          onPress={() => router.push(`/school/${schoolId}/operators` as never)}
        />
        <Button
          label="Activity and sessions"
          variant="secondary"
          onPress={() => router.push(`/school/${schoolId}/history` as never)}
        />
        <Button label="My account" variant="secondary" onPress={() => router.push('/account')} />
      </Row>
      <Heading>Invite someone to {schoolName}</Heading>
      <Card>
        <TextField label="Full name" value={displayName} onChangeText={setDisplayName} />
        <TextField
          label="Email or phone (+country code)"
          value={contact}
          onChangeText={setContact}
        />
        <Row>
          {ROLES.map((r) => (
            <Button
              key={r.value}
              label={`${role === r.value ? '✓ ' : ''}${r.label}`}
              variant={role === r.value ? 'primary' : 'secondary'}
              onPress={() => setRole(r.value)}
            />
          ))}
        </Row>
        {invite.isError ? (
          <Banner tone="danger" title="Not invited" message={messageFor(invite.error)} live />
        ) : null}
        {invite.isSuccess ? (
          <Banner
            tone="success"
            title="Invitation sent"
            message={`${invite.data.displayName} (${invite.data.contactMasked}) can now accept it.`}
            live
          />
        ) : null}
        <Button label="Send invitation" busy={invite.isPending} onPress={() => invite.mutate()} />
      </Card>
      <Heading>People</Heading>
      <TextField
        label="Reason for status changes (required, at least 10 characters)"
        value={reason}
        onChangeText={setReason}
      />
      {changeStatus.isError ? (
        <Banner
          tone="danger"
          title="Status not changed"
          message={messageFor(changeStatus.error)}
          live
        />
      ) : null}
      {members.isError ? (
        <Banner tone="danger" title="Could not load people" message={messageFor(members.error)} />
      ) : null}
      {members.data?.items.map((m) => (
        <Card key={m.membershipId}>
          <Text variant="label">{m.displayName}</Text>
          <Text tone="muted" variant="caption">
            {m.roles.join(', ').toLowerCase()} ·{' '}
            {m.status === 'ACTIVE'
              ? '✓ Active'
              : m.status === 'INVITED'
                ? '• Invitation pending'
                : `! ${m.status.toLowerCase()}`}{' '}
            · {m.contactMasked}
          </Text>
          {m.roles.includes('SCHOOL_ADMIN') ? null : m.status === 'SUSPENDED' ? (
            <Button
              label={`Reactivate ${m.displayName}`}
              variant="secondary"
              disabled={reason.trim().length < 10}
              onPress={() =>
                changeStatus.mutate({ membershipId: m.membershipId, action: 'reactivate' })
              }
            />
          ) : m.status !== 'REVOKED' ? (
            <Button
              label={
                m.status === 'INVITED'
                  ? `Cancel invitation for ${m.displayName}`
                  : `Suspend ${m.displayName}`
              }
              variant="danger"
              disabled={reason.trim().length < 10}
              onPress={() =>
                changeStatus.mutate({ membershipId: m.membershipId, action: 'suspend' })
              }
            />
          ) : null}
        </Card>
      ))}
    </>
  );
}
