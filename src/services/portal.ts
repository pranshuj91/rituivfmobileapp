import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';
import RNFS from 'react-native-fs';

/** Portal API URL – set in code; not configurable in Settings. */
const PORTAL_API_URL = 'https://leadtracker.gaincafe.com/api/call-logs/sync';
const RECORDING_UPLOAD_URL = 'https://leadtracker.gaincafe.com/api/call-logs/upload-recording';

/** Optional: set in code if your backend requires these headers. */
const CALL_LOG_APP_KEY = ''; // e.g. 'your-app-key'
const AUTHORIZATION = ''; // e.g. 'Bearer token'

const DEVICE_NAME_KEY = '@ritu_device_name';
const DEVICE_PHONE_KEY = '@ritu_device_phone';
const LAST_SYNCED_AT_KEY = '@ritu_last_synced_at';
const uploadedRecordingsByCallId = new Map<string, Array<Record<string, unknown>>>();
const STRICT_PAIR_WINDOW_MS = 120 * 1000;
const UPLOAD_TIMEOUT_MS = 25 * 1000;
const SYNC_TIMEOUT_MS = 35 * 1000;

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
  source?: string;
  recorded_at?: string;
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
    ...(r.source ? { source: r.source } : {}),
    ...(r.recorded_at ? { recorded_at: r.recorded_at } : {}),
  }));
}

function normalizeDigits(input?: string | null): string {
  return (input ?? '').replace(/\D/g, '');
}

function parseRecordingExternalId(externalId: string): { recCallId: string; recPhoneLast10: string } {
  if (!externalId) return { recCallId: '', recPhoneLast10: '' };
  const idx = externalId.lastIndexOf(':');
  const head = idx >= 0 ? externalId.slice(0, idx) : externalId;
  const tail = idx >= 0 ? externalId.slice(idx + 1) : '';
  // recording_external_id format example:
  // +919602999299-2604011548.mp3:160
  // Phone must be extracted from the filename prefix (before first dash),
  // not from all digits in head (which includes timestamp digits).
  const fileNameOnly = head.split('/').pop() ?? head;
  const beforeDash = fileNameOnly.split('-')[0] ?? fileNameOnly;
  const recPhoneDigits = normalizeDigits(beforeDash);
  const recPhoneLast10 = recPhoneDigits.slice(-10);
  const recCallId = tail.trim();
  return { recCallId, recPhoneLast10 };
}

