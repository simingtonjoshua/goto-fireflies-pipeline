require('dotenv').config();
const express = require('express');

const {
    fetchRecordingContent,
    fetchTranscript,
    getAccountKey,
    createWebhookChannel,
    subscribeCallHistoryEvents,
    subscribeCallParkingEvents,
} = require('./gotoClient');
const driveClient = require('./driveClient');
const interactions = require('./interactions');

const app = express();
app.use(express.json({ limit: '5mb' }));

// In-memory correlation state. This is intentionally ephemeral (lost on restart,
// redeploy, or the free-tier instance spinning down) - it only needs to survive the
// few seconds between a call's STARTING/ENDING events and its RECORDING_UPLOADED /
// RECORDING_TRANSCRIPT_UPLOADED notifications arriving. See README for options if this
// needs to be made durable (e.g. writing this map to a small database or KV store
// instead of memory).
const conversationMetadata = new Map(); // conversationSpaceId -> latest call metadata
const recordingMetadata = new Map(); // recordingId -> call metadata snapshot

// Observed on 2026-07-18: some calls generate TWO RECORDING_UPLOADED notifications with
// different recording_ids for what is the same physical recording (byte-identical),
// likely because the extension has multiple devices (desk phone + softphone clients)
// ringing simultaneously and each leg gets its own recording artifact. Only one of the
// two recording_ids typically shows up in the call-state events we track. Guard against
// archiving both copies to Drive by remembering recent upload byte-sizes (fallback
// safety net) and, more importantly, by batching notifications that land within a short
// window and preferring whichever recording_id we actually have call metadata for -
// otherwise the dedup logic can end up keeping the untracked/generic copy and discarding
// the one with real caller info, depending on arrival order (observed on 2026-07-18).
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

