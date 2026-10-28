# Prompt for the Gaincafe CRM Claude session: build the Call Sync backend

Copy everything below the line into the CRM session.

---

Implement the "Call Sync" feature in this CRM so the Gaincafe CRM Android call-sync app can connect. Your earlier investigation report (Section B proposals) is the design; this prompt pins the exact contract the app already implements, so build to it rather than inventing new field names. Work in one focused PR. Do not change the leads API or auth; the app already uses `POST /api/auth/login` and `GET /api/leads` as they are.

## How the app talks to the CRM (already implemented, do not change)

- Every request carries `Authorization: Bearer <sanctum token>`, `X-Workspace-Id: <workspace uuid>`, `Accept: application/json`.
- A `401` makes the app sign the agent out. A `403` is shown to the agent as "access denied / ask admin to enable Call Sync". Any non-2xx on sync makes the app retry the whole batch later with backoff (up to 16 attempts).
- Timeouts on the phone: recording upload 25 seconds per file, sync 60 seconds per batch. Keep both endpoints fast; do heavy work (transcoding, contact linking, broadcasts) in queued jobs.
- Leads: `GET /api/leads?status=new,follow_up&search=<name or phone>&per_page=50&page=1`. The app reads `data[]` plus either `meta.current_page/last_page/total` or the same keys at top level. Confirm `search` is accepted as the query param (or alias it to `q`).

## Endpoint 1: upload a recording

`POST /api/call-logs/upload-recording`, multipart/form-data:

- `file`: the audio file. The app labels every file `audio/mpeg` regardless of real format, so detect by extension and magic bytes. Accept mp3, m4a, aac, amr, wav, ogg, 3gp. Reject over 25 MB.
- `recording_external_id`: string, format `<last10digits>-<yyyyMMddHHmmss>-<token>:<deviceCallId>`, for example `9876543210-20261028161530-recA1B2C3:1427`. Unique per device. Store it.
- `source`: string, always `mobile_app`.

Response `200`/`201` JSON. The app looks for a URL at `recording_url`, then `url`, then `data.recording_url`, then `data.url`. Return:

```json
{ "recording_url": "<signed playback URL>", "recording_path": "call-recordings/<workspace>/<file>", "recording_external_id": "<as sent>" }
```

Store the file with `MediaStorageService::storeBinary()` under `call-recordings/{workspace_id}/`. Persist a row (see table below) keyed by `recording_external_id` so a repeat upload of the same id returns the existing row instead of storing twice. The sync call that follows will reference the recording by `recording_external_id`, so link by that, not by the URL string (the URL is signed and changes).

## Endpoint 2: sync call logs

`POST /api/call-logs/sync`, JSON body exactly:

```json
{
  "logs": [
    {
      "id": "1427",
      "callId": "1427",
      "phone_number": "+919876543210",
      "name": "Contact name or the number",
      "direction": "OUTGOING",
      "duration_seconds": 83,
      "called_at": "2026-10-28 10:45:30",
      "recordings": [
        {
          "recording_url": "<signed URL returned by upload>",
          "recording_external_id": "9876543210-20261028161530-recA1B2C3:1427",
          "duration_seconds": 83,
          "source": "mobile_app",
          "recorded_at": "2026-10-28 10:45:30"
        }
      ]
    }
  ],
  "deviceName": "Reception Phone",
  "devicePhone": "+919000000000",
  "sentAt": "2026-10-28T10:50:01.000Z"
}
```

Rules the server must follow:

