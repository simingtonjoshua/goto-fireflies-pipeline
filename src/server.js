require('dotenv').config();
const express = require('express');
const fs = require('fs');

const {
  fetchRecordingContent,
  fetchTranscript,
  getAccountKey,
  getChannelId,
  subscribeCallHistoryEvents,
  subscribeCallParkingEvents,
} = require('./gotoClient');
const { stageRecording, getLocalFile } = require('./storage');
const { uploadAudio, updateMeetingChannel } = require('./fireflies');
const interactions = require('./interactions');

const app = express();
app.use(express.json({ limit: '5mb' }));

// The Fireflies "Call Recordings" channel every call transcript should land in.
// Looked up once via the channels query on 2026-07-18 (Joshua's workspace already had
// this channel). Override with FIREFLIES_CALL_RECORDINGS_CHANNEL_ID in .env if it's
// ever recreated and gets a new id.
//
// NOTE: this Fireflies path is being kept running as-is while the new pipeline (GoTo's
// own transcription, Google Drive archival, OpenAI summarization, direct Heymarket
// posting - see src/interactions.js) is built out alongside it. Once that new pipeline
// is fully wired up and verified, this Fireflies leg can likely be retired.
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
// two recording_ids typically shows up in the call-state events we track. Guard against
// uploading both by remembering recent upload byte-sizes (fallback safety net) and, more
// importantly, by batching notifications that land within a short window and preferring
// to upload whichever recording_id we actually have call metadata for - otherwise the
// dedup logic can end up keeping the untracked/generic-titled copy and discarding the
// one with real caller info, depending on arrival order (observed on 2026-07-18).
const recentUploadSizes = new Map(); // byteLength -> timestamp of last upload
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

let pendingRecordingBatch = [];
let recordingBatchTimer = null;
const BATCH_WINDOW_MS = 1500;

function queueRecording(recordingId) {
  pendingRecordingBatch.push(recordingId);
  if (recordingBatchTimer) return;
  recordingBatchTimer = setTimeout(() => {
    const batch = pendingRecordingBatch;
    pendingRecordingBatch = [];
    recordingBatchTimer = null;
    processRecordingBatch(batch).catch((err) =>
      console.error('Error processing recording batch:', err)
    );
  }, BATCH_WINDOW_MS);
}

async function processRecordingBatch(batch) {
  if (batch.length === 1) {
    return handleRecording(batch[0]);
  }

  const withMeta = batch.find((id) => recordingMetadata.has(id));
  const winner = withMeta || batch[0];
  const skipped = batch.filter((id) => id !== winner);
  console.log(
    `Recording batch ${JSON.stringify(batch)} - uploading only ${winner} (known metadata: ${!!withMeta}), skipping ${JSON.stringify(skipped)} as duplicate leg recordings of the same call.`
  );
  return handleRecording(winner);
}

// GoTo pings the webhook with an empty request (User-Agent: "GoTo Notifications")
// when the notification channel is first created, just to verify reachability.
app.get('/webhooks/goto', (req, res) => res.sendStatus(200));

