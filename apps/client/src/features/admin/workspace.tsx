import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { administration, type WorkspaceSelector } from '@aegis/contracts';
import { Banner, Button, Card, Row, Screen, Text, TextField } from '@aegis/ui';
import { ApiError, messageFor } from '../../core/api-client';
import { LeaseKeeper, type LeaseLossReason } from '../../core/lease-keeper';
import { api } from '../../services/session';

type GateState =
  | { kind: 'opening' }
  | { kind: 'held'; lease: administration.LeaseView }
  | {
      kind: 'in-use';
      occupancy: { operatorDisplayName: string; acquiredAt: string; lastActivityAt: string };
    }
  | { kind: 'lost'; reason: LeaseLossReason }
  | { kind: 'error'; message: string };

/**
 * Wraps every administration screen. Privileged views render only while this session holds the
 * workspace lease; the server enforces the same rule on every request, so this gate is purely
 * about showing the operator the truth (who is acting, and when access ended).
 */
export function WorkspaceGate({
  workspace,
  title,
  children,
}: {
  workspace: WorkspaceSelector;
  title: string;
  children: (lease: administration.LeaseView) => ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: 'opening' });
  const keeper = useRef<LeaseKeeper | null>(null);

  async function open(takeoverReason?: string): Promise<void> {
    setState({ kind: 'opening' });
    try {
      const lease =
        takeoverReason === undefined
          ? await api.request('/api/v1/privileged-access/acquire', {
              method: 'POST',
              body: { workspace },
              schema: administration.LeaseView,
            })
          : await api.request('/api/v1/privileged-access/takeover', {
              method: 'POST',
              body: { workspace, reason: takeoverReason },
              schema: administration.LeaseView,
            });
      keeper.current?.stop();
      keeper.current = new LeaseKeeper(
        lease,
        {
          heartbeat: (grantId, userActive) =>
            api.request('/api/v1/privileged-access/heartbeat', {
              method: 'POST',
              body: { grantId, userActive },
              schema: administration.LeaseView,
            }),
          release: async (grantId) => {
            await api.request('/api/v1/privileged-access/release', {
              method: 'POST',
              body: { grantId },
            });
          },
        },
        {
          setInterval: (fn, ms) => setInterval(fn, ms),
          clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
        },
        (reason) => setState({ kind: 'lost', reason }),
        (renewed) => setState({ kind: 'held', lease: renewed }),
      );
      keeper.current.start();
      setState({ kind: 'held', lease });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'ADMIN_WORKSPACE_IN_USE' &&
        error.problem?.occupancy !== undefined
      ) {
        setState({ kind: 'in-use', occupancy: error.problem.occupancy });
      } else {
        setState({ kind: 'error', message: messageFor(error) });
      }
    }
  }

  useEffect(() => {
    void open();
    const onInput = () => keeper.current?.noteInteraction();
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('keydown', onInput);
      window.addEventListener('pointerdown', onInput);
    }
    return () => {
      keeper.current?.stop();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('keydown', onInput);
        window.removeEventListener('pointerdown', onInput);
      }
    };
    // The workspace identity is the only input; reopening on every render would churn leases.
  }, [workspace.type, workspace.type === 'SCHOOL' ? workspace.schoolId : null]);

  async function leave(): Promise<void> {
    await keeper.current?.release().catch(() => undefined);
    router.replace('/');
  }

  if (state.kind === 'held') {
    return (
      <Screen
        title={title}
        header={
          <Card>
            <Row>
              <Text variant="label">Operating as {state.lease.operator.displayName}</Text>
              <Text tone="muted" variant="caption">
                Access confirmed by server until{' '}
                {new Date(state.lease.expiresAt).toLocaleTimeString()} (renews while you work)
              </Text>
              <Button
                label="Leave administration"
                variant="secondary"
                onPress={() => void leave()}
              />
            </Row>
          </Card>
        }
      >
        {children(state.lease)}
      </Screen>
    );
  }

  return (
    <Screen title={title}>
      {state.kind === 'opening' ? (
        <Banner tone="info" title="Opening the administration workspace…" live />
      ) : null}
      {state.kind === 'in-use' ? (
        <InUse
          occupancy={state.occupancy}
          onRetry={() => void open()}
          onTakeover={(reason) => void open(reason)}
        />
      ) : null}
      {state.kind === 'lost' ? (
        <>
          <Banner
            tone="warning"
            title="Your administration access has ended"
            message={
              state.reason === 'network'
                ? 'The connection was lost for too long.'
                : 'Access expired, was released, or another operator took over.'
            }
            live
          />
          <Button label="Open the workspace again" onPress={() => void open()} />
        </>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <Banner tone="danger" title="Could not open the workspace" message={state.message} live />
          <Button label="Try again" onPress={() => void open()} />
        </>
      ) : null}
    </Screen>
  );
}

function InUse({
  occupancy,
  onRetry,
  onTakeover,
}: {
  occupancy: { operatorDisplayName: string; acquiredAt: string; lastActivityAt: string };
  onRetry: () => void;
  onTakeover: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Banner
        tone="warning"
        title="Another operator is using this workspace"
        message={`${occupancy.operatorDisplayName} has been working since ${new Date(occupancy.acquiredAt).toLocaleString()} (last active ${new Date(occupancy.lastActivityAt).toLocaleTimeString()}). Only one operator can administer at a time.`}
      />
      <Button label="Check again" onPress={onRetry} />
      {confirming ? (
        <Card>
          <Text>
            Emergency takeover ends their access immediately and is permanently recorded with your
            name and reason. You must have verified your authenticator code in the last 5 minutes.
          </Text>
          <TakeoverReason value={reason} onChange={setReason} />
          <Button
            label="Take over now"
            variant="danger"
            disabled={reason.trim().length < 10}
            onPress={() => onTakeover(reason.trim())}
          />
        </Card>
      ) : (
        <Button
          label="Emergency takeover…"
          variant="secondary"
          onPress={() => setConfirming(true)}
        />
      )}
    </>
  );
}

function TakeoverReason({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextField label="Reason (at least 10 characters)" value={value} onChangeText={onChange} />
  );
}
