// Groups individual call legs (recordings + transcripts) into one real-world
// "interaction" - e.g. a call that gets parked and picked back up, or transferred to
// another team member, produces multiple separate legs in GoTo's own data model, but
// should read as ONE call when we eventually summarize it and post it to Heymarket.
//
// The grouping key is Call History's `originatorId` (confirmed via developer.goto.com on
// 2026-07-19: "common Id grouping the items for a single interaction (call)"). We learn
// it from Call History Subscription events (source: "call-history"), which include a
// `legId` that also appears on participants in the ordinary call-events stream - that
// shared legId is the join between the two event streams. CONFIRMED live 2026-07-21:
// Call History events for this account's test call arrived with no userKeys filter
// needed, and correlated correctly to the originatorId.
//
// UNVERIFIED as of this writing (2026-07-21), pending a live park/transfer test:
// - The exact payload shape of Call Parking events (no live payload has been seen yet;
// handleCallParkingEvent() just logs the raw payload for now).
//
// Resilience: if we never learn an originatorId for a given conversationSpaceId (e.g.
// the Call History subscription turns out not to be wired up correctly, or the event
// simply hasn't arrived yet), we still finalize using conversationSpaceId alone once the
// quiet period elapses - a plain, non-parked, non-transferred call should never get
// stuck waiting on a piece of data it doesn't actually need.
//
// BUG FIXED 2026-07-21 (found via first live test call): linkConversationToOriginator()
// used to unconditionally call scheduleFinalize(originatorId) the moment Call History
// correlated a leg - which happens within seconds of a call starting, not when it ends.
// On the test call this fired a 30s countdown while the call was still in progress (the
// caller was just talking, so no further webhook events arrived), finalizing and posting
// an EMPTY Heymarket private note (0 transcripts, 0 recordings) mid-call. Then the real
// ENDING/recording/transcript events arrived ~2.5 minutes later under a fresh in-memory
// state (the first interaction had already been cleaned up) and finalized a SECOND time
// with the real transcript + recording, posting a second, duplicate Heymarket note for
// the same phone call.
//
// The fix: only start the finalize countdown from a genuine end-of-call signal -
// recordLegState() now schedules it when GoTo's call-state ENDING event supplies
// callEnded, and recordTranscript()/recordRecordingLink() still (re)schedule it as
// before since those can only fire post-call. linkConversationToOriginator() no longer
// starts a timer from scratch - correlating a leg to its originatorId is bookkeeping,
// not an end-of-call signal - it only carries an ALREADY-RUNNING timer over to the
// shared originatorId group so a late-arriving Call History event can't accidentally
// cancel a pending finalize.
//
// TRANSCRIPT DOC + SINGLE-LINK HEYMARKET NOTE (added 2026-07-21, per Joshua): each
// finalized interaction now gets its own Drive subfolder (see driveClient.js
// buildCallFolderName/getOrCreateCallFolder) holding both the audio recording (uploaded
// by server.js's archiveToDrive as soon as it's available) and a transcript+summary
// Google Doc (created here, once summarization finishes). Heymarket's private note
// links to that ONE subfolder instead of separate recording/transcript links, to keep
// the note short. Both upload paths compute the same folder name independently and
// converge on the same folder via getOrCreateCallFolder's find-or-create logic, since
// they can finish in either order. Both files inside the folder (the recording and the
// transcript Doc) are named with that same folder name as a prefix, so a file opened on
// its own (e.g. from a "Recent" list) still carries the date/direction/phone context
// instead of a generic "Call Recording.mp3".
//
// FOLLOW-UP FIXES (added 2026-07-21, after Joshua reviewed the first live Doc):
// - The Doc's metadata block used to show the phone company's caller-ID/line label
//   (e.g. "Rancho Cordova / East Elk Grove (RC)") as if it were the customer's name.
//   It's now labeled "Phone number" first, with "Caller ID" only shown as a separate
//   line, and only for inbound calls (outbound caller-ID metadata describes us, not the
//   customer).
// - "CSR(s)" relabeled "Team Member(s)".
// - Folder/file naming now uses a YYYY-MM-DD date (driveClient.formatDateForFilename)
//   instead of "Jul 21, 2026" so files sort and scan correctly in a file listing.
//
// TEAM MEMBER NAME FROM CALL HISTORY (added 2026-07-21, after a real call showed "Team
// Member: unknown" throughout the whole transcript/summary despite Joshua Simington
// actually answering it): GoTo's call-events stream doesn't always surface OUR OWN
// internal participant object at all - on that call, only the external caller ever
// appeared in call-state events' `participants` array, so recordLegState() never got an
// internalName/internalExtension to push onto csrChain. Call History events always
// include BOTH parties (caller/callee) though, so recordCallHistoryEvent() below now
// also extracts whichever side looks like an internal extension (a short number like
// "00003" rather than a full phone number) and backfills csrChain from it - this is a
// fallback source of the team member's name, used only when call-state didn't already
// supply one. Also fixed: recordCallHistoryEvent() used to give up entirely if THIS
// event's own legId hadn't been seen in a call-state event yet (common for whichever
// party's leg call-state doesn't surface), even when the shared originatorId was
// already linked to a known conversationSpaceId by an earlier Call History event for
// the same call - it now falls back to that known link.
//
// SLOW-TRANSCRIPT FIX (added 2026-07-21, found on a real call, 916-548-3966): the
// original 45s quiet period was calibrated against a call where the recording and
// transcript both showed up within 5-6s of call end. On this real call, the recording
// arrived quickly (~8s) but the transcript took ~90s to generate - past the 45s window
// - so the interaction finalized (and posted a "no transcript available" summary)
// BEFORE the transcript existed. When the transcript then arrived ~50s later, the
// interaction's in-memory state had already been cleaned up, so recordTranscript()
// silently created a brand-new, mostly-empty leg and finalized a SECOND time - this one
// with the transcript but no phone number/customer info (since that lived on the
// deleted original leg), posting a duplicate near-empty Doc and skipping Heymarket
// entirely (no externalNumber).
//
// The fix has two parts:
// 1) GoTo's ENDING call-state event tells us up front which recording ids are expected
//    to produce a transcript (state.transcripts[].id - server.js now forwards these as
//    expectedTranscriptIds). recordLegState() tracks these per leg as
//    pendingTranscriptIds, and recordTranscript() clears an id from that set once its
//    transcript actually arrives. The finalize timer, when it fires, now checks
//    stillWaitingOnTranscript() first: if a leg in the group still has a pending
//    transcript id AND we're within FINALIZE_MAX_WAIT_MS (3 minutes) of that leg's
//    callEnded, it just re-arms the same 45s timer instead of finalizing - so a normal,
//    fast call still posts quickly, and only a call with a genuinely slow transcript
//    waits longer. Past the 3-minute backstop, it gives up waiting and finalizes
//    without the transcript, same as the original behavior, so a transcript that never
//    arrives (or arrives absurdly late) can't hang an interaction forever.
// 2) As a safety net for that rare backstop-exceeded case (or any other late arrival
//    after an interaction has already been finalized and cleaned up):
//    recentlyFinalizedConversationSpaceIds tracks conversationSpaceIds that were just
//    finalized. recordTranscript() and recordRecordingLink() check this before creating
//    a new leg - if the conversationSpaceId was recently finalized and has no live leg,
//    they log it and drop the late data instead of silently building a phantom
//    duplicate interaction with missing customer info.

