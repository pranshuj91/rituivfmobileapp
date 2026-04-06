import { PermissionsAndroid, Platform } from 'react-native';
import Contacts, { type Contact } from 'react-native-contacts';
import type { CallLog } from 'react-native-call-log';

function normalizeDigits(input?: string | null): string {
  return (input ?? '').replace(/\D/g, '');
}

async function buildContactNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let contacts: Contact[] = [];
  try {
    contacts = await Contacts.getAllWithoutPhotos();
  } catch {
    return map;
  }
  for (const c of contacts) {
    const displayName = (c.displayName || c.givenName || '').trim();
    if (!displayName) continue;
    for (const pn of c.phoneNumbers ?? []) {
      const digits = normalizeDigits(pn.number);
      if (!digits) continue;
      if (digits.length >= 10) map.set(digits.slice(-10), displayName);
      map.set(digits, displayName);
    }
  }
  return map;
}

/**
 * Fills missing CallLog.name from the device contacts book when READ_CONTACTS is granted.
 * The stock call-log cursor often leaves name empty even when the dialer shows a label
 * (dialer does its own lookup). This keeps UI + sync payload aligned when possible.
 */
export async function enrichCallLogsWithContactNames(calls: CallLog[]): Promise<CallLog[]> {
  if (Platform.OS !== 'android' || calls.length === 0) return calls;
  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CONTACTS);
    if (!granted) return calls;
    const contactNames = await buildContactNameMap();
    if (contactNames.size === 0) return calls;
    return calls.map((item) => {
      if ((item.name || '').trim().length > 0) return item;
      const digits = normalizeDigits(item.phoneNumber || item.formattedNumber);
      const key = digits.length >= 10 ? digits.slice(-10) : digits;
      const name = contactNames.get(key);
      return name ? { ...item, name } : item;
    });
  } catch {
    return calls;
  }
}
