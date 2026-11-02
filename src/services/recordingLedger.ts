/**
 * Persistent ledger of call recordings the app has tried to upload.
 *
 * Without this, a recording whose upload timed out or failed was simply
 * forgotten: the next automatic sync only looks at files newer than the last
 * sync, so the recording never went to the CRM. The ledger remembers every
 * recording the matcher paired with a call, its upload status, and enough of
 * the call log to resend the call together with the recording later.
 *
 * Statuses:
 *  - pending   upload not finished yet (will be retried, up to MAX_RECORDING_ATTEMPTS)
 *  - uploaded  CRM returned a URL; stored so the file is never uploaded twice
 *  - failed    gave up after MAX_RECORDING_ATTEMPTS attempts
 *  - rejected  will never upload (file over the CRM's 25 MB limit, or file gone)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@gaincafe_recording_ledger';
const MAX_ENTRIES = 600;
const UPLOADED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_RECORDING_ATTEMPTS = 10;
/** The CRM rejects recordings over 25 MB. */
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export type RecordingStatus = 'pending' | 'uploaded' | 'failed' | 'rejected';

export interface LedgerLog {
  id: string;
  callId: string;
  phone_number: string;
  name: string;
  direction: string;
  duration_seconds: number;
  called_at: string;
}

export interface RecordingLedgerEntry {
  externalId: string;
  callId: string;
  filePath: string;
  fileName: string;
  sizeBytes?: number;
  status: RecordingStatus;
  url?: string;
  attempts: number;
  lastError?: string;
  /** Call log fields, so the call can be resent with the recording later. */
  log: LedgerLog;
  recording: { duration_seconds?: number; source: string; recorded_at?: string };
  /** true once a sync batch carrying this call (with or without the recording) was queued. */
  queued: boolean;
  createdAt: number;
  updatedAt: number;
}

let memory: RecordingLedgerEntry[] | undefined;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<RecordingLedgerEntry[]> {
  if (memory) return memory;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as RecordingLedgerEntry[]) : [];
    memory = Array.isArray(parsed) ? parsed : [];
  } catch {
    memory = [];
  }
  return memory;
}

function prune(entries: RecordingLedgerEntry[]): RecordingLedgerEntry[] {
  const now = Date.now();
  let kept = entries.filter((e) => !(e.status === 'uploaded' && e.queued && now - e.updatedAt > UPLOADED_KEEP_MS));
  if (kept.length > MAX_ENTRIES) {
    kept = [...kept].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
  }
  return kept;
}

/** Serialise writes so two concurrent uploads cannot overwrite each other's update. */
function mutate(fn: (entries: RecordingLedgerEntry[]) => void): Promise<void> {
  writeChain = writeChain.then(async () => {
    const entries = await load();
    fn(entries);
    memory = prune(entries);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      // Memory copy still serves this session.
    }
  });
  return writeChain;
}

export async function getLedgerEntry(externalId: string): Promise<RecordingLedgerEntry | undefined> {
  if (!externalId) return undefined;
  return (await load()).find((e) => e.externalId === externalId);
}

/** Remember a recording the matcher paired with a call. No-op if it is already known. */
export async function registerRecording(input: {
  externalId: string;
  callId: string;
  filePath: string;
  fileName: string;
  log: LedgerLog;
  recording: { duration_seconds?: number; source: string; recorded_at?: string };
}): Promise<void> {
  if (!input.externalId) return;
  await mutate((entries) => {
    const existing = entries.find((e) => e.externalId === input.externalId);
    if (existing) {
      // Keep status/attempts; refresh the log in case contact name or path changed.
      existing.log = input.log;
      existing.filePath = input.filePath;
      existing.fileName = input.fileName;
      return;
    }
    const now = Date.now();
    entries.push({
      ...input,
      status: 'pending',
      attempts: 0,
      queued: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function markRecordingUploaded(externalId: string, url: string, sizeBytes?: number): Promise<void> {
  await mutate((entries) => {
    const e = entries.find((x) => x.externalId === externalId);
    if (!e) return;
    e.status = 'uploaded';
    e.url = url;
    if (sizeBytes != null) e.sizeBytes = sizeBytes;
    e.lastError = undefined;
    e.updatedAt = Date.now();
  });
}

/** One failed attempt; becomes `failed` after MAX_RECORDING_ATTEMPTS. */
export async function markRecordingAttemptFailed(externalId: string, error: string): Promise<void> {
  await mutate((entries) => {
    const e = entries.find((x) => x.externalId === externalId);
    if (!e || e.status === 'uploaded' || e.status === 'rejected') return;
    e.attempts += 1;
    e.lastError = error;
    e.status = e.attempts >= MAX_RECORDING_ATTEMPTS ? 'failed' : 'pending';
    e.updatedAt = Date.now();
  });
}

export async function markRecordingRejected(externalId: string, reason: string, sizeBytes?: number): Promise<void> {
  await mutate((entries) => {
    const e = entries.find((x) => x.externalId === externalId);
    if (!e || e.status === 'uploaded') return;
    e.status = 'rejected';
    e.lastError = reason;
    if (sizeBytes != null) e.sizeBytes = sizeBytes;
    e.updatedAt = Date.now();
  });
}

export async function markRecordingsQueued(externalIds: string[]): Promise<void> {
  if (externalIds.length === 0) return;
  const set = new Set(externalIds);
  await mutate((entries) => {
    const now = Date.now();
    entries.forEach((e) => {
      if (set.has(e.externalId)) {
        e.queued = true;
        e.updatedAt = now;
      }
    });
  });
}

/** Entries of one call. */
export async function getLedgerEntriesForCall(callId: string): Promise<RecordingLedgerEntry[]> {
  return (await load()).filter((e) => e.callId === callId);
}

/** true when the call still has a recording whose upload is pending (so the call must wait). */
export function hasPendingRecording(entries: RecordingLedgerEntry[]): boolean {
  return entries.some((e) => e.status === 'pending');
}

/**
 * Calls that still need work from the background retry: a pending upload, or a
 * call whose recordings gave up / were rejected but whose log was never queued.
 */
export async function getCallsNeedingRetry(): Promise<Map<string, RecordingLedgerEntry[]>> {
  const entries = await load();
  const byCall = new Map<string, RecordingLedgerEntry[]>();
  for (const e of entries) {
    if (e.queued) continue;
    const list = byCall.get(e.callId) ?? [];
    list.push(e);
    byCall.set(e.callId, list);
  }
  return byCall;
}

export interface CallRecordingSummary {
  status: RecordingStatus;
  attempts: number;
  lastError?: string;
}

/** One status per call for the UI: pending wins over failed, failed over rejected, else uploaded. */
export async function getRecordingStatusByCall(): Promise<Map<string, CallRecordingSummary>> {
  const entries = await load();
  const rank: Record<RecordingStatus, number> = { pending: 3, failed: 2, rejected: 1, uploaded: 0 };
  const out = new Map<string, CallRecordingSummary>();
  for (const e of entries) {
    const current = out.get(e.callId);
    if (!current || rank[e.status] > rank[current.status]) {
      out.set(e.callId, { status: e.status, attempts: e.attempts, lastError: e.lastError });
    }
  }
  return out;
}

export async function clearRecordingLedger(): Promise<void> {
  memory = [];
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
