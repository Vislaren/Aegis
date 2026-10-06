import { Stack, useLocalSearchParams } from 'expo-router';
import { OperatorsPanel } from '../../../src/features/admin/operators';
import { WorkspaceGate } from '../../../src/features/admin/workspace';

export default function SchoolOperators() {
  const { schoolId } = useLocalSearchParams<{ schoolId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'School administrators' }} />
      <WorkspaceGate workspace={{ type: 'SCHOOL', schoolId }} title="Administrators">
        {() => (
          <OperatorsPanel
            basePath={`/api/v1/schools/${schoolId}/admin-operators`}
            queryKey={`school-operators-${schoolId}`}
          />
        )}
      </WorkspaceGate>
    </>
  );
}
