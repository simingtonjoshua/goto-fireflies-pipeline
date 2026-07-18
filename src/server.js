require('dotenv').config();
const express = require('express');
const fs = require('fs');

const { fetchRecordingContent } = require('./gotoClient');
const { stageRecording, getLocalFile } = require('./storage');
const { uploadAudio, updateMeetingChannel } = require('./fireflies');

const app = express();
app.use(express.json({ limit: '5mb' }));

// The Fireflies "Call Recordings" channel every call transcript should land in.
// Looked up once via the channels query on 2026-07-18 (Joshua's workspace already had
// this channel). Override with FIREFLIES_CALL_RECORDINGS_CHANNEL_ID in .env if it's
// ever recreated and gets a new id.
const CALL_RECORDINGS_CHANNEL_ID =
  process.env.FIREFLIES_CALL_RECORDINGS_CHANNEL_ID || '6a5b4b13499df03d1fb00897';

// In-memory correlation state. This is intentionally ephemeral (lost on restart,
// redeploy, or the free-tier instance spinning down) - it only needs to survive the
// few seconds between a call's STARTING/ENDING events and its RECORDING_UPLOADED
// notification, and then again until Fireflies' own webhook confirms the transcript is
// ready (usually well under a minute for short calls, but can take longer for long
// ones). If the service restarts in that window the channel auto-assignment for that
// specific call will be skipped - the transcript still appears in Fireflies, just
// unfiled. See README for options if this needs to be made durable (e.g. writing this
// map to a small database or KV store instead of memory).
const conversationMetadata = new Map(); // conversationSpaceId -> latest call metadata
const recordingMetadata = new Map(); // recordingId -> call metadata snapshot
const pendingByRecordingId = new Map(); // recordingId -> call metadata, kept until Fireflies confirms transcription

// Observed on 2026-07-18: some calls generate TWO RECORDING_UPLOADED notifications with
// different recording_ids for what is the same physical recording (byte-identical),
// likely because the extension has multiple devices (desk phone + softphone clients)
// ringing simultaneously and each leg gets its own recording artifact. Only one of the
// two recording_ids ever shows up in the call-state events we track, so the second one
// arrives with no known metadata and would otherwise get uploaded to Fireflies as a
// duplicate transcript with a generic "unknown number/unknown time" title. Guard against
// this by remembering recent upload byte-sizes and skipping any recording that matches
// one already uploaded within the last couple minutes.
const recentUploadSizes = new Map(); // byteLength -> timestamp of last upload
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// GoTo pings the webhook with an empty request (User-Agent: "GoTo Notifications")
// when the notification channel is first created, just to verify reachability.
app.get('/webhooks/goto', (req, res) => res.sendStatus(200));

app.post('/webhooks/goto', async (req, res) => {
  // Always ack fast; GoTo will retry if it doesn't get a timely response.
  res.sendStatus(200);

  const payload = req.body;
  console.log('GoTo notification received:', JSON.stringify(payload));

  try {
    const recordingId = extractRecordingId(payload);
    if (recordingId) {
      await handleRecording(recordingId);
      return;
    }

    if (payload?.source === 'call-events' && payload?.type === 'call-state') {
      trackCallState(payload);
    }
  } catch (err) {
    console.error('Error handling GoTo notification:', err);
  }
});

// Fireflies calls this back once a transcript we uploaded finishes processing (set via
// the `webhook` field on uploadAudio). Payload: { meetingId, eventType, clientReferenceId }
// where meetingId is the Fireflies transcript id and clientReferenceId is the GoTo
// recordingId we set when uploading. See https://docs.fireflies.ai/graphql-api/webhooks
app.post('/webhooks/fireflies', async (req, res) => {
  res.sendStatus(200);

  const payload = req.body;
  console.log('Fireflies notification received:', JSON.stringify(payload));

  try {
    if (payload?.eventType !== 'Transcription completed') return;

    const transcriptId = payload.meetingId;
    const recordingId = payload.clientReferenceId;
    const meta = recordingId ? pendingByRecordingId.get(recordingId) : null;

    console.log('Call transcript ready:', JSON.stringify({ transcriptId, recordingId, ...meta }));

    await updateMeetingChannel(transcriptId, CALL_RECORDINGS_CHANNEL_ID);
    console.log(`Assigned transcript ${transcriptId} to the Call Recordings channel.`);

    if (recordingId) pendingByRecordingId.delete(recordingId);
  } catch (err) {
    console.error('Error handling Fireflies notification:', err);
  }
});

// Confirmed against a live payload on 2026-07-18: GoTo's recording-ready notification
// looks like { source: "recording-service", type: "RECORDING_UPLOADED", content: { recording_id } }.
// Call-state events look like { source: "call-events", type: "call-state", content: { state: {...} } }.
function extractRecordingId(payload) {
  if (payload?.type === 'RECORDING_UPLOADED' && payload?.content?.recording_id) {
    return payload.content.recording_id;
  }
  return (
    payload?.recordingId ||
    payload?.recording?.id ||
    payload?.data?.recordingId ||
    payload?.body?.recordingId ||
    payload?.content?.recording_id ||
    null
  );
}

