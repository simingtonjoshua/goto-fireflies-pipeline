// Summarizes a finalized call interaction (see src/interactions.js) using OpenAI, for
// posting into Heymarket as a private note and for the transcript+summary Google Doc
// (src/driveClient.js createTranscriptDoc, wired up in interactions.js). Plain fetch,
// no SDK, to match the rest of this codebase's dependency-light style.
//
// CONFIRMED live on 2026-07-21 against a real transcript (an outbound call that went to
// voicemail, recordingId 81d444ef-8818-4458-becc-b1625ccfef4f): the shape is
// { version, results: [{ type: "utterances", transcript, final, startTimeMs, endTimeMs,
// channel, languageCode }] } - matches GoTo's documented schema. normalizeTranscript()
// below parses this plus a couple of defensive fallback shapes in case a future
// recording (e.g. a live two-way call rather than a voicemail) comes back slightly
// differently.
//
// Speaker-role heuristic (per Joshua, 2026-07-21, REVISED same day after a rapid-fire
// dialer burst - see below): GoTo's channel numbers aren't labeled by role. The
// ORIGINAL heuristic was: whichever side speaks FIRST on an inbound call is the team
// member (trained to greet the customer first), while on an outbound call the SECOND
// side to speak is the team member. That heuristic depends entirely on `direction`
// being reliably known - and a live burst of ~15 outbound dialer calls placed within a
// 20-minute window on 2026-07-21 showed several calls finalizing with `direction`
// completely missing (GoTo's call-state webhook never delivered metadata for that
// specific conversationSpaceId before the call's transcript/recording were ready and it
// finalized - see the metadata-race note in interactions.js). Falling back to the
// inbound assumption (first speaker = team member) for those calls got the labels
// EXACTLY BACKWARDS, since they were actually outbound calls: the real team member's
// own self-introduction ("Hi, this is Christine, calling on behalf of Budget Blinds")
// was labeled "Customer", and the actual customer's answers were labeled "Team Member".
//
// FIX: inferChannelRoles() now tries a content-based signal FIRST - a Budget Blinds
// team member making one of these calls always announces the business by name early on
// ("...on behalf of Budget Blinds" / "Emily with Budget Blinds" - speech-to-text
// sometimes mishears "Blinds" as "Lines"), and a real customer never does. Whichever
// channel says it is the team member, regardless of `direction`. The old
// direction+turn-order heuristic is now only a fallback for the rarer case where
// neither channel ever says the business name - and if direction itself isn't reliably
// INBOUND/OUTBOUND either, it deliberately gives up (returns no labels, falling
// through to generic "Channel N" tags) rather than guessing wrong.
//
// Follow-up fixes (per Joshua, 2026-07-21, after reviewing the first live Doc/summary):
// 1) Relabeled "CSR" to "Team Member" everywhere the transcript/summary shows it.
// 2) Transcript lines now show the team member's actual NAME directly (or "Team Member"
// if we don't have one on file) instead of repeating the literal word "CSR" on every
// line, and each line is tagged with its elapsed seconds into the call.
// 3) Stopped treating the phone company's caller-ID/line label (e.g. "Rancho Cordova /
// East Elk Grove (RC)" - a region label attached to a phone number, not a person) as
// if it were the customer's real name - the first live test call had exactly this
// happen. The customer is now referenced by phone number by default; a real name is
// only used if the customer states it themselves in the transcript, and the raw
// caller-ID label is only ever shown as a separate, clearly-labeled line (and only
// for inbound calls, where it's at least plausibly about the actual caller - on
// outbound calls the "caller ID" metadata is about US, not the customer, so it's
// dropped entirely).
// 4) Fixed a real bug: the first live summary said "There is no transcript text
// available for this call" despite a full transcript being attached and shown
// correctly in the Doc - it was a one-sided voicemail message (system prompt + the
// team member leaving a message, no customer speech), and the model incorrectly
// treated "nobody responded" as "no transcript text." The prompt now explicitly
// tells the model that a one-sided transcript is still a real transcript to
// summarize, and reserves "no transcript was available" strictly for the case where
// there is truly no transcript text at all.
// 5) Fixed a phone-number hallucination bug found in the same 2026-07-21 dialer burst:
// an earlier draft of these instructions used a real, specific-looking example
// phone number purely to illustrate a desired format - but on a call where the real
// customer number was unknown, the model would sometimes echo that literal example
// number back as if it were real data, even though it never appeared anywhere in
// that call's transcript. There's now an explicit instruction never to invent a
// phone number that isn't in the metadata or transcript.
// 6) Fixed a misclassification bug found on a real call (Raymond Padilla, 2026-07-21):
// he already had an installation appointment and called to ask if an earlier slot
// was available (it wasn't, so nothing changed) - the model described this as a
// fresh booking and invented a "Booked ..." line describing the unchanged
// appointment as if it had just been booked during this call. The instructions now
// explicitly call out that checking on/confirming/asking to move an existing
// appointment is not the same as booking a new one, and nothing should be described
// as booked unless it actually was during this call.
// 7) Fixed another misclassification bug found on a real call (510-566-3827,
// 2026-07-21): the customer called only to CANCEL an existing appointment (found
// another solution, nothing was broken). The model extracted the facts correctly
// but, back when summaries were forced into one of three rigid categories, filed
// this as a "service/support issue" since that was the closest of only three
// buckets and nothing told it a cancellation isn't a "problem" with a product.
// 8) Fixed two more bugs found on a real call (916-498-4568, 2026-07-21): a vendor
// (Natalie from Clear Channel Outdoor, an out-of-home advertising company) called
// trying to reach James/Amy to sell Budget Blinds on advertising - not a customer
// call at all. The summary called her "the customer," which is wrong framing (she's
// not asking about window treatments, she's soliciting US). Added an explicit
// instruction to identify vendor/solicitation calls as such by name/company rather
// than defaulting to "the customer." Separately, the same summary's actual text
// started with a literal category-name header even though the instructions already
// said not to add one - the model didn't reliably follow that instruction. Added a
// defensive code-level strip (see summarizeInteraction) that removes a leading
// label from the model's response if one slips through anyway, so a
// prompt-following slip can't leak into the posted summary.
// 9) FORMAT REDESIGN (added 2026-07-21, after real-call feedback on 916-846-4771 and
// others): the original design used three rigid categories (a new-booking template,
// a product-issue template, and a free-form catch-all), each with its own
// fill-in-the-blank shape. Even after several rounds of narrowing the category
// definitions (see items 6-8 above), real calls kept getting force-fit into the
// wrong bucket (a cancellation misfiled as a product issue, a vendor call mislabeled
// as a customer) - and the booking template's own placeholder syntax leaked into the
// output literally ("15\. Roller shades" instead of "15 windows, roller shades"),
// while its single {time} placeholder dropped a booked appointment's actual arrival
// WINDOW (e.g. "3:30-4:00 PM") down to just the start time. Per Joshua's direction,
// replaced all three rigid templates with one instruction: describe what actually
// happened on the call in plain language, keeping every specific detail the call
// actually contained (exact window/door counts, product names, full appointment
// date + arrival window, address, names, order/reference numbers) instead of
// compressing them into a fill-in-the-blank shape. Length is whatever the call
// actually needs - a one-line note for a quick callback, a fuller paragraph for a
// detailed booking - rather than a fixed template or number of sentences.
// 10) NO-TRANSCRIPT ATTRIBUTION + UTC-TIME FIX (added 2026-07-21, found on two real
// calls): 253-444-7157, an outbound call placed by Emily Kingdon that captured no
// transcript (likely no answer/short call), got summarized as "The call was made by
// the customer at (253) 444-7157" - backwards, since Emily's team placed this call
// TO that number, the customer didn't call in. A second real call, 415-786-7738 -
// this one WITH a full, unambiguous transcript of Kristine Vandervort placing an
// outbound call to Amber to book a consultation - still opened with "Amber called
// Budget Blinds," the same backwards framing, confirming this wasn't just a
// no-transcript edge case: the model needed to be told the call's direction
// explicitly rather than inferring it, even when the transcript content alone made
// it obvious to a person. The same 253-444-7157 summary also said the call
// "started ... at 8:10 PM" when it actually started at 1:10 PM Pacific - the model
// was handed the raw ISO UTC timestamp ("...T20:10:00.000Z") in the metadata context
// and simply read the UTC clock digits back as if they were correct, with nothing
// telling it otherwise. Two root causes, two fixes:
// a) `direction` (OUTBOUND/INBOUND) was never given to the model as its own labeled
// context line - it was only implied indirectly by whether a "Caller ID" line
// happened to be present. There's now an explicit "Call direction: ..." context
// line that also spells out what OUTBOUND/INBOUND means in plain terms, plus a
// matching IMPORTANT instruction in SYSTEM_PROMPT.
// b) `callCreated`/`callEnded` are now passed through driveClient.formatPacific()
// (the same helper already used for the Doc's own "Call started"/"Call ended"
// lines) before ever reaching the model, so it only ever sees the already-correct
// local time and never has to do (or botch) its own timezone conversion.
// A no-transcript call has no real conversation for a model to summarize anyway -
// it's pure metadata - so as a further safety net this class of call now skips the
// OpenAI call entirely: buildNoTranscriptSummary() below builds that one sentence
// directly from the same already-correct direction/name/time data, which guarantees
// both of these bugs can't recur for this case rather than just making them less
// likely.
// 11) SUPPLIER/VENDOR-SUPPORT-CALL + AUTOMATED-IVR FIX (added 2026-07-21, found on two
// real calls to 866-260-7521, Hunter Douglas's own vendor support line): a) An
// OUTBOUND call where Kristine Vandervort called Hunter Douglas's automated support
// line got its channel roles assigned exactly backwards: the automated recording
// said "You have reached the budget blinds dedicated support line" (describing the
// account the line supports), which matched the old SELF_ID_PATTERN on its own,
// wrongly labeling the ENTIRE automated recording "Kristine Vandervort" (team
// member) while Kristine's own real hold-time comments and stated name got labeled
// "Customer" - the summary then wrote "The customer, identified as Christine,
// confirmed her name," inventing a customer who was really just Kristine herself.
// SELF_ID_PATTERN alone was too loose - a real team member always frames the
// business name as part of their OWN introduction ("this is ___, calling on behalf
// of Budget Blinds"), while an automated system never does. inferChannelRoles() now
// also requires a nearby first-person self-introduction cue (hasSelfIntroduction()
// below) before treating a "Budget Blinds" mention as a team member self-ID, so an
// automated recording that merely references the business name no longer qualifies,
// and falls through to the direction+order fallback instead (which correctly puts
// Kristine's real channel on the team member side for this call). b) A second,
// separate bug on the same number: an INBOUND callback from Jackie (a support rep at
// Custom Browns Group / Hunter Douglas, calling Budget Blinds BACK about an order
// Budget Blinds itself placed with them) got summarized as "Jackie ... informed
// Christine that only the tensioners and tensioner brackets were received" - backwards
// from what the transcript actually shows (the Team Member line says "I only got the
// tensioners ... I didn't get any cords at all" - our OWN team member reported the
// problem to Jackie, not the other way around). This is the reverse of the ordinary
// customer-support pattern (Budget Blinds is the one being served here, not the one
// serving), and the model's usual assumption about which side has the complaint
// doesn't hold. Added an explicit instruction covering this supplier/vendor-support
// scenario. c) Call History's correlation never linked to this same inbound leg at
// all (confirmed in Render logs - the only two Call History events for this call
// referenced a different, unanswered ring-group leg for a different extension), so
// csrChain never got a name and the Doc showed "Team Member(s): unknown" - the model's
// only source for the team member's name was their own self-introduction in the
// transcript ("this is Christine"), which is GoTo's speech-to-text mishearing the
// same real name ("Kristine Vandervort") already seen correctly on the other call the
// same day - the same phenomenon documented above for "Budget Blinds"/"Budget Lines",
// just on a person's name instead. extractSelfStatedTeamMemberName() below now covers
// this specific, confirmed mishearing as a last-resort name source, used only when
// Call History supplied no name at all. Also added an instruction covering the more
// general case where the "Customer" channel is actually just an automated recording
// (menu options, hold-time announcements) rather than a live person, so future calls
// like the Kristine/Hunter-Douglas one describe it as an automated system rather than
// inventing a customer identity from it.

