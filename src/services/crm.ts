/**
 * Gaincafe CRM API: leads list and dialing.
 *
 * GET /api/leads?status=new,follow_up&search=...&per_page=50&page=1
 * Laravel pagination; both the resource shape ({data, meta}) and the plain
 * paginator shape ({data, current_page, last_page, total}) are handled.
 */

import { Linking } from 'react-native';
import { AuthError, CRM_API_BASE_URL, clearSession, getAuthHeaders } from './auth';

const REQUEST_TIMEOUT_MS = 30 * 1000;

export interface Lead {
  id: string;
  name: string | null;
  phone: string | null;
  alternate_phone?: string | null;
  email?: string | null;
  treatment?: string | null;
  lead_source?: string | null;
  lead_channel?: string | null;
  status: string;
  follow_up_date?: string | null;
  notes?: string | null;
  city?: string | null;
  state?: string | null;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string | null;
}

export interface LeadsPage {
  items: Lead[];
  page: number;
  lastPage: number;
  total: number;
}

export interface LeadsQuery {
  page?: number;
  perPage?: number;
  /** CRM status slugs, e.g. ['new', 'follow_up'] */
  status?: string[];
  /** Matches name or phone on the CRM side */
  search?: string;
}

export interface LeadStatusMeta {
  slug: string;
  /** Full label as the CRM shows it */
  label: string;
  /** Short label for filter chips */
  short: string;
  /** Badge text colour */
  fg: string;
  /** Badge background colour */
  bg: string;
}

/**
 * The CRM's 13 lead statuses (Lead::statusLabels()). The API sends the slug;
 * labels are not exposed by any endpoint, so they live here.
 */
export const LEAD_STATUSES: LeadStatusMeta[] = [
  { slug: 'new', label: 'New', short: 'New', fg: '#2563EB', bg: '#DBEAFE' },
  { slug: 'contacted_high', label: 'Contacted – High Priority', short: 'Contacted · High', fg: '#DB2777', bg: '#FCE7F3' },
  { slug: 'contacted_low', label: 'Contacted – Low Priority', short: 'Contacted · Low', fg: '#9333EA', bg: '#F3E8FF' },
  { slug: 'follow_up', label: 'Follow Up', short: 'Follow up', fg: '#D97706', bg: '#FEF3C7' },
  { slug: 'not_contacted', label: 'Call Not Connected', short: 'Call not connected', fg: '#EA580C', bg: '#FFEDD5' },
  { slug: 'appointment_booked', label: 'Appointment Booked', short: 'Appointment', fg: '#0891B2', bg: '#CFFAFE' },
  { slug: 'consultation_done', label: 'Consultation Done', short: 'Consultation done', fg: '#0D9488', bg: '#CCFBF1' },
  { slug: 'package_booked', label: 'Package Booked', short: 'Package booked', fg: '#4F46E5', bg: '#E0E7FF' },
  { slug: 'converted', label: 'Converted', short: 'Converted', fg: '#16A34A', bg: '#DCFCE7' },
  { slug: 'not_interested', label: 'Not Interested', short: 'Not interested', fg: '#DC2626', bg: '#FEE2E2' },
  { slug: 'lost', label: 'Lost', short: 'Lost', fg: '#57534E', bg: '#E7E5E4' },
  { slug: 'non_ivf_gynecology', label: 'Non-IVF – Gynecology', short: 'Non-IVF Gyne', fg: '#7C3AED', bg: '#EDE9FE' },
  { slug: 'spam_marketing', label: 'Spam / Marketing', short: 'Spam', fg: '#78716C', bg: '#F5F5F4' },
];

const STATUS_BY_SLUG: Record<string, LeadStatusMeta> = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s.slug, s])
);

const UNKNOWN_STATUS: LeadStatusMeta = {
  slug: '',
  label: 'Unknown',
  short: 'Unknown',
  fg: '#78716C',
  bg: '#F5F5F4',
};

export function leadStatusMeta(status?: string | null): LeadStatusMeta {
  if (!status) return UNKNOWN_STATUS;
  const known = STATUS_BY_SLUG[status];
  if (known) return known;
  const label = status.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { ...UNKNOWN_STATUS, slug: status, label, short: label };
}

export function leadStatusLabel(status?: string | null): string {
  return leadStatusMeta(status).label;
}

export class CrmError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { message?: unknown; errors?: Record<string, unknown> };
  if (b.errors && typeof b.errors === 'object') {
    const first = Object.values(b.errors)[0];
    if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  }
  if (typeof b.message === 'string' && b.message.trim()) return b.message;
  return fallback;
}

/**
 * Authenticated GET/POST to the CRM. A 401 clears the stored session so the
 * app falls back to the login screen; a 403 is reported as-is (feature disabled
 * for the workspace, or missing permission).
 */
export async function crmRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeaders();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${CRM_API_BASE_URL}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } catch (e) {
    const isAbort = e instanceof Error && e.name === 'AbortError';
    throw new CrmError(isAbort ? 'Request timed out.' : 'Could not reach Gaincafe CRM.');
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 401) {
    await clearSession();
    throw new AuthError('Your session has expired. Please log in again.', 401);
  }
  if (res.status === 403 && /access to this workspace/i.test(messageFromBody(body, ''))) {
    // The stored workspace id no longer matches the token's membership
    // (e.g. a bad session migration). A fresh login stores the right one.
    await clearSession();
    throw new AuthError('Workspace access changed. Please log in again.', 403);
  }
  if (!res.ok) {
    const fallback =
      res.status === 403
        ? 'Access denied. Ask your admin to enable Call Sync for this workspace.'
        : `Gaincafe CRM responded with ${res.status}.`;
    throw new CrmError(messageFromBody(body, fallback), res.status);
  }
  return body as T;
}

export async function fetchLeads(query: LeadsQuery = {}): Promise<LeadsPage> {
  const params = new URLSearchParams();
  params.set('page', String(query.page ?? 1));
  params.set('per_page', String(Math.min(100, query.perPage ?? 50)));
  if (query.status && query.status.length > 0) params.set('status', query.status.join(','));
  if (query.search && query.search.trim()) params.set('search', query.search.trim());

  const json = await crmRequest<{
    data?: Lead[];
    meta?: { current_page?: number; last_page?: number; total?: number };
    current_page?: number;
    last_page?: number;
    total?: number;
  }>(`/leads?${params.toString()}`);

  const items = Array.isArray(json?.data) ? json.data : [];
  const page = json?.meta?.current_page ?? json?.current_page ?? query.page ?? 1;
  const lastPage = json?.meta?.last_page ?? json?.last_page ?? page;
  const total = json?.meta?.total ?? json?.total ?? items.length;
  return { items, page, lastPage, total };
}

/** CRM stores digits only with country code (919876543210). Dialer wants +91... */
export function toDialable(phone?: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export function formatPhoneForDisplay(phone?: string | null): string {
  const dial = toDialable(phone);
  if (!dial) return '';
  if (dial.startsWith('+91') && dial.length === 13) {
    return `+91 ${dial.slice(3, 8)} ${dial.slice(8)}`;
  }
  return dial;
}

/** Opens the phone dialer with the lead's number. Returns false when nothing to dial. */
export async function dialLead(lead: Pick<Lead, 'phone' | 'alternate_phone'>): Promise<boolean> {
  const number = toDialable(lead.phone) || toDialable(lead.alternate_phone);
  if (!number) return false;
  await Linking.openURL(`tel:${number}`);
  return true;
}
