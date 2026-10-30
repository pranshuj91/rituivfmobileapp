import RNFS from 'react-native-fs';
import type { CallLog } from 'react-native-call-log';
import { getLastSyncedAt, toCalledAt, type SyncOptions } from './portal';

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|amr|wav|ogg|3gp)$/i;
const STRICT_MATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const FALLBACK_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
const RECENT_FILE_BUFFER_MS = 10 * 60 * 1000; // include a small overlap around last sync

function normalizeDigits(input?: string | null): string {
  return (input ?? '').replace(/\D/g, '');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatCallTimeForExternalId(ms: number): string {
  const d = new Date(ms);
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join('');
}

function shortTokenFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const alnum = base.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum.length >= 6) return `rec${alnum.slice(-6)}`;
  // Stable fallback token for short/odd filenames.
  let hash = 0;
  for (let i = 0; i < fileName.length; i += 1) {
    hash = (hash * 31 + fileName.charCodeAt(i)) % 2147483647;
  }
  const suffix = Math.abs(hash).toString(36).toUpperCase().slice(0, 6).padEnd(6, '0');
  return `rec${suffix}`;
}

export function buildRecordingExternalId(call: CallLog, fileName: string, callTs: number): string {
  const phoneLast10 = normalizeDigits(call.phoneNumber || call.formattedNumber).slice(-10) || '0000000000';
  const callTime = formatCallTimeForExternalId(callTs);
  const shortFileToken = shortTokenFromFileName(fileName);
  return `${phoneLast10}-${callTime}-${shortFileToken}:${call.id}`;
}

