# Prompt for the Gaincafe CRM Claude session

Copy everything below the line and paste it into the Claude session that built Gaincafe CRM.

---

I have a separate Android app (React Native 0.84) called "Gaincafe CRM" call sync app. I want to integrate it with this CRM so that an agent can call leads from the app, and the phone's call recording gets uploaded against that lead in the CRM. I need you to document this CRM's API and data model so another engineer can build the integration without reading the CRM code. Please answer every section below. Where something does not exist yet, say "does not exist" and propose the endpoint you would add.

## What the mobile app does today

- It does not record calls itself. It reads the Android call log (number, name, direction, duration, time) and scans the phone's built-in dialer recording folders for audio files (mp3, m4a, aac, amr, wav, ogg, 3gp). It matches a recording to a call by phone number plus time.
- It syncs automatically every 30 minutes in the background and on demand. Each sync is one JSON POST per batch of up to 100 calls.
- Current contract (built for a different backend). Reuse it if you can, because then the app needs very few changes:
  1. `POST /api/call-logs/upload-recording`, multipart form, headers `X-App-Key: <key>` and optional `Authorization: Bearer <token>`. File field `file` (audio/mpeg), text fields `recording_external_id` and `source` ("mobile_app"). Must respond JSON with a public or signed `url` or `recording_url`.
  2. `POST /api/call-logs/sync`, JSON, same headers. Body:
     ```json
     {
       "logs": [{
         "id": "<android call log id>",
         "callId": "<android call log id>",
         "phone_number": "+919876543210",
         "name": "Contact name or number",
         "direction": "OUTGOING | INCOMING | MISSED | REJECTED | UNKNOWN",
         "duration_seconds": 83,
         "called_at": "YYYY-MM-DD HH:mm:ss",
         "recordings": [{
           "recording_url": "<url returned by upload>",
           "recording_external_id": "<last10digits>-<yyyyMMddHHmmss>-<token>:<callId>",
           "duration_seconds": 83,
           "source": "mobile_app",
           "recorded_at": "YYYY-MM-DD HH:mm:ss"
         }]
       }],
       "deviceName": "Reception Phone",
       "devicePhone": "+91...",
       "sentAt": "ISO-8601"
     }
     ```
     Expected response: `{ "message": "...", "saved": 3, "results": [{ "phone_number": "...", "status": "saved | matched | created | duplicate", "call_log_id": 123, "recordings_saved": 1, "lead": {...} }] }`. The app retries any log whose status is not one of those four.
- The app currently has no login. It uses one global app key and a device name plus phone set in Settings. For the CRM it must become per-agent, per-organization.

## What I want the integration to do

1. Agent logs into the app with their CRM credentials and sees only their organization's data.
2. Agent sees a list of leads assigned to them (or a call queue), taps a lead, and the phone dialer opens with the lead's number.
3. After the call, the app uploads the call log and the recording against that lead, and it shows up in the lead's conversation timeline in the CRM inbox, next to the WhatsApp messages.
4. Incoming calls from a number that matches a lead should also be logged against that lead.

## Questions to answer

### 1. Authentication and tenancy
- How does a user authenticate against the API? Give the login endpoint, request and response bodies, token type, expiry and refresh flow.
- How is the organization (tenant) determined for a request: from the token, a header, a subdomain, or a path segment? Can one user belong to more than one organization?
- What roles exist and which role an agent using the mobile app would have.
- Is there any existing API key or service token concept for integrations? Should the mobile app use per-user tokens or a per-organization key plus a user id?
- Base URL for staging and production, API version prefix, and any required headers on every request.

### 2. Leads
- Endpoint to list leads for the logged-in agent: pagination style, filters (status, assigned_to, updated_since, has_phone), sort, and page size limits.
- Endpoint to fetch one lead by id, and endpoint to search leads by phone number.
- The full lead schema with field names and types. Point out: id type (uuid or int), name, phone fields, status values, source, tags, assigned agent, last activity time.
- How phone numbers are stored and normalized (E.164 with country code? digits only?). What should the app send so that a call to "9876543210" matches a lead stored as "+919876543210"?
- Can two leads in the same organization share a phone number? If yes, which one should a call be attached to?

### 3. Call activities on a lead
- Is there an existing way to record a call on a lead (an activity, a message of type "call", a note)? Give the endpoint, body, and response. If it does not exist, propose one that accepts the fields in the mobile contract above, plus `lead_id`, `agent_id`, and an idempotency key equal to the device call id so retries do not create duplicates.
- Is a batch endpoint acceptable (up to 100 calls per request)? What should the per-item result look like?
- How should the response tell the app that a number matched no lead? Should the CRM auto-create a lead in that case, and from which source?

### 4. Recording upload and storage
- How does the CRM store media today for WhatsApp attachments: local disk, S3, or something else? Give the upload endpoint, whether it is multipart or a presigned URL flow, size limits, accepted MIME types, and the response.
- How a stored file is linked to a message or activity, and how the inbox renders audio (is there an audio player for voice notes already?).
- Whether recordings need a signed URL to play back and how long it stays valid.

### 5. Inbox timeline
- The schema of the conversation timeline (messages table or collection): message types, direction, sender, timestamps, metadata JSON. Tell me exactly what a "call" item should look like so it renders well, including a link to the recording and the call duration.
- Any real-time channel (websockets, SSE, polling) the inbox uses, so a call logged from the phone appears without refresh.

### 6. Agent device and notifications
- Should each phone register itself (device name, phone number, agent id, push token)? If there is a device or session table, describe it; otherwise propose an endpoint.
- Is Firebase Cloud Messaging or any push service set up? Can the CRM push "call this lead" tasks to an agent's phone?

### 7. Conventions
- Error response format, validation error format, rate limits.
- Date and time format and timezone used by the API.
- Pagination format (page/limit, cursor, or offset).

### 8. Deliverables I need from you
1. A markdown API document covering every endpoint above with a sample request, sample response, and a working curl command.
2. A staging base URL plus a test organization and test agent login I can use from the phone. Put the credentials in a separate file, not in the document.
3. A list of what is missing in the CRM for this flow, and the code changes you propose to add it (new endpoints, new message type "call", storage for recordings, idempotency).
4. The tech stack summary: backend framework, database, auth library, file storage, and how multi-tenancy is enforced in queries.
