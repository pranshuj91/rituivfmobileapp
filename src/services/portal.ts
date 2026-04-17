import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';
import RNFS from 'react-native-fs';
import Config from 'react-native-config';
import { enrichCallLogsWithContactNames } from './callLogNames';

/** Portal API URL – set in code; not configurable in Settings. */
const PORTAL_API_URL =
  Config.CALL_LOG_SYNC_URL || 'https://leadtracker.gaincafe.com/api/call-logs/sync';
const RECORDING_UPLOAD_URL =
  Config.CALL_LOG_UPLOAD_URL || 'https://leadtracker.gaincafe.com/api/call-logs/upload-recording';

/** Optional: set in code if your backend requires these headers. */
const CALL_LOG_APP_KEY = Config.CALL_LOG_APP_KEY || '';
const AUTHORIZATION = Config.CALL_LOG_AUTHORIZATION || ''; // e.g. 'Bearer token'

const DEVICE_NAME_KEY = '@ritu_device_name';
const DEVICE_PHONE_KEY = '@ritu_device_phone';
const LAST_SYNCED_AT_KEY = '@ritu_last_synced_at';
const PENDING_SYNC_BATCHES_KEY = '@ritu_pending_sync_batches';
const FAILED_SYNC_BATCHES_KEY = '@ritu_failed_sync_batches';
const uploadedRecordingsByCallId = new Map<string, Array<Record<string, unknown>>>();
const uploadedRecordingUrlByExternalId = new Map<string, string>();
const STRICT_PAIR_WINDOW_MS = 120 * 1000;
const UPLOAD_TIMEOUT_MS = 25 * 1000;
const SYNC_TIMEOUT_MS = 60 * 1000;
const DUPLICATE_SYNC_WINDOW_MS = 30 * 1000;
const SAME_LOGS_RECORDING_DROP_WINDOW_MS = 2 * 60 * 1000;
const MAX_PENDING_SYNC_BATCHES = 96;
const MAX_FAILED_SYNC_BATCHES = 200;
const MAX_BATCH_ATTEMPTS = 16;
const RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const EVICTED_BATCH_RETRY_DELAY_MS = 30 * 60 * 1000;
let syncRequestInFlight = false;
let lastSyncSignature = '';
let lastSyncAtMs = 0;
let lastSyncRecordingItems = 0;

interface SyncPayloadLog {
  id: string;
  callId: string;
  phone_number: string;
  name: string;
  direction: string;
  duration_seconds: number;
  called_at: string;
  recordings: Array<Record<string, unknown>>;
}

interface SyncPayload {
  logs: SyncPayloadLog[];
  deviceName?: string;
  devicePhone?: string;
  sentAt: string;
}

interface PendingSyncBatch {
  id: string;
  signature: string;
  priority: 'high' | 'normal';
  recordingItems: number;
  createdAt: number;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
  payload: SyncPayload;
}

export type SyncMode = 'manual' | 'auto';

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