export function callTimeMs(c: CallLog): number {
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
  // Keep this strict (5+ digits) so we don't accidentally match timestamp fragments.
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

function isMissedType(type?: string): boolean {
  return String(type ?? '').toUpperCase().includes('MISSED');
}

function preferredFileTimeMs(file: { name: string; mtimeMs: number }): number {
  const fromName = parseTimestampFromFileName(file.name);
  return fromName || file.mtimeMs;
}

function normalizeAlpha(input?: string | null): string {
  return (input ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function hasContactNameInFile(fileName: string, contactName?: string | null): boolean {
  const fileAlpha = normalizeAlpha(fileName);
  const nameAlpha = normalizeAlpha(contactName);
  if (!fileAlpha || nameAlpha.length < 3) return false;
  return fileAlpha.includes(nameAlpha);
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

/**
 * Folders where phone dialers and recorder apps save call recordings.
 * Scanned up to 3 levels deep, so "Music/Recordings/Call Recordings" is covered by "Music".
 */
export function candidateRecordingDirs(): string[] {
  const base = RNFS.ExternalStorageDirectoryPath;
  return [
    // Samsung Phone, Vivo/iQOO, HyperOS, generic
    `${base}/Recordings`,
    `${base}/Call`,
    `${base}/CallRecordings`,
    `${base}/CallRecord`,
    `${base}/Call Recordings`,
    `${base}/PhoneRecord`,
    `${base}/Record`,
    `${base}/Record/Call`,
    `${base}/Record/PhoneRecord`,
    `${base}/Sounds`,
    // Oppo / Realme / OnePlus (ODialer): Music/Recordings/Call Recordings
    `${base}/Music`,
    // Xiaomi / Redmi / POCO (MIUI)
    `${base}/MIUI/sound_recorder/call_rec`,
    `${base}/MIUI/sound_recorder`,
    // Dialer app media folders
    `${base}/Android/media/com.google.android.dialer/CallRecordings`,
    `${base}/Android/media/com.android.dialer/CallRecordings`,
    `${base}/Android/media/com.oplus.dialer/CallRecordings`,
    `${base}/Android/media/com.heytap.dialer/CallRecordings`,
    `${base}/Android/media/com.coloros.dialer/CallRecordings`,
    `${base}/Android/media/com.oppo.dialer/CallRecordings`,
    `${base}/Android/media/com.oplus.dialer/Recordings/Call`,
    `${base}/Android/media/com.heytap.dialer/Recordings/Call`,
    `${base}/Android/media/com.coloros.soundrecorder`,
    `${base}/Android/media/com.coloros.soundrecorder/Recordings`,
    `${base}/Android/media/com.oplus.soundrecorder/Recordings`,
    `${base}/Android/media/com.samsung.android.dialer`,
    `${base}/Android/media/com.vivo.dialer`,
    `${base}/Android/media/com.android.incallui`,
    // Cube ACR (third-party recorder for Google Phone devices)
    `${base}/CubeCallRecorder`,
    `${base}/CubeCallRecorder/All`,
    `${base}/Android/media/com.catalinagroup.callrecorder`,
    `${base}/Android/media/com.catalinagroup.callrecorder/CubeCallRecorder`,
  ];
}

export interface RecordingFolderInfo {
  /** Path relative to the storage root, e.g. "Music/Recordings/Call Recordings" */
  relativePath: string;
  files: number;
  newestMs: number;
}

/** Folders on this phone that actually contain audio files, newest first. Used by Settings. */
export async function listRecordingFolders(): Promise<RecordingFolderInfo[]> {
  const base = RNFS.ExternalStorageDirectoryPath;
  const byDir = new Map<string, { files: number; newestMs: number }>();
  for (const d of candidateRecordingDirs()) {
    const out: Array<{ path: string; name: string; mtimeMs: number }> = [];
    await collectFromDir(d, 3, out);
    for (const f of out) {
      const dir = f.path.slice(0, f.path.lastIndexOf('/'));
      const entry = byDir.get(dir) ?? { files: 0, newestMs: 0 };
      entry.files += 1;
      entry.newestMs = Math.max(entry.newestMs, f.mtimeMs);
      byDir.set(dir, entry);
    }
  }
  return Array.from(byDir.entries())
    .map(([dir, info]) => ({
      relativePath: dir.startsWith(base) ? dir.slice(base.length + 1) : dir,
      files: info.files,
      newestMs: info.newestMs,
    }))
    // Call-recording folders first (by name), then whatever has the newest audio.
    .sort((a, b) => {
      const aCall = /call|phonerecord|cube/i.test(a.relativePath) ? 1 : 0;
      const bCall = /call|phonerecord|cube/i.test(b.relativePath) ? 1 : 0;
      return bCall - aCall || b.newestMs - a.newestMs;
    });
}

async function collectCandidateRecordings(): Promise<Array<{ path: string; name: string; mtimeMs: number }>> {
  const out: Array<{ path: string; name: string; mtimeMs: number }> = [];
  const seen = new Set<string>();
  for (const d of candidateRecordingDirs()) {
    const found: Array<{ path: string; name: string; mtimeMs: number }> = [];
    await collectFromDir(d, 3, found);
    for (const f of found) {
      // Nested candidate dirs (e.g. Music and Music/Recordings) must not list a file twice.
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  }
  return out;
}

export async function buildRecordingSyncOptions(calls: CallLog[]): Promise<SyncOptions> {
  try {
    const allFiles = await collectCandidateRecordings();
    if (allFiles.length === 0 || calls.length === 0) return {};
    const lastSyncedAt = await getLastSyncedAt();
    // Look back to the oldest call being pushed, not only to the last sync: a manual
    // "Push to portal" of older calls must still find their recordings.
    const callTimes = calls.map(callTimeMs).filter((t) => t > 0);
    const oldestCallTs = callTimes.length > 0 ? Math.min(...callTimes) : 0;
    const sinceLastSync = lastSyncedAt ? lastSyncedAt - RECENT_FILE_BUFFER_MS : 0;
    const minFileTs = Math.max(0, Math.min(sinceLastSync, oldestCallTs > 0 ? oldestCallTs - RECENT_FILE_BUFFER_MS : sinceLastSync));
    let files = allFiles.filter((f) => preferredFileTimeMs(f) >= minFileTs);
    // Some dialers report stale mtime/parsed timestamps; fallback to last 24h scope for discovery.
    if (files.length === 0) {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      files = allFiles.filter((f) => preferredFileTimeMs(f) >= dayAgo);
    }
    console.log('[recording-debug] discovery', {
      allFilesCount: allFiles.length,
      selectedFilesCount: files.length,
      sampleSelected: files.slice(0, 10).map((f) => ({ name: f.name, path: f.path })),
    });
    if (files.length === 0) return {};

    const recordingsByCallId: NonNullable<SyncOptions['recordingsByCallId']> = {};
    const usedPaths = new Set<string>();
    // Newest-first helps avoid older calls consuming nearby recordings first.
    const sortedCalls = [...calls].sort((a, b) => callTimeMs(b) - callTimeMs(a));
    const debugLatestCallIds = new Set(sortedCalls.slice(0, 5).map((c) => String(c.id)));
    for (const c of sortedCalls) {
      const ts = callTimeMs(c);
      if (!ts) continue;

      const digits = normalizeDigits(c.phoneNumber || c.formattedNumber);
      const unmatchedCandidates = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => hasSamePhoneInName(f.name, digits));
      const matches = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => belongsToCall(f, c, ts, digits))
        .sort((a, b) => matchScore(b.name, c.id, digits, ts, b.mtimeMs) - matchScore(a.name, c.id, digits, ts, a.mtimeMs))
        .slice(0, 2);
      const fallbackByPhoneNearest = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => hasSamePhoneInName(f.name, digits))
        .filter((f) => Math.abs(ts - preferredFileTimeMs(f)) <= FALLBACK_MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(ts - preferredFileTimeMs(a)) - Math.abs(ts - preferredFileTimeMs(b)))
        .slice(0, 1);
      const fallbackByNameNearest = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => hasContactNameInFile(f.name, c.name))
        .filter((f) => Math.abs(ts - preferredFileTimeMs(f)) <= FALLBACK_MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(ts - preferredFileTimeMs(a)) - Math.abs(ts - preferredFileTimeMs(b)))
        .slice(0, 1);
      const fallbackByTimeOnly = files
        .filter((f) => !usedPaths.has(f.path))
        .filter((f) => Math.abs(ts - preferredFileTimeMs(f)) <= 90 * 1000)
        .sort((a, b) => Math.abs(ts - preferredFileTimeMs(a)) - Math.abs(ts - preferredFileTimeMs(b)))
        .slice(0, 1);
      const finalMatches =
        matches.length > 0 || isMissedType(c.type)
          ? matches
          : (fallbackByPhoneNearest.length > 0
            ? fallbackByPhoneNearest
            : (fallbackByNameNearest.length > 0 ? fallbackByNameNearest : fallbackByTimeOnly));

      if (debugLatestCallIds.has(String(c.id))) {
        console.log('[recording-debug] latest-call-candidates', {
          callId: String(c.id),
          phone: c.phoneNumber || c.formattedNumber || '',
          callTs: ts,
          unmatchedCandidatesCount: unmatchedCandidates.length,
          matchedCount: matches.length,
          fallbackMatchedCount: fallbackByPhoneNearest.length,
          fallbackNameMatchedCount: fallbackByNameNearest.length,
          fallbackTimeOnlyCount: fallbackByTimeOnly.length,
          matchedNames: matches.map((m) => m.name),
          finalMatchedNames: finalMatches.map((m) => m.name),
        });
      }

      if (finalMatches.length > 0) {
        finalMatches.forEach((m) => usedPaths.add(m.path));
        const calledAt = toCalledAt(c);
        recordingsByCallId[c.id] = finalMatches.map((m) => ({
          recording_url: `file://${m.path}`,
          recording_external_id: buildRecordingExternalId(c, m.name, ts),
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

