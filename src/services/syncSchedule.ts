/**
 * Scheduled sync: every 30 minutes (and on app active) read call logs and POST to /api/call-logs/sync.
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
import NetInfo from '@react-native-community/netinfo';
import {
  getLastSyncedAt,
  pushCallsToPortal,
  setLastSyncedAt,
} from './portal';
import { buildRecordingSyncOptions } from './recordings';

/** Max calls per request to keep payload size reasonable. */
const BATCH_LIMIT = 100;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
let scheduledSyncInFlight = false;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isNetworkConnected(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    if (!state.isConnected) return false;
    if (state.isInternetReachable === false) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the same sync as manual "Push to portal": load call logs from the device (calls after
 * last_synced_at, or from install if no last_synced_at; cap at BATCH_LIMIT per request),
 * then POST to /api/call-logs/sync. On success sets last_synced_at to the newest call
 * timestamp in the batch so the next run won't miss older calls. On error, skips (next run retries).
 */
export async function runScheduledSync(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (scheduledSyncInFlight) {
    console.log('[auto-sync] skipped: scheduled sync already running');
    return;
  }
  scheduledSyncInFlight = true;

  try {
    if (!(await isNetworkConnected())) return;
    const lastSyncedAt = await getLastSyncedAt();
    const minTs = lastSyncedAt ?? 0;

    const callsToSend = await CallLogs.load(BATCH_LIMIT, {
      minTimestamp: minTs,
    });

    if (callsToSend.length === 0) return;

    const syncOptions = await buildRecordingSyncOptions(callsToSend);
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await pushCallsToPortal(callsToSend, syncOptions);
      if (result.success) {
        const newestTs = Math.max(...callsToSend.map(getCallTimeMs));
        await setLastSyncedAt(newestTs);
        return;
      }
      if (attempt >= RETRY_DELAYS_MS.length) break;
      if (!(await isNetworkConnected())) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  } catch {
    // Skip this run; next run will retry.
  } finally {
    scheduledSyncInFlight = false;
  }
}

/**
 * Returns true if we should run sync now (e.g. never synced or last sync was > 30 minutes ago).
 */
export async function shouldRunSyncNow(): Promise<boolean> {
  const last = await getLastSyncedAt();
  if (last == null) return true;
  return Date.now() - last >= THIRTY_MINUTES_MS;
}
