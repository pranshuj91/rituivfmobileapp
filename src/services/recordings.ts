import RNFS from 'react-native-fs';
import type { CallLog } from 'react-native-call-log';
import type { SyncOptions } from './portal';

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|amr|wav|ogg|3gp)$/i;
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

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

function matchScore(name: string, callDigits: string, callTs: number, fileTs: number): number {
  const fileDigits = normalizeDigits(name);
  const numBoost =
    callDigits && fileDigits && (fileDigits.includes(callDigits.slice(-10)) || fileDigits.includes(callDigits.slice(-7)))
      ? 1
      : 0;
  const delta = Math.abs(callTs - fileTs);
  return numBoost * 1_000_000 - delta;
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
    for (const c of calls) {
      const ts = callTimeMs(c);
      if (!ts) continue;

      const digits = normalizeDigits(c.phoneNumber || c.formattedNumber);
      const matches = files
        .filter((f) => Math.abs(ts - f.mtimeMs) <= MATCH_WINDOW_MS)
        .sort((a, b) => matchScore(b.name, digits, ts, b.mtimeMs) - matchScore(a.name, digits, ts, a.mtimeMs))
        .slice(0, 2);

      if (matches.length > 0) {
        recordingsByCallId[c.id] = matches.map((m) => ({
          recording_url: `file://${m.path}`,
          recording_external_id: `${m.name}:${Math.floor(m.mtimeMs / 1000)}`,
          duration_seconds: c.duration > 0 ? c.duration : undefined,
        }));
      }
    }

    return Object.keys(recordingsByCallId).length > 0 ? { recordingsByCallId } : {};
  } catch {
    return {};
  }
}