function toMsFromCalledAt(value?: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

function strictRecordingMatchesCall(recording: Record<string, unknown>, log: Record<string, unknown>): boolean {
  const recExtId = String(recording.recording_external_id ?? '');
  const callId = String(log.callId ?? log.id ?? '');
  const callPhoneLast10 = normalizeDigits(String(log.phone_number ?? '')).slice(-10);
  const { recCallId, recPhoneLast10 } = parseRecordingExternalId(recExtId);

  // Primary matcher: exact callId match.
  // Phone in recording_external_id is treated as advisory only because
  // device/provider formatting can differ while callId remains stable in same sync batch.
  if (recCallId) {
    return recCallId === callId;
  }

  // Secondary matcher: exact phone(last10) + close time window.
  const phoneMatches = !!recPhoneLast10 && recPhoneLast10 === callPhoneLast10;
  const recAt = toMsFromCalledAt(recording.recorded_at);
  const callAt = toMsFromCalledAt(log.called_at);
  const timeMatches = recAt && callAt ? Math.abs(recAt - callAt) <= STRICT_PAIR_WINDOW_MS : false;
  if (phoneMatches && timeMatches) return true;

  // Fallback (only when recCallId is not parsable): same uploaded callId + close time.
  const uploadedForCallId = String(recording.__uploaded_for_call_id ?? '');
  const sameCall = uploadedForCallId && uploadedForCallId === callId;
  if (!sameCall) return false;
  return !recAt || !callAt || Math.abs(recAt - callAt) <= STRICT_PAIR_WINDOW_MS;
}

async function uploadRecordingIfNeeded(
  recording: Record<string, unknown>,
  callId: string
): Promise<Record<string, unknown> | null> {
  const rawUrl = typeof recording.recording_url === 'string' ? recording.recording_url : '';
  if (!rawUrl) return recording;
  if (!rawUrl.startsWith('file://')) return recording;
  if (!RECORDING_UPLOAD_URL) return null;

  const filePath = rawUrl.replace('file://', '');
  const exists = await RNFS.exists(filePath);
  if (!exists) return null;

  try {
    const filename = filePath.split('/').pop() || 'recording.mp3';
    const uploadHeaders: Record<string, string> = {
      Accept: 'application/json',
    };
    if (CALL_LOG_APP_KEY) uploadHeaders['X-App-Key'] = CALL_LOG_APP_KEY;
    if (AUTHORIZATION) uploadHeaders.Authorization = AUTHORIZATION;
    const uploadPromise = RNFS.uploadFiles({
      toUrl: RECORDING_UPLOAD_URL,
      files: [
        {
          name: 'file',
          filename,
          filepath: filePath,
          filetype: 'audio/mpeg',
        },
      ],
      method: 'POST',
      headers: uploadHeaders,
      fields: {
        recording_external_id: String(recording.recording_external_id ?? ''),
        source: String(recording.source ?? 'mobile_app'),
      },
    }).promise;

    const uploadRes = await Promise.race([
      uploadPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), UPLOAD_TIMEOUT_MS)),
    ]);
    if (!uploadRes) return null;

    if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) {
      return null;
    }

    let uploadedUrl = '';
    try {
      const json = JSON.parse(uploadRes.body || '{}') as {
        url?: string;
        recording_url?: string;
        data?: { url?: string; recording_url?: string };
      };
      uploadedUrl = json.recording_url ?? json.url ?? json.data?.recording_url ?? json.data?.url ?? '';
    } catch {
      uploadedUrl = '';
    }

    if (!uploadedUrl) return null;
    const uploaded: Record<string, unknown> = {
      ...recording,
      recording_url: uploadedUrl,
    };
    // Save upload mapping per callId immediately after upload success.
    const key = callId;
    const list = uploadedRecordingsByCallId.get(key) ?? [];
    list.push({
      recording_url: String(uploaded.recording_url ?? ''),
      recording_external_id: String(recording.recording_external_id ?? ''),
      duration_seconds: recording.duration_seconds,
      source: recording.source,
      recorded_at: recording.recorded_at,
      __uploaded_for_call_id: callId,
    });
    uploadedRecordingsByCallId.set(key, list);
    return uploaded;
  } catch {
    return null;
  }
}

