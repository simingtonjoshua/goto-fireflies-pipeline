// Groups individual call legs (recordings + transcripts) into one real-world
// "interaction" - e.g. a call that gets parked and picked back up, or transferred to
// another CSR, produces multiple separate legs in GoTo's own data model, but should
// read as ONE call when we eventually summarize it and post it to Heymarket.
//
// The grouping key is Call History's `originatorId` (confirmed via developer.goto.com on
// 2026-07-19: "common Id grouping the items for a single interaction (call)"). We learn
// it from Call History Subscription events (source: "call-history"), which include a
// `legId` that also appears on participants in the ordinary call-events stream - that
// shared legId is the join between the two event streams.
//
// UNVERIFIED as of this writing (2026-07-21), pending a live test:
//   - Whether Call History Subscription, given only { accountKey, channelId } with no
//     userKeys, actually covers the whole account rather than just one user.
//   - The exact payload shape of Call Parking events (no live payload has been seen yet;
//     handleCallParkingEvent() just logs the raw payload for now).
//   - The exact shape of the transcript JSON from GoTo's Transcriptions endpoint, and
//     which physical channel (0 or 1) is the CSR vs. the customer - see the comments in
//     src/openaiClient.js and src/gotoClient.js.
//
// Resilience: if we never learn an originatorId for a given conversationSpaceId (e.g.
// the Call History subscription turns out not to be wired up correctly, or the event
// simply hasn't arrived yet), we still finalize using conversationSpaceId alone once the
// quiet period elapses - a plain, non-parked, non-transferred call should never get
// stuck waiting on a piece of data it doesn't actually need.

const openaiClient = require('./openaiClient');
const heymarketClient = require('./heymarketClient');

const FINALIZE_QUIET_MS = 30 * 1000; // see conversation 2026-07-20: parks/transfers on
// this account resolve almost instantly once GoTo's own signals are used, so this only
// needs to cover normal network/notification lag, not a real waiting game.

// conversationSpaceId -> { legId, csrChain: [{name, extension, enteredAt}], externalName,
//   externalNumber, direction, dialString, callCreated, callEnded, accountKey,
//   transcript: null | array of utterance objects, recordingId }
const legs = new Map();

// legId -> conversationSpaceId (learned from call-events participants)
const legIdToConversation = new Map();

// conversationSpaceId -> originatorId (learned from Call History events)
const originatorForConversation = new Map();

// originatorId -> Set<conversationSpaceId>
const conversationsForOriginator = new Map();

// groupKey (originatorId, or conversationSpaceId if no originatorId known) -> timer
const closeTimers = new Map();

function getOrCreateLeg(conversationSpaceId) {
    let leg = legs.get(conversationSpaceId);
    if (!leg) {
          leg = { csrChain: [], transcript: null, recordingId: null };
          legs.set(conversationSpaceId, leg);
    }
    return leg;
}

// Call this from trackCallState() for every call-state event, in addition to (not
// instead of) the existing conversationMetadata bookkeeping in server.js. Captures the
// ordered chain of internal parties (CSRs) rather than overwriting - a transfer test on
// 2026-07-20 showed the previous last-write-wins approach silently lost the first CSR
// once the call was handed to a second one.
function recordLegState(conversationSpaceId, { legId, internalName, internalExtension, externalName, externalNumber, direction, dialString, callCreated, callEnded, accountKey }) {
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
    if (callEnded) leg.callEnded = callEnded;
    if (accountKey) leg.accountKey = accountKey;

  if (internalName || internalExtension) {
        const last = leg.csrChain[leg.csrChain.length - 1];
        const isSame = last && last.name === internalName && last.extension === internalExtension;
        if (!isSame) {
                leg.csrChain.push({ name: internalName, extension: internalExtension, enteredAt: new Date().toISOString() });
        }
  }
}

// Call History events (source: "call-history") carry { originatorId, legId, ... }.
// Joins back to whichever conversationSpaceId we already associated with that legId via
// the ordinary call-events stream, and remembers the originatorId for next time too, in
// case the transcript/recording for this leg hasn't arrived yet.
function recordCallHistoryEvent(payload) {
    const content = payload?.content || {};
    const { originatorId, legId } = content;
    if (!originatorId || !legId) return;

  const conversationSpaceId = legIdToConversation.get(legId);
    console.log(
          `Call History event: legId=${legId} originatorId=${originatorId}` +
            (conversationSpaceId ? ` -> conversationSpaceId=${conversationSpaceId}` : ' (no matching conversationSpaceId seen yet)')
        );
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

  // If this conversationSpaceId already had its own quiet-period timer running under
  // its own id (because we didn't know its originatorId yet), cancel it - it now belongs
  // to a shared group, which gets its own timer.
  cancelTimer(conversationSpaceId);
    scheduleFinalize(originatorId);
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
function recordTranscript(conversationSpaceId, recordingId, transcript) {
    const leg = getOrCreateLeg(conversationSpaceId);
    leg.recordingId = recordingId;
    leg.transcript = transcript;
    scheduleFinalize(groupKeyFor(conversationSpaceId));
}

// Attaches a Google Drive archival link for this leg's recording (see
// server.js handleRecording -> driveClient.uploadRecording, added 2026-07-20), and
// (re)starts the interaction's quiet-period timer the same way recordTranscript does.
// Kept as its own entry point (rather than folded into recordTranscript) since the Drive
// upload and the transcript fetch are two independent async operations that can finish
// in either order.
function recordRecordingLink(conversationSpaceId, recordingId, driveLink) {
    if (!conversationSpaceId) return;
    const leg = getOrCreateLeg(conversationSpaceId);
    leg.recordingId = leg.recordingId || recordingId;
    leg.driveLink = driveLink;
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

function scheduleFinalize(groupKey) {
    cancelTimer(groupKey);
    const timer = setTimeout(() => {
          closeTimers.delete(groupKey);
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

// Assembles the finished interaction, summarizes it with OpenAI (src/openaiClient.js),
// and posts that summary + Drive link(s) to Heymarket as a private note
// (src/heymarketClient.js). Both steps are wrapped in their own try/catch and never
// throw out of this function - a summarization or Heymarket outage should never crash
// the webhook handler or block cleanup of this interaction's in-memory state below.
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
    const callCreated = legRecords.map((l) => l.callCreated).filter(Boolean).sort()[0];
    const callEnded = legRecords.map((l) => l.callEnded).filter(Boolean).sort().slice(-1)[0];
    const recordingLinks = legRecords.filter((l) => l.driveLink).map((l) => l.driveLink);

  const summary = {
        groupKey,
        legCount: legRecords.length,
        externalNumber,
        externalName,
        csrPath,
        callCreated,
        callEnded,
        transcriptsAttached: legRecords.filter((l) => l.transcript).length,
        recordingLinks,
  };

  console.log('INTERACTION READY FOR SUMMARY:', JSON.stringify(summary, null, 2));

  try {
        const summaryText = await openaiClient.summarizeInteraction({
                legRecords,
                csrPath,
                externalName,
                externalNumber,
                callCreated,
                callEnded,
        });

      const noteLines = [summaryText];
        if (recordingLinks.length) {
                noteLines.push('', `Recording: ${recordingLinks.join(', ')}`);
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

  // Clean up now that this interaction is closed.
  for (const id of conversationSpaceIds) {
        legs.delete(id);
        originatorForConversation.delete(id);
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
