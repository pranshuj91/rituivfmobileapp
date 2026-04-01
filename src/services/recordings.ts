import RNFS from 'react-native-fs';
import type { CallLog } from 'react-native-call-log';
import type { SyncOptions } from './portal';

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|amr|wav|ogg|3gp)$/i;
const STRICT_MATCH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

function normalizeDigits(input?: string | null): string {
  return (input ?? '').replace(/\D/g, '');
}

function callTimeMs(c: CallLog): number {
  const raw = typeof c.timestamp === 'string' ? Number(c.timestamp) : c.timestamp;
  if (Number.isFinite(raw)) {
    return (raw as number) > 1e12 ? (raw as number) : (raw as number) * 1000;
  }
  if (c.dateTime) {
    const d = Date.parse(c.dateTime);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

function toRecordedAt(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCallIdInName(fileName: string, callId: string): boolean {
  // Avoid accidental matches for short ids like "91" that appear in "+91..." or timestamps.
  if (!callId || callId.length < 5) return false;
  const re = new RegExp(`(?:^|[^0-9])${escapeRegExp(callId)}(?:[^0-9]|$)`);
  return re.test(fileName);
}

function hasSamePhoneInName(fileName: string, callDigits: string): boolean {
  const fileDigits = normalizeDigits(fileName);
  if (!callDigits || !fileDigits) return false;
  const d10 = callDigits.slice(-10);
  const d7 = callDigits.slice(-7);
  return (d10.length >= 7 && fileDigits.includes(d10)) || (d7.length >= 7 && fileDigits.includes(d7));
}

function belongsToCall(
  file: { name: string; mtimeMs: number },
  call: CallLog,
  callTs: number,
  callDigits: string
): boolean {
  // Strict rule #1: filename explicitly includes callId token + same phone.
  if (hasCallIdInName(file.name, call.id)) {
    return hasSamePhoneInName(file.name, callDigits);
  }
  // Strict rule #2: same phone number in filename + very close timestamp.
  const samePhone = hasSamePhoneInName(file.name, callDigits);
  const closeTime = Math.abs(callTs - file.mtimeMs) <= STRICT_MATCH_WINDOW_MS;
  return samePhone && closeTime;
}

function matchScore(fileName: string, callId: string, callDigits: string, callTs: number, fileTs: number): number {
  const byId = hasCallIdInName(fileName, callId) ? 1 : 0;
  const byPhone = hasSamePhoneInName(fileName, callDigits) ? 1 : 0;
  const delta = Math.abs(callTs - fileTs);
  return byId * 10_000_000 + byPhone * 1_000_000 - delta;
}

async function listFiles(dir: string): Promise<RNFS.ReadDirItem[]> {
  try {
    return await RNFS.readDir(dir);
  } catch {
    return [];
  }
}

async function collectFromDir(
  dir: string,
  maxDepth: number,
  out: Array<{ path: string; name: string; mtimeMs: number }>
): Promise<void> {
  if (maxDepth < 0) return;
  const entries = await listFiles(dir);
  for (const e of entries) {
    if (e.isFile() && AUDIO_EXT_RE.test(e.name)) {
      out.push({
        path: e.path,
        name: e.name,
        mtimeMs: e.mtime ? new Date(e.mtime).getTime() : 0,
      });
      continue;
    }
    if (e.isDirectory()) {
      await collectFromDir(e.path, maxDepth - 1, out);
    }
  }
}

async function collectCandidateRecordings(): Promise<Array<{ path: string; name: string; mtimeMs: number }>> {
  const base = RNFS.ExternalStorageDirectoryPath;
  const dirs = [
    `${base}/Recordings`,
    `${base}/Call`,
    `${base}/CallRecordings`,
    `${base}/CallRecord`,
    `${base}/PhoneRecord`,
    `${base}/Sounds`,
    `${base}/Music`,
    `${base}/Android/media/com.google.android.dialer/CallRecordings`,
    `${base}/Android/media/com.android.dialer/CallRecordings`,
    `${base}/Android/media/com.coloros.soundrecorder`,
    `${base}/MIUI/sound_recorder/call_rec`,
  ];

  const out: Array<{ path: string; name: string; mtimeMs: number }> = [];
  for (const d of dirs) {
    await collectFromDir(d, 3, out);
  }
  return out;
}

export async function buildRecordingSyncOptions(calls: CallLog[]): Promise<SyncOptions> {
  try {
    const files = await collectCandidateRecordings();
    if (files.length === 0 || calls.length === 0) return {};

    const recordingsByCallId: NonNullable<SyncOptions['recordingsByCallId']> = {};
    const usedPaths = new Set<string>();
    const sortedCalls = [...calls].sort((a, b) => callTimeMs(a) - callTimeMs(b));
    for (const c of sortedCalls) {
      const ts = callTimeMs(c);
      if (!ts) continue;

      const digits = normalizeDigits(c.phoneNumber || c.formattedNumber);
      const matches = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => belongsToCall(f, c, ts, digits))
        .sort((a, b) => matchScore(b.name, c.id, digits, ts, b.mtimeMs) - matchScore(a.name, c.id, digits, ts, a.mtimeMs))
        .slice(0, 2);

      if (matches.length > 0) {
        matches.forEach((m) => usedPaths.add(m.path));
        recordingsByCallId[c.id] = matches.map((m) => ({
          recording_url: `file://${m.path}`,
          recording_external_id: `${m.name}:${c.id}`,
          duration_seconds: c.duration > 0 ? c.duration : undefined,
          source: 'mobile_app',
          recorded_at: toRecordedAt(m.mtimeMs),
        }));
      }
    }

    return Object.keys(recordingsByCallId).length > 0 ? { recordingsByCallId } : {};
  } catch {
    return {};
  }
}

