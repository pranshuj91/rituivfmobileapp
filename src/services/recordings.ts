import RNFS from 'react-native-fs';
import type { CallLog } from 'react-native-call-log';
import { toCalledAt, type SyncOptions } from './portal';

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|amr|wav|ogg|3gp)$/i;
const STRICT_MATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCallIdInName(fileName: string, callId: string): boolean {
  // Avoid accidental matches for very short ids like "9" / "91".
  // 3+ digits with numeric boundaries are usually safe to match.
  if (!callId || callId.length < 3) return false;
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

function parseTimestampFromFileName(fileName: string): number {
  // Many dialers encode local time like yymmddHHMM[ss] in filename.
  // Example: +919602999299-260402160649.mp3
  const base = fileName.replace(/\.[^.]+$/, '');
  const m = base.match(/(?:^|[^0-9])(\d{10,14})(?:[^0-9]|$)/);
  if (!m?.[1]) return 0;
  const digits = m[1];
  const yy = Number(digits.slice(0, 2));
  const mo = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  const hh = Number(digits.slice(6, 8));
  const mi = Number(digits.slice(8, 10));
  const ss = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
  if ([yy, mo, dd, hh, mi, ss].some((n) => !Number.isFinite(n))) return 0;
  const year = 2000 + yy;
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return 0;
  const t = new Date(year, mo - 1, dd, hh, mi, ss).getTime();
  return Number.isFinite(t) ? t : 0;
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
  if (!samePhone) return false;
  const closeByMtime = Math.abs(callTs - file.mtimeMs) <= STRICT_MATCH_WINDOW_MS;
  if (closeByMtime) return true;
  const fileTsFromName = parseTimestampFromFileName(file.name);
  const closeByNameTime = fileTsFromName
    ? Math.abs(callTs - fileTsFromName) <= STRICT_MATCH_WINDOW_MS
    : false;
  return closeByNameTime;
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
    // Newest-first helps avoid older calls consuming nearby recordings first.
    const sortedCalls = [...calls].sort((a, b) => callTimeMs(b) - callTimeMs(a));
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
        const calledAt = toCalledAt(c);
        recordingsByCallId[c.id] = matches.map((m) => ({
          recording_url: `file://${m.path}`,
          recording_external_id: `${m.name}:${c.id}`,
          duration_seconds: c.duration > 0 ? c.duration : undefined,
          source: 'mobile_app',
          recorded_at: calledAt,
        }));
      }
    }

    return Object.keys(recordingsByCallId).length > 0 ? { recordingsByCallId } : {};
  } catch {
    return {};
  }
}

