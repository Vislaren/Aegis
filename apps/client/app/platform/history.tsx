import { Stack } from 'expo-router';
import { WorkspaceHistory } from '../../src/features/admin/history';
import { WorkspaceGate } from '../../src/features/admin/workspace';

export default function PlatformHistory() {
  return (
    <>
      <Stack.Screen options={{ title: 'Platform activity' }} />
      <WorkspaceGate workspace={{ type: 'PLATFORM' }} title="Activity and sessions">
        {(lease) => <WorkspaceHistory grantId={lease.grantId} />}
      </WorkspaceGate>
    </>
  );
}