- Up to 100 logs per request. `recordings` may be empty.
- `callId` is the Android call-log row id. It is unique per phone only, so two agents' phones can both send `callId` 1427. Idempotency key = `(workspace_id, device_key, device_call_id)` where `device_key` = `devicePhone` normalized, falling back to `deviceName`, falling back to the authenticated user id.
- `called_at` and `recorded_at` are UTC in `YYYY-MM-DD HH:mm:ss` with no timezone suffix. Treat them as UTC.
- `direction` values from Android: `OUTGOING`, `INCOMING`, `MISSED`, `REJECTED`, `BLOCKED`, `VOICEMAIL`, `UNKNOWN`. Map `MISSED`/`REJECTED`/`BLOCKED` to an inbound call with zero duration and keep the raw value in metadata.
- `phone_number` may be E.164 (`+91...`), 10 digits, or with a leading 0. Normalize with `PhoneNormalizer::normalize()` before matching.
- Matching order per log: existing lead by `(workspace_id, phone)` -> `matched`; otherwise create a lead with `lead_source = call_sync` and `status = new` -> `created`; if the idempotency key already exists -> `duplicate` (return the existing `call_log_id`, create nothing). Use `saved` only if you keep a path that stores a call without any lead involvement; `matched`/`created` are preferred.
- For every non-duplicate log, also resolve or create the contact and conversation for that phone (`LeadContactLinker` / `resolveOrCreateConversation`, `whatsapp_phone_id` may be null) and append a timeline message of the new type `call` (see below). Mirror it as `LeadActivity` `TYPE_CALL` on the lead.
- Agent = the authenticated user; store it on the call log and the message.

Response `200` JSON, one result per log, in any order, and `phone_number` must be echoed exactly as sent (the app matches results to logs by the last 10 digits of `phone_number`):

```json
{
  "message": "3 call(s) synced.",
  "saved": 3,
  "results": [
    { "phone_number": "+919876543210", "normalized": "919876543210", "status": "matched", "call_log_id": 501, "recordings_saved": 1, "lead": { "id": "<uuid>", "name": "..." } }
  ]
}
```

The app treats `status` in `saved`, `matched`, `created`, `duplicate` as acknowledged. Any other status, or a log missing from `results`, is retried later, so never omit a log and never return a custom status for success. Validation failures of a single log should still produce a result row with `status: "invalid"` and a `message`, not a 422 for the whole batch.

## Data model

New table `call_logs`: `id`, `workspace_id`, `user_id` (agent), `lead_id` nullable, `contact_id` nullable, `conversation_id` nullable, `message_id` nullable, `device_key`, `device_call_id`, `device_name`, `device_phone`, `phone_raw`, `phone_normalized`, `direction`, `duration_seconds`, `called_at` (UTC), `metadata` json, timestamps. Unique `(workspace_id, device_key, device_call_id)`.

New table `call_recordings`: `id`, `workspace_id`, `call_log_id` nullable (linked during sync), `recording_external_id` unique per workspace, `storage_disk`, `storage_path`, `mime_type`, `size_bytes`, `duration_seconds` nullable, `source`, `recorded_at` nullable, `uploaded_by` (user id), timestamps. Uploads arrive before the sync, so `call_log_id` is filled in by the sync step using `recording_external_id`.

Add `Message::TYPE_CALL = 'call'` with `metadata` `{direction, duration_seconds, device_call_id, agent_id, call_log_id, recording_path, recording_external_id, missed: bool}`. Playback uses the existing signed `messages.media` route (6-hour signed URL) or `GET /api/messages/{id}/file`, reusing the voice-note audio player in the inbox.

## Feature flag and permissions

- Add slug `call-sync` to `FeatureCatalog`. Protect both new routes with `auth:sanctum`, `workspace`, `workspace.feature:call-sync`, and `workspace.can:contacts.manage`. Enable it per customer from the Control Panel like `patient-enquiries`.
- Disabled workspace must get `403` with `{ "message": "Call Sync is not enabled for this workspace." }`.

## Deliverables

1. Migrations, models, controller(s), form requests, routes, feature slug, the `call` message type, and queued jobs for contact linking and broadcasting.
2. Feature tests: upload then sync (matched and created), duplicate re-sync returns `duplicate` with no new rows, 403 when the feature is off, 401 with a revoked token, and a result row for every log in a mixed batch.
3. A short markdown API doc with one curl example per endpoint.
4. Set up for testing from the phone: enable `call-sync` on a test workspace, create a test agent, add three leads with real-looking phone numbers (one of them my own number). Put the login in a separate credentials file, not in the doc.
5. Tell me what the inbox frontend must change to render a `call` message (icon, direction, duration, play button) so I can brief that project separately.
