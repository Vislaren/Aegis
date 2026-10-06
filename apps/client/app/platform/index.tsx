import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { administration } from '@aegis/contracts';
import { Banner, Button, Card, Heading, Row, Text, TextField } from '@aegis/ui';
import { messageFor } from '../../src/core/api-client';
import { WorkspaceGate } from '../../src/features/admin/workspace';
import { api } from '../../src/services/session';

/** Platform console: tenant registry and manual school provisioning. No school child data. */
export default function PlatformHome() {
  return (
    <>
      <Stack.Screen options={{ title: 'Platform administration' }} />
      <WorkspaceGate workspace={{ type: 'PLATFORM' }} title="Schools">
        {() => <Schools />}
      </WorkspaceGate>
    </>
  );
}

function Schools() {
  const queryClient = useQueryClient();
  const schools = useQuery({
    queryKey: ['platform-schools'],
    queryFn: () =>
      api.request('/api/v1/platform/schools?limit=100', {
        schema: administration.SchoolListResponse,
      }),
  });
  const [form, setForm] = useState({
    name: '',
    slug: '',
    timezone: 'Africa/Douala',
    countryCode: 'CM',
    defaultLanguage: 'fr',
    adminName: '',
    adminContact: '',
  });
  const provision = useMutation({
    mutationFn: () =>
      api.request('/api/v1/platform/schools', {
        method: 'POST',
        idempotent: true,
        schema: administration.ProvisionSchoolResponse,
        body: {
          name: form.name,
          slug: form.slug,
          timezone: form.timezone,
          countryCode: form.countryCode,
          defaultLanguage: form.defaultLanguage,
          firstAdministrator: { displayName: form.adminName, contact: form.adminContact },
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-schools'] }),
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <>
      <Row>
        <Button
          label="Platform operators"
          variant="secondary"
          onPress={() => router.push('/platform/operators')}
        />
        <Button
          label="Activity and sessions"
          variant="secondary"
          onPress={() => router.push('/platform/history')}
        />
        <Button label="My account" variant="secondary" onPress={() => router.push('/account')} />
      </Row>
      <Heading>Provision a school</Heading>
      <Card>
        <TextField label="School name" value={form.name} onChangeText={set('name')} />
        <TextField
          label="Identifier (lowercase, dashes)"
          value={form.slug}
          onChangeText={set('slug')}
        />
        <TextField label="Timezone (IANA)" value={form.timezone} onChangeText={set('timezone')} />
        <TextField
          label="Country code"
          value={form.countryCode}
          onChangeText={set('countryCode')}
        />
        <TextField
          label="Default language"
          value={form.defaultLanguage}
          onChangeText={set('defaultLanguage')}
        />
        <TextField
          label="First administrator's full name"
          value={form.adminName}
          onChangeText={set('adminName')}
        />
        <TextField
          label="First administrator's email or phone"
          value={form.adminContact}
          onChangeText={set('adminContact')}
        />
        {provision.isError ? (
          <Banner
            tone="danger"
            title="Not provisioned"
            message={messageFor(provision.error)}
            live
          />
        ) : null}
        {provision.isSuccess ? (
          <Banner
            tone="success"
            title={`${provision.data.school.name} created`}
            message={`An invitation was sent to ${provision.data.firstAdministrator.contactMasked}.`}
            live
          />
        ) : null}
        <Button
          label="Create school and invite administrator"
          busy={provision.isPending}
          onPress={() => provision.mutate()}
        />
      </Card>
      <Heading>Schools</Heading>
      {schools.isError ? (
        <Banner tone="danger" title="Could not load schools" message={messageFor(schools.error)} />
      ) : null}
      {schools.data?.items.map((school) => (
        <Card key={school.schoolId}>
          <Text variant="label">{school.name}</Text>
          <Text tone="muted" variant="caption">
            {school.status === 'ACTIVE' ? '✓ Active' : '! Suspended'} · {school.timezone} ·{' '}
            {school.slug}
          </Text>
        </Card>
      ))}
    </>
  );
}
