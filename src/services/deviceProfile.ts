/**
 * Detects the phone brand and default dialer, and maps them to how call
 * recordings can be obtained on this phone:
 *   auto  - the dialer saves recordings in a public folder the app scans
 *   share - the dialer keeps recordings private (Google Phone); the agent
 *           shares the recording to the app after the call
 */

import { NativeModules, Platform } from 'react-native';

export type RecordingMode = 'auto' | 'share';

export interface DeviceInfo {
  manufacturer: string;
  brand: string;
  model: string;
  sdk: number;
  /** Default dialer package, e.g. com.oplus.dialer */
  dialer: string;
}

export interface BrandProfile {
  key: string;
  /** Brand names as shown in the chart */
  brands: string;
  dialer: string;
  builtIn: boolean;
  mode: RecordingMode;
  steps: string[];
  folder: string;
}

export const BRAND_PROFILES: BrandProfile[] = [
  {
    key: 'oppo',
    brands: 'OPPO / Realme / OnePlus',
    dialer: 'ODialer',
    builtIn: true,
    mode: 'auto',
    steps: [
      'Open the Phone app → ⋮ (three dots) → Settings → Call recording.',
      'Turn on "Record all calls" (or add the numbers to record).',
      'Nothing to install on OPPO/Realme: ODialer is built in. On a OnePlus with Google Phone, install ODialer from Play Store and set it as default.',
    ],
    folder: 'Music/Recordings/Call Recordings',
  },
  {
    key: 'samsung',
    brands: 'Samsung',
    dialer: 'Samsung Phone',
    builtIn: true,
    mode: 'auto',
    steps: [
      'Open the Phone app → ⋮ (three dots) → Settings → Record calls.',
      'Turn on "Auto record calls" (all calls, or selected numbers).',
    ],
    folder: 'Recordings/Call',
  },
  {
    key: 'vivo',
    brands: 'Vivo / iQOO',
    dialer: 'Vivo Phone',
    builtIn: true,
    mode: 'auto',
    steps: [
      'Open Phone app → ⋮ → Settings → Call recording (on some models: Settings → search "Call recording").',
      'Turn on "Record all calls".',
    ],
    folder: 'Recordings/Call Recordings',
  },
  {
    key: 'xiaomi',
    brands: 'Xiaomi / Redmi / POCO',
    dialer: 'Mi Dialer (MIUI / HyperOS)',
    builtIn: true,
    mode: 'auto',
    steps: [
      'Open the Phone app → ⋮ → Settings → Call recording.',
      'Turn on "Record calls automatically".',
    ],
    folder: 'MIUI/sound_recorder/call_rec or Recordings/Call Recordings',
  },
  {
    key: 'google',
    brands: 'Motorola / Nothing / Pixel (Google Phone)',
    dialer: 'Google Phone',
    builtIn: true,
    mode: 'share',
    steps: [
      'Google Phone keeps recordings inside the Phone app; no app can read them.',
      'After the call: Phone app → Recents → the call → Recording → Share → "Gaincafe CRM". The app attaches it to the right call.',
      'Alternative: install Cube ACR and turn on auto recording (quality varies on Android 10+; the other side may be quiet unless on speaker).',
    ],
    folder: 'Share to Gaincafe CRM (or CubeCallRecorder/All with Cube ACR)',
  },
  {
    key: 'other',
    brands: 'Other brands',
    dialer: "Phone's own dialer",
    builtIn: true,
    mode: 'auto',
    steps: [
      'Open the Phone app settings and turn on automatic call recording if it exists.',
      'Check "Call recording folder" above after a recorded call: if a folder shows up, recordings sync automatically.',
      'If the dialer has no recording option, use "Share to Gaincafe CRM" from any recorder app.',
    ],
    folder: 'Depends on the dialer',
  },
];

const GOOGLE_DIALERS = new Set(['com.google.android.dialer', 'com.android.dialer']);
const KNOWN_DIALERS: Record<string, string> = {
  'com.google.android.dialer': 'Google Phone',
  'com.android.dialer': 'Phone (AOSP)',
  'com.oplus.dialer': 'ODialer',
  'com.coloros.dialer': 'ODialer',
  'com.heytap.dialer': 'ODialer',
  'com.samsung.android.dialer': 'Samsung Phone',
  'com.vivo.dialer': 'Vivo Phone',
  'com.android.contacts': 'Mi Dialer',
  'com.miui.contacts': 'Mi Dialer',
  'com.catalinagroup.callrecorder': 'Cube ACR',
  'com.truecaller': 'Truecaller',
};

interface NativeDeviceInfoModule {
  getDeviceInfo(): Promise<DeviceInfo>;
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const fallback: DeviceInfo = {
    manufacturer: String((Platform as { constants?: { Manufacturer?: string } }).constants?.Manufacturer ?? ''),
    brand: String((Platform as { constants?: { Brand?: string } }).constants?.Brand ?? ''),
    model: String((Platform as { constants?: { Model?: string } }).constants?.Model ?? ''),
    sdk: typeof Platform.Version === 'number' ? Platform.Version : 0,
    dialer: '',
  };
  if (Platform.OS !== 'android') return fallback;
  const mod = (NativeModules as { ShareReceiver?: NativeDeviceInfoModule }).ShareReceiver;
  if (!mod) return fallback;
  try {
    const info = await mod.getDeviceInfo();
    return { ...fallback, ...info };
  } catch {
    return fallback;
  }
}

export function profileFor(info: DeviceInfo): BrandProfile {
  const m = `${info.manufacturer} ${info.brand}`.toLowerCase();
  const byBrand =
    /samsung/.test(m) ? 'samsung'
      : /xiaomi|redmi|poco/.test(m) ? 'xiaomi'
        : /oppo|realme|oneplus/.test(m) ? 'oppo'
          : /vivo|iqoo/.test(m) ? 'vivo'
            : /google|nothing|motorola|moto/.test(m) ? 'google'
              : 'other';
  let key = byBrand;
  // The dialer decides more than the brand: Google Phone always means "share".
  if (GOOGLE_DIALERS.has(info.dialer)) key = 'google';
  return BRAND_PROFILES.find((p) => p.key === key) ?? BRAND_PROFILES[BRAND_PROFILES.length - 1];
}

export function dialerLabel(dialerPackage: string): string {
  if (!dialerPackage) return 'unknown dialer';
  return KNOWN_DIALERS[dialerPackage] ?? dialerPackage;
}

export function deviceLabel(info: DeviceInfo): string {
  const brand = (info.brand || info.manufacturer || '').trim();
  const pretty = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Android';
  return `${pretty} ${info.model || ''}`.trim();
}