const openaiClient = require('./openaiClient');
const heymarketClient = require('./heymarketClient');
const driveClient = require('./driveClient');

const FINALIZE_QUIET_MS = 45 * 1000; // Anchored to the real call-ended signal as of the
// 2026-07-21 fix (see BUG FIXED note above), so this only needs to cover GoTo's own
// notification lag between a call ending and its recording/transcript becoming available
// - confirmed live at ~5-6s on 2026-07-21 - plus a safety margin, not a real waiting game.

// How long we'll keep re-arming the quiet-period timer for a leg that's still waiting
// on an expected transcript (see SLOW-TRANSCRIPT FIX above), measured from that leg's
// callEnded. Past this, we give up waiting and finalize without the transcript rather
// than risk hanging an interaction indefinitely if GoTo's transcript webhook never
// fires for some reason.
const FINALIZE_MAX_WAIT_MS = 3 * 60 * 1000;

// How long a conversationSpaceId stays in recentlyFinalizedConversationSpaceIds after
// being cleaned up, so a very late (post-backstop) transcript/recording arrival can be
// recognized and dropped instead of building a phantom duplicate interaction. Generous
// on purpose - the cost of remembering a few extra ids is trivial, the cost of another
// duplicate empty Doc is not.
const RECENTLY_FINALIZED_TTL_MS = 15 * 60 * 1000;