// Tracks call-state events (STARTING/ACTIVE/ENDING) so that by the time a
// RECORDING_UPLOADED notification arrives for a given recordingId, we already know
// that call's direction, the outside phone number, and when it happened.
function trackCallState(payload) {
  const content = payload.content || {};
  const metadata = content.metadata || {};
  const state = content.state || {};
  const conversationSpaceId = metadata.conversationSpaceId;
  if (!conversationSpaceId) return;

  const participants = state.participants || [];
  const external = participants.find((p) => p?.type?.value === 'PHONE_NUMBER');
  const internal = participants.find((p) => p?.type?.value === 'LINE');

  // NOTE: GoTo nests the actual per-participant details (number, name, extensionNumber,
  // caller) under `type`, not on the participant object itself - confirmed against a
  // real inbound call payload on 2026-07-18. For PHONE_NUMBER participants, `type.number`
  // is the DID that was dialed/answered (e.g. the office number on an inbound call), while
  // `type.caller` holds the true originating party's name/number - prefer that when present
  // since it's the more useful "who was this call with" value.
  const externalType = external?.type || {};
  const externalCaller = externalType.caller || {};
  const internalType = internal?.type || {};

  const existing = conversationMetadata.get(conversationSpaceId) || {};
  const merged = {
    conversationSpaceId,
    direction: metadata.direction || existing.direction,
    dialString: metadata.dialString || existing.dialString,
    callCreated: metadata.callCreated || existing.callCreated,
    accountKey: metadata.accountKey || existing.accountKey,
    externalNumber: externalCaller.number || externalType.number || existing.externalNumber,
    externalName: externalCaller.name || externalType.name || existing.externalName,
    internalName: internalType.name || existing.internalName,
    internalExtension: internalType.extensionNumber || existing.internalExtension,
    callState: state.type || existing.callState,
    callEnded: state.type === 'ENDING' ? state.timestamp : existing.callEnded,
  };
  conversationMetadata.set(conversationSpaceId, merged);

  // Whenever a recording id shows up (on a participant or on the state itself),
  // remember which call it belongs to so handleRecording() can look it up later.
  const recordingIds = new Set();
  for (const p of participants) {
    for (const r of p.recordings || []) recordingIds.add(r.id);
  }
  for (const r of state.recordings || []) recordingIds.add(r.id);
  for (const id of recordingIds) recordingMetadata.set(id, merged);

  console.log(
    `Call event: ${state.type} (conversationSpaceId=${conversationSpaceId}, direction=${merged.direction}, number=${merged.externalNumber})`
  );
}

async function handleRecording(recordingId) {
  console.log(`Fetching recording ${recordingId} from GoTo...`);
  const { buffer, contentType } = await fetchRecordingContent(recordingId);

  const now = Date.now();
  const lastSeen = recentUploadSizes.get(buffer.length);
  if (lastSeen && now - lastSeen < DUPLICATE_WINDOW_MS) {
    console.log(
      `Skipping recording ${recordingId} (${buffer.length} bytes) - matches a recording uploaded ${Math.round((now - lastSeen) / 1000)}s ago, likely a duplicate leg recording of the same call. Not uploading to Fireflies.`
    );
    return;
  }
  recentUploadSizes.set(buffer.length, now);

  console.log(`Staging recording ${recordingId} (${buffer.length} bytes, ${contentType})...`);
  const publicUrl = await stageRecording(buffer, contentType);

  const meta = recordingMetadata.get(recordingId) || {};
  const title = buildTitle(recordingId, meta);
  console.log(`Sending ${recordingId} to Fireflies as \"${title}\"...`);

  const webhook = process.env.PUBLIC_BASE_URL
    ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/fireflies`
    : undefined;

  pendingByRecordingId.set(recordingId, meta);

  const result = await uploadAudio({
    url: publicUrl,
    title,
    clientReferenceId: recordingId,
    webhook,
  });
  console.log('Fireflies response:', result);
}

// Builds a title that makes the call identifiable at a glance in the Fireflies list -
// e.g. "GoTo OUTBOUND call - +19163908378 - 7/18/2026, 2:30:40 AM". All the raw
// metadata (direction, number, timestamps, conversationSpaceId) is also logged
// alongside the transcript id once Fireflies confirms processing is done (see the
// /webhooks/fireflies handler above) so it can be greped out of the Render logs or
// piped somewhere else later.
function buildTitle(recordingId, meta) {
  const when = meta.callCreated ? new Date(meta.callCreated).toLocaleString('en-US') : 'unknown time';
  const direction = meta.direction || 'call';
  const number = meta.externalNumber || meta.dialString || 'unknown number';
  return `GoTo ${direction} call - ${number} - ${when}`;
}

// Serves locally staged recordings (only used when STORAGE_BACKEND=local).
app.get('/recordings/:file', (req, res) => {
  const token = req.params.file.split('.')[0];
  const entry = getLocalFile(token);
  if (!entry) return res.sendStatus(404);
  res.setHeader('Content-Type', entry.contentType);
  fs.createReadStream(entry.filePath).pipe(res);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`goto-fireflies-pipeline listening on :${port}`));
