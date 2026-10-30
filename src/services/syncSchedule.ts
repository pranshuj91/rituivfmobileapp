/**
 * Scheduled sync: every 30 minutes (and on app active) read call logs and POST to /api/call-logs/sync.
 * Uses same endpoint, body { logs }, and headers as manual sync.
 *
 * Load strategy: Load call logs from the device (calls after last_synced_at, or from install
 * if no last_synced_at); optionally cap at 100 per batch. That way we don't miss calls when
 * there are more than 100 since last sync. After a successful send we set last_synced_at to
 * the newest call timestamp in the batch so the next run continues from there.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import CallLogs from 'react-native-call-log';
import type { CallLog } from 'react-native-call-log';
import NetInfo from '@react-native-community/netinfo';
import {
  getLastSyncedAt,
  pushCallsToPortal,
  flushPendingSyncQueue,
  setLastSyncedAt,
} from './portal';
import { buildRecordingSyncOptions } from './recordings';
import { isLoggedIn } from './auth';
import { filterLeadCalls, getLeadPhoneIndex } from './leadIndex';
import { getAllCallSyncEnabled } from './appSettings';

/** Max device calls examined per run; most are filtered out (non-lead numbers). */
const BATCH_LIMIT = 200;
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

export interface ScheduledSyncResult {
  status: 'synced' | 'nothing' | 'skipped' | 'failed';
  message: string;
  /** Calls sent in this run */
  sent: number;
}

/**
 * Run the same sync as manual "Push to portal": load call logs from the device (calls after
 * last_synced_at, or from install if no last_synced_at; cap at BATCH_LIMIT per request),
 * then POST to /api/call-logs/sync. On success sets last_synced_at to the newest call
 * timestamp in the batch so the next run won't miss older calls. On error, skips (next run retries).
 */
export async function runScheduledSync(): Promise<ScheduledSyncResult> {
  if (Platform.OS !== 'android') {
    return { status: 'skipped', message: 'Call sync is only available on Android.', sent: 0 };
  }
  if (scheduledSyncInFlight) {
    console.log('[auto-sync] skipped: scheduled sync already running');
    return { status: 'skipped', message: 'A sync is already running.', sent: 0 };
  }
  scheduledSyncInFlight = true;

  try {
    if (!(await isNetworkConnected())) {
      return { status: 'skipped', message: 'No internet connection.', sent: 0 };
    }
    // No agent session: nothing to sync against (the app shows the login screen).
    if (!(await isLoggedIn())) {
      return { status: 'skipped', message: 'Not signed in.', sent: 0 };
    }
    // Reading the call log needs a runtime permission that is granted from the Call logs tab.
    const canReadCallLog = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CALL_LOG);
    if (!canReadCallLog) {
      return {
        status: 'skipped',
        message: 'Call log access is not allowed yet. Open the Call logs tab and tap "Grant permissions".',
        sent: 0,
      };
    }
    // First drain anything queued from an earlier run (offline, timeout, app
    // killed mid-sync). This must not depend on there being new calls.
    const flushed = await flushPendingSyncQueue();
    if (flushed) {
      console.log('[auto-sync] queued batches', { success: flushed.success, message: flushed.message });
    }
    const queuedNote = flushed?.success ? ' Queued calls from earlier were sent.' : '';

    const lastSyncedAt = await getLastSyncedAt();
    const minTs = lastSyncedAt ?? 0;

    const loaded = await CallLogs.load(BATCH_LIMIT, {
      minTimestamp: minTs,
    });

    if (loaded.length === 0) {
      if (flushed && !flushed.success) {
        return { status: 'failed', message: flushed.message, sent: 0 };
      }
      return { status: 'nothing', message: `No new calls since the last sync.${queuedNote}`, sent: 0 };
    }
    const newestTs = Math.max(...loaded.map(getCallTimeMs));

    // "All call sync" off: only calls with CRM lead numbers are synced, and
    // without a lead list we must not upload anything. On: every call is sent.
    const allCallSync = await getAllCallSyncEnabled();
    let callsToSend = loaded;
    if (!allCallSync) {
      const leadIndex = await getLeadPhoneIndex();
      if (!leadIndex) {
        console.log('[auto-sync] skipped: CRM lead list not available');
        return { status: 'skipped', message: 'CRM lead list not available. Refresh leads and try again.', sent: 0 };
      }
      callsToSend = filterLeadCalls(leadIndex, loaded);
      if (callsToSend.length === 0) {
        // Nothing to sync in this window; move the cursor so these are not re-read.
        await setLastSyncedAt(newestTs);
        return { status: 'nothing', message: `No new calls with CRM leads since the last sync.${queuedNote}`, sent: 0 };
      }
    }

    const syncOptions = await buildRecordingSyncOptions(callsToSend);
    let lastMessage = 'Sync failed.';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await pushCallsToPortal(callsToSend, syncOptions, 'auto');
      if (result.success) {
        await setLastSyncedAt(newestTs);
        return {
          status: 'synced',
          message: `${callsToSend.length} call${callsToSend.length === 1 ? '' : 's'}${allCallSync ? '' : ' with leads'} sent to the CRM.`,
          sent: callsToSend.length,
        };
      }
      lastMessage = result.message;
      if (attempt >= RETRY_DELAYS_MS.length) break;
      if (!(await isNetworkConnected())) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    return { status: 'failed', message: lastMessage, sent: 0 };
  } catch (e) {
    // Skip this run; next run will retry.
    return { status: 'failed', message: e instanceof Error ? e.message : 'Sync failed.', sent: 0 };
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
