/**
 * User-facing app settings (stored on the phone).
 *
 * allCallSync
 *   false (default): only calls whose number exists as a lead in the CRM are
 *                    shown in Call logs and synced.
 *   true:            every call on the phone is synced; recordings upload and
 *                    the CRM creates a new lead for unknown numbers.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const ALL_CALL_SYNC_KEY = '@gaincafe_all_call_sync';

let cachedAllCallSync: boolean | undefined;
const listeners = new Set<(enabled: boolean) => void>();

export async function getAllCallSyncEnabled(): Promise<boolean> {
  if (cachedAllCallSync !== undefined) return cachedAllCallSync;
  try {
    const raw = await AsyncStorage.getItem(ALL_CALL_SYNC_KEY);
    cachedAllCallSync = raw === '1';
  } catch {
    cachedAllCallSync = false;
  }
  return cachedAllCallSync;
}

export async function setAllCallSyncEnabled(enabled: boolean): Promise<void> {
  cachedAllCallSync = enabled;
  try {
    await AsyncStorage.setItem(ALL_CALL_SYNC_KEY, enabled ? '1' : '0');
  } catch {
    // Memory copy still applies for this session.
  }
  listeners.forEach((l) => {
    try {
      l(enabled);
    } catch {
      // ignore
    }
  });
}

export function subscribeAllCallSync(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