async function getPendingSyncBatches(): Promise<PendingSyncBatch[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_SYNC_BATCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingSyncBatch[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function setPendingSyncBatches(batches: PendingSyncBatch[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_SYNC_BATCHES_KEY, JSON.stringify(batches));
}

async function getFailedSyncBatches(): Promise<PendingSyncBatch[]> {
  try {
    const raw = await AsyncStorage.getItem(FAILED_SYNC_BATCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingSyncBatch[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function setFailedSyncBatches(batches: PendingSyncBatch[]): Promise<void> {
  await AsyncStorage.setItem(FAILED_SYNC_BATCHES_KEY, JSON.stringify(batches));
}

async function moveBatchToFailedArchive(batch: PendingSyncBatch): Promise<void> {
  const existing = await getFailedSyncBatches();
  if (existing.some((b) => b.id === batch.id)) return;
  const next = [...existing, batch];
  const capped = next.length > MAX_FAILED_SYNC_BATCHES
    ? next.slice(next.length - MAX_FAILED_SYNC_BATCHES)
    : next;
  await setFailedSyncBatches(capped);
}

async function requeueDueFailedBatches(): Promise<void> {
  const now = Date.now();
  const [pending, failed] = await Promise.all([
    getPendingSyncBatches(),
    getFailedSyncBatches(),
  ]);
  if (failed.length === 0) return;

  const pendingIds = new Set(pending.map((b) => b.id));
  const dueFailed = failed.filter((b) => b.nextRetryAt <= now && !pendingIds.has(b.id));
  if (dueFailed.length === 0) return;

  const availableSlots = Math.max(0, MAX_PENDING_SYNC_BATCHES - pending.length);
  if (availableSlots === 0) return;

  const toRequeue = dueFailed
    .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
    .slice(0, availableSlots)
    .map((b) => ({
      ...b,
      nextRetryAt: now,
      lastError: `${b.lastError ?? 'recovered'} (requeued from failed archive)`,
    }));

  if (toRequeue.length === 0) return;

  const requeueIds = new Set(toRequeue.map((b) => b.id));
  const remainingFailed = failed.filter((b) => !requeueIds.has(b.id));
  await Promise.all([
    setPendingSyncBatches([...pending, ...toRequeue]),
    setFailedSyncBatches(remainingFailed),
  ]);
}

function makeBatchId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hashSignature(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function makeDeterministicBatchId(signature: string): string {
  return `batch-${hashSignature(signature)}`;
}

function retryDelayForAttempt(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts, RETRY_BACKOFF_MS.length - 1));
  return RETRY_BACKOFF_MS[idx];
}

async function enqueuePendingSyncBatch(batch: PendingSyncBatch): Promise<void> {
  await requeueDueFailedBatches();
  const existing = await getPendingSyncBatches();
  // BatchId dedupe: same logical payload should not enqueue twice.
  if (existing.some((b) => b.id === batch.id)) return;
  const next = batch.priority === 'high'
    ? [batch, ...existing]
    : [...existing, batch];
  // Queue limit:
  // - for high priority manual batch, always keep the new head and trim from tail
  // - for normal batch, keep newest N batches
  let capped = next;
  if (next.length > MAX_PENDING_SYNC_BATCHES) {
    capped = batch.priority === 'high'
      ? [next[0], ...next.slice(1, MAX_PENDING_SYNC_BATCHES)]
      : next.slice(next.length - MAX_PENDING_SYNC_BATCHES);
    const keptIds = new Set(capped.map((b) => b.id));
    const evicted = next.filter((b) => !keptIds.has(b.id));
    await Promise.all(
      evicted.map((e) => moveBatchToFailedArchive({
        ...e,
        nextRetryAt: Date.now() + EVICTED_BATCH_RETRY_DELAY_MS,
        lastError: `${e.lastError ?? 'queue limit'} (evicted from pending queue)`,
      }))
    );
  }
  await setPendingSyncBatches(capped);
}

async function postSyncPayload(
  payload: SyncPayload,
  headers: Record<string, string>
): Promise<{
  ok: boolean;
  message: string;
  count?: number;
  results?: PushResult['results'];
}> {
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
    return { ok: false, message: msg };
  }
  let apiMessage = `${payload.logs.length} call(s) pushed to portal.`;
  let savedCount = payload.logs.length;
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
  return { ok: true, message: apiMessage, count: savedCount, results };
}

async function flushPendingSyncBatches(
  headers: Record<string, string>
): Promise<PushResult> {
  await requeueDueFailedBatches();
  let batches = await getPendingSyncBatches();
  if (batches.length === 0) {
    return { success: true, message: 'No pending sync batch.' };
  }

  let lastSuccess: PushResult = {
    success: true,
    message: 'Synced pending batches successfully.',
  };
  let processedAny = false;
  let progressed = true;
  while (batches.length > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < batches.length; index += 1) {
      const current = batches[index];
      if (current.nextRetryAt > Date.now()) {
        continue;
      }
      progressed = true;
      processedAny = true;

      const before = batches.slice(0, index);
      const after = batches.slice(index + 1);

      const updateQueueAndReturn = async (
        replacement: PendingSyncBatch | null,
        result: PushResult
      ): Promise<PushResult> => {
        batches = replacement ? [...before, replacement, ...after] : [...before, ...after];
        await setPendingSyncBatches(batches);
        return result;
      };

    const posted = await postSyncPayload(current.payload, headers);
    if (!posted.ok) {
      const nextAttempts = current.attempts + 1;
      if (nextAttempts >= MAX_BATCH_ATTEMPTS) {
        const terminalFailed: PendingSyncBatch = {
          ...current,
          attempts: nextAttempts,
          nextRetryAt: 0,
          lastError: posted.message,
        };
        await moveBatchToFailedArchive(terminalFailed);
        return updateQueueAndReturn(null, {
          success: false,
          message: `Batch moved to failed archive after ${MAX_BATCH_ATTEMPTS} attempts.`,
        });
      }
      const failed: PendingSyncBatch = {
        ...current,
        attempts: nextAttempts,
        nextRetryAt: Date.now() + retryDelayForAttempt(current.attempts),
        lastError: posted.message,
      };
      return updateQueueAndReturn(failed, { success: false, message: posted.message });
    }
    const results = posted.results ?? [];
    const hasPartial = results.length > 0 && results.length < current.payload.logs.length;
    if (hasPartial) {
      const acknowledgedStatuses = new Set(['saved', 'matched', 'created', 'duplicate']);
      const resultsByPhone = new Map(
        results.map((r) => [normalizeDigits(String(r.phone_number ?? '')).slice(-10), r.status || ''])
      );
      const remainingLogs = current.payload.logs.filter((l) => {
        const k = normalizeDigits(String(l.phone_number ?? '')).slice(-10);
        const status = resultsByPhone.get(k);
        return !status || !acknowledgedStatuses.has(status);
      });
      if (remainingLogs.length > 0) {
        const nextAttempts = current.attempts + 1;
        if (nextAttempts >= MAX_BATCH_ATTEMPTS) {
          const terminalFailed: PendingSyncBatch = {
            ...current,
            attempts: nextAttempts,
            nextRetryAt: 0,
            lastError: `Partial success reached max attempts: ${results.length}/${current.payload.logs.length}`,
          };
          await moveBatchToFailedArchive(terminalFailed);
          return updateQueueAndReturn(null, {
            success: false,
            message: `Partial batch moved to failed archive after ${MAX_BATCH_ATTEMPTS} attempts.`,
          });
        }
        const partialBatch: PendingSyncBatch = {
          ...current,
          attempts: nextAttempts,
          nextRetryAt: Date.now() + retryDelayForAttempt(current.attempts),
          lastError: `Partial success: ${results.length}/${current.payload.logs.length}`,
          payload: {
            ...current.payload,
            logs: remainingLogs,
            sentAt: new Date().toISOString(),
          },
          signature: remainingLogs
            .map((l) => `${String(l.callId ?? l.id)}|${String(l.called_at ?? '')}`)
            .join('||'),
          recordingItems: remainingLogs.reduce(
            (acc, l) => acc + (l.recordings?.length ?? 0),
            0
          ),
        };
        return updateQueueAndReturn(partialBatch, {
          success: false,
          message: `Partial sync success. Remaining ${remainingLogs.length} logs queued for retry.`,
        });
      }
    }
      batches = [...before, ...after];
      await setPendingSyncBatches(batches);
    lastSyncSignature = current.signature;
    lastSyncAtMs = Date.now();
    lastSyncRecordingItems = current.recordingItems;
    lastSuccess = {
      success: true,
      message: posted.message,
      count: posted.count,
      results: posted.results,
    };
      break;
    }
  }
  if (!processedAny) {
    const nextDueMs = Math.min(...batches.map((b) => b.nextRetryAt));
    return {
      success: false,
      message: `Retry scheduled in ${Math.ceil((nextDueMs - Date.now()) / 1000)}s.`,
    };
  }
  return lastSuccess;
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

/** Same string as log `called_at` in sync payload — use for `recorded_at` on recordings. */
export function toCalledAt(c: CallLog): string {
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

function getCallTimeMs(c: CallLog): number {
  const rawTs = typeof c.timestamp === 'string' ? Number(c.timestamp) : c.timestamp;
  if (Number.isFinite(rawTs)) {
    return (rawTs as number) > 1e12 ? (rawTs as number) : (rawTs as number) * 1000;
  }
  if (c.dateTime) {
    const t = Date.parse(c.dateTime);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function callIdFromRecordingExternalId(externalId?: unknown): string {
  const ext = String(externalId ?? '');
  const idx = ext.lastIndexOf(':');
  if (idx < 0) return '';
  return ext.slice(idx + 1).trim();
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
  const externalId = String(recording.recording_external_id ?? '');
  // Reuse already uploaded URL for same stable recording_external_id.
  // This avoids repeated uploads across retries/auto-runs in same app session.
  if (externalId) {
    const cachedUrl = uploadedRecordingUrlByExternalId.get(externalId);
    if (cachedUrl) {
      const cached: Record<string, unknown> = {
        ...recording,
        recording_url: cachedUrl,
      };
      const list = uploadedRecordingsByCallId.get(callId) ?? [];
      list.push({
        recording_url: cachedUrl,
        recording_external_id: externalId,
        duration_seconds: recording.duration_seconds,
        source: recording.source,
        recorded_at: recording.recorded_at,
        __uploaded_for_call_id: callId,
      });
      uploadedRecordingsByCallId.set(callId, list);
      return cached;
    }
  }
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
    if (externalId) {
      uploadedRecordingUrlByExternalId.set(externalId, uploadedUrl);
    }
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
  options: SyncOptions = {},
  syncMode: SyncMode = 'manual'
): Promise<PushResult> {
  if (syncRequestInFlight) {
    console.log('[sync-lock] skipped duplicate sync request', { callCount: calls.length });
    return {
      success: false,
      message: 'Sync already in progress. Please wait a few seconds and try again.',
    };
  }
  syncRequestInFlight = true;
  try {
    // Dialer often shows a name while CallLogs.load() leaves name empty; fill from contacts when allowed.
    const callsForPayload = await enrichCallLogsWithContactNames(calls);
    const currentCallIds = new Set(callsForPayload.map((c) => String(c.id)));
    const deviceInfo = await getDeviceInfo();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (CALL_LOG_APP_KEY) headers['X-App-Key'] = CALL_LOG_APP_KEY;
    if (AUTHORIZATION) headers.Authorization = AUTHORIZATION;

    const logsBase = await Promise.all(callsForPayload.map(async (c) => {
      const singleRec = toRecordingSingle(options.singleRecordingByCallId?.[c.id]);
      const recordings = toRecordingArray(options.recordingsByCallId?.[c.id]);
      // Send a single unified recordings[] array to avoid duplicate payload forms.
      const mergedRecordingsRawAll = recordings ?? (Object.keys(singleRec).length > 0 ? [singleRec] : []);
      const mergedRecordingsRaw = mergedRecordingsRawAll.filter((r) => {
        const recCallId = callIdFromRecordingExternalId(r.recording_external_id);
        // Upload only candidates whose :callId belongs to current sync batch.
        return !!recCallId && recCallId === String(c.id) && currentCallIds.has(recCallId);
      });
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
    const currentLogCallIds = new Set(
      logsBase.map((l) => String((l as Record<string, unknown>).callId ?? (l as Record<string, unknown>).id ?? ''))
    );

    const requestedRecordingsByCallId = new Map<string, number>();
    callsForPayload.forEach((c) => {
      const list = options.recordingsByCallId?.[c.id] ?? [];
      const one = options.singleRecordingByCallId?.[c.id];
      const all = [...list, ...(one ? [one] : [])];
      const filtered = all.filter((r) => {
        const recCallId = callIdFromRecordingExternalId(r.recording_external_id ?? r.external_id);
        return !!recCallId && recCallId === String(c.id) && currentCallIds.has(recCallId);
      });
      requestedRecordingsByCallId.set(String(c.id), filtered.length);
    });
    const latestCall = [...callsForPayload].sort((a, b) => getCallTimeMs(b) - getCallTimeMs(a))[0];
    const latestCallId = latestCall ? String(latestCall.id) : '';
    const latestCallRequestedRecordings = latestCallId ? (requestedRecordingsByCallId.get(latestCallId) ?? 0) : 0;

    // Merge uploaded recordings into logs[] by callId.
    const usedExternalIds = new Set<string>();
    const usedRecordingUrls = new Set<string>();
    const dropReasonCounts: Record<string, number> = {
      outOfBatchOrMismatch: 0,
      strictMismatch: 0,
      duplicateExternalId: 0,
      duplicateRecordingUrl: 0,
    };
    const logs = logsBase.map((log) => {
      const callId = String(log.callId ?? log.id ?? '');
      const recsForCall = uploadedRecordingsByCallId.get(callId) ?? [];
      const recs = recsForCall.filter((r) => {
        const extId = String(r.recording_external_id ?? '');
        const extCallId = callIdFromRecordingExternalId(extId);
        const recUrl = String(r.recording_url ?? '');
        // Keep recording only when external id has ":<callId>" and this callId is in current batch.
        if (!extCallId || extCallId !== callId || !currentLogCallIds.has(extCallId)) {
          dropReasonCounts.outOfBatchOrMismatch += 1;
          console.warn('[recording-skip] out-of-batch-or-mismatch', {
            callId,
            extCallId,
            recording_external_id: extId,
          });
          return false;
        }
        if (!strictRecordingMatchesCall(r, log as Record<string, unknown>)) {
          dropReasonCounts.strictMismatch += 1;
          console.warn('[recording-skip] strict mismatch', {
            callId,
            phone: String(log.phone_number ?? ''),
            recording_external_id: extId,
          });
          return false;
        }
        if (extId && usedExternalIds.has(extId)) {
          dropReasonCounts.duplicateExternalId += 1;
          console.warn('[recording-skip] duplicate external id', {
            callId,
            recording_external_id: extId,
          });
          return false;
        }
        if (recUrl && usedRecordingUrls.has(recUrl)) {
          dropReasonCounts.duplicateRecordingUrl += 1;
          console.warn('[recording-skip] duplicate recording url', {
            callId,
            recording_url: recUrl,
            recording_external_id: extId,
          });
          return false;
        }
        if (extId) usedExternalIds.add(extId);
        if (recUrl) usedRecordingUrls.add(recUrl);
        return true;
      });
      return {
        ...log,
        recordings: recs,
      };
    });

    const payload: SyncPayload = {
      logs,
      ...(deviceInfo.deviceName ? { deviceName: deviceInfo.deviceName } : {}),
      ...(deviceInfo.devicePhone ? { devicePhone: deviceInfo.devicePhone } : {}),
      sentAt: new Date().toISOString(),
    };
    // Normal when no files matched / no local recordings — only noisy as a warning.
    if (!payload.logs.some((l) => (l as { recordings?: unknown[] }).recordings?.length)) {
      console.log('[sync-payload] no recordings attached in this batch (call logs only)');
    }
    const logsWithRecordings = payload.logs.filter((l) => (l as { recordings?: unknown[] }).recordings?.length).length;
    const totalRecordingItems = payload.logs.reduce((acc, l) => {
      const n = (l as { recordings?: unknown[] }).recordings?.length ?? 0;
      return acc + n;
    }, 0);
    const samplePairs = payload.logs.flatMap((l) => {
      const recs = l.recordings ?? [];
      return recs.slice(0, 1).map((r) => ({
        callId: String(l.callId || l.id || ''),
        phone: String(l.phone_number || ''),
        recording_external_id: String(r.recording_external_id ?? ''),
      }));
    }).slice(0, 5);
    const first2Compact = payload.logs.slice(0, 2).map((l) => ({
      callId: String(l.callId || l.id || ''),
      recordingsLength: (l.recordings?.length ?? 0),
    }));
    const syncSignature = payload.logs
      .map((l) => {
        const callId = String(l.callId || l.id || '');
        const calledAt = String(l.called_at || '');
        const recIds = (l.recordings ?? [])
          .map((r) => String(r.recording_external_id ?? ''))
          .filter(Boolean)
          .sort()
          .join(',');
        return `${callId}|${calledAt}|${recIds}`;
      })
      .join('||');
    const nowMs = Date.now();
    if (
      lastSyncSignature &&
      syncSignature === lastSyncSignature &&
      nowMs - lastSyncAtMs <= DUPLICATE_SYNC_WINDOW_MS
    ) {
      console.warn('[sync-block] duplicate payload in short window', {
        duplicateWithinMs: nowMs - lastSyncAtMs,
        totalLogs: payload.logs.length,
      });
      return {
        success: false,
        message: 'Duplicate sync payload detected. Skipping immediate re-send.',
      };
    }
    if (
      lastSyncSignature &&
      syncSignature === lastSyncSignature &&
      lastSyncRecordingItems > 0 &&
      totalRecordingItems === 0 &&
      nowMs - lastSyncAtMs <= SAME_LOGS_RECORDING_DROP_WINDOW_MS
    ) {
      console.error('[sync-block] same logs re-sent with recordings dropped', {
        previousRecordingItems: lastSyncRecordingItems,
        currentRecordingItems: totalRecordingItems,
        withinMs: nowMs - lastSyncAtMs,
      });
      return {
        success: false,
        message: 'Same logs re-sent without recordings soon after previous sync. Sync blocked.',
      };
    }
    console.log('[sync-payload] totals', {
      totalLogs: payload.logs.length,
      currentCallIdsSize: currentLogCallIds.size,
      logsWithRecordings,
      totalRecordingItems,
      uploadSucceededCount,
      dropReasonCounts,
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
    const latestCallLogEntry = latestCallId
      ? payload.logs.find(
        (l) => String(l.callId || l.id || '') === latestCallId
      ) as { recordings?: unknown[] } | undefined
      : undefined;
    const latestCallPayloadRecordings = latestCallLogEntry?.recordings?.length ?? 0;
    if (latestCallRequestedRecordings > 0 && latestCallPayloadRecordings === 0) {
      console.error('[sync-block] latest call expected recording but payload has none', {
        latestCallId,
        latestCallRequestedRecordings,
        latestCallPayloadRecordings,
      });
      return {
        success: false,
        message: 'Latest call has recording candidate, but payload recordings are empty. Sync blocked.',
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
      console.log('[sync-payload] no non-empty recordings before /sync (expected if batch has no matched files)');
    }
    console.log('[sync-payload] first 2 callId+recordings.length =', first2Compact);
    await enqueuePendingSyncBatch({
      id: makeDeterministicBatchId(syncSignature) || makeBatchId(),
      signature: syncSignature,
      priority: syncMode === 'manual' ? 'high' : 'normal',
      recordingItems: totalRecordingItems,
      createdAt: Date.now(),
      attempts: 0,
      nextRetryAt: Date.now(),
      payload,
    });
    return flushPendingSyncBatches(headers);
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
    syncRequestInFlight = false;
  }
}

export async function pushSingleCallToPortal(
  call: CallLog,
  options: SyncOptions = {},
  syncMode: SyncMode = 'manual'
): Promise<PushResult> {
  return pushCallsToPortal([call], options, syncMode);
}
