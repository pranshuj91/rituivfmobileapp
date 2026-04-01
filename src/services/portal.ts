import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';

/** Portal API URL – set in code; not configurable in Settings. */
const PORTAL_API_URL = 'https://leadtracker.gaincafe.com/api/call-logs/sync';

/** Optional: set in code if your backend requires these headers. */
const CALL_LOG_APP_KEY = ''; // e.g. 'your-app-key'
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
  results?: Array<{
    phone_number: string;
    normalized?: string;
    status: string;
    call_log_id?: number;
    recordings_saved?: number;
    lead?: unknown;
  }>;
}

export interface RecordingPayload {
  url?: string;
  external_id?: string;
  recording_external_id?: string;
  recording_url?: string;
  duration_seconds?: number;
  // Backward compatible alias
  recording_duration?: number;
}

export interface SyncOptions {
  /** Optional recording for each call: key = CallLog.id */
  singleRecordingByCallId?: Record<string, RecordingPayload>;
  /** Optional multiple recordings for each call: key = CallLog.id */
  recordingsByCallId?: Record<string, RecordingPayload[]>;
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

function toDirection(type?: string): string {
  if (!type) return 'UNKNOWN';
  return String(type).toUpperCase();
}

function toRecordingSingle(r?: RecordingPayload): Record<string, unknown> {
  if (!r) return {};
  const extId = r.recording_external_id ?? r.external_id;
  return {
    ...(r.recording_url || r.url ? { recording_url: r.recording_url ?? r.url } : {}),
    ...(extId ? { recording_external_id: extId } : {}),
    ...(r.duration_seconds ?? r.recording_duration
      ? { recording_duration: r.duration_seconds ?? r.recording_duration }
      : {}),
  };
}

function toRecordingArray(list?: RecordingPayload[]): Array<Record<string, unknown>> | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((r) => ({
    ...(r.recording_url || r.url ? { recording_url: r.recording_url ?? r.url } : {}),
    ...(r.recording_external_id || r.external_id
      ? { recording_external_id: r.recording_external_id ?? r.external_id }
      : {}),
    ...(r.duration_seconds ?? r.recording_duration
      ? { duration_seconds: r.duration_seconds ?? r.recording_duration }
      : {}),
  }));
}

export async function pushCallsToPortal(
  calls: CallLog[],
  options: SyncOptions = {}
): Promise<PushResult> {
  try {
    const deviceInfo = await getDeviceInfo();
    const payload = {
      logs: calls.map((c) => {
        const singleRec = toRecordingSingle(options.singleRecordingByCallId?.[c.id]);
        const recordings = toRecordingArray(options.recordingsByCallId?.[c.id]);
        return {
          phone_number: c.phoneNumber,
          direction: toDirection(c.type),
          duration_seconds: c.duration,
          called_at: toCalledAt(c),
          ...(recordings && recordings[0]?.recording_url
            ? { recording_url: String(recordings[0].recording_url) }
            : {}),
          ...(recordings && recordings[0]?.recording_external_id
            ? { recording_external_id: String(recordings[0].recording_external_id) }
            : {}),
          ...(recordings ? { recordings } : {}),
          ...singleRec,
        };
      }),
      ...(deviceInfo.deviceName ? { deviceName: deviceInfo.deviceName } : {}),
      ...(deviceInfo.devicePhone ? { devicePhone: deviceInfo.devicePhone } : {}),
      sentAt: new Date().toISOString(),
    };
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (CALL_LOG_APP_KEY) headers['X-App-Key'] = CALL_LOG_APP_KEY;
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
    let results: PushResult['results'];
    try {
      const json = (await res.json()) as {
        message?: string;
        saved?: number;
        results?: PushResult['results'];
      };
      if (json.message) apiMessage = json.message;
      if (typeof json.saved === 'number') savedCount = json.saved;
      if (Array.isArray(json.results)) {
        results = json.results;
        savedCount = json.results.length;
      }
    } catch {
      // Keep fallback success message
    }
    return { success: true, message: apiMessage, count: savedCount, results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Network error';
    return { success: false, message: msg };
  }
}

export async function pushSingleCallToPortal(
  call: CallLog,
  options: SyncOptions = {}
): Promise<PushResult> {
  return pushCallsToPortal([call], options);
}