const fetch = require('node-fetch');
const driveClient = require('./driveClient');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function normalizeTranscript(raw) {
              if (!raw) return [];
              const items = Array.isArray(raw) ? raw : raw.results || raw.items || raw.transcriptions || [];
              if (!Array.isArray(items)) return [];

  return items
                .filter((item) => item && (item.transcript || item.text))
                .map((item) => ({
                                  channel: item.channel ?? 0,
                                  text: (item.transcript || item.text || '').trim(),
                                  startTimeMs: item.startTimeMs ?? item.start_time_ms ?? 0,
                }))
                .filter((item) => item.text)
                .sort((a, b) => a.startTimeMs - b.startTimeMs);
}

// A Budget Blinds team member making one of these calls always announces the business
// by name early on ("...calling on behalf of Budget Blinds" / "Emily with Budget
// Blinds"), and a real customer never does. Speech-to-text sometimes mishears "Blinds"
// as "Lines" (confirmed live 2026-07-21), so that variant is matched too.
const SELF_ID_PATTERN = /budget\s+(blinds|lines)\b/i;

// First-person self-introduction cues that make a nearby "Budget Blinds" mention
// trustworthy as a team member self-ID (see header comment item 11 - a plain mention
// of the business name on its own isn't enough, since an automated third-party IVR can
// say it too, e.g. "you have reached the budget blinds dedicated support line").
const SELF_ID_CUE = /\b(this is|i'm|i am|my name is|calling on behalf of|speaking with)\b/i;

// True if `text` contains a "Budget Blinds"/"Budget Lines" mention that reads as the
// speaker's OWN introduction rather than a third party merely referencing the business
// name (see header comment item 11, found on a real call to 866-260-7521 where an
// automated vendor-support recording's own script - "you have reached the budget
// blinds dedicated support line" - matched the old pattern on its own and got the
// entire automated recording mislabeled as the team member). Requires a first-person
// cue (SELF_ID_CUE) within a short window of the mention, or the narrower "___ with
// Budget Blinds" self-intro form (e.g. "Emily with Budget Blinds") immediately before
// it - "with" alone is a much weaker signal than the other cues, so it's only trusted
// right up against the mention rather than anywhere in the wider window.
function hasSelfIntroduction(text) {
              if (!text) return false;
              const mentionPattern = /budget\s+(blinds|lines)\b/gi;
              let match;
              while ((match = mentionPattern.exec(text))) {
                              const windowStart = Math.max(0, match.index - 60);
                              const windowEnd = Math.min(text.length, match.index + match[0].length + 60);
                              if (SELF_ID_CUE.test(text.slice(windowStart, windowEnd))) return true;

                const immediatelyBefore = text.slice(Math.max(0, match.index - 15), match.index);
                              if (/\bwith\s*$/i.test(immediatelyBefore)) return true;
              }
              return false;
}

// Labels each channel number as a team member or "Customer" for one leg's transcript.
// Tries the content-based self-identification signal FIRST (see header comment above -
// far more reliable than direction, and works even when `direction` metadata never
// arrived), falling back to the order-of-first-utterance + call-direction heuristic
// only when neither channel ever says the business name. Returns {} (no labels) if
// there's only one channel with any speech at all, or if roles genuinely can't be
// inferred - callers should fall back to generic "Channel N" labels in that case rather
// than guessing.
function inferChannelRoles(utterances, direction) {
              const channelsInOrder = [];
              for (const u of utterances) {
                              if (!channelsInOrder.includes(u.channel)) channelsInOrder.push(u.channel);
                              if (channelsInOrder.length >= 2) break;
              }
              if (channelsInOrder.length < 2) return {};

  const [first, second] = channelsInOrder;

  const textByChannel = {};
              for (const u of utterances) {
                              textByChannel[u.channel] = `${textByChannel[u.channel] || ''} ${u.text}`;
              }
              const selfIdChannels = channelsInOrder.filter((c) => hasSelfIntroduction(textByChannel[c] || ''));
              if (selfIdChannels.length === 1) {
                              const teamMemberChannel = selfIdChannels[0];
                              const customerChannel = teamMemberChannel === first ? second : first;
                              return { [teamMemberChannel]: 'TeamMember', [customerChannel]: 'Customer' };
              }

  // Fallback: order-of-first-utterance + call-direction heuristic. Only trustworthy
  // when direction is definitively known - an unknown/missing direction (the metadata
  // race described in the header comment) makes this a coin flip, so give up rather
  // than risk labeling the two sides backwards.
  if (direction !== 'OUTBOUND' && direction !== 'INBOUND') return {};
              const teamMemberChannel = direction === 'OUTBOUND' ? second : first;
              const customerChannel = teamMemberChannel === first ? second : first;
              return { [teamMemberChannel]: 'TeamMember', [customerChannel]: 'Customer' };
}

// Known GoTo speech-to-text mishearings of a real team member's name, confirmed
// against real calls (2026-07-21) - the same phenomenon documented above for "Budget
// Blinds" being misheard as "Budget Lines," just on a person's name instead. Only used
// as a last-resort name source (see extractSelfStatedTeamMemberName below) when Call
// History never backfilled a confirmed name for this leg at all - if we already have a
// name from Call History, that's always used instead and this never runs.
const KNOWN_NAME_MISHEARINGS = { christine: 'Kristine' };

// Looks for the team member's own self-introduction ("this is ___" / "my name is
// ___") in their labeled channel's speech, as a last-resort name source when Call
// History never supplied one for this leg (see header comment item 11 - found on a
// real call, 866-260-7521, where Call History's correlation never linked to this leg
// at all, leaving nothing to correct GoTo's mis-transcribed "Christine" against).
// Returns null if no self-introduction phrase is found.
function extractSelfStatedTeamMemberName(utterances, roles) {
              const teamMemberChannelKey = Object.keys(roles).find((ch) => roles[ch] === 'TeamMember');
              if (teamMemberChannelKey === undefined) return null;
              const text = utterances
                .filter((u) => String(u.channel) === teamMemberChannelKey)
                .map((u) => u.text)
                .join(' ');
              const match = text.match(/\bthis is ([A-Z][a-zA-Z']+)\b/) || text.match(/\bmy name is ([A-Z][a-zA-Z']+)\b/);
              if (!match) return null;
              const stated = match[1];
              return KNOWN_NAME_MISHEARINGS[stated.toLowerCase()] || stated;
}

// Formats one leg's transcript as an array of { seconds, label, text } rows. seconds is
// elapsed time since the FIRST utterance in this leg (so it resets to 0 per leg of a
// transferred/parked call, rather than being a raw/meaningless timestamp). label is the
// team member's actual name (falling back to a self-stated name from the transcript,
// then to "Team Member", if we don't have one on file for this leg), "Customer", or
// "Channel N" when we can't infer roles at all (see inferChannelRoles). Shared by
// buildConversationText (what gets sent to the model) and formatTranscriptForDoc (what
// gets written into the Google Doc), so both always show the exact same labeling.
function formatLegTranscript(leg) {
              const utterances = normalizeTranscript(leg.transcript);
              if (!utterances.length) return [];

  const roles = inferChannelRoles(utterances, leg.direction);
              const teamMemberName = (leg.csrChain && leg.csrChain.length)
                ? leg.csrChain[leg.csrChain.length - 1].name
                              : extractSelfStatedTeamMemberName(utterances, roles);
              const startMs = utterances[0].startTimeMs || 0;

  return utterances.map((u) => {
                  const role = roles[u.channel];
                  let label;
                  if (role === 'TeamMember') label = teamMemberName || 'Team Member';
                  else if (role === 'Customer') label = 'Customer';
                  else label = `Channel ${u.channel}`;
                  const seconds = Math.max(0, Math.round((u.startTimeMs - startMs) / 1000));
                  return { seconds, label, text: u.text };
  });
}

// Concatenates every leg's transcript rows, in chronological order by the leg's own
// callCreated timestamp, across the whole interaction.
function allTranscriptRows(legRecords) {
              const ordered = [...legRecords].sort((a, b) =>
                              (a.callCreated || '').localeCompare(b.callCreated || '')
                                                     );
              const rows = [];
              for (const leg of ordered) {
                              for (const row of formatLegTranscript(leg)) rows.push(row);
              }
              return rows;
}

// Plain-text "[Ns] Label: text" lines, one per transcript row, for the model.
function buildConversationText(legRecords) {
              return allTranscriptRows(legRecords)
                .map((r) => `[${r.seconds}s] ${r.label}: ${r.text}`)
                .join('\n');
}

// Same rows as buildConversationText, but HTML-escaped and wrapped as <p> tags for
// direct inclusion in the transcript+summary Google Doc (see
// driveClient.createTranscriptDoc / interactions.js finalizeInteraction).
function escapeHtml(text) {
              return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
}

function formatTranscriptForDoc(legRecords) {
              const rows = allTranscriptRows(legRecords);
              if (!rows.length) return '<p><i>No transcript was available for this call.</i></p>';

  return rows
                .map((r) => `<p><b>[${r.seconds}s] ${escapeHtml(r.label)}:</b> ${escapeHtml(r.text)}</p>`)
                .join('\n');
}

// Free-form call summary instructions (see header comment item 9 - FORMAT REDESIGN,
// 2026-07-21). Replaced the earlier three-rigid-category design: rather than picking
// between fixed templates, the model just describes what happened, as accurately and
// completely as the call warrants.
const SYSTEM_PROMPT = `You summarize customer phone calls for a Budget Blinds franchise CRM. You will be given call metadata and a speaker-labeled transcript (labels are "Team Member" and "Customer" where we could tell, or "Channel 0"/"Channel 1" where we couldn't - infer speaker identity from context in that case). Each transcript line is prefixed with "[Ns]" - the number of seconds into the call that line started.

Write a plain-language summary of what actually happened on this call - not a fixed template, just an accurate account of the conversation. Use as many or as few sentences as the call actually needs (a single short sentence is fine for a quick callback; a fuller paragraph is fine for a detailed booking or a complicated issue). Do not force the call into a category, and do not add a header or label announcing what "type" of call this was - just describe it.

Keep every concrete detail the call actually contained, stated plainly and exactly rather than rounded off or compressed:
- The exact number of windows/doors mentioned and the product(s) discussed together in one clause (e.g. "15 windows, roller shades" - never split the count off on its own like "15.").
- If an appointment was booked, confirmed, moved, or cancelled: the exact date, and the FULL time window discussed (e.g. "3:30-4:00 PM arrival", not just the start time), and who the designer/installer is, if named. If nothing was actually booked or changed (e.g. the customer just checked on an existing appointment and nothing moved), say that plainly rather than describing it as a new booking.
- The address/location, if given.
- Any order, product, or reference number mentioned, and what the customer said was broken or not working, if this was a product issue - plus whether photos/video were requested and whether anything was escalated (and to whom).
- Lead source (how they heard about Budget Blinds), if mentioned.
- Any follow-up action that's still needed.

If a detail wasn't mentioned, simply leave it out rather than writing "Not mentioned" as filler - only call out something as missing if the absence itself matters (e.g. the customer never gave a callback number and clearly should have).

IMPORTANT - identifying the customer: never treat the "Caller ID" metadata value as the customer's real name. That value is a phone company / carrier line label (often a city, region, or business name - e.g. "Rancho Cordova / East Elk Grove (RC)") attached to the phone number, not a person's name. Only use a real personal name for the customer if the customer states it themselves somewhere in the transcript. If no real name was ever stated, refer to the customer by their phone number (as given in the metadata) instead of guessing or using the Caller ID label.

IMPORTANT - never invent a phone number: only ever write a phone number that appears EXACTLY as given in the "Customer phone number" metadata line, or that the customer explicitly states themselves in the transcript. If the metadata says the number is unknown and no number was ever spoken in the transcript, just don't include a number - never reuse a callback number the team member recites for someone else, or any other unrelated number, as if it were the customer's own.

IMPORTANT - a one-sided transcript is still a transcript: if the transcript is just an automated voicemail greeting followed by the team member leaving a message (no customer speech at all), that is NOT "no transcript available" - summarize what the team member said in the message (who they were trying to reach, what it was about, any callback info given). Only say a transcript was unavailable if the transcript section given to you is truly empty (no lines at all).

IMPORTANT - vendor/solicitation calls are not customer calls: if the caller is clearly a vendor, salesperson, recruiter, advertiser, or other outside business calling to sell or pitch something TO Budget Blinds (rather than asking about window treatments themselves), do not refer to them as "the customer" anywhere in the summary. Identify the caller by their actual name and company if stated (e.g. "Natalie from Clear Channel Outdoor"), and describe plainly what they were soliciting and what was said - do not frame it as a customer inquiry.

IMPORTANT - who called whom: the metadata includes this call's direction. OUTBOUND means a Budget Blinds team member placed this call to the customer's number - never describe an outbound call as something the customer initiated (e.g. never say "the customer called" for an outbound call). INBOUND means the customer called in to Budget Blinds. Also always use the times exactly as given in the metadata (they're already in the correct local time) - never do your own timezone conversion or restate a time differently than given.

IMPORTANT - supplier/vendor support calls (the reverse case): sometimes this call is Budget Blinds contacting - or being contacted back by - an outside supplier or vendor's OWN support/order line about a problem with an order Budget Blinds placed with them (e.g. missing or incorrect parts in a shipment). In this scenario Budget Blinds is the one being served, not the customer described elsewhere in these instructions. Identify the external party by their real name and company if stated (e.g. "Jackie from Custom Browns Group"), describe the order/shipment problem as Budget Blinds' own issue rather than a customer's, and read the transcript literally to determine which side actually reported the problem - do not assume the external party is the one with the complaint just because that's the more common pattern; a Budget Blinds team member can be the one describing what's wrong with a shipment they received.

IMPORTANT - automated systems are not customers: if the "Customer"-labeled channel is clearly an automated phone system, IVR menu, or hold-queue recording (menu options, "press one," hold-time announcements, a scripted greeting) rather than a live person, describe it as such (e.g. "an automated support line" or "the hold system") rather than treating it as a customer. This is common when a Budget Blinds team member calls an outside vendor's own support line, and there may be no real third-party "customer" on the call at all.`;

// Builds the summary directly, without calling OpenAI at all, for a call with no
// transcript text whatsoever (see header comment item 10 - NO-TRANSCRIPT ATTRIBUTION +
// UTC-TIME FIX). There's no real conversation content for a model to summarize in this
// case anyway - it's pure metadata - so this generates the one sentence that's actually
// knowable directly from data that's already correct, rather than asking the model to
// guess at it (which produced two real bugs: describing an outbound call as something
// the customer did, and restating a raw UTC timestamp as if it were the correct local
// time).
function buildNoTranscriptSummary({ csrPath, externalNumber, direction, callCreated }) {
              const displayNumber = driveClient.formatPhoneForDisplay(externalNumber);
              const when = driveClient.formatPacific(callCreated);
              const lastTeamMember = (csrPath && csrPath.length)
                ? csrPath[csrPath.length - 1].replace(/\s*\([^)]*\)\s*$/, '').trim()
                              : null;
              const teamMemberPhrase = lastTeamMember || 'a Budget Blinds team member';

  if (direction === 'OUTBOUND') {
                  return `No transcript was available for this call. ${teamMemberPhrase} placed an outbound call to ${displayNumber} on ${when}, but no conversation audio or transcript was captured for it (likely no answer, a voicemail with no message left, or a call too short to record).`;
  }
              if (direction === 'INBOUND') {
                              return `No transcript was available for this call. ${displayNumber} called in to Budget Blinds and was connected to ${teamMemberPhrase} on ${when}, but no conversation audio or transcript was captured for it.`;
              }
              return `No transcript was available for this call involving ${displayNumber} on ${when}.`;
}

