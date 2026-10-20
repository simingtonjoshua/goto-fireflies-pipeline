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
// (e.g. "Rancho Cordova / East Elk Grove (RC)") as if it were the customer's name.
// It's now labeled "Phone number" first, with "Caller ID" only shown as a separate
// line, and only for inbound calls (outbound caller-ID metadata describes us, not the
// customer).
// - "CSR(s)" relabeled "Team Member(s)".
// - Folder/file naming now uses a YYYY-MM-DD date (driveClient.formatDateForFilename)
// instead of "Jul 21, 2026" so files sort and scan correctly in a file listing.
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
// to produce a transcript (state.transcripts[].id - server.js now forwards these as
// expectedTranscriptIds). recordLegState() tracks these per leg as
// pendingTranscriptIds, and recordTranscript() clears an id from that set once its
// transcript actually arrives. The finalize timer, when it fires, now checks
// stillWaitingOnTranscript() first: if a leg in the group still has a pending
// transcript id AND we're within FINALIZE_MAX_WAIT_MS (3 minutes) of that leg's
// callEnded, it just re-arms the same 45s timer instead of finalizing - so a normal,
// fast call still posts quickly, and only a call with a genuinely slow transcript
// waits longer. Past the 3-minute backstop, it gives up waiting and finalizes
// without the transcript, same as the original behavior, so a transcript that never
// arrives (or arrives absurdly late) can't hang an interaction forever.
// 2) As a safety net for that rare backstop-exceeded case (or any other late arrival
// after an interaction has already been finalized and cleaned up):
// recentlyFinalizedConversationSpaceIds tracks conversationSpaceIds that were just
// finalized. recordTranscript() and recordRecordingLink() check this before creating
// a new leg - if the conversationSpaceId was recently finalized and has no live leg,
// they log it and drop the late data instead of silently building a phantom
// duplicate interaction with missing customer info.
//
// DUPLICATE-LEG FIX (added 2026-07-21, found via multiple real calls - e.g. a booking
// call to 916-846-4771 and several other calls the same morning): a single real phone
// call sometimes arrives from GoTo as TWO (or more) separate conversationSpaceIds
// instead of one - e.g. one leg carries the real participants/recording/transcript,
// while a second, mostly-empty leg (no participants, "unknown number") is ALSO opened
// and closed by GoTo for what is the same physical call. These are supposed to merge
// into one interaction via Call History's originatorId (see the top-of-file note on
// that), but that correlation doesn't always arrive before one leg's own 45s quiet
// period elapses and it finalizes on its own - so BOTH legs end up posting their own
// separate Heymarket private note to the same customer, each with its own (sometimes
// different) recording link, and the second one - built from less/garbled context - is
// often misclassified.
//
// Root-causing exactly why GoTo splits an ordinary call into two conversationSpaceIds
// is still open, but regardless of the cause, two real customer-facing Heymarket notes
// for one phone call is a worse failure mode than one. So this adds a safety net at the
// point where it matters most: before posting to Heymarket, finalizeInteraction() checks
// whether ANOTHER interaction for the SAME external phone number was already finalized
// within the last DUPLICATE_CALL_SUPPRESS_MS (3 minutes, matching FINALIZE_MAX_WAIT_MS's
// backstop window). If so, this is treated as a duplicate leg of that same call: the
// transcript Doc still gets created (so no data is silently lost), but the Heymarket
// post is skipped and logged instead of double-messaging the customer. A genuine second
// call from the same customer minutes later (e.g. the callback-to-clarify-a-detail
// pattern seen on 916-846-4771, ~8 minutes after the original call) still posts
// normally, since that's well outside this window.
//
// Also closed a related gap: recordLegState() (unlike recordTranscript/
// recordRecordingLink) had no guard against a late/re-ordered call-state event for a
// conversationSpaceId that was already finalized and cleaned up - it would silently
// spin up a brand-new near-empty leg and finalize it a second time under the same id.
// It now checks wasRecentlyFinalized() the same way the other two functions do.
//
// HEYMARKET AUTHOR NAME (added 2026-07-23, per Joshua): the private note's author is
// now direction-aware ("Inbound Call Summary" / "Outbound Call Summary" instead of a
// generic "Call Summary") - see heymarketClient.postPrivateNote's new `direction`
// parameter. finalizeInteraction() already computes `direction` for the OpenAI context
// above, so this just threads that same value through to the Heymarket call below too.
//
// DUPLICATE-LEG DEDUP FALSE POSITIVE FIX (added 2026-07-23, found on a real call,
// 916-216-5726, per Joshua): the DUPLICATE-LEG FIX above (see that note for the
// original problem it solves) suppressed a Heymarket post that should NOT have been
// suppressed. What actually happened: the customer's first call attempt connected for
// only ~1.2 seconds (STARTING at 18:20:54.726Z, ENDING at 18:20:55.951Z) - genuinely no
// time for any conversation, so it correctly finalized as "no transcript available" and
// posted that accurate note. The customer then immediately redialed; THIS call
// connected properly and ran a full ~79-second conversation (Joyce Mills, a blinds
// issue, an appointment scheduled) - a completely different, genuine call, not another
// leg of the first one. But it finalized only ~98 seconds after the first call's own
// finalize, which was well within DUPLICATE_CALL_SUPPRESS_MS's flat 3-minute window, so
// the old check - "was ANY interaction for this number finalized within the last 3
// minutes" - wrongly treated it as a duplicate leg and skipped its Heymarket post
// entirely (the transcript Doc still got created, so the real conversation wasn't lost,
// just never posted).
//
// The old check never actually looked at whether the two calls' own time ranges
// overlap - which is the real signature of the ORIGINAL problem this dedup exists for
// (GoTo splitting one physical call into two conversationSpaceIds: both legs cover
// virtually the same start/end window, since they're the same call). A genuine second
// call - even an immediate redial seconds later - starts only once the first call has
// actually ended, so its time range never overlaps the first's. recentlyFinalizedBy
// ExternalNumber now also remembers each finalized call's own callCreated/callEnded,
// and timeRangesOverlap() below checks that the two calls' windows actually intersect
// (with a small clock-skew margin) before suppressing - a flat "recently finalized"
// timestamp proximity is no longer enough on its own. If either call is missing a
// timestamp to compare, this still falls back to suppressing (the original, safer
// default), so unknown cases don't regress to double-posting.

const openaiClient = require('./openaiClient');
const heymarketClient = require('./heymarketClient');
const driveClient = require('./driveClient');
const sheetsClient = require('./sheetsClient');
const callParties = require('./callParties');
const roster = require('./roster');
const cardRedact = require('./cardRedact');
const gotoClient = require('./gotoClient');

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

// How long after finalizing an interaction for a given external phone number we'll
// treat ANOTHER interaction finalizing for that SAME number as a duplicate leg of the
// same call rather than a genuine new call (see DUPLICATE-LEG FIX above). Matches
// FINALIZE_MAX_WAIT_MS since that's the longest a real leg of one call should ever take
// to show up and finalize.
const DUPLICATE_CALL_SUPPRESS_MS = 3 * 60 * 1000;

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