// conversationSpaceId -> { legId, csrChain: [{name, extension, enteredAt}], externalName,
// externalNumber, direction, dialString, callCreated, callEnded, accountKey,
// transcript: null | array of utterance objects, recordingId, driveLink, folderId,
// folderLink, pendingTranscriptIds: Set<recordingId> }
const legs = new Map();

// legId -> conversationSpaceId (learned from call-events participants)
const legIdToConversation = new Map();

// conversationSpaceId -> originatorId (learned from Call History events)
const originatorForConversation = new Map();

// originatorId -> Set<conversationSpaceId>
const conversationsForOriginator = new Map();

// groupKey (originatorId, or conversationSpaceId if no originatorId known) -> timer
const closeTimers = new Map();

// conversationSpaceId -> finalizedAtMs (see SLOW-TRANSCRIPT FIX above)
const recentlyFinalizedConversationSpaceIds = new Map();

function getOrCreateLeg(conversationSpaceId) {
    let leg = legs.get(conversationSpaceId);
    if (!leg) {
          leg = { csrChain: [], transcript: null, recordingId: null, pendingTranscriptIds: new Set() };
          legs.set(conversationSpaceId, leg);
    }
    return leg;
}

function wasRecentlyFinalized(conversationSpaceId) {
    const finalizedAt = recentlyFinalizedConversationSpaceIds.get(conversationSpaceId);
    if (!finalizedAt) return false;
    if (Date.now() - finalizedAt > RECENTLY_FINALIZED_TTL_MS) {
          recentlyFinalizedConversationSpaceIds.delete(conversationSpaceId);
          return false;
    }
    return true;
}

// Call this from trackCallState() for every call-state event, in addition to (not
// instead of) the existing conversationMetadata bookkeeping in server.js. Captures the
// ordered chain of internal parties (team members) rather than overwriting - a transfer
// test on 2026-07-20 showed the previous last-write-wins approach silently lost the
// first team member once the call was handed to a second one.
function recordLegState(conversationSpaceId, { legId, internalName, internalExtension, externalName, externalNumber, direction, dialString, callCreated, callEnded, accountKey, expectedTranscriptIds }) {
    const leg = getOrCreateLeg(conversationSpaceId);
    if (legId) {
          leg.legId = legId;
          legIdToConversation.set(legId, conversationSpaceId);
    }
    if (externalName) leg.externalName = externalName;
    if (externalNumber) leg.externalNumber = externalNumber;
    if (direction) leg.direction = direction;
    if (dialString) leg.dialString = dialString;
    if (callCreated) leg.callCreated = callCreated;
    if (accountKey) leg.accountKey = accountKey;

  if (internalName || internalExtension) {
        const last = leg.csrChain[leg.csrChain.length - 1];
        const isSame = last && last.name === internalName && last.extension === internalExtension;
        if (!isSame) {
                leg.csrChain.push({ name: internalName, extension: internalExtension, enteredAt: new Date().toISOString() });
        }
  }

  // This is the real "the call is over" signal (GoTo's call-state ENDING event, passed
  // through from server.js's trackCallState as callEnded) - start the finalize countdown
  // here, not merely when Call History happens to correlate this leg to an originatorId
  // (see the BUG FIXED note at the top of this file for why that distinction matters).
  if (callEnded) {
        leg.callEnded = callEnded;
        if (expectedTranscriptIds && expectedTranscriptIds.length) {
                for (const id of expectedTranscriptIds) {
                          // If a transcript for this id already arrived (rare ordering, but cheap to
                  // guard), don't mark it pending - recordTranscript() sets leg.recordingId once
                  // it receives one.
                  if (leg.recordingId !== id) leg.pendingTranscriptIds.add(id);
                }
        }
        scheduleFinalize(groupKeyFor(conversationSpaceId));
  }
}

