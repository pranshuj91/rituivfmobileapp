/**
 * "Share to Gaincafe CRM": audio files shared into the app from the dialer.
 * Backed by the native ShareReceiver module (android/app/src/main/java/com/gaincafecrm).
 */

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

export interface SharedFile {
  /** Absolute path of the copy in the app cache */
  path: string;
  name: string;
  mime: string;
  size: number;
  receivedAt: number;
}

interface ShareReceiverNative {
  getPendingShares(): Promise<SharedFile[]>;
  deleteFile(path: string): Promise<boolean>;
}

const EVENT_NAME = 'GaincafeShareReceived';

function native(): ShareReceiverNative | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as { ShareReceiver?: ShareReceiverNative }).ShareReceiver;
  return mod ?? null;
}

export async function getPendingShares(): Promise<SharedFile[]> {
  const mod = native();
  if (!mod) return [];
  try {
    const list = await mod.getPendingShares();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function subscribeShares(listener: (files: SharedFile[]) => void): () => void {
  const sub = DeviceEventEmitter.addListener(EVENT_NAME, (files: unknown) => {
    listener(Array.isArray(files) ? (files as SharedFile[]) : []);
  });
  return () => sub.remove();
}

export async function deleteSharedFile(path: string): Promise<void> {
  const mod = native();
  if (!mod) return;
  try {
    await mod.deleteFile(path);
  } catch {
    // Cache files are cleaned up by the OS eventually anyway.
  }
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
