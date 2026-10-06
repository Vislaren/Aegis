import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Banner, Screen } from '@aegis/ui';
import { gateAfterSignIn } from '../src/core/navigation';
import { restoreSession, useSession } from '../src/services/session';

/** Single entry point: restores a session if possible, then routes to the role home. */
export default function Entry() {
  const { session, contexts } = useSession();
  const [restoring, setRestoring] = useState(session === null);

  useEffect(() => {
    if (session !== null) return;
    void restoreSession().finally(() => setRestoring(false));
  }, [session]);

  if (restoring) {
    return (
      <Screen title="Aegis">
        <Stack.Screen options={{ title: 'Aegis' }} />
        <Banner tone="info" title="Checking your session…" live />
      </Screen>
    );
  }

  const gate = gateAfterSignIn({ session, contexts });
  switch (gate.next) {
    case 'sign-in':
      return <Redirect href="/sign-in" />;
    case 'mfa-enroll':
      return <Redirect href={{ pathname: '/mfa', params: { mode: 'enroll' } }} />;
    case 'mfa-verify':
      return <Redirect href={{ pathname: '/mfa', params: { mode: 'verify' } }} />;
    case 'no-access':
      return <Redirect href="/no-access" />;
    case 'choose':
      return <Redirect href="/choose" />;
    case 'home':
      return <Redirect href={gate.route as never} />;
  }
}
