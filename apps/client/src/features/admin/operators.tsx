import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { administration } from '@aegis/contracts';
import { Banner, Button, Card, Heading, Text, TextField } from '@aegis/ui';
import { messageFor } from '../../core/api-client';
import { api } from '../../services/session';

/** Named operator profiles of the current workspace (platform or one school). */
export function OperatorsPanel({ basePath, queryKey }: { basePath: string; queryKey: string }) {
  const queryClient = useQueryClient();
  const operators = useQuery({
    queryKey: [queryKey],
    queryFn: () =>
      api.request(`${basePath}?limit=100`, { schema: administration.OperatorListResponse }),
  });
  const [displayName, setDisplayName] = useState('');
  const [contact, setContact] = useState('');
  const [reason, setReason] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [queryKey] });

  const invite = useMutation({
    mutationFn: () =>
      api.request(basePath, {
        method: 'POST',
        body: { displayName, contact },
        schema: administration.OperatorView,
      }),
    onSuccess: refresh,
  });
  const changeStatus = useMutation({
    mutationFn: (input: { profileId: string; action: 'suspend' | 'reactivate' }) =>
      api.request(`${basePath}/${input.profileId}/${input.action}`, {
        method: 'POST',
        body: { reason },
        schema: administration.OperatorView,
      }),
    onSuccess: refresh,
  });

  return (
    <>
      <Heading>Invite an operator</Heading>
      <Card>
        <Text tone="muted">
          Every operator signs in individually with multi-factor verification. Never share an
          account.
        </Text>
        <TextField label="Full name" value={displayName} onChangeText={setDisplayName} />
        <TextField label="Email or phone" value={contact} onChangeText={setContact} />
        {invite.isError ? (
          <Banner tone="danger" title="Not invited" message={messageFor(invite.error)} live />
        ) : null}
        {invite.isSuccess ? (
          <Banner
            tone="success"
            title="Invitation sent"
            message={`Sent to ${invite.data.contactMasked}.`}
            live
          />
        ) : null}
        <Button label="Send invitation" busy={invite.isPending} onPress={() => invite.mutate()} />
      </Card>
      <Heading>Operators</Heading>
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
      {operators.data?.items.map((op) => (
        <Card key={op.profileId}>
          <Text variant="label">{op.displayName}</Text>
          <Text tone="muted" variant="caption">
            {op.status === 'ACTIVE'
              ? '✓ Active'
              : op.status === 'INVITED'
                ? '• Invitation pending'
                : '! Suspended'}{' '}
            · {op.contactMasked}
          </Text>
          {op.status === 'SUSPENDED' ? (
            <Button
              label={`Reactivate ${op.displayName}`}
              variant="secondary"
              disabled={reason.trim().length < 10}
              onPress={() => changeStatus.mutate({ profileId: op.profileId, action: 'reactivate' })}
            />
          ) : (
            <Button
              label={`Suspend ${op.displayName}`}
              variant="danger"
              disabled={reason.trim().length < 10}
              onPress={() => changeStatus.mutate({ profileId: op.profileId, action: 'suspend' })}
            />
          )}
        </Card>
      ))}
    </>
  );
}
