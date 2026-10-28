/**
 * Local index of CRM lead phone numbers.
 *
 * The app must only show and sync calls made to (or received from) numbers that
 * exist as leads in the CRM workspace. This module keeps a cached map
 * last-10-digits -> lead, refreshed from GET /api/leads, so the Call logs screen
 * and the background sync can filter the device call log before anything is
 * uploaded.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';
import { isLoggedIn } from './auth';
import { fetchLeads, type Lead } from './crm';

const STORAGE_KEY = '@gaincafe_lead_phone_index';
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // up to 5000 leads
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export interface LeadRef {
  id: string;
  name: string;
  status: string;
  /** CRM lead_source, e.g. "WhatsApp Inbound", "Call", "call_sync" */
  source?: string;
  createdAt?: string;
}

export interface LeadPhoneIndex {
  /** key = last 10 digits of the phone number */
  byLast10: Record<string, LeadRef>;
  fetchedAt: number;
  /** false when the fetch stopped early (page cap or error on a later page) */
  complete: boolean;
}

let memory: LeadPhoneIndex | null | undefined; // undefined = not loaded from storage yet
let refreshInFlight: Promise<LeadPhoneIndex | null> | null = null;

export function phoneKey(input?: string | null): string {
  const digits = (input ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function callPhoneKey(call: CallLog): string {
  return phoneKey(call.phoneNumber || call.formattedNumber);
}

function toRef(lead: Lead): LeadRef {
  return {
    id: String(lead.id),
    name: (lead.name || '').trim(),
    status: lead.status || '',
    source: lead.lead_source || undefined,
    createdAt: lead.created_at,
  };
}

async function loadFromStorage(): Promise<LeadPhoneIndex | null> {
  if (memory !== undefined) return memory;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memory = null;
      return null;
    }
    const parsed = JSON.parse(raw) as LeadPhoneIndex;
    if (!parsed || typeof parsed.byLast10 !== 'object') {
      memory = null;
      return null;
    }
    memory = parsed;
    return parsed;
  } catch {
    memory = null;
    return null;
  }
}

async function persist(index: LeadPhoneIndex): Promise<void> {
  memory = index;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(index));
  } catch {
    // Memory copy still serves this session.
  }
}

/** Merge leads seen on the Leads screen into the index without a full refresh. */
export async function addLeadsToIndex(leads: Lead[]): Promise<void> {
  if (leads.length === 0) return;
  const existing = (await loadFromStorage()) ?? { byLast10: {}, fetchedAt: 0, complete: false };
  const byLast10 = { ...existing.byLast10 };
  for (const lead of leads) {
    const ref = toRef(lead);
    for (const p of [lead.phone, lead.alternate_phone]) {
      const key = phoneKey(p);
      if (key.length >= 7) byLast10[key] = ref;
    }
  }
  await persist({ ...existing, byLast10 });
}

/** Full refresh from the CRM: every lead, every status. */
export async function refreshLeadPhoneIndex(): Promise<LeadPhoneIndex | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!(await isLoggedIn())) return null;
    const byLast10: Record<string, LeadRef> = {};
    let complete = true;
    let page = 1;
    let lastPage = 1;
    // Diagnostics: what the CRM actually sends per lead (fields, statuses, tags).
    const statusCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    let fieldNames: string[] = [];
    let tagSample: unknown;
    try {
      do {
        const result = await fetchLeads({ page, perPage: PAGE_SIZE, status: [] });
        for (const lead of result.items) {
          const raw = lead as unknown as Record<string, unknown>;
          if (fieldNames.length === 0) fieldNames = Object.keys(raw);
          const st = String(lead.status ?? '');
          statusCounts[st] = (statusCounts[st] ?? 0) + 1;
          const src = String(lead.lead_source ?? '');
          sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
          if (tagSample === undefined && (raw.tags != null || raw.labels != null)) {
            tagSample = raw.tags ?? raw.labels;
          }
          const ref = toRef(lead);
          for (const p of [lead.phone, lead.alternate_phone]) {
            const key = phoneKey(p);
            if (key.length >= 7) byLast10[key] = ref;
          }
        }
        lastPage = result.lastPage;
        page = result.page + 1;
        if (page > MAX_PAGES) {
          complete = false;
          break;
        }
      } while (page <= lastPage);
    } catch (e) {
      console.warn('[lead-index] refresh failed', e instanceof Error ? e.message : e);
      // Keep whatever we already had rather than replacing it with a partial list.
      const previous = await loadFromStorage();
      if (previous) return previous;
      if (Object.keys(byLast10).length === 0) return null;
      complete = false;
    }
    const index: LeadPhoneIndex = { byLast10, fetchedAt: Date.now(), complete };
    await persist(index);
    console.log('[lead-index] refreshed', { leads: Object.keys(byLast10).length, complete });
    console.log('[lead-index] lead shape', JSON.stringify({ fieldNames, statusCounts, sourceCounts, tagSample }));
    // Diagnostics: leads that were created by call sync itself (source call_sync / Call),
    // which make later calls to those numbers count as "lead calls".
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const fromSync = Object.entries(byLast10)
      .filter(([, ref]) => /call/i.test(ref.source ?? ''))
      .map(([key, ref]) => ({
        last4: key.slice(-4),
        name: ref.name,
        status: ref.status,
        source: ref.source,
        createdAt: ref.createdAt,
        today: ref.createdAt ? Date.parse(ref.createdAt) >= todayStart.getTime() : false,
      }));
    console.log('[lead-index] leads from call sources', JSON.stringify({
      total: fromSync.length,
      createdToday: fromSync.filter((l) => l.today).length,
      sample: fromSync.slice(0, 15),
    }));
    return index;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Returns the index, refreshing it when older than maxAgeMs. Falls back to the
 * stale copy when the refresh fails, and to null when nothing was ever fetched
 * (callers must then skip syncing rather than upload unfiltered calls).
 */
export async function getLeadPhoneIndex(options: { maxAgeMs?: number } = {}): Promise<LeadPhoneIndex | null> {
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cached = await loadFromStorage();
  if (cached && Date.now() - cached.fetchedAt <= maxAge) return cached;
  const refreshed = await refreshLeadPhoneIndex();
  return refreshed ?? cached;
}

export function findLeadForCall(index: LeadPhoneIndex | null, call: CallLog): LeadRef | undefined {
  if (!index) return undefined;
  const key = callPhoneKey(call);
  if (!key) return undefined;
  return index.byLast10[key];
}

export function filterLeadCalls(index: LeadPhoneIndex | null, calls: CallLog[]): CallLog[] {
  if (!index) return [];
  return calls.filter((c) => !!findLeadForCall(index, c));
}

export async function clearLeadPhoneIndex(): Promise<void> {
  memory = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