// normalized external phone number (digits only) -> { finalizedAtMs, groupKey,
// callCreated, callEnded, direction } (see DUPLICATE-LEG FIX above; callCreated/callEnded added
// per the DUPLICATE-LEG DEDUP FALSE POSITIVE FIX above, so a later call can check
// whether its own time range actually overlaps this one before treating it as a
// duplicate leg). direction is compared too: an inbound call and an outbound call
// to the same number are not the same leg.
const recentlyFinalizedByExternalNumber = new Map();

// Call-history events that arrived before any call-state leg was known. Replayed
// once the leg id or originator id shows up. Dropped after 10 minutes so a stale
// event cannot attach to a later, different call.
const pendingHistory = [];
const PENDING_HISTORY_TTL_MS = 10 * 60 * 1000;

let onFinalized = () => {};
let audioUploader = null;
// Tests inject this. Production uses GET /call-events-report/v1/reports/{id}.
let callReportFetcher = null;

function setOnFinalized(fn) {
            onFinalized = typeof fn === 'function' ? fn : () => {};
}

function getOrCreateLeg(conversationSpaceId) {
            let leg = legs.get(conversationSpaceId);
            if (!leg) {
                          leg = { csrChain: [], transcript: null, recordingId: null, pendingTranscriptIds: new Set() };
                          legs.set(conversationSpaceId, leg);
            }
            return leg;
}

function orderedChain(chain) {
            return [...(chain || [])].sort((a, b) => String(a.enteredAt || '').localeCompare(String(b.enteredAt || '')));
}

// Inbound: only someone GoTo shows as answered (CONNECTED / answerTime). Outbound:
// the person who placed the call, even if the far end never picked up.
function noteTeamSource(leg, source) {
            if (!source || leg.teamMemberSource) return;
            leg.teamMemberSource = source;
}

function considerTeamMember(leg, member, { requireAnswered, source }) {
            if (!member || member.isSystem) return;
            if (requireAnswered && !member.answered && !member.connected) return;
            const extension = member.extension || null;
            const name = member.name || null;
            if (!name && !extension) return;
            const existing = (leg.csrChain || []).find((entry) => (
                          (member.userKey && entry.userKey === member.userKey)
                          || (extension && entry.extension === extension)
            ));
            const answered = Boolean(member.answered || member.connected);
            if (existing) {
                          if (name && (!existing.name || existing.name === 'unknown')) existing.name = name;
                          if (answered) existing.answered = true;
                          if (member.answerTime && !existing.enteredAt) existing.enteredAt = member.answerTime;
                          noteTeamSource(leg, source);
                          return;
            }
            leg.csrChain.push({
                          name,
                          extension,
                          userKey: member.userKey || null,
                          answered,
                          enteredAt: member.answerTime || new Date().toISOString(),
            });
            noteTeamSource(leg, source);
}

function lineSource(line) {
            if (!line) return null;
            if (line.matchedBy === 'userKey') return 'roster userKey';
            if (line.isOriginator) return 'STARTING originator';
            return null;
}

function applyLines(leg, lines, direction) {
            for (const line of lines || []) {
                          const inbound = direction !== 'OUTBOUND';
                          const source = lineSource(line);
                          considerTeamMember(leg, line, { requireAnswered: inbound ? true : !(line.isOriginator || line.connected), source });
                          // Outbound originator counts even while their line is still RINGING.
                          if (!inbound && (line.isOriginator || line.connected)) {
                                          considerTeamMember(leg, line, { requireAnswered: false, source });
                          }
                          if (line.legId) {
                                          leg.extraLegIds = leg.extraLegIds || new Set();
                                          leg.extraLegIds.add(line.legId);
                                          legIdToConversation.set(line.legId, leg.conversationSpaceId);
                          }
            }
}

function setDirection(leg, direction, source) {
            if (direction !== 'INBOUND' && direction !== 'OUTBOUND') return;
            // metadata.direction is authoritative when GoTo sent it. A later history
            // leg must not flip it. History can only fill a missing direction.
            if (source === 'metadata') {
                          leg.direction = direction;
                          leg.directionSource = 'metadata';
                          return;
            }
            if (!leg.direction) {
                          leg.direction = direction;
                          leg.directionSource = source;
            }
}

function rememberCallerNumber(leg, number) {
            if (!leg || !number) return;
            const book = roster.getRoster();
            if (book.isSystemNumber(number) || book.extensionFrom(number)) return;
            if (!roster.last10(number)) return;
            leg.callerNumbers = leg.callerNumbers || [];
            if (leg.callerNumbers.some((existing) => callParties.sameCustomer(existing, number))) return;
            leg.callerNumbers.push(number);
}

function setExternalNumber(leg, number, options = {}) {
            if (options.caller) rememberCallerNumber(leg, number);
            if (!number) return;
            const book = roster.getRoster();
            if (book.isSystemNumber(number) || book.extensionFrom(number)) return;
            const next = callParties.sameCustomer(leg.externalNumber, number);
            if (leg.externalNumber && !next) {
                          leg.externalConflict = true;
                          console.log(`REVIEW: conversation ${leg.conversationSpaceId} reported a second customer number. Keeping the first and not posting to the other one.`);
                          return;
            }
            if (!leg.externalNumber) leg.externalNumber = number;
}

function historySource(teamMember) {
            if (!teamMember) return null;
            if (teamMember.matchedBy === 'userKey') return 'roster userKey';
            return 'call history';
}

function applyHistory(leg, analysis, options = {}) {
            const direction = leg.direction || analysis.legDirection;
            if (analysis.teamMember) {
                          considerTeamMember(leg, {
                                          name: analysis.teamMember.name,
                                          extension: analysis.teamMember.extension,
                                          userKey: analysis.teamMember.userKey,
                                          answered: analysis.answered,
                                          connected: analysis.answered,
                                          answerTime: analysis.answerTime,
                          }, { requireAnswered: direction !== 'OUTBOUND', source: historySource(analysis.teamMember) });
            }
            setDirection(leg, analysis.legDirection, 'history');
            const inboundCaller = analysis.legDirection === 'INBOUND';
            if (options.setNumber === false) {
                          if (inboundCaller) rememberCallerNumber(leg, analysis.externalNumber);
            } else {
                          setExternalNumber(leg, analysis.externalNumber, { caller: inboundCaller });
            }
            if (!leg.externalName && analysis.externalName) leg.externalName = analysis.externalName;
            if (analysis.answered) {
                          leg.sawAnswer = true;
                          leg.explicitlyUnanswered = false;
                          if (leg.direction === 'OUTBOUND' || analysis.legDirection === 'OUTBOUND') leg.customerAnswered = true;
            } else if (analysis.explicitlyUnanswered && !leg.sawAnswer && !leg.customerAnswered) {
                          leg.explicitlyUnanswered = true;
            }
            if (analysis.legId) {
                          leg.extraLegIds = leg.extraLegIds || new Set();
                          leg.extraLegIds.add(analysis.legId);
                          legIdToConversation.set(analysis.legId, leg.conversationSpaceId);
            }
}

