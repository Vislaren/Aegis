import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { administration, identity } from '@aegis/contracts';
import { ApiClient, type CredentialStrategy } from '../core/api-client';
import { readCsrfCookie, tokenStore } from '../security/token-store';

type SessionView = identity.SessionResponse['session'];

interface SessionState {
  session: SessionView | null;
  contexts: administration.AccessContextsResponse | null;
  /** In-memory only (native). Never persisted. */
  accessToken: string | null;
  setFromResponse(response: identity.SessionResponse): Promise<void>;
  setContexts(contexts: administration.AccessContextsResponse | null): void;
  clear(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  session: null,
  contexts: null,
  accessToken: null,
  async setFromResponse(response) {
    if (response.tokens !== null) await tokenStore.writeRefreshToken(response.tokens.refreshToken);
    set({ session: response.session, accessToken: response.tokens?.accessToken ?? null });
  },
  setContexts(contexts) {
    set({ contexts });
  },
  async clear() {
    await tokenStore.clear();
    set({ session: null, contexts: null, accessToken: null });
  },
}));

const baseUrl: string =
  Platform.OS === 'web'
    ? ''
    : String(
        (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
          'http://localhost:3000',
      );

let refreshInFlight: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = await tokenStore.readRefreshToken();
      if (Platform.OS !== 'web' && refreshToken === null) return false;
      const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(Platform.OS === 'web' ? { 'x-csrf-token': readCsrfCookie() ?? '' } : {}),
        },
        body: JSON.stringify(refreshToken === null ? {} : { refreshToken }),
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
      });
      if (!response.ok) {
        await useSession.getState().clear();
        return false;
      }
      await useSession
        .getState()
        .setFromResponse(identity.SessionResponse.parse(await response.json()));
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

const credentials: CredentialStrategy =
  Platform.OS === 'web'
    ? { kind: 'cookie', accessToken: () => null, csrfToken: readCsrfCookie, refresh }
    : {
        kind: 'bearer',
        accessToken: () => useSession.getState().accessToken,
        csrfToken: () => null,
        refresh,
      };

export const api = new ApiClient({
  baseUrl,
  credentials,
  newIdempotencyKey: () => `ck-${Crypto.randomUUID()}`,
});

/** Stable per-install device identifier for session and device management (hashed server-side). */
let deviceId: string | null = null;
export function clientDescriptor(): identity.ClientDescriptor {
  deviceId ??= Crypto.randomUUID();
  return Platform.OS === 'web'
    ? { type: 'WEB', deviceId, platform: 'web' }
    : {
        type: 'NATIVE',
        deviceId,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceName: Constants.deviceName ?? undefined,
      };
}

export async function loadContexts(): Promise<administration.AccessContextsResponse> {
  const contexts = await api.request('/api/v1/access/contexts', {
    schema: administration.AccessContextsResponse,
  });
  useSession.getState().setContexts(contexts);
  return contexts;
}

export async function signOut(): Promise<void> {
  try {
    await api.request('/api/v1/auth/logout', { method: 'POST' });
  } finally {
    await useSession.getState().clear();
  }
}

/** Restores a native session from the keystore, or a web session from cookies, at launch. */
export async function restoreSession(): Promise<boolean> {
  if (!(await refresh())) return false;
  await loadContexts();
  return true;
}