export async function pushCallsToPortal(
  calls: CallLog[],
  options: SyncOptions = {}
): Promise<PushResult> {
  try {
    const deviceInfo = await getDeviceInfo();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (CALL_LOG_APP_KEY) headers['X-App-Key'] = CALL_LOG_APP_KEY;
    if (AUTHORIZATION) headers.Authorization = AUTHORIZATION;

    const logsBase = await Promise.all(calls.map(async (c) => {
      const singleRec = toRecordingSingle(options.singleRecordingByCallId?.[c.id]);
      const recordings = toRecordingArray(options.recordingsByCallId?.[c.id]);
      // Send a single unified recordings[] array to avoid duplicate payload forms.
      const mergedRecordingsRaw = recordings ?? (Object.keys(singleRec).length > 0 ? [singleRec] : []);
      const calledAt = toCalledAt(c);
      await Promise.all(mergedRecordingsRaw.map((r) => uploadRecordingIfNeeded(r, c.id)));
      const phoneNumber = c.phoneNumber || c.formattedNumber || '';
      const contactName = (c.name || '').trim();
      return {
        id: c.id,
        callId: c.id,
        phone_number: phoneNumber,
        name: contactName || phoneNumber,
        direction: toDirection(c.type),
        duration_seconds: c.duration,
        called_at: calledAt,
      };
    }));

    const uploadSucceededCount = Array.from(uploadedRecordingsByCallId.values()).reduce(
      (acc, list) => acc + list.length,
      0
    );

    // Merge uploaded recordings into logs[] by callId.
    const usedExternalIds = new Set<string>();
    const usedRecordingUrls = new Set<string>();
    const logs = logsBase.map((log) => {
      const recsForCall = uploadedRecordingsByCallId.get(String(log.callId)) ?? [];
      const recs = recsForCall.filter((r) => {
        const extId = String(r.recording_external_id ?? '');
        const recUrl = String(r.recording_url ?? '');
        if (!strictRecordingMatchesCall(r, log as Record<string, unknown>)) {
          console.warn('[recording-skip] strict mismatch', {
            callId: String(log.callId ?? log.id ?? ''),
            phone: String(log.phone_number ?? ''),
            recording_external_id: extId,
          });
          return false;
        }
        if (extId && usedExternalIds.has(extId)) return false;
        if (recUrl && usedRecordingUrls.has(recUrl)) return false;
        if (extId) usedExternalIds.add(extId);
        if (recUrl) usedRecordingUrls.add(recUrl);
        return true;
      });
      return {
        ...log,
        recordings: recs,
      };
    });

    const payload = {
      logs,
      ...(deviceInfo.deviceName ? { deviceName: deviceInfo.deviceName } : {}),
      ...(deviceInfo.devicePhone ? { devicePhone: deviceInfo.devicePhone } : {}),
      sentAt: new Date().toISOString(),
    };
    if (!payload.logs.some((l) => (l as { recordings?: unknown[] }).recordings?.length)) {
      console.warn('[sync-payload] no recordings attached in this batch');
    }
    const logsWithRecordings = payload.logs.filter((l) => (l as { recordings?: unknown[] }).recordings?.length).length;
    const totalRecordingItems = payload.logs.reduce((acc, l) => {
      const n = (l as { recordings?: unknown[] }).recordings?.length ?? 0;
      return acc + n;
    }, 0);
    const samplePairs = payload.logs.slice(0, 2).flatMap((l) => {
      const recs = (l as { recordings?: Array<Record<string, unknown>> }).recordings ?? [];
      return recs.slice(0, 1).map((r) => ({
        callId: String((l as Record<string, unknown>).callId ?? (l as Record<string, unknown>).id ?? ''),
        phone: String((l as Record<string, unknown>).phone_number ?? ''),
        recording_external_id: String(r.recording_external_id ?? ''),
      }));
    });
    const first2Compact = payload.logs.slice(0, 2).map((l) => ({
      callId: String((l as Record<string, unknown>).callId ?? (l as Record<string, unknown>).id ?? ''),
      recordingsLength: ((l as { recordings?: unknown[] }).recordings?.length ?? 0),
    }));
    console.log('[sync-payload] totals', {
      totalLogs: payload.logs.length,
      logsWithRecordings,
      totalRecordingItems,
      uploadSucceededCount,
      samplePairs,
      first2Compact,
    });
    // Hard guard: uploads succeeded but recordings missing in final payload.
    if (uploadSucceededCount > 0 && totalRecordingItems === 0) {
      return {
        success: false,
        message: 'Recording upload succeeded, but merged sync payload has 0 recordings. Sync blocked.',
      };
    }
    console.log('[sync-payload] logs[0].recordings?.length =', (payload.logs[0] as { recordings?: unknown[] } | undefined)?.recordings?.length ?? 0);
    console.log('[sync-payload] first 2 logs =', payload.logs.slice(0, 2));
    const firstWithRecordings = payload.logs.find(
      (l) => ((l as { recordings?: unknown[] }).recordings?.length ?? 0) > 0
    );
    if (firstWithRecordings) {
      console.log('[sync-payload] sample with recordings =', firstWithRecordings);
    } else {
      console.warn('[sync-payload] no non-empty recordings item found before /sync');
    }
    console.log('[sync-payload] first 2 callId+recordings.length =', first2Compact);
    const controller = new AbortController();
    const syncTimeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    const res = await fetch(PORTAL_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(syncTimeout));
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
    const isAbort = e instanceof Error && e.name === 'AbortError';
    const msg = isAbort
      ? `Portal sync timed out after ${Math.floor(SYNC_TIMEOUT_MS / 1000)} seconds`
      : e instanceof Error
        ? e.message
        : 'Network error';
    return { success: false, message: msg };
  } finally {
    // Keep map until sync call has executed, then clear.
    uploadedRecordingsByCallId.clear();
  }
}

export async function pushSingleCallToPortal(
  call: CallLog,
  options: SyncOptions = {}
): Promise<PushResult> {
  return pushCallsToPortal([call], options);
}