app.post('/webhooks/goto', async (req, res) => {
  // Always ack fast; GoTo will retry if it doesn't get a timely response.
  res.sendStatus(200);

  const payload = req.body;
  console.log('GoTo notification received:', JSON.stringify(payload));

  try {
    const notification = classifyNotification(payload);

    if (notification.kind === 'recording-uploaded') {
      queueRecording(notification.recordingId);
      return;
    }

    if (notification.kind === 'transcript-uploaded') {
      handleTranscriptReady(notification.recordingId).catch((err) =>
        console.error(`Error handling transcript for recording ${notification.recordingId}:`, err)
      );
      return;
    }

    if (payload?.source === 'call-events' && payload?.type === 'call-state') {
      trackCallState(payload);
      return;
    }

    if (payload?.source === 'call-history') {
      interactions.recordCallHistoryEvent(payload);
      return;
    }

    if (payload?.source === 'call-parking') {
      interactions.recordCallParkingEvent(payload);
      return;
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

// GoTo's recording-service notifications come in two flavors, confirmed against live
// payloads on 2026-07-18 (RECORDING_UPLOADED) and 2026-07-20 (RECORDING_TRANSCRIPT_UPLOADED,
// once the Advanced Reporting & Analytics add-on was enabled):
//   { source: "recording-service", type: "RECORDING_UPLOADED", content: { recording_id } }
//   { source: "recording-service", type: "RECORDING_TRANSCRIPT_UPLOADED", content: { recording_id } }
// These must be told apart explicitly - a previous version of this function used a
// generic fallback (any payload with content.recording_id) that treated both the same,
// which meant every transcript-ready notification was silently re-triggering an
// unnecessary re-fetch/re-upload attempt of a recording we'd already processed (masked
// by the byte-size dedup, but wasteful and fragile - found while investigating the new
// transcript notification on 2026-07-20).
function classifyNotification(payload) {
  if (payload?.type === 'RECORDING_UPLOADED' && payload?.content?.recording_id) {
    return { kind: 'recording-uploaded', recordingId: payload.content.recording_id };
  }
  if (payload?.type === 'RECORDING_TRANSCRIPT_UPLOADED' && payload?.content?.recording_id) {
    return { kind: 'transcript-uploaded', recordingId: payload.content.recording_id };
  }
  return { kind: 'unknown' };
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

  // Feeds the new interaction-grouping/CSR-chain tracker (src/interactions.js) in
  // parallel with the existing conversationMetadata bookkeeping above. Kept as a
  // separate call (rather than folded into `merged`) so the new pipeline can evolve
  // independently of the Fireflies-based one without the two stepping on each other.
  interactions.recordLegState(conversationSpaceId, {
    legId: internal?.legId || external?.legId,
    internalName: internalType.name,
    internalExtension: internalType.extensionNumber,
    externalName: merged.externalName,
    externalNumber: merged.externalNumber,
    direction: merged.direction,
    dialString: merged.dialString,
    callCreated: merged.callCreated,
    callEnded: merged.callEnded,
    accountKey: merged.accountKey,
  });

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

// New pipeline path (2026-07-20): fetches the actual transcript content from GoTo now
// that the Advanced Reporting & Analytics add-on is enabled, and hands it to
// interactions.js to be grouped with the rest of its interaction. Runs alongside the
// existing Fireflies flow (handleRecording below), not instead of it, until the
// summarization/Drive/Heymarket steps are built and this can be verified end-to-end.
async function handleTranscriptReady(recordingId) {
  console.log(`Fetching transcript for recording ${recordingId} from GoTo...`);
  const transcript = await fetchTranscript(recordingId);

  const meta = recordingMetadata.get(recordingId);
  if (!meta || !meta.conversationSpaceId) {
    console.log(
      `Transcript for ${recordingId} has no known conversationSpaceId yet - this is exactly the "orphan recording" case (see the parked-call investigation from 2026-07-19/20). Dropping for now; Call History correlation (src/interactions.js) may still resolve the recording itself once we also track recordingId -> legId, which isn't wired up yet.`
    );
    return;
  }

  interactions.recordTranscript(meta.conversationSpaceId, recordingId, transcript);
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
  console.log(`Sending ${recordingId} to Fireflies as "${title}"...`);

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
//
// The GoTo timestamps are UTC (ISO 8601, e.g. "2026-07-18T10:41:40.8Z"). Joshua is on
// Pacific time, so the title is formatted with an explicit America/Los_Angeles timezone
// rather than relying on the server's local time (Render's containers default to UTC),
// which was previously making every title's timestamp look ~7 hours off.
function buildTitle(recordingId, meta) {
  const when = meta.callCreated
    ? new Date(meta.callCreated).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
    : 'unknown time';
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

// One-off admin route (added 2026-07-20): registers the new Call History + Call Parking
// subscriptions on the SAME notification channel setup.js already created, WITHOUT
// re-running setup.js itself (which would duplicate the call-events/recording
// subscriptions it also creates - see the "safe to re-run" caveat in setup.js). Render's
// free tier has no Shell access, so this is the practical way to trigger the equivalent
// of `npm run setup`'s new subscription calls against the live deployment: hit this route
// once after a deploy, check the JSON response, then it can be removed in a follow-up
// commit since running it again would register duplicate subscriptions.
app.get('/admin/register-new-subscriptions', async (req, res) => {
  try {
    const accountKey = process.env.GOTO_ACCOUNT_KEY || (await getAccountKey());
    const channelId = await getChannelId('fireflies-pipeline');
    const result = { accountKey, channelId };

    try {
      result.callHistory = await subscribeCallHistoryEvents(channelId, accountKey);
    } catch (err) {
      result.callHistoryError = err.message;
    }

    try {
      result.callParking = await subscribeCallParkingEvents(channelId, accountKey);
    } catch (err) {
      result.callParkingError = err.message;
    }

    console.log('Admin: registered new subscriptions:', JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('Admin: failed to register new subscriptions:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`goto-fireflies-pipeline listening on :${port}`));
