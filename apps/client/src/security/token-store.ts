import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const REFRESH_KEY = 'aegis.refresh-token';

/**
 * Native: the refresh token lives in the OS keystore (Keychain / Android Keystore) through
 * SecureStore, never in AsyncStorage or logs; the access token is kept in memory only.
 * Web: tokens are HttpOnly cookies the JavaScript runtime cannot read, so nothing is stored.
 */
export const tokenStore = {
  async readRefreshToken(): Promise<string | null> {
    if (Platform.OS === 'web') return null;
    return SecureStore.getItemAsync(REFRESH_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  async writeRefreshToken(token: string): Promise<void> {
    if (Platform.OS === 'web') return;
    await SecureStore.setItemAsync(REFRESH_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  async clear(): Promise<void> {
    if (Platform.OS === 'web') return;
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  },
};

export function readCsrfCookie(): string | null {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith('aegis_csrf='));
  return match === undefined ? null : decodeURIComponent(match.slice('aegis_csrf='.length));
}
