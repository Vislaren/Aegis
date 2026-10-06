import { useQuery } from '@tanstack/react-query';
import { administration, audit } from '@aegis/contracts';
import { Banner, Card, Heading, Text } from '@aegis/ui';
import { messageFor } from '../../core/api-client';
import { api } from '../../services/session';

/** Session history and activity journal of the workspace this session currently holds. */
export function WorkspaceHistory({ grantId }: { grantId: string }) {
  const history = useQuery({
    queryKey: ['session-history', grantId],
    queryFn: () =>
      api.request('/api/v1/administration/session-history?limit=50', {
        schema: administration.SessionHistoryResponse,
      }),
  });
  const journal = useQuery({
    queryKey: ['activity-journal', grantId],
    queryFn: () =>
      api.request('/api/v1/administration/activity-journal?limit=50', {
        schema: audit.JournalResponse,
      }),
  });

  return (
    <>
      <Heading>Administrative activity</Heading>
      {journal.isError ? (
        <Banner tone="danger" title="Journal unavailable" message={messageFor(journal.error)} />
      ) : null}
      {journal.data !== undefined ? (
        <>
          <Banner
            tone={journal.data.chainVerified ? 'success' : 'danger'}
            title={
              journal.data.chainVerified
                ? 'Journal integrity verified'
                : 'Journal integrity check FAILED: report this to Aegis security immediately'
            }
          />
          {journal.data.items.map((entry) => (
            <Card key={entry.id}>
              <Text variant="label">{entry.action.replace(/_/g, ' ').toLowerCase()}</Text>
              <Text tone="muted" variant="caption">
                {new Date(entry.occurredAt).toLocaleString()} · {entry.outcome} · operator{' '}
                {entry.operatorProfileId ?? 'system'} · session{' '}
                {entry.sessionId?.slice(0, 8) ?? '-'}
              </Text>
            </Card>
          ))}
        </>
      ) : null}
      <Heading>Access sessions</Heading>
      {history.isError ? (
        <Banner tone="danger" title="History unavailable" message={messageFor(history.error)} />
      ) : null}
      {history.data?.items.map((item) => (
        <Card key={item.id}>
          <Text variant="label">
            {item.operatorDisplayName ?? 'Unknown operator'}:{' '}
            {item.outcome.replace(/_/g, ' ').toLowerCase()}
          </Text>
          <Text tone="muted" variant="caption">
            {new Date(item.attemptedAt).toLocaleString()}
            {item.endedAt !== null
              ? ` → ended ${new Date(item.endedAt).toLocaleString()} (${item.endReason ?? ''})`
              : ' · active'}
          </Text>
        </Card>
      ))}
    </>
  );
}
