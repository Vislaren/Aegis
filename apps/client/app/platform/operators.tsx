import { Stack } from 'expo-router';
import { OperatorsPanel } from '../../src/features/admin/operators';
import { WorkspaceGate } from '../../src/features/admin/workspace';

export default function PlatformOperators() {
  return (
    <>
      <Stack.Screen options={{ title: 'Platform operators' }} />
      <WorkspaceGate workspace={{ type: 'PLATFORM' }} title="Platform operators">
        {() => (
          <OperatorsPanel
            basePath="/api/v1/platform/admin-operators"
            queryKey="platform-operators"
          />
        )}
      </WorkspaceGate>
    </>
  );
}
