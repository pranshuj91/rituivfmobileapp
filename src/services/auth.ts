/**
 * Gaincafe CRM authentication.
 *
 * Login: POST /api/auth/login {email, password}
 *   -> {token, token_type: "Bearer", user, workspace, role, permissions, features}
 * The token is a Sanctum personal access token that never expires on its own; it is
 * revoked by logout, password change, or member suspension. Every CRM request needs
 *   Authorization: Bearer <token>
 *   X-Workspace-Id: <workspace uuid>
 */

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Config from 'react-native-config';

export const CRM_API_BASE_URL = (
  Config.CRM_API_BASE_URL || 'https://whatsapp.gaincafe.com/api'
).replace(/\/+$/, '');

const SESSION_KEY = '@gaincafe_auth_session';
const LOGIN_TIMEOUT_MS = 30 * 1000;

export interface AuthUser {
  id: string | number;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

export interface AuthWorkspace {
  id: string;
  name?: string;
  slug?: string;
  /** Brand logo of the customer's workspace, when the CRM provides one. */
  logoUrl?: string;
  /** Field names the CRM returned for the workspace (for checking what is available). */
  rawKeys?: string[];
}

/** CRM origin without the /api suffix, for resolving relative media paths. */
const CRM_ORIGIN = CRM_API_BASE_URL.replace(/\/api\/?$/, '');

const LOGO_KEYS = [
  'logo_url', 'logoUrl', 'logo', 'logo_path', 'brand_logo_url', 'brand_logo',
  'avatar_url', 'avatar', 'image_url', 'image', 'icon_url',
];

function absolutize(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${CRM_ORIGIN}/${url.replace(/^\/+/, '')}`;
}

/** Finds a logo/avatar URL in an object, including nested branding/settings blocks. */
function pickImageUrl(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const key of LOGO_KEYS) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return absolutize(v.trim());
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>).url ?? (v as Record<string, unknown>).path;
      if (typeof inner === 'string' && inner.trim()) return absolutize(inner.trim());
    }
  }
  for (const nested of ['branding', 'brand', 'settings', 'meta', 'metadata', 'theme']) {
    const found = pickImageUrl(o[nested]);
    if (found) return found;
  }
  return undefined;
}

/** Finds the array of workspaces in a response, whatever key wraps it. */
function extractList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const o = json as Record<string, unknown>;
  for (const key of ['data', 'workspaces', 'items', 'results']) {
    const v = o[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = extractList(v);
      if (inner.length > 0) return inner;
    }
  }
  const firstArray = Object.values(o).find((v) => Array.isArray(v));
  return Array.isArray(firstArray) ? firstArray : [];
}

function toWorkspace(raw: unknown): AuthWorkspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.id == null || String(o.id) === '') return null;
  return {
    id: String(o.id),
    name: typeof o.name === 'string' ? o.name : undefined,
    slug: typeof o.slug === 'string' ? o.slug : undefined,
    logoUrl: pickImageUrl(o),
    rawKeys: Object.keys(o),
  };
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  workspace: AuthWorkspace;
  role?: string;
  features?: string[];
}

export class AuthError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

type Listener = (session: AuthSession | null) => void;

/** undefined = not loaded from storage yet, null = logged out */
let cachedSession: AuthSession | null | undefined;
const listeners = new Set<Listener>();

function notify(session: AuthSession | null): void {
  listeners.forEach((l) => {
    try {
      l(session);
    } catch {
      // ignore listener errors
    }
  });
}

export async function getSession(): Promise<AuthSession | null> {
  if (cachedSession !== undefined) return cachedSession;
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) {
      cachedSession = null;
      return null;
    }
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.token || !parsed?.workspace?.id) {
      cachedSession = null;
      return null;
    }
    cachedSession = parsed;
    return parsed;
  } catch {
    cachedSession = null;
    return null;
  }
}

async function saveSession(session: AuthSession | null): Promise<void> {
  cachedSession = session;
  if (session) {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    await AsyncStorage.removeItem(SESSION_KEY);
  }
  notify(session);
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Headers for every CRM request. Throws AuthError when not logged in so callers
 * can show the login screen instead of sending an unauthenticated request.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  if (!session) throw new AuthError('Not logged in. Please log in first.', 401);
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${session.token}`,
    'X-Workspace-Id': session.workspace.id,
  };
}

/** Call when the CRM answers 401: the token was revoked, so drop the session. */
export async function clearSession(): Promise<void> {
  await saveSession(null);
}

function messageFromErrorBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { message?: unknown; errors?: Record<string, unknown> };
  if (b.errors && typeof b.errors === 'object') {
    const first = Object.values(b.errors)[0];
    if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  }
  if (typeof b.message === 'string' && b.message.trim()) return b.message;
  return fallback;
}