// Call History events (source: "call-history") carry { originatorId, legId, caller,
// callee, ... }. Joins back to whichever conversationSpaceId we already associated with
// that legId via the ordinary call-events stream, and remembers the originatorId for
// next time too, in case the transcript/recording for this leg hasn't arrived yet.
//
// Also backfills the team member's name onto csrChain when call-state never supplied
// one (see the "TEAM MEMBER NAME FROM CALL HISTORY" header note above) - Call History
// always carries both parties' name+number, even for the internal participant GoTo's
// call-events stream sometimes omits entirely.
function recordCallHistoryEvent(payload) {
    const content = payload?.content || {};
    const { originatorId, legId, caller, callee } = content;
    if (!originatorId) return;

  let conversationSpaceId = legId ? legIdToConversation.get(legId) : undefined;
    if (!conversationSpaceId) {
          // Even when THIS event's own legId was never seen in a call-state event (the exact
      // gap the csrChain backfill below exists to patch), fall back to the originatorId
      // if it's already been linked to a conversationSpaceId by an earlier Call History
      // event for the same call (e.g. the other party's own leg, which usually
      // correlates fine via call-state).
      const known = conversationsForOriginator.get(originatorId);
          if (known && known.size) conversationSpaceId = [...known][0];
    }

  console.log(
        `Call History event: legId=${legId} originatorId=${originatorId}` +
        (conversationSpaceId ? ` -> conversationSpaceId=${conversationSpaceId}` : ' (no matching conversationSpaceId seen yet)')
      );

  if (conversationSpaceId) {
        // Whichever side has a short, extension-style number (e.g. "00003") rather than a
      // full phone number is our own internal team member.
      const internalParty = [caller, callee].find((p) => p && p.name && p.number && String(p.number).length <= 6);
        if (internalParty) {
                const leg = getOrCreateLeg(conversationSpaceId);
                const last = leg.csrChain[leg.csrChain.length - 1];
                const isSame = last && last.name === internalParty.name && last.extension === internalParty.number;
                if (!isSame) {
                          leg.csrChain.push({ name: internalParty.name, extension: internalParty.number, enteredAt: new Date().toISOString() });
                }
        }
  }

  if (!conversationSpaceId) return;

  linkConversationToOriginator(conversationSpaceId, originatorId);
}

function linkConversationToOriginator(conversationSpaceId, originatorId) {
    const already = originatorForConversation.get(conversationSpaceId);
    if (already === originatorId) return;

  originatorForConversation.set(conversationSpaceId, originatorId);
    if (!conversationsForOriginator.has(originatorId)) {
          conversationsForOriginator.set(originatorId, new Set());
    }
    conversationsForOriginator.get(originatorId).add(conversationSpaceId);

  // If this conversationSpaceId already had its own quiet-period timer running under its
  // own id (because the call had genuinely ended - see recordLegState - before we knew
  // its originatorId yet), move that timer to the shared originatorId group instead of
  // dropping it. Do NOT start a brand-new timer here if none was already running:
  // correlating a leg to its originatorId can happen seconds into a call that's still in
  // progress (confirmed live 2026-07-21 - see the BUG FIXED note at the top of this
  // file), so it must never be treated as an end-of-call signal on its own.
  const hadTimer = closeTimers.has(conversationSpaceId);
    cancelTimer(conversationSpaceId);
    if (hadTimer) scheduleFinalize(originatorId);
}

// Not verified against a real payload yet - logging generously so the first live park
// test tells us the actual shape to parse. Once we know it, this should call
// linkConversationToOriginator() the same way recordCallHistoryEvent() does, but instantly
// (no need to wait on Call History at all for the park case specifically).
function recordCallParkingEvent(payload) {
    console.log('Call Parking event received (shape not yet mapped):', JSON.stringify(payload));
}

