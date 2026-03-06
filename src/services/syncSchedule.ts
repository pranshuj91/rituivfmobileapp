/**
 * Scheduled sync: every 3 hours (and on app active) read call logs and POST to /api/call-logs/sync.
 * Uses same endpoint, body { logs }, and headers as manual sync.
 *
 * Load strategy: Load call logs from the device (calls after last_synced_at, or from install
 * if no last_synced_at); optionally cap at 100 per batch. That way we don't miss calls when
 * there are more than 100 since last sync. After a successful send we set last_synced_at to
 * the newest call timestamp in the batch so the next run continues from there.
 */

import { Platform } from 'react-native';
import CallLogs from 'react-native-call-log';
import type { CallLog } from 'react-native-call-log';
import {
  getLastSyncedAt,
  pushCallsToPortal,
  setLastSyncedAt,
} from './portal';

/** Max calls per request to keep payload size reasonable. */
const BATCH_LIMIT = 100;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

function getCallTimeMs(c: CallLog): number {
  if (typeof c.timestamp === 'number') {
    return c.timestamp > 1e12 ? c.timestamp : c.timestamp * 1000;
  }
  const ts = typeof c.timestamp === 'string' ? Number(c.timestamp) : NaN;
  if (Number.isFinite(ts)) return ts > 1e12 ? ts : ts * 1000;
  if (c.dateTime) {
    const t = Date.parse(c.dateTime);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Run the same sync as manual "Push to portal": load call logs from the device (calls after
 * last_synced_at, or from install if no last_synced_at; cap at BATCH_LIMIT per request),
 * then POST to /api/call-logs/sync. On success sets last_synced_at to the newest call
 * timestamp in the batch so the next run won't miss older calls. On error, skips (next run retries).
 */
export async function runScheduledSync(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    const lastSyncedAt = await getLastSyncedAt();
    const minTs = lastSyncedAt ?? 0;

    const callsToSend = await CallLogs.load(BATCH_LIMIT, {
      minTimestamp: minTs,
    });

    if (callsToSend.length === 0) return;

    const result = await pushCallsToPortal(callsToSend);
    if (result.success) {
      const newestTs = Math.max(...callsToSend.map(getCallTimeMs));
      await setLastSyncedAt(newestTs);
    }
  } catch {
    // Skip this run; next run (in 3h or on next app active) will retry
  }
}

/**
 * Returns true if we should run sync now (e.g. never synced or last sync was > 3 hours ago).
 */
export async function shouldRunSyncNow(): Promise<boolean> {
  const last = await getLastSyncedAt();
  if (last == null) return true;
  return Date.now() - last >= THREE_HOURS_MS;
}