/** Login returns features either as slugs or as objects with a slug/key. */
function featureSlug(f: unknown): string {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') {
    const o = f as { slug?: unknown; key?: unknown; name?: unknown };
    const v = o.slug ?? o.key ?? o.name;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/** True when the login response listed features and this slug is missing. */
export function featureMissing(session: AuthSession | null | undefined, slug: string): boolean {
  if (!session?.features || session.features.length === 0) return false;
  return !session.features.includes(slug);
}

async function fetchWorkspaceFallback(token: string): Promise<AuthWorkspace | null> {
  try {
    const res = await fetch(`${CRM_API_BASE_URL}/workspaces`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return toWorkspace(extractList(json)[0]);
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !password) {
    throw new AuthError('Enter your email and password.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${CRM_API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: trimmedEmail, password }),
      signal: controller.signal,
    });
  } catch (e) {
    const isAbort = e instanceof Error && e.name === 'AbortError';
    throw new AuthError(
      isAbort ? 'Login timed out. Check your internet connection.' : 'Could not reach Gaincafe CRM. Check your internet connection.'
    );
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const fallback =
      res.status === 401 || res.status === 422
        ? 'Invalid email or password.'
        : res.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : `Login failed (${res.status}).`;
    throw new AuthError(messageFromErrorBody(body, fallback), res.status);
  }

  const data = (body ?? {}) as {
    token?: string;
    user?: Record<string, unknown>;
    workspace?: unknown;
    role?: string;
    features?: unknown[];
  };
  if (!data.token) {
    throw new AuthError('Login response did not include a token.');
  }
  let workspace: AuthWorkspace | null = toWorkspace(data.workspace);
  if (!workspace) {
    workspace = await fetchWorkspaceFallback(data.token);
  }
  if (!workspace) {
    throw new AuthError('Your account is not a member of any workspace.');
  }

  const rawUser = data.user ?? {};
  const user: AuthUser = {
    id: typeof rawUser.id === 'string' || typeof rawUser.id === 'number' ? rawUser.id : '',
    name: typeof rawUser.name === 'string' ? rawUser.name : undefined,
    email: typeof rawUser.email === 'string' ? rawUser.email : undefined,
    avatarUrl: pickImageUrl(rawUser),
  };

  const session: AuthSession = {
    token: data.token,
    user,
    workspace,
    role: data.role,
    features: Array.isArray(data.features) ? data.features.map(featureSlug).filter(Boolean) : undefined,
  };
  await saveSession(session);
  return session;
}

/**
 * Re-reads the current workspace from GET /api/workspaces (name, logo, fields)
 * so sessions stored by older app versions pick up the brand data without a
 * new login. Best effort; keeps the stored session on any failure.
 */
export async function refreshWorkspaceInfo(): Promise<AuthWorkspace | null> {
  const session = await getSession();
  if (!session) return null;
  try {
    // No X-Workspace-Id here on purpose: this lists the user's memberships and
    // must work even when the stored workspace id is wrong (recovery below).
    const res = await fetch(`${CRM_API_BASE_URL}/workspaces`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
    });
    if (!res.ok) {
      console.warn('[workspace] GET /workspaces failed', res.status);
      return session.workspace;
    }
    const json = (await res.json()) as unknown;
    const list = extractList(json).filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object'
    );
    const storedId = session.workspace.id;
    const same = (v: unknown) => v != null && String(v) === storedId;

    // GET /workspaces returns membership rows: { id, workspace_id, user_id, role, workspace? }.
    // The workspace uuid is `workspace_id` there (login calls it workspace.id).
    let row = list.find((r) => same(r.workspace_id) || same(r.uuid));
    let correctedId = storedId;
    if (!row) {
      // Plain workspace rows (id is the workspace uuid itself).
      row = list.find((r) => same(r.id) && r.workspace_id == null);
    }
    if (!row) {
      // Recovery: an earlier app build stored a membership id as the workspace id.
      const membership = list.find((r) => same(r.id) && r.workspace_id != null);
      if (membership) {
        row = membership;
        correctedId = String(membership.workspace_id);
        console.warn('[workspace] corrected stored workspace id from membership row');
      }
    }
    if (!row) {
      console.warn('[workspace] current workspace not found in /workspaces response', {
        topLevelKeys: Object.keys((json as object) ?? {}),
        listSize: list.length,
      });
      return session.workspace;
    }

    const inner =
      row.workspace && typeof row.workspace === 'object'
        ? (row.workspace as Record<string, unknown>)
        : row;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    const rawKeys = Array.from(new Set([...Object.keys(inner), ...(inner !== row ? Object.keys(row) : [])]));
    const merged: AuthWorkspace = {
      ...session.workspace,
      id: correctedId,
      name: str(inner.name) ?? str(row.workspace_name) ?? str(row.name) ?? session.workspace.name,
      slug: str(inner.slug) ?? str(row.slug) ?? session.workspace.slug,
      logoUrl: pickImageUrl(inner) ?? pickImageUrl(row) ?? session.workspace.logoUrl,
      rawKeys,
    };
    const changed =
      merged.id !== session.workspace.id ||
      merged.logoUrl !== session.workspace.logoUrl ||
      merged.name !== session.workspace.name ||
      (merged.rawKeys ?? []).join() !== (session.workspace.rawKeys ?? []).join();
    if (changed) {
      await saveSession({ ...session, workspace: merged });
    }
    return merged;
  } catch {
    return session.workspace;
  }
}

export async function logout(): Promise<void> {
  const session = await getSession();
  if (session) {
    try {
      await fetch(`${CRM_API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${session.token}`,
          'X-Workspace-Id': session.workspace.id,
        },
      });
    } catch {
      // Token revocation is best effort; local logout always proceeds.
    }
  }
  await saveSession(null);
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook: undefined while loading from storage, null when logged out,
 * otherwise the current session. Re-renders on login/logout.
 */
export function useSession(): AuthSession | null | undefined {
  const [session, setSession] = useState<AuthSession | null | undefined>(cachedSession);

  useEffect(() => {
    let mounted = true;
    getSession().then((s) => {
      if (mounted) setSession(s);
    });
    const unsubscribe = subscribeAuth((s) => {
      if (mounted) setSession(s);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return session;
}