// Attaches a fetched transcript (see gotoClient.fetchTranscript) to the leg for this
// recording's conversationSpaceId, and (re)starts that interaction's quiet-period timer.
//
// Guards against the late-arrival-after-finalize case (see SLOW-TRANSCRIPT FIX above):
// if this conversationSpaceId has no live leg AND was recently finalized, this transcript
// missed the window entirely - log it and drop it rather than building a new, mostly-
// empty phantom interaction with no customer info attached.
function recordTranscript(conversationSpaceId, recordingId, transcript) {
    if (!legs.has(conversationSpaceId) && wasRecentlyFinalized(conversationSpaceId)) {
          console.log(
                  `Transcript for recording ${recordingId} arrived for conversationSpaceId=${conversationSpaceId} after it was already finalized - dropping instead of creating a duplicate interaction.`
                );
          return;
    }
    const leg = getOrCreateLeg(conversationSpaceId);
    leg.recordingId = recordingId;
    leg.transcript = transcript;
    leg.pendingTranscriptIds.delete(recordingId);
    scheduleFinalize(groupKeyFor(conversationSpaceId));
}

// Attaches a Google Drive archival link (and per-call subfolder info, added 2026-07-21)
// for this leg's recording (see server.js handleRecording -> driveClient.uploadRecording),
// and (re)starts the interaction's quiet-period timer the same way recordTranscript
// does. Kept as its own entry point (rather than folded into recordTranscript) since the
// Drive upload and the transcript fetch are two independent async operations that can
// finish in either order.
//
// Same late-arrival guard as recordTranscript() (see SLOW-TRANSCRIPT FIX above).
function recordRecordingLink(conversationSpaceId, recordingId, driveLink, folder) {
    if (!conversationSpaceId) return;
    if (!legs.has(conversationSpaceId) && wasRecentlyFinalized(conversationSpaceId)) {
          console.log(
                  `Recording link for ${recordingId} arrived for conversationSpaceId=${conversationSpaceId} after it was already finalized - dropping instead of creating a duplicate interaction.`
                );
          return;
    }
    const leg = getOrCreateLeg(conversationSpaceId);
    leg.recordingId = leg.recordingId || recordingId;
    leg.driveLink = driveLink;
    if (folder && folder.id) {
          leg.folderId = folder.id;
          leg.folderLink = folder.webViewLink;
    }
    scheduleFinalize(groupKeyFor(conversationSpaceId));
}

function groupKeyFor(conversationSpaceId) {
    return originatorForConversation.get(conversationSpaceId) || conversationSpaceId;
}

function cancelTimer(key) {
    const timer = closeTimers.get(key);
    if (timer) {
          clearTimeout(timer);
          closeTimers.delete(key);
    }
}

// True if any leg in this group is still waiting on an expected transcript that hasn't
// arrived yet, and we're still within FINALIZE_MAX_WAIT_MS of that leg's callEnded (see
// SLOW-TRANSCRIPT FIX above). Used by scheduleFinalize's timer callback to decide
// whether to actually finalize or just keep waiting a bit longer.
function stillWaitingOnTranscript(groupKey) {
    const now = Date.now();
    for (const conversationSpaceId of conversationSpaceIdsFor(groupKey)) {
          const leg = legs.get(conversationSpaceId);
          if (!leg || !leg.pendingTranscriptIds || !leg.pendingTranscriptIds.size) continue;
          const callEndedMs = leg.callEnded ? new Date(leg.callEnded).getTime() : null;
          if (!callEndedMs || now - callEndedMs < FINALIZE_MAX_WAIT_MS) return true;
    }
    return false;
}

function scheduleFinalize(groupKey) {
    cancelTimer(groupKey);
    const timer = setTimeout(() => {
          closeTimers.delete(groupKey);
          if (stillWaitingOnTranscript(groupKey)) {
                  console.log(`Interaction ${groupKey} quiet period elapsed but a transcript is still pending (within the backstop window) - extending the wait.`);
                  scheduleFinalize(groupKey);
                  return;
          }
          finalizeInteraction(groupKey).catch((err) =>
                  console.error(`Error finalizing interaction ${groupKey}:`, err)
                                                  );
    }, FINALIZE_QUIET_MS);
    closeTimers.set(groupKey, timer);
}