// BUG FIXED 2026-07-21 (found while investigating a rapid burst of ~15 back-to-back
// outbound dialer calls placed within a 20-minute window): this used to pick ONE
// "winner" recording out of the WHOLE batch and discard every other recording in it as
// a "duplicate leg recording of the same call" - which is only true for the
// multi-device case this batching exists for (see the comment above). Under heavy call
// volume, two recordings from two COMPLETELY DIFFERENT, unrelated calls can easily land
// in the same 1.5s batch window just by coincidence (confirmed live: an outbound call
// to one customer and an unrelated inbound call both had their RECORDING_UPLOADED
// notifications arrive within the same second) - the old code silently dropped one of
// those two customers' recordings entirely, keeping only whichever recording happened
// to have known call metadata.
//
// Fix: group the batch by each recording's own known conversationSpaceId first (via
// recordingMetadata) - only recordings that share the SAME conversationSpaceId are
// actual candidates for the multi-device dedup; every other conversationSpaceId (or
// unknown metadata) gets its own group and is never discarded as someone else's
// duplicate.
async function processRecordingBatch(batch) {
    if (batch.length === 1) {
          return handleRecording(batch[0]);
    }

  const groups = new Map(); // groupKey -> recordingIds sharing that key
  for (const id of batch) {
        const meta = recordingMetadata.get(id);
        // Recordings with no known conversationSpaceId get their own unique group
      // (keyed by their own id) rather than being lumped together, since we have
      // no basis to believe they belong to the same call.
      const groupKey = meta && meta.conversationSpaceId ? meta.conversationSpaceId : `unknown:${id}`;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(id);
  }

  const winners = [];
    for (const [groupKey, ids] of groups) {
          if (ids.length === 1) {
                  winners.push(ids[0]);
                  continue;
          }
          const withMeta = ids.find((id) => recordingMetadata.has(id));
          const winner = withMeta || ids[0];
          const skipped = ids.filter((id) => id !== winner);
          console.log(
                  `Recording group ${groupKey} within batch ${JSON.stringify(batch)} - archiving only ${winner} (known metadata: ${!!withMeta}), skipping ${JSON.stringify(skipped)} as duplicate leg recordings of the same call.`
                );
          winners.push(winner);
    }

  await Promise.all(
        winners.map((id) =>
                handleRecording(id).catch((err) => console.error(`Error handling recording ${id} from batch:`, err))
                        )
      );
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

// GoTo's recording-service notifications come in two flavors, confirmed against live
// payloads on 2026-07-18 (RECORDING_UPLOADED) and 2026-07-20 (RECORDING_TRANSCRIPT_UPLOADED,
// once the Advanced Reporting & Analytics add-on was enabled):
//   { source: "recording-service", type: "RECORDING_UPLOADED", content: { recording_id } }
//   { source: "recording-service", type: "RECORDING_TRANSCRIPT_UPLOADED", content: { recording_id } }
// These must be told apart explicitly - a previous version of this function used a
// generic fallback (any payload with content.recording_id) that treated both the same,
// which meant every transcript-ready notification was silently re-triggering an
// unnecessary re-fetch/re-archive attempt of a recording we'd already processed (masked
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
    const externalCallee = externalType.callee || {};
    const internalType = internal?.type || {};

  const existing = conversationMetadata.get(conversationSpaceId) || {};
    const callDirection = metadata.direction || existing.direction;
    const resolvedExternalNumber = callDirection === 'OUTBOUND'
      ? (externalCallee.number || externalCaller.number || externalType.number)
          : (externalCaller.number || externalCallee.number || externalType.number);
    const resolvedExternalName = callDirection === 'OUTBOUND'
      ? (externalCallee.name || externalCaller.name || externalType.name)
          : (externalCaller.name || externalCallee.name || externalType.name);
    const merged = {
          conversationSpaceId,
          direction: callDirection,
          dialString: metadata.dialString || existing.dialString,
          callCreated: metadata.callCreated || existing.callCreated,
          accountKey: metadata.accountKey || existing.accountKey,
          externalNumber: resolvedExternalNumber || existing.externalNumber,
          externalName: resolvedExternalName || existing.externalName,
          internalName: internalType.name || existing.internalName,
          internalExtension: internalType.extensionNumber || existing.internalExtension,
          callState: state.type || existing.callState,
          callEnded: state.type === 'ENDING' ? state.timestamp : existing.callEnded,
    };
    conversationMetadata.set(conversationSpaceId, merged);

  // On ENDING, GoTo tells us up front which recording ids are expected to produce a
  // transcript (state.transcripts[].id) - added 2026-07-21 after a real call (916-548-
  // 3966) showed the transcript arriving ~90s after call end, well past the 45s quiet
  // period interactions.js used to wait before finalizing. Forwarding these ids lets
  // interactions.js's recordLegState() track which transcripts are still pending and
  // extend its wait only when one hasn't shown up yet, instead of guessing with a flat
  // delay for every call (see the "SLOW-TRANSCRIPT FIX" note in interactions.js).
  const expectedTranscriptIds = (state.transcripts || []).map((t) => t.id).filter(Boolean);

  // Feeds the interaction-grouping/CSR-chain tracker (src/interactions.js) in parallel
  // with the conversationMetadata bookkeeping above.
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
        expectedTranscriptIds,
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

// Fetches the actual transcript content from GoTo (Advanced Reporting & Analytics
// add-on) and hands it to interactions.js to be grouped with the rest of its
// interaction.
async function handleTranscriptReady(recordingId) {
    console.log(`Fetching transcript for recording ${recordingId} from GoTo...`);
    const transcript = await fetchTranscript(recordingId);

  const meta = recordingMetadata.get(recordingId);
    if (!meta || !meta.conversationSpaceId) {
          console.log(
                  `Transcript for ${recordingId} has no known conversationSpaceId yet - this is the "orphan recording" case (see the parked-call investigation from 2026-07-19/20). Dropping for now; Call History correlation (src/interactions.js) may still resolve the recording itself once we also track recordingId -> legId, which isn't wired up yet.`
                );
          return;
    }

  interactions.recordTranscript(meta.conversationSpaceId, recordingId, transcript);
}

// Fetches the recording bytes from GoTo and archives them to Joshua's personal Google
// Drive (src/driveClient.js). This is the only thing this pipeline does with the raw
// audio now that GoTo's own Advanced Reporting & Analytics add-on produces transcripts
// directly - there's no separate transcription service to feed anymore.
async function handleRecording(recordingId) {
    console.log(`Fetching recording ${recordingId} from GoTo...`);
    const { buffer, contentType } = await fetchRecordingContent(recordingId);

  const now = Date.now();
    const lastSeen = recentUploadSizes.get(buffer.length);
    if (lastSeen && now - lastSeen < DUPLICATE_WINDOW_MS) {
          console.log(
                  `Skipping recording ${recordingId} (${buffer.length} bytes) - matches a recording archived ${Math.round((now - lastSeen) / 1000)}s ago, likely a duplicate leg recording of the same call.`
                );
          return;
    }
    recentUploadSizes.set(buffer.length, now);

  const meta = recordingMetadata.get(recordingId) || {};
    await archiveToDrive(recordingId, buffer, contentType, meta);
}

// Uploads a recording's bytes to Google Drive (into the per-call subfolder - see
// driveClient.buildCallFolderName/getOrCreateCallFolder) and records the resulting link
// against this call's interaction so it can be included in the Heymarket note. The
// filename itself carries the folder's own name as a prefix (per Joshua, 2026-07-21) so
// the file still shows its date/direction/phone context if it's ever viewed on its own.
async function archiveToDrive(recordingId, buffer, contentType, meta) {
    try {
          const ext = driveClient.extForContentType(contentType);
          const folderName = driveClient.buildCallFolderName({
                  callCreated: meta.callCreated,
                  direction: meta.direction,
                  externalNumber: meta.externalNumber || meta.dialString,
          });
          const topFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
          const folder = await driveClient.getOrCreateCallFolder(topFolderId, folderName);
          const filename = `${folderName} - Recording.${ext}`;

      const { webViewLink } = await driveClient.uploadRecording(buffer, contentType, filename, folder.id);
          console.log(`Archived recording ${recordingId} to Google Drive folder "${folderName}": ${webViewLink}`);

      if (meta.conversationSpaceId) {
              interactions.recordRecordingLink(meta.conversationSpaceId, recordingId, webViewLink, folder);
      } else {
              console.log(
                        `Recording ${recordingId} archived to Drive but has no known conversationSpaceId yet - the link won't be attached to an interaction (same "orphan recording" case handleTranscriptReady logs).`
                      );
      }
    } catch (err) {
          console.error(`Error archiving recording ${recordingId} to Google Drive:`, err);
    }
}

// One-off admin route (added 2026-07-20): registers the new Call History + Call Parking
// subscriptions on the SAME notification channel setup.js already created, WITHOUT
// re-running setup.js itself (which would duplicate the call-events/recording
// subscriptions it also creates - see the "safe to re-run" caveat in setup.js). Render's
// free tier has no Shell access, so this is the practical way to trigger the equivalent
// of `npm run setup`'s new subscription calls against the live deployment: hit this route
// once after a deploy, check the JSON response, then it can be removed in a follow-up
// commit since running it again would register duplicate subscriptions.
//
// NOTE: GoTo's notification-channel endpoint only supports POST (confirmed live on
// 2026-07-20 - a GET attempt returned 405 METHOD_NOT_ALLOWED), not a GET-by-nickname
// lookup. So instead of looking up the existing channel, this re-POSTs to
// createWebhookChannel() with the SAME nickname + webhook URL setup.js originally used -
// since the nickname is the path identifier, this should upsert/return the same
// channelId rather than creating a second channel.
app.get('/admin/register-new-subscriptions', async (req, res) => {
    try {
          const accountKey = process.env.GOTO_ACCOUNT_KEY || (await getAccountKey());
          const webhookUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/goto`;
          const channelId = await createWebhookChannel(webhookUrl);
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
// TEMPORARY debug route (added 2026-07-21, remove after use): fetches and returns the
// raw transcript JSON for a given recordingId, so we can see GoTo's actual transcript
// shape/format instead of guessing from the docs. Not auth-protected - fine for a
// short-lived debug aid, but should be deleted before this is left running long-term.
app.get('/admin/debug-transcript/:recordingId', async (req, res) => {
    try {
          const transcript = await fetchTranscript(req.params.recordingId);
          res.json(transcript);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});


// One-off admin route (added 2026-07-21): renames the top-level Drive destination
// folder from "Call Recordings" to "Call Recordings & Transcriptions" now that
// per-call transcript Docs live there too (see driveClient.js). Hit once, confirm the
// JSON response, then this can be removed in a follow-up commit.
app.get('/admin/rename-drive-folder', async (req, res) => {
    try {
          const folder = await driveClient.renameFolder(process.env.GOOGLE_DRIVE_FOLDER_ID, 'Call Recordings & Transcriptions');
          res.json(folder);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`goto-fireflies-pipeline listening on :${port}`));