function parkHistory(content) {
            const cutoff = Date.now() - PENDING_HISTORY_TTL_MS;
            while (pendingHistory.length && pendingHistory[0].receivedAt < cutoff) pendingHistory.shift();
            pendingHistory.push({ content, receivedAt: Date.now() });
}

function flushPendingHistory(conversationSpaceId) {
            const leg = legs.get(conversationSpaceId);
            if (!leg) return;
            const kept = [];
            for (const item of pendingHistory) {
                          if (Date.now() - item.receivedAt > PENDING_HISTORY_TTL_MS) continue;
                          const analysis = callParties.analyzeCallHistory(item.content, roster.getRoster());
                          const legMatch = analysis.legId && (analysis.legId === leg.legId || (leg.extraLegIds && leg.extraLegIds.has(analysis.legId)));
                          const originator = originatorForConversation.get(conversationSpaceId);
                          const originMatch = analysis.originatorId && originator && analysis.originatorId === originator;
                          const numberMatch = historyMatchesLegByNumber(leg, analysis);
                          const recovery = !legMatch && !originMatch && !numberMatch
                            && matchingNumberlessInboundIds(analysis).length === 1
                            && matchingNumberlessInboundIds(analysis)[0] === conversationSpaceId;
                          if (!legMatch && !originMatch && !numberMatch && !recovery) {
                                          kept.push(item);
                                          continue;
                          }
                          if (recovery) {
                                          applyHistory(leg, analysis, { setNumber: false });
                                          continue;
                          }
                          if (analysis.externalNumber && leg.externalNumber && !callParties.sameCustomer(leg.externalNumber, analysis.externalNumber)) {
                                          if (analysis.legDirection === 'INBOUND') rememberCallerNumber(leg, analysis.externalNumber);
                                          console.log(`REVIEW: parked call history does not match conversation ${conversationSpaceId}. Leaving it unmatched.`);
                                          kept.push(item);
                                          continue;
                          }
                          applyHistory(leg, analysis);
            }
            pendingHistory.length = 0;
            pendingHistory.push(...kept);
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

// Digits-only phone number, used as the dedup key in recentlyFinalizedByExternalNumber
// (see DUPLICATE-LEG FIX above). Returns null for an empty/unknown number so callers
// never accidentally treat "no number" as a shared key across unrelated calls.
function normalizeNumberForDedup(phoneNumber) {
            const digits = (phoneNumber || '').replace(/\D/g, '');
            return digits || null;
}

// True if two calls' own time ranges actually intersect (see the DUPLICATE-LEG DEDUP
// FALSE POSITIVE FIX header comment above) - the real signature of GoTo splitting one
// physical call into two conversationSpaceIds, since both legs cover virtually the same
// start/end window. A genuine second call - even an immediate callback seconds later -
// only starts once the first call has actually ended, so its window never overlaps the
// first's. `marginMs` gives a little slack for clock skew/rounding between the two
// legs' own timestamps, not for genuinely separate back-to-back calls. Falls back to
// treating the calls as overlapping (the original, safer default before this fix) if
// either call is missing a timestamp to compare, so an unknown case still suppresses
// rather than risking a real duplicate double-post.
const OVERLAP_MARGIN_MS = 5 * 1000;
function timeRangesOverlap(a, b) {
            const aStart = a.callCreated ? new Date(a.callCreated).getTime() : null;
            const aEnd = a.callEnded ? new Date(a.callEnded).getTime() : null;
            const bStart = b.callCreated ? new Date(b.callCreated).getTime() : null;
            const bEnd = b.callEnded ? new Date(b.callEnded).getTime() : null;
            if (aStart == null || aEnd == null || bStart == null || bEnd == null) return true;
            return bStart < aEnd + OVERLAP_MARGIN_MS && aStart < bEnd + OVERLAP_MARGIN_MS;
}

// Call this from trackCallState() for every call-state event, in addition to (not
// instead of) the existing conversationMetadata bookkeeping in server.js. Captures the
// ordered chain of internal parties (team members) rather than overwriting - a transfer
// test on 2026-07-20 showed the previous last-write-wins approach silently lost the
// first team member once the call was handed to a second one.
//
// Guards against a late/re-ordered call-state event for an already-finalized
// conversationSpaceId (see DUPLICATE-LEG FIX above) the same way recordTranscript/
// recordRecordingLink already do - without this, a stray event arriving after cleanup
// would silently spin up a brand-new, mostly-empty leg and finalize it a second time.
function indexLegId(leg, conversationSpaceId, id) {
            if (!id) return;
            leg.extraLegIds = leg.extraLegIds || new Set();
            leg.extraLegIds.add(id);
            legIdToConversation.set(id, conversationSpaceId);
}

function recordLegState(conversationSpaceId, {
            legId, lines, participantLegIds, recordingOwners, externalConnected, externalName, externalNumber,
            originatorNumber, direction, directionSource, dialString, callCreated, callEnded, accountKey,
            callIdVersion, expectedTranscriptIds,
}) {
            if (!legs.has(conversationSpaceId) && wasRecentlyFinalized(conversationSpaceId)) {
                          console.log(
                                          `Call-state event for conversationSpaceId=${conversationSpaceId} arrived after it was already finalized - dropping instead of creating a duplicate interaction.`
                                        );
                          return;
            }
            const leg = getOrCreateLeg(conversationSpaceId);
            leg.conversationSpaceId = conversationSpaceId;
            // A reused conversation id with a different callCreated is a new call.
            // Drop the previous number and team member instead of posting this call
            // onto the earlier customer's thread.
            if (callCreated && leg.callCreated && callCreated !== leg.callCreated) {
                          console.log(`REVIEW: conversation ${conversationSpaceId} started a new call. Not keeping the previous call's number or team member.`);
                          if (leg.legId) legIdToConversation.delete(leg.legId);
                          for (const extra of leg.extraLegIds || []) legIdToConversation.delete(extra);
                          leg.legId = null;
                          leg.extraLegIds = new Set();
                          leg.externalNumber = null;
                          leg.externalName = null;
                          leg.externalConflict = false;
                          leg.csrChain = [];
                          leg.customerAnswered = false;
                          leg.explicitlyUnanswered = false;
                          leg.sawAnswer = false;
                          leg.teamMemberSource = null;
                          leg.dialString = null;
                          leg.direction = null;
                          leg.directionSource = null;
                          leg.suppressPost = false;
            }
            if (legId) {
                          leg.legId = legId;
                          legIdToConversation.set(legId, conversationSpaceId);
            }
            for (const id of participantLegIds || []) indexLegId(leg, conversationSpaceId, id);
            setDirection(leg, direction, directionSource || 'metadata');
            setExternalNumber(leg, externalNumber);
            if (originatorNumber && leg.direction === 'INBOUND') rememberCallerNumber(leg, originatorNumber);
            if (externalName && !leg.externalName) leg.externalName = externalName;
            if (dialString) leg.dialString = dialString;
            if (callCreated) leg.callCreated = callCreated;
            if (accountKey) leg.accountKey = accountKey;
            if (callIdVersion) leg.callIdVersion = callIdVersion;
            if (recordingOwners) {
                          leg.recordingOwners = { ...(leg.recordingOwners || {}), ...recordingOwners };
            }
            if (externalConnected && leg.direction === 'OUTBOUND') leg.customerAnswered = true;
            applyLines(leg, lines, leg.direction);
            flushPendingHistory(conversationSpaceId);

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
let loggedHistoryShape = false;

function historyBody(payload) {
            const content = payload?.content || {};
            if (content.originatorId || content.legId) return content;
            if (content.item && (content.item.originatorId || content.item.legId)) return content.item;
            if (Array.isArray(content.items)) {
                          const item = content.items.find((entry) => entry && (entry.originatorId || entry.legId));
                          if (item) return item;
            }
            return content;
}

// Inbound STARTING often never lists the extension that picked up, so that
// history legId is not in the call-state index. One open leg with the same
// customer number is still the same call. Two open legs is not a guess.
function historyMatchesLegByNumber(leg, analysis) {
            if (!analysis.externalNumber || !leg || !leg.externalNumber) return false;
            if (!callParties.sameCustomer(leg.externalNumber, analysis.externalNumber)) return false;
            if (leg.direction && analysis.legDirection && leg.direction !== analysis.legDirection) return false;
            return true;
}

const INBOUND_CALLER_MATCH_MS = 3 * 60 * 1000;

function historyStartMs(analysis) {
            if (!analysis || !analysis.startTime) return null;
            const ms = new Date(analysis.startTime).getTime();
            return Number.isFinite(ms) ? ms : null;
}

// null when the history event has no start time to compare. false when it is a
// different call. true when it falls in this leg's window.
function legWindowMatchesHistory(leg, analysis) {
            const startMs = historyStartMs(analysis);
            if (startMs == null || !leg || !leg.callCreated) return null;
            const created = new Date(leg.callCreated).getTime();
            if (!Number.isFinite(created)) return null;
            const ended = leg.callEnded ? new Date(leg.callEnded).getTime() : null;
            if (ended != null && startMs >= created - 5000 && startMs <= ended + 60 * 1000) return true;
            return Math.abs(startMs - created) <= INBOUND_CALLER_MATCH_MS;
}

function matchingNumberlessInboundIds(analysis) {
            if (!analysis || analysis.legDirection !== 'INBOUND' || !analysis.externalNumber) return [];
            const ids = [];
            for (const [id, leg] of legs) {
                          if (!leg || leg.externalNumber) continue;
                          if (leg.direction && leg.direction !== 'INBOUND') continue;
                          if (legWindowMatchesHistory(leg, analysis) === false) continue;
                          ids.push(id);
            }
            return ids;
}

function findConversationForHistory(analysis) {
            if (analysis.legId && legIdToConversation.has(analysis.legId)) {
                          return { id: legIdToConversation.get(analysis.legId), join: 'legId' };
            }
            if (analysis.conversationSpaceId && legs.has(analysis.conversationSpaceId)) {
                          return { id: analysis.conversationSpaceId, join: 'conversationSpaceId' };
            }
            if (analysis.originatorId) {
                          const known = conversationsForOriginator.get(analysis.originatorId);
                          if (known) {
                                          const id = [...known].find((candidate) => legs.has(candidate));
                                          if (id) return { id, join: 'originator' };
                          }
            }
            if (analysis.externalNumber) {
                          const candidates = [];
                          for (const [id, leg] of legs) {
                                          if (historyMatchesLegByNumber(leg, analysis)) candidates.push(id);
                          }
                          if (candidates.length === 1) return { id: candidates[0], join: 'customer-number' };
            }
            const recovered = matchingNumberlessInboundIds(analysis);
            if (recovered.length === 1) return { id: recovered[0], join: 'inbound-recovery' };
            return { id: null, join: 'none' };
}

function recordCallHistoryEvent(payload) {
            const content = historyBody(payload);
            const { originatorId, legId } = content;
            if (!originatorId) return;
            if (!loggedHistoryShape) {
                          loggedHistoryShape = true;
                          console.log(`Call history content fields: ${Object.keys(content).join(',')}`);
            }

            const analysis = callParties.analyzeCallHistory(content, roster.getRoster());
            const found = findConversationForHistory(analysis);
            const conversationSpaceId = found.id;
            const join = found.join;

            console.log(
                          `Call History event: legId=${legId} originatorId=${originatorId} answered=${analysis.answered} extension=${analysis.teamMember?.extension || 'none'} join=${join}` +
                          (conversationSpaceId ? ` -> conversationSpaceId=${conversationSpaceId}` : ' (no matching conversationSpaceId seen yet)')
                        );

            if (!conversationSpaceId) {
                          parkHistory(content);
                          return;
            }

            const leg = getOrCreateLeg(conversationSpaceId);
            leg.conversationSpaceId = conversationSpaceId;
            if (analysis.externalNumber && leg.externalNumber && !callParties.sameCustomer(leg.externalNumber, analysis.externalNumber)) {
                          if (analysis.legDirection === 'INBOUND') rememberCallerNumber(leg, analysis.externalNumber);
                          console.log(`REVIEW: call history for originator ${originatorId} does not match conversation ${conversationSpaceId}. Not attaching it and not reusing that number.`);
                          return;
            }
            if (join === 'inbound-recovery') {
                          console.log(`Inbound caller recovered from call history for conversation ${conversationSpaceId} (no call-state number).`);
                          applyHistory(leg, analysis, { setNumber: false });
            } else {
                          applyHistory(leg, analysis);
            }
            linkConversationToOriginator(conversationSpaceId, originatorId);
            flushPendingHistory(conversationSpaceId);
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
            const redacted = cardRedact.redactTranscript(transcript);
            const leg = getOrCreateLeg(conversationSpaceId);
            leg.recordingId = recordingId;
            leg.transcriptReceived = true;
            leg.cardMasked = redacted.masked;
            leg.cardReview = false;
            leg.cardFlagged = redacted.masked;
            leg.transcript = redacted.transcript;
            if (redacted.masked) console.log(`Card data masked on conversation ${conversationSpaceId}.`);
            leg.pendingTranscriptIds.delete(recordingId);
            const groupKey = groupKeyFor(conversationSpaceId);
            scheduleFinalize(groupKey);
            const flagged = groupIsCardFlagged(conversationSpaceId);
            const releaseIds = flagged ? [...conversationSpaceIdsFor(groupKey)] : [conversationSpaceId];
            releaseHeldAudio(releaseIds, flagged).catch((err) =>
                          console.error(`Error releasing held audio for ${conversationSpaceId}:`, err)
                        );
}

// Attaches a Google Drive archival link (and per-call subfolder info, added 2026-07-21)
// for this leg's recording (see server.js handleRecording -> driveClient.uploadRecording),
// and (re)starts the interaction's quiet-period timer the same way recordTranscript
// does. Kept as its own entry point (rather than folded into recordTranscript) since the
// Drive upload and the transcript fetch are two independent async operations that can
// finish in either order.
//
// Same late-arrival guard as recordTranscript() (see SLOW-TRANSCRIPT FIX above).
function recordRecordingLink(conversationSpaceId, recordingId, driveLink, folder, options) {
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
            if (!options || options.schedule !== false) scheduleFinalize(groupKeyFor(conversationSpaceId));
}

function setAudioUploader(fn) {
            audioUploader = typeof fn === 'function' ? fn : null;
}

function groupIsCardFlagged(conversationSpaceId) {
            if (!conversationSpaceId) return false;
            for (const id of conversationSpaceIdsFor(groupKeyFor(conversationSpaceId))) {
                          const leg = legs.get(id);
                          if (leg && leg.cardFlagged) return true;
            }
            return false;
}

function isCardFlagged(conversationSpaceId) {
            return groupIsCardFlagged(conversationSpaceId);
}

// 'archive' uploads now. 'hold' keeps the bytes until the transcript has been checked.
// 'skip' means this call was flagged (real card data was masked) and the audio must not be stored.
function audioArchiveDecision(conversationSpaceId) {
            if (!conversationSpaceId) return 'archive';
            if (groupIsCardFlagged(conversationSpaceId)) return 'skip';
            const leg = legs.get(conversationSpaceId);
            if (!leg || !leg.transcriptReceived) return 'hold';
            return 'archive';
}

function holdRecordingAudio(conversationSpaceId, pending) {
            if (!conversationSpaceId || !pending) return;
            if (!legs.has(conversationSpaceId) && wasRecentlyFinalized(conversationSpaceId)) {
                          console.log(
                                          `Recording ${pending.recordingId} arrived for conversationSpaceId=${conversationSpaceId} after it was already finalized - dropping instead of creating a duplicate interaction.`
                                        );
                          return;
            }
            const leg = getOrCreateLeg(conversationSpaceId);
            if (!leg.pendingAudio) leg.pendingAudio = [];
            leg.pendingAudio.push(pending);
            leg.recordingId = leg.recordingId || pending.recordingId;
            scheduleFinalize(groupKeyFor(conversationSpaceId));
}

async function releaseHeldAudio(conversationSpaceIds, flagged) {
            const pending = [];
            for (const id of conversationSpaceIds || []) {
                          const leg = legs.get(id);
                          if (!leg || !leg.pendingAudio) continue;
                          const held = Array.isArray(leg.pendingAudio) ? leg.pendingAudio : [leg.pendingAudio];
                          leg.pendingAudio = null;
                          if (flagged || leg.cardFlagged) {
                                          for (const audio of held) {
                                                          console.log(`Skipping Drive audio archive for recording ${audio.recordingId}: call flagged for card data.`);
                                          }
                          } else {
                                          pending.push(...held);
                          }
            }
            for (const audio of pending) {
                          if (audioUploader) await audioUploader(audio);
            }
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

function legIsSubstantive(leg) {
            if (leg && leg.cardFlagged) return true;
            return callParties.transcriptIsSubstantive(leg && leg.transcript, roster.getRoster());
}

function legIsFragment(leg) {
            if (!leg || !legIsSubstantive(leg) || leg.cardFlagged) return false;
            return callParties.callIsFragment(leg, roster.getRoster());
}

function clearLegIndex(leg) {
            if (!leg) return;
            if (leg.legId) legIdToConversation.delete(leg.legId);
            for (const extra of leg.extraLegIds || []) legIdToConversation.delete(extra);
}

function pendingCallerNumbersFor(legRecords) {
            const found = [];
            const inGroup = new Set((legRecords || []).map((leg) => leg.conversationSpaceId));
            for (const item of pendingHistory) {
                          const analysis = callParties.analyzeCallHistory(item.content, roster.getRoster());
                          if (analysis.legDirection !== 'INBOUND' || !analysis.externalNumber) continue;
                          const matched = (legRecords || []).filter((leg) => {
                                          if (leg.direction && leg.direction !== 'INBOUND') return false;
                                          return legWindowMatchesHistory(leg, analysis) !== false;
                          });
                          if (matched.length !== 1) continue;
                          const others = matchingNumberlessInboundIds(analysis).filter((id) => !inGroup.has(id));
                          if (others.length) continue;
                          found.push(analysis.externalNumber);
            }
            return found;
}

function describeGroup(groupKey) {
            const conversationSpaceIds = [...conversationSpaceIdsFor(groupKey)];
            const legRecords = conversationSpaceIds
              .map((id) => {
                            const leg = { ...(legs.get(id) || {}) };
                            delete leg.pendingAudio;
                            return { conversationSpaceId: id, ...leg };
              })
              .filter((leg) => leg.legId || leg.transcript || leg.externalNumber || (leg.csrChain && leg.csrChain.length));

            const csrChain = [];
            for (const entry of orderedChain(legRecords.flatMap((leg) => leg.csrChain || []))) {
                          const last = csrChain[csrChain.length - 1];
                          const sameExtension = last && entry.extension && last.extension === entry.extension;
                          const sameUnnumbered = last && !entry.extension && !last.extension && entry.name && entry.name === last.name;
                          if (!sameExtension && !sameUnnumbered) csrChain.push(entry);
            }

            const numbers = callParties.uniqueExternalNumbers(legRecords.map((leg) => leg.externalNumber));
            let externalConflict = legRecords.some((leg) => leg.externalConflict) || numbers.length > 1;
            const direction = legRecords.find((leg) => leg.direction)?.direction || null;
            const callCreated = legRecords.map((leg) => leg.callCreated).filter(Boolean).sort()[0];
            const callEnded = legRecords.map((leg) => leg.callEnded).filter(Boolean).sort().slice(-1)[0];
            const explicitYes = direction === 'OUTBOUND'
              ? legRecords.some((leg) => leg.customerAnswered)
              : Boolean(direction === 'INBOUND' && csrChain.some((entry) => entry.answered && (entry.name || entry.extension)));
            const explicitNo = !explicitYes && legRecords.some((leg) => leg.explicitlyUnanswered);
            // No answer field and no CONNECTED party is unknown, not "the call was not answered".
            const answered = explicitYes ? true : (explicitNo ? false : null);
            const hasTranscript = legRecords.some((leg) => {
                          const transcript = leg.transcript;
                          if (!transcript) return false;
                          if (typeof transcript === 'string') return transcript.trim().length > 0;
                          return true;
            });

            let externalNumber = externalConflict ? null : (numbers[0] || null);
            const substantive = legRecords.some((leg) => legIsSubstantive(leg));
            // A direct DID or forwarded inbound often has no call-state caller.
            // Call history and the STARTING originator still carried it. Post that
            // number for a real conversation instead of leaving the note unsent.
            // A greeting with no conversation keeps the missing-number review.
            if (direction === 'INBOUND' && substantive) {
                          const recovered = callParties.uniqueExternalNumbers(
                            legRecords.flatMap((leg) => leg.callerNumbers || []).concat(pendingCallerNumbersFor(legRecords)),
                          );
                          if (recovered.length === 1 && (!externalNumber || externalConflict)) {
                                          console.log(
                                            `Inbound caller recovered for ${groupKey}: ${recovered[0]} `
                                            + `(call-state ${externalConflict ? 'conflicted' : 'had no number'}).`,
                                          );
                                          externalNumber = recovered[0];
                                          externalConflict = false;
                          }
            }

            return {
                          conversationSpaceIds,
                          legRecords,
                          csrChain,
                          csrPath: csrChain.map((entry) => roster.formatTeamMember(entry)),
                          externalNumber,
                          externalConflict,
                          externalName: legRecords.find((leg) => leg.externalName)?.externalName,
                          direction,
                          callCreated,
                          callEnded,
                          substantive: legRecords.some((leg) => legIsSubstantive(leg)),
                          fragment: legRecords.some((leg) => legIsSubstantive(leg))
                            && legRecords.filter((leg) => legIsSubstantive(leg)).every((leg) => legIsFragment(leg)),
                          hasTranscript,
                          hasRecording: legRecords.some((leg) => leg.driveLink || leg.recordingId),
                          suppressPost: legRecords.some((leg) => leg.suppressPost),
                          skipArtifacts: legRecords.some((leg) => leg.skipArtifacts),
                          teamMemberSource: csrChain.length
                            ? (legRecords.map((leg) => leg.teamMemberSource).find(Boolean) || 'none')
                            : 'none',
                          answered,
            };
}

function siblingSnapshots(groupKey) {
            const byGroup = new Map();
            for (const [id, leg] of legs) {
                          const key = groupKeyFor(id);
                          if (key === groupKey) continue;
                          if (!byGroup.has(key)) byGroup.set(key, { groupKey: key, substantive: false });
                          const snap = byGroup.get(key);
                          if (!snap.externalNumber && leg.externalNumber) snap.externalNumber = leg.externalNumber;
                          if (!snap.direction && leg.direction) snap.direction = leg.direction;
                          if (!snap.callCreated && leg.callCreated) snap.callCreated = leg.callCreated;
                          if (leg.callEnded) snap.callEnded = leg.callEnded;
                          if (legIsSubstantive(leg)) {
                                          snap.substantive = true;
                                          if (!legIsFragment(leg)) snap.fragment = false;
                                          else if (snap.fragment !== false) snap.fragment = true;
                          }
                          if (leg.transcript) snap.hasTranscript = true;
                          if (leg.driveLink || leg.recordingId) snap.hasRecording = true;
                          const legAnswered = Boolean(leg.customerAnswered || (leg.csrChain || []).some((entry) => entry.answered));
                          if (legAnswered) snap.answered = true;
                          else if (snap.answered !== true && leg.explicitlyUnanswered) snap.answered = false;
            }
            return [...byGroup.values()];
}

function planForGroup(groupKey, described) {
            if (described.suppressPost) {
                          return {
                                          action: 'suppress',
                                          reason: 'folded into another leg',
                                          skipArtifacts: Boolean(described.skipArtifacts),
                          };
            }
            const normalized = normalizeNumberForDedup(described.externalNumber);
            const prior = normalized ? recentlyFinalizedByExternalNumber.get(normalized) : null;
            const recent = prior
              && prior.groupKey !== groupKey
              && Date.now() - prior.finalizedAtMs < DUPLICATE_CALL_SUPPRESS_MS
              ? prior
              : null;
            return callParties.postingPlan({
                          externalNumber: described.externalNumber,
                          externalConflict: described.externalConflict,
                          direction: described.direction,
                          callCreated: described.callCreated,
                          callEnded: described.callEnded,
                          substantive: described.substantive,
                          fragment: described.fragment,
                          hasTranscript: described.hasTranscript,
                          hasRecording: described.hasRecording,
                          answered: described.answered,
                          openSiblings: siblingSnapshots(groupKey),
                          recent,
            });
}

function markSuppressed(groupKey, options = {}) {
            for (const id of conversationSpaceIdsFor(groupKey)) {
                          const leg = legs.get(id);
                          if (!leg) continue;
                          leg.suppressPost = true;
                          if (options.skipArtifacts) leg.skipArtifacts = true;
            }
}

function rememberFinalizedNumber(groupKey, described) {
            const normalized = normalizeNumberForDedup(described.externalNumber);
            if (!normalized || described.externalConflict) return;
            recentlyFinalizedByExternalNumber.set(normalized, {
                          finalizedAtMs: Date.now(),
                          groupKey,
                          callCreated: described.callCreated,
                          callEnded: described.callEnded,
                          direction: described.direction,
                          externalNumber: described.externalNumber,
                          substantive: described.substantive === true,
                          fragment: described.fragment === true,
            });
}

function cleanupGroup(groupKey, conversationSpaceIds) {
            try {
                          onFinalized(conversationSpaceIds);
            } catch (err) {
                          console.error(`Error running finalize callback for ${groupKey}:`, err);
            }
            for (const id of conversationSpaceIds) {
                          clearLegIndex(legs.get(id));
                          legs.delete(id);
                          originatorForConversation.delete(id);
                          recentlyFinalizedConversationSpaceIds.set(id, Date.now());
            }
            conversationsForOriginator.delete(groupKey);
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
                          const described = describeGroup(groupKey);
                          if (described.legRecords.length) {
                                          const plan = planForGroup(groupKey, described);
                                          if (plan.action === 'hold') {
                                                          console.log(`Interaction held ${groupKey}: ${plan.reason}`);
                                                          scheduleFinalize(groupKey);
                                                          return;
                                          }
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
function isRosterChainEntry(entry, book) {
            if (!entry) return false;
            if (entry.extension && book.personByExtension(entry.extension)) return true;
            if (entry.name && (book.personByName(entry.name) || book.primaryByName(entry.name))) return true;
            return false;
}

function fillMissingExtensions(leg, book) {
            for (const entry of leg.csrChain || []) {
                          if (entry.extension || !entry.name) continue;
                          const person = book.primaryByName(entry.name);
                          if (person && person.extension) entry.extension = person.extension;
            }
}

// A queue, DID, or other non-roster line in csrChain is not an answerer. It used
// to block the transcript fallback while the sheet still showed unknown.
function groupLooksInbound(groupKey) {
            for (const id of conversationSpaceIdsFor(groupKey)) {
                          const leg = legs.get(id);
                          if (leg && leg.direction === 'INBOUND') return true;
            }
            return false;
}

// A queue or agent leg of an inbound call is often tagged OUTBOUND. The doc
// still labels "This is Josh speaking" as Team Member on that leg's channel
// map, then the old inbound-only check skipped the leg and the header stayed
// unknown. Credit whoever that team-labeled channel introduces.
function transcriptAnswererFor(leg, book, inboundGroup) {
            if (leg.direction === 'OUTBOUND' && !inboundGroup) {
                          return { found: callParties.outboundIntroAnswerer(leg, book), source: 'outbound introduction' };
            }
            if (inboundGroup && leg.direction === 'OUTBOUND') {
                          return { found: callParties.teamChannelAnswerer(leg, book), source: 'transcript introduction' };
            }
            if (leg.direction === 'INBOUND' || inboundGroup || !leg.direction) {
                          return {
                                          found: callParties.answererFromTranscript(
                                            leg.direction ? leg : { ...leg, direction: 'INBOUND' },
                                            book,
                                          ),
                                          source: 'transcript introduction',
                          };
            }
            return { found: null, source: null };
}

function applyFoundAnswerer(leg, found, source) {
            const book = roster.getRoster();
            leg.csrChain = (leg.csrChain || []).filter((entry) => isRosterChainEntry(entry, book));
            considerTeamMember(leg, {
                          name: found.name,
                          extension: found.extension,
                          userKey: found.userKey,
                          answered: true,
                          connected: true,
                          answerTime: found.answerTime,
            }, { requireAnswered: false, source });
}

// Call Events Report is the primary inbound answerer. The webhook ENDING event
// does not include participants, and this subscription does not receive ACTIVE,
// which is where the answering extension is CONNECTED. Transcript self-intro
// still runs afterwards and only fills a leg the report left unnamed.
async function loadInboundAnswerers(groupKey) {
            if (!groupLooksInbound(groupKey)) return;
            const book = roster.getRoster();
            const fetchReport = callReportFetcher || gotoClient.fetchCallEventsReport;
            const ids = [...conversationSpaceIdsFor(groupKey)];
            const pending = ids.filter((id) => {
                          const leg = legs.get(id);
                          return leg && !(leg.csrChain || []).some((entry) => isRosterChainEntry(entry, book));
            });
            if (!pending.length) return;

            const extras = [];
            for (const id of pending) {
                          let report = null;
                          try {
                                          report = await fetchReport(id);
                          } catch (err) {
                                          console.error(`Call events report for ${id} failed: ${err.message}`);
                                          continue;
                          }
                          if (!report) continue;
                          recordCallReport(id, report);
                          const body = report.callStates || report.participants ? report : (report.content || report);
                          for (const associated of body.associatedConversations || []) {
                                          if (associated && !ids.includes(associated) && !extras.includes(associated)) extras.push(associated);
                          }
            }
            if ([...conversationSpaceIdsFor(groupKey)].some((id) => {
                          const leg = legs.get(id);
                          return leg && (leg.csrChain || []).some((entry) => isRosterChainEntry(entry, book));
            })) return;

            const inboundId = ids.find((id) => {
                          const leg = legs.get(id);
                          return leg && leg.direction === 'INBOUND';
            }) || ids[0];
            for (const id of extras.slice(0, 4)) {
                          let report = null;
                          try {
                                          report = await fetchReport(id);
                          } catch (err) {
                                          console.error(`Call events report for ${id} failed: ${err.message}`);
                                          continue;
                          }
                          if (!report) continue;
                          const answerers = callParties.answerersFromCallReport(report, book);
                          const leg = legs.get(inboundId);
                          if (!leg || !answerers.length) continue;
                          for (const found of answerers) applyFoundAnswerer(leg, found, 'call events report');
                          if ((leg.csrChain || []).some((entry) => isRosterChainEntry(entry, book))) return;
            }
}

function recordCallReport(conversationSpaceId, report) {
            const leg = legs.get(conversationSpaceId);
            if (!leg || !report) return [];
            const groupKey = groupKeyFor(conversationSpaceId);
            if (leg.direction === 'OUTBOUND' && !groupLooksInbound(groupKey)) return [];
            const book = roster.getRoster();
            if ((leg.csrChain || []).some((entry) => isRosterChainEntry(entry, book))) return [];
            const answerers = callParties.answerersFromCallReport(report, book);
            for (const found of answerers) applyFoundAnswerer(leg, found, 'call events report');
            if (answerers.length) {
                          console.log(
                                          `Inbound answerer from call events report: ${answerers.map((entry) => roster.formatTeamMember(entry)).join(' -> ')} conversation=${conversationSpaceId}`,
                          );
            }
            return answerers;
}

function applyTranscriptAnswerers(groupKey) {
            const book = roster.getRoster();
            const inboundGroup = groupLooksInbound(groupKey);
            for (const id of conversationSpaceIdsFor(groupKey)) {
                          const leg = legs.get(id);
                          if (!leg) continue;
                          fillMissingExtensions(leg, book);
                          const already = (leg.csrChain || []).find((entry) => isRosterChainEntry(entry, book));
                          const { found, source } = transcriptAnswererFor(leg, book, inboundGroup);
                          if (already) {
                                          if (found && found.name && already.name && found.name !== already.name) {
                                                          console.log(
                                                                          `Transcript introduction names ${found.name}; keeping ${already.name} from ${leg.teamMemberSource || 'GoTo'}.`,
                                                          );
                                          }
                                          continue;
                          }
                          if (!found) continue;
                          applyFoundAnswerer(leg, found, source);
            }
}

async function attributeInboundAnswerers(groupKey) {
            await loadInboundAnswerers(groupKey);
            applyTranscriptAnswerers(groupKey);
}

async function finalizeInteraction(groupKey) {
            await attributeInboundAnswerers(groupKey);
            const described = describeGroup(groupKey);
            const {
                          conversationSpaceIds, legRecords, csrPath, externalNumber, externalName,
                          direction, callCreated, callEnded, answered,
            } = described;

            if (!legRecords.length) {
                          await releaseHeldAudio(conversationSpaceIds, false);
                          console.log(`Interaction ${groupKey} closed with no leg data recorded - nothing to summarize.`);
                          return;
            }

            const plan = planForGroup(groupKey, described);
            if (plan.action === 'hold') {
                          console.log(`Interaction held ${groupKey}: ${plan.reason}`);
                          scheduleFinalize(groupKey);
                          return;
            }
            if (plan.suppressSibling) markSuppressed(plan.suppressSibling, { skipArtifacts: Boolean(plan.skipSiblingArtifacts) });
            console.log(`Team member source: ${described.teamMemberSource || 'none'}`);
            if (plan.action === 'post' || (plan.action === 'suppress' && /duplicate|overlapping/i.test(plan.reason))) {
                          rememberFinalizedNumber(groupKey, described);
            }
            if (plan.action === 'suppress' || plan.skipArtifacts) {
                          console.log(`Interaction ${groupKey} not posted (${plan.reason}).`);
                          await releaseHeldAudio(conversationSpaceIds, legRecords.some((leg) => leg.cardFlagged));
                          cleanupGroup(groupKey, conversationSpaceIds);
                          return;
            }

            const existingFolderLeg = legRecords.find((leg) => leg.folderId);
            const sheetPhone = plan.action === 'post' ? (externalNumber || 'unknown') : 'unknown';

            console.log('INTERACTION READY FOR SUMMARY:', JSON.stringify({
                          groupKey,
                          legCount: legRecords.length,
                          direction,
                          csrPath,
                          callCreated,
                          callEnded,
                          answered,
                          post: plan.action,
                          reason: plan.reason,
                          transcriptsAttached: legRecords.filter((leg) => leg.transcript).length,
                          hasRecording: legRecords.some((leg) => leg.driveLink),
            }, null, 2));

            try {
                          const cardFlagged = legRecords.some((leg) => leg.cardFlagged);
                          await releaseHeldAudio(conversationSpaceIds, cardFlagged);
                          const summaryText = await openaiClient.summarizeInteraction({
                                          legRecords,
                                          csrPath,
                                          externalName,
                                          externalNumber,
                                          direction,
                                          callCreated,
                                          callEnded,
                                          answered,
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

                          if (plan.action === 'post' && externalNumber) {
                                          await heymarketClient.postPrivateNote(externalNumber, noteText, direction);
                                          console.log(`Posted Heymarket private note for interaction ${groupKey}.`);
                          } else if (plan.action === 'review') {
                                          console.log(`REVIEW: interaction ${groupKey} not posted (${plan.reason}).`);
                          } else {
                                          console.log(`Interaction ${groupKey} not posted (${plan.reason}).`);
                          }

                          // Sheet row is the Calls index. A suppressed duplicate does not get a
                          // second row. A call with no number, or two different numbers, is logged
                          // with phone "unknown" so it can be reviewed without landing on a thread.
                          if (plan.action !== 'suppress') {
                                          try {
                                                          const spreadsheetId = await sheetsClient.getOrCreateFeedbackSheet();
                                                          await sheetsClient.appendRow(spreadsheetId, 'Calls', [
                                                                          groupKey,
                                                                          driveClient.formatPacific(callCreated),
                                                                          direction || 'unknown',
                                                                          sheetPhone,
                                                                          csrPath.join(' -> ') || 'unknown',
                                                                          folderLink || '',
                                                          ]);
                                          } catch (err) {
                                                          console.error(`Error logging interaction ${groupKey} to the Calls feedback sheet:`, err);
                                          }
                          }
            } catch (err) {
                          console.error(`Error summarizing/posting interaction ${groupKey}:`, err);
            }

            cleanupGroup(groupKey, conversationSpaceIds);
}

// recordingId -> { transcript, receivedAt }
// A transcript notification can arrive before call-state has named its
// conversationSpaceId. Parking it (instead of dropping it) lets the next
// call-state event that mentions the recording attach it.
const parkedOrphans = new Map();

function openLegSnapshot() {
            const open = [];
            for (const [id, leg] of legs) {
                          open.push({
                                          id,
                                          direction: leg.direction || null,
                                          externalNumber: leg.externalNumber || null,
                                          callCreated: leg.callCreated || null,
                                          callEnded: leg.callEnded || null,
                          });
            }
            return open;
}

function parkOrphanTranscript(recordingId, transcript) {
            if (!recordingId) return;
            const existing = parkedOrphans.get(recordingId) || { receivedAt: Date.now() };
            existing.transcript = transcript;
            parkedOrphans.set(recordingId, existing);
            console.log(
              `ORPHAN transcript parked recordingId=${recordingId} reason=no conversationSpaceId `
              + `openLegs=${JSON.stringify(openLegSnapshot())}`,
            );
}

function attachParkedOrphan(recordingId, conversationSpaceId) {
            const parked = parkedOrphans.get(recordingId);
            if (!parked || !parked.transcript || !conversationSpaceId) return false;
            parkedOrphans.delete(recordingId);
            const waitedMs = Date.now() - parked.receivedAt;
            console.log(
              `ORPHAN transcript attached recordingId=${recordingId} conversationSpaceId=${conversationSpaceId} waitedMs=${waitedMs}`,
            );
            recordTranscript(conversationSpaceId, recordingId, parked.transcript);
            return true;
}

function abandonOrphan(recordingId) {
            const parked = parkedOrphans.get(recordingId);
            if (!parked) return false;
            parkedOrphans.delete(recordingId);
            console.log(
              `ORPHAN transcript gave up recordingId=${recordingId} waitedMs=${Date.now() - parked.receivedAt} `
              + `reason=still no conversationSpaceId openLegs=${JSON.stringify(openLegSnapshot())}`,
            );
            return true;
}

function setCallReportFetcherForTests(fn) {
            callReportFetcher = typeof fn === 'function' ? fn : null;
}

function resetForTests() {
            for (const timer of closeTimers.values()) clearTimeout(timer);
            closeTimers.clear();
            parkedOrphans.clear();
            audioUploader = null;
            callReportFetcher = null;
            legs.clear();
            legIdToConversation.clear();
            originatorForConversation.clear();
            conversationsForOriginator.clear();
            recentlyFinalizedConversationSpaceIds.clear();
            recentlyFinalizedByExternalNumber.clear();
            pendingHistory.length = 0;
}

function peekLeg(conversationSpaceId) {
            const leg = legs.get(conversationSpaceId);
            if (!leg) return null;
            const copy = {
                          ...leg,
                          csrChain: (leg.csrChain || []).map((entry) => ({ ...entry })),
                          extraLegIds: leg.extraLegIds ? [...leg.extraLegIds] : [],
                          pendingTranscriptIds: leg.pendingTranscriptIds ? [...leg.pendingTranscriptIds] : [],
            };
            delete copy.pendingAudio;
            return copy;
}

module.exports = {
            recordLegState,
            recordCallHistoryEvent,
            recordCallParkingEvent,
            recordTranscript,
            recordRecordingLink,
            audioArchiveDecision,
            holdRecordingAudio,
            releaseHeldAudio,
            setAudioUploader,
            isCardFlagged,
            legIdToConversation,
            wasRecentlyFinalized,
            setOnFinalized,
            resetForTests,
            peekLeg,
            applyTranscriptAnswerers,
            attributeInboundAnswerers,
            buildTranscriptDocHtml,
            recordCallReport,
            setCallReportFetcherForTests,
            describeForTests: describeGroup,
            parkOrphanTranscript,
            attachParkedOrphan,
            abandonOrphan,
};
