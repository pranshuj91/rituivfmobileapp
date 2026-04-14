# Ritu IVF Call Sync App - Client User Guide

## 1) What this app does

This app reads call logs from your Android phone and syncs them to the portal.  
If a call recording exists on your phone, the app uploads it and links it to the correct call in the portal.

## 2) First-time setup

1. Install the latest APK shared by your support team.
2. Open the app.
3. Go to `Settings`.
4. Fill in:
   - `Device name` (example: `Reception Phone 1`)
   - `Device phone number` (your SIM number used for calls)
5. Allow all requested permissions:
   - Call logs
   - Contacts
   - Phone state/number
   - Storage/media (for recordings)

If permissions are denied, syncing will be incomplete.

## 3) Main screens

- `Home`: app logo and basic navigation.
- `Call Logs`: shows recent phone calls and sync controls.
- `Settings`: device details used for portal tracking.

## 4) How to sync call logs

### Manual sync

- Open `Call Logs`.
- Tap cloud icon on a single row to push one call.
- Tap `Push to Portal` (or bulk sync button) to push multiple calls.
- After successful sync, `synced` appears for synced entries.

### Auto sync

- The app auto-syncs approximately every **30 minutes**.
- It also tries to sync when app comes to foreground (open/resume).
- Android battery/network policies can delay exact timing.

## 5) What data is sent

For each call log, app sends:

- `id` / `callId`
- `phone_number`
- `name` (contact name; fallback is phone number)
- `direction`
- `duration_seconds`
- `called_at`
- `recordings[]` (if available)

For each recording item:

- `recording_url` (uploaded web URL, not local file path)
- `recording_external_id` (stable unique ID)
- `duration_seconds` (if available)
- `source` (`mobile_app`)
- `recorded_at` (same as call time for mapped call)

## 6) How recordings are handled

1. App scans phone recording folders.
2. Matches recording to call (call ID first, then safe fallbacks).
3. Uploads recording file to server.
4. Merges uploaded URL into that call's `recordings[]`.
5. Sends final call logs sync payload.

If recording upload fails, local `file://` path is **not** sent to portal.

## 7) Best practices for users

- Keep internet on (Wi-Fi or mobile data).
- Keep battery optimization relaxed for this app if possible.
- Open app at least once daily so foreground backup sync can run.
- Do not clear app storage unless instructed (it resets local sync tracking).
- Keep phone date/time automatic.

## 8) Quick troubleshooting

### Calls not appearing in portal

- Confirm internet is active.
- Open app and run manual `Push to Portal`.
- Verify app has call log permission.

### Name not showing

- Ensure contact exists in phone contacts.
- Ensure contacts permission is granted.

### Recording not showing

- Confirm call recording is enabled in dialer.
- Ensure storage/media permission is granted.
- Make one new test call, then manual push.
- Wait a short time for backend processing and refresh portal.

### Auto push seems delayed

- This is normal on Android due to background limits.
- Keep app opened periodically; foreground trigger improves reliability.

## 9) Support checklist before raising issue

Share these details with support team:

- Device model + Android version
- App build date/version (APK used)
- Device name configured in Settings
- Approx call time and phone number of missing record
- Whether manual push succeeds
- Screenshot of app call row and portal row (if possible)

---

For installation updates, always use the latest APK provided by your technical team.
