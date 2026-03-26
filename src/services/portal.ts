import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';

/** Portal API URL – set in code; not configurable in Settings. */
const PORTAL_API_URL = 'https://leadtracker.gaincafe.com/api/call-logs/sync';

/** Optional: set in code if your backend requires these headers. */
const X_APP_KEY = ''; // e.g. 'your-app-key'
const AUTHORIZATION = ''; // e.g. 'Bearer token'

const DEVICE_NAME_KEY = '@ritu_device_name';
const DEVICE_PHONE_KEY = '@ritu_device_phone';
const LAST_SYNCED_AT_KEY = '@ritu_last_synced_at';

export interface DeviceInfo {
  deviceName: string;
  devicePhone: string;
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  try {
    const [name, phone] = await Promise.all([
      AsyncStorage.getItem(DEVICE_NAME_KEY),
      AsyncStorage.getItem(DEVICE_PHONE_KEY),
    ]);
    return {
      deviceName: name ?? '',
      devicePhone: phone ?? '',
    };
  } catch {
    return {
      deviceName: '',
      devicePhone: '',
    };
  }
}

export async function setDeviceInfo(deviceName: string, devicePhone: string): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(DEVICE_NAME_KEY, deviceName.trim()),
    AsyncStorage.setItem(DEVICE_PHONE_KEY, devicePhone.trim()),
  ]);
}

export async function getLastSyncedAt(): Promise<number | null> {
  try {
    const s = await AsyncStorage.getItem(LAST_SYNCED_AT_KEY);
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function setLastSyncedAt(ms: number): Promise<void> {
  await AsyncStorage.setItem(LAST_SYNCED_AT_KEY, String(ms));
}

export interface PushResult {
  success: boolean;
  message: string;
  count?: number;
}

function toCalledAt(c: CallLog): string {
  const rawTs = typeof c.timestamp === 'string' ? Number(c.timestamp) : c.timestamp;
  const ts = Number.isFinite(rawTs)
    ? (rawTs as number) > 1e12
      ? (rawTs as number)
      : (rawTs as number) * 1000
    : NaN;
  const date = Number.isFinite(ts) ? new Date(ts as number) : new Date();
  // Backend expects "YYYY-MM-DD HH:mm:ss"
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function pushCallsToPortal(calls: CallLog[]): Promise<PushResult> {
  try {
    const deviceInfo = await getDeviceInfo();
    const payload = {
      logs: calls.map((c) => ({
        id: c.id,
        phone_number: c.phoneNumber,
        called_at: toCalledAt(c),
        formatted_number: c.formattedNumber,
        duration: c.duration,
        name: c.name,
        timestamp: c.timestamp,
        date_time: c.dateTime,
        type: c.type,
        // Keep camelCase fields too for compatibility.
        phoneNumber: c.phoneNumber,
        calledAt: toCalledAt(c),
        formattedNumber: c.formattedNumber,
        dateTime: c.dateTime,
      })),
      ...(deviceInfo.deviceName ? { deviceName: deviceInfo.deviceName } : {}),
      ...(deviceInfo.devicePhone ? { devicePhone: deviceInfo.devicePhone } : {}),
      sentAt: new Date().toISOString(),
    };
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (X_APP_KEY) headers['X-App-Key'] = X_APP_KEY;
    if (AUTHORIZATION) headers['Authorization'] = AUTHORIZATION;
    const res = await fetch(PORTAL_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let details = '';
      try {
        details = await res.text();
      } catch {
        details = '';
      }
      const msg = details
        ? `Portal responded with ${res.status}: ${details}`
        : `Portal responded with ${res.status}`;
      return { success: false, message: msg };
    }
    let apiMessage = `${calls.length} call(s) pushed to portal.`;
    let savedCount = calls.length;
    try {
      const json = (await res.json()) as { message?: string; saved?: number };
      if (json.message) apiMessage = json.message;
      if (typeof json.saved === 'number') savedCount = json.saved;
    } catch {
      // Keep fallback success message
    }
    return { success: true, message: apiMessage, count: savedCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Network error';
    return { success: false, message: msg };
  }
}

export async function pushSingleCallToPortal(call: CallLog): Promise<PushResult> {
  return pushCallsToPortal([call]);
}
