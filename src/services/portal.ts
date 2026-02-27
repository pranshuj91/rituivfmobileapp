import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CallLog } from 'react-native-call-log';

const PORTAL_URL_KEY = '@ritu_portal_url';
const DEVICE_NAME_KEY = '@ritu_device_name';
const DEVICE_PHONE_KEY = '@ritu_device_phone';
const DEFAULT_PORTAL_URL = 'https://your-portal-api.com/calls'; // Replace with your endpoint

export async function getPortalUrl(): Promise<string> {
  try {
    const url = await AsyncStorage.getItem(PORTAL_URL_KEY);
    return url ?? DEFAULT_PORTAL_URL;
  } catch {
    return DEFAULT_PORTAL_URL;
  }
}

export async function setPortalUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(PORTAL_URL_KEY, url.trim() || DEFAULT_PORTAL_URL);
}

export interface DeviceInfo {
  deviceName: string;
  devicePhone: string;
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  try {
    const [name, phone] = await Promise.all([
      AsyncStorage.getItem(DEVICE_NAME_KEY),
      AsyncStorage.getItem(DEVICE_PHONE_KEY),
    ]);
    return {
      deviceName: name ?? '',
      devicePhone: phone ?? '',
    };
  } catch {
    return {
      deviceName: '',
      devicePhone: '',
    };
  }
}

export async function setDeviceInfo(deviceName: string, devicePhone: string): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(DEVICE_NAME_KEY, deviceName.trim()),
    AsyncStorage.setItem(DEVICE_PHONE_KEY, devicePhone.trim()),
  ]);
}

export interface PushResult {
  success: boolean;
  message: string;
}

export async function pushCallsToPortal(calls: CallLog[]): Promise<PushResult> {
  const baseUrl = await getPortalUrl();
  if (!baseUrl || baseUrl === DEFAULT_PORTAL_URL) {
    return {
      success: false,
      message: 'Set your portal URL in Settings first.',
    };
  }
  try {
    const deviceInfo = await getDeviceInfo();
    const payload = {
      deviceName: deviceInfo.deviceName,
      devicePhone: deviceInfo.devicePhone,
      calls: calls.map((c) => ({
        id: c.id,
        phoneNumber: c.phoneNumber,
        formattedNumber: c.formattedNumber,
        duration: c.duration,
        name: c.name,
        timestamp: c.timestamp,
        dateTime: c.dateTime,
        type: c.type,
      })),
      sentAt: new Date().toISOString(),
    };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { success: false, message: `Portal responded with ${res.status}` };
    }
    return { success: true, message: `${calls.length} call(s) pushed to portal.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Network error';
    return { success: false, message: msg };
  }
}

export async function pushSingleCallToPortal(call: CallLog): Promise<PushResult> {
  return pushCallsToPortal([call]);
}