// groupKey is either an originatorId (multi-leg interaction) or a bare
// conversationSpaceId (single-leg call where we never learned an originatorId).
function conversationSpaceIdsFor(groupKey) {
    return conversationsForOriginator.get(groupKey) || new Set([groupKey]);
}

function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

// Assembles the Google Doc content: call metadata, the AI summary, then the full
// speaker-labeled transcript (openaiClient.formatTranscriptForDoc - the exact same
// labeling shown to the model itself, so the Doc and the Heymarket note never
// disagree about who said what).
//
// Customer identification (revised 2026-07-21 - see the header comment's "FOLLOW-UP
// FIXES"): leads with the phone number rather than a name, since we usually don't have
// the customer's real name. The "Caller ID" line (the carrier/line label GoTo has on
// file for the number - e.g. "Rancho Cordova / East Elk Grove (RC)") is only shown for
// inbound calls, and only as a clearly separate line - never presented as if it were the
// customer's name, and never shown at all for outbound calls (where that metadata
// describes our own line, not the customer's).
function buildTranscriptDocHtml({ externalName, externalNumber, direction, csrPath, callCreated, callEnded, summaryText, legRecords }) {
    const metaRows = [['Phone number', escapeHtml(driveClient.formatPhoneForDisplay(externalNumber))]];
    if (direction !== 'OUTBOUND' && externalName) {
          metaRows.push(['Caller ID', escapeHtml(externalName)]);
    }
    metaRows.push(
          ['Direction', escapeHtml(direction || 'unknown')],
          ['Team Member(s)', escapeHtml((csrPath || []).join(' → ') || 'unknown')],
          ['Call started', escapeHtml(driveClient.formatPacific(callCreated))],
          ['Call ended', escapeHtml(driveClient.formatPacific(callEnded))]
        );
    const metaHtml = metaRows.map(([label, value]) => `<p><b>${label}:</b> ${value}</p>`).join('\n');

  const summaryHtml = escapeHtml(summaryText || '')
      .split('\n')
      .map((line) => `<p>${line}</p>`)
      .join('\n');

  const transcriptHtml = openaiClient.formatTranscriptForDoc(legRecords);

  return `<html><body>
        <h1>Call Summary</h1>
                    ${metaHtml}
                                        <hr>
                                                                      <h2>Summary</h2>
                                                                                                                ${summaryHtml}
                                                                                                                                                                        <hr>
                                                                                                                                                                                                                                                <h2>Transcript</h2>
                                                                                                                                                                                                                                                                                                                                          ${transcriptHtml}
                                                                                                                                                                                                                                                                                                                                                                                                                                                        </body></html>`;
}