// Sends the assembled call context to OpenAI and returns the formatted summary.
// Throws on failure - the caller (src/interactions.js) catches and logs so a
// summarization failure never crashes the webhook handler.
async function summarizeInteraction({ legRecords, csrPath, externalName, externalNumber, direction, callCreated, callEnded }) {
              const conversationText = buildConversationText(legRecords);

  // A call with genuinely no transcript text has no real content for a model to
  // summarize - see buildNoTranscriptSummary above and header comment item 10 for why
  // this is built directly in code instead of asking OpenAI to describe it.
  if (!conversationText) {
                  return buildNoTranscriptSummary({ csrPath, externalNumber, direction, callCreated });
  }

  const contextLines = [
                  `Customer phone number: ${driveClient.formatPhoneForDisplay(externalNumber)}`,
                  `Call direction: ${direction || 'unknown'} (OUTBOUND = a Budget Blinds team member placed this call to the customer; INBOUND = the customer called Budget Blinds - never describe an outbound call as something the customer did)`,
                  direction !== 'OUTBOUND' && externalName
                    ? `Caller ID on file for this number (a carrier/line label, not necessarily a person's name - see instructions above): ${externalName}`
                    : null,
                  `Team member path (in order, if transferred/parked): ${(csrPath || []).join(' -> ') || 'unknown'}`,
                  `Call started: ${driveClient.formatPacific(callCreated)}`,
                  `Call ended: ${driveClient.formatPacific(callEnded)}`,
                ].filter(Boolean);
              const context = contextLines.join('\n');

  const userPrompt = `${context}\n\nTranscript:\n${conversationText}`;

  const res = await fetch(OPENAI_URL, {
                  method: 'POST',
                  headers: {
                                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                                    model: MODEL,
                                    temperature: 0.2,
                                    messages: [
                                                { role: 'system', content: SYSTEM_PROMPT },
                                                { role: 'user', content: userPrompt },
                                                      ],
                  }),
  });

  if (!res.ok) {
                  throw new Error(`OpenAI summarization failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
              let summary = data.choices?.[0]?.message?.content?.trim();
              if (!summary) {
                              throw new Error(`OpenAI response had no summary content: ${JSON.stringify(data)}`);
              }

  // Defensive strip (added 2026-07-21, see header comment item 8): kept as a safety net
  // even after the item-9 format redesign removed the three rigid categories - in case
  // old habits make the model still open with a label like this, it gets stripped
  // before ever reaching Heymarket or the Doc.
  summary = summary.replace(/^\s*(CONSULTATION BOOKING|SERVICE\/SUPPORT ISSUE|GENERAL INQUIRY)\s*[-:]\s*/i, '');

  return summary;
}

module.exports = { summarizeInteraction, formatTranscriptForDoc };
