import { Stack, useLocalSearchParams } from 'expo-router';
import { WorkspaceHistory } from '../../../src/features/admin/history';
import { WorkspaceGate } from '../../../src/features/admin/workspace';

export default function SchoolHistory() {
  const { schoolId } = useLocalSearchParams<{ schoolId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'School activity' }} />
      <WorkspaceGate workspace={{ type: 'SCHOOL', schoolId }} title="Activity and sessions">
        {(lease) => <WorkspaceHistory grantId={lease.grantId} />}
      </WorkspaceGate>
    </>
  );
}