// Assembles the finished interaction, summarizes it with OpenAI (src/openaiClient.js),
// creates the transcript+summary Google Doc alongside the recording in this call's
// Drive subfolder, and posts the summary + a single folder link to Heymarket as a
// private note (src/heymarketClient.js). Both the Doc creation and the Heymarket post
// are wrapped in their own try/catch and never throw out of this function - a
// summarization, Drive, or Heymarket outage should never crash the webhook handler or
// block cleanup of this interaction's in-memory state below.
async function finalizeInteraction(groupKey) {
    const conversationSpaceIds = [...conversationSpaceIdsFor(groupKey)];
    const legRecords = conversationSpaceIds.map((id) => ({ conversationSpaceId: id, ...legs.get(id) })).filter((l) => l.legId || l.transcript || l.externalNumber);

  if (!legRecords.length) {
        console.log(`Interaction ${groupKey} closed with no leg data recorded - nothing to summarize.`);
        return;
  }

  const csrChain = [];
    for (const leg of legRecords) {
          for (const entry of leg.csrChain || []) {
                  const last = csrChain[csrChain.length - 1];
                  if (!last || last.name !== entry.name || last.extension !== entry.extension) {
                            csrChain.push(entry);
                  }
          }
    }

  const csrPath = csrChain.map((c) => `${c.name || 'unknown'} (${c.extension || 'unknown ext'})`);
    const externalNumber = legRecords.find((l) => l.externalNumber)?.externalNumber;
    const externalName = legRecords.find((l) => l.externalName)?.externalName;
    const direction = legRecords.find((l) => l.direction)?.direction;
    const callCreated = legRecords.map((l) => l.callCreated).filter(Boolean).sort()[0];
    const callEnded = legRecords.map((l) => l.callEnded).filter(Boolean).sort().slice(-1)[0];
    const existingFolderLeg = legRecords.find((l) => l.folderId);

  const summary = {
        groupKey,
        legCount: legRecords.length,
        externalNumber,
        externalName,
        direction,
        csrPath,
        callCreated,
        callEnded,
        transcriptsAttached: legRecords.filter((l) => l.transcript).length,
        hasRecording: legRecords.some((l) => l.driveLink),
  };

  console.log('INTERACTION READY FOR SUMMARY:', JSON.stringify(summary, null, 2));

  try {
        const summaryText = await openaiClient.summarizeInteraction({
                legRecords,
                csrPath,
                externalName,
                externalNumber,
                direction,
                callCreated,
                callEnded,
        });

      // Find-or-create the same per-call subfolder server.js's archiveToDrive already
      // created (or will create) for this call's recording - both sides compute the
      // folder name from the same callCreated/direction/externalNumber fields (see
      // driveClient.buildCallFolderName), so this converges on the same folder rather
      // than making a second one, regardless of which of the two ran first. Both the
      // recording (named in server.js's archiveToDrive) and this transcript Doc are named
      // with that same folder name as a prefix, so either file carries its own
      // date/direction/phone context even when viewed outside the folder.
      let folderLink = existingFolderLeg?.folderLink;
        try {
                const topFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
                const folderName = driveClient.buildCallFolderName({ callCreated, direction, externalNumber });
                const folder = await driveClient.getOrCreateCallFolder(topFolderId, folderName);
                folderLink = folder.webViewLink;

          const docHtml = buildTranscriptDocHtml({
                    externalName,
                    externalNumber,
                    direction,
                    csrPath,
                    callCreated,
                    callEnded,
                    summaryText,
                    legRecords,
          });
                await driveClient.createTranscriptDoc(folder.id, `${folderName} - Call Summary & Transcript`, docHtml);
                console.log(`Created transcript Doc for interaction ${groupKey} in folder ${folder.id}.`);
        } catch (err) {
                console.error(`Error creating transcript Doc for interaction ${groupKey}:`, err);
        }

      const noteLines = [summaryText];
        if (folderLink) {
                noteLines.push('', `Call recording & transcript: ${folderLink}`);
        }
        const noteText = noteLines.join('\n');

      if (externalNumber) {
              await heymarketClient.postPrivateNote(externalNumber, noteText);
              console.log(`Posted Heymarket private note for interaction ${groupKey} (${externalNumber}).`);
      } else {
              console.log(
                        `Interaction ${groupKey} has no externalNumber - skipping Heymarket post. Summary was:\n${summaryText}`
                      );
      }
  } catch (err) {
        console.error(`Error summarizing/posting interaction ${groupKey}:`, err);
  }

  // Clean up now that this interaction is closed. Remember each conversationSpaceId
  // briefly (see recentlyFinalizedConversationSpaceIds above) so a late-arriving
  // transcript/recording past the backstop window can be recognized and dropped
  // instead of silently building a duplicate phantom interaction.
  const finalizedAt = Date.now();
    for (const id of conversationSpaceIds) {
          legs.delete(id);
          originatorForConversation.delete(id);
          recentlyFinalizedConversationSpaceIds.set(id, finalizedAt);
    }
    conversationsForOriginator.delete(groupKey);
}

module.exports = {
    recordLegState,
    recordCallHistoryEvent,
    recordCallParkingEvent,
    recordTranscript,
    recordRecordingLink,
    legIdToConversation,
};
