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
// Call-type formatting (per Joshua, 2026-07-21): rather than one generic summary shape
// for every call, the model picks between three formats depending on what the call was
// actually about - see the three template blocks inside SYSTEM_PROMPT below.
//
// Follow-up fixes (per Joshua, 2026-07-21, after reviewing the first live Doc/summary):
// 1) Relabeled "CSR" to "Team Member" everywhere the transcript/summary shows it.
// 2) Transcript lines now show the team member's actual NAME directly (or "Team Member"
//    if we don't have one on file) instead of repeating the literal word "CSR" on every
//    line, and each line is tagged with its elapsed seconds into the call.
// 3) Stopped treating the phone company's caller-ID/line label (e.g. "Rancho Cordova /
//    East Elk Grove (RC)" - a region label attached to a phone number, not a person) as
//    if it were the customer's real name - the first live test call had exactly this
//    happen. The customer is now referenced by phone number by default; a real name is
//    only used if the customer states it themselves in the transcript, and the raw
//    caller-ID label is only ever shown as a separate, clearly-labeled line (and only
//    for inbound calls, where it's at least plausibly about the actual caller - on
//    outbound calls the "caller ID" metadata is about US, not the customer, so it's
//    dropped entirely).
// 4) Fixed a real bug: the first live summary said "There is no transcript text
//    available for this call" despite a full transcript being attached and shown
//    correctly in the Doc - it was a one-sided voicemail message (system prompt + the
//    team member leaving a message, no customer speech), and the model incorrectly
//    treated "nobody responded" as "no transcript text." The prompt now explicitly
//    tells the model that a one-sided transcript is still a real transcript to
//    summarize, and reserves "no transcript was available" strictly for the case where
//    there is truly no transcript text at all.
// 5) Fixed a phone-number hallucination bug found in the same 2026-07-21 dialer burst:
//    the CONSULTATION BOOKING / SERVICE ISSUE templates below used to show a real,
//    specific-looking example phone number ("(916) 306-0800") purely to illustrate the
//    desired FORMAT - but on a call where the real customer number was unknown, the
//    model would sometimes echo that literal example number back as if it were real
//    data, even though it never appeared anywhere in that call's transcript. The
//    format hint now uses a non-numeric placeholder ("(XXX) XXX-XXXX") and there's an
//    explicit instruction never to invent a phone number that isn't in the metadata or
//    transcript.

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
          const selfIdChannels = channelsInOrder.filter((c) => SELF_ID_PATTERN.test(textByChannel[c] || ''));
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

// Formats one leg's transcript as an array of { seconds, label, text } rows. seconds is
// elapsed time since the FIRST utterance in this leg (so it resets to 0 per leg of a
// transferred/parked call, rather than being a raw/meaningless timestamp). label is the
// team member's actual name (falling back to "Team Member" if we don't have one on file
// for this leg), "Customer", or "Channel N" when we can't infer roles at all (see
// inferChannelRoles). Shared by buildConversationText (what gets sent to the model) and
// formatTranscriptForDoc (what gets written into the Google Doc), so both always show
// the exact same labeling.
function formatLegTranscript(leg) {
          const utterances = normalizeTranscript(leg.transcript);
          if (!utterances.length) return [];

  const roles = inferChannelRoles(utterances, leg.direction);
          const teamMemberName = (leg.csrChain && leg.csrChain.length) ? leg.csrChain[leg.csrChain.length - 1].name : null;
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

// The three call-type formats, spelled out exactly as specified (2026-07-21, revised
// same day after the first live test - see the header comment's "Follow-up fixes"). The
// model picks whichever one actually matches the call rather than us pre-classifying it
// in a separate step - keeps this to one OpenAI call per interaction instead of two.
const SYSTEM_PROMPT = `You summarize customer phone calls for a Budget Blinds franchise CRM. You will be given call metadata and a speaker-labeled transcript (labels are "Team Member" and "Customer" where we could tell, or "Channel 0"/"Channel 1" where we couldn't - infer speaker identity from context in that case). Each transcript line is prefixed with "[Ns]" - the number of seconds into the call that line started.

IMPORTANT - identifying the customer: never treat the "Caller ID" metadata value as the customer's real name. That value is a phone company / carrier line label (often a city, region, or business name - e.g. "Rancho Cordova / East Elk Grove (RC)") attached to the phone number, not a person's name. Only use a real personal name for the customer if the customer states it themselves somewhere in the transcript. If no real name was ever stated, refer to the customer by their phone number (as given in the metadata) instead of guessing or using the Caller ID label.

IMPORTANT - never invent a phone number: only ever write a phone number that appears EXACTLY as given in the "Customer phone number" metadata line, or that the customer explicitly states themselves in the transcript. If the metadata says the number is unknown and no number was ever spoken in the transcript, write "Unknown" rather than filling in any digits - never reuse an example number from these instructions or a number mentioned for an unrelated purpose (e.g. a callback number the team member recites) as if it were the customer's own number.

IMPORTANT - a one-sided transcript is still a transcript: if the transcript is just an automated voicemail greeting followed by the team member leaving a message (no customer speech at all), that is NOT "no transcript available" - summarize what the team member said in the message (who they were trying to reach, what it was about, any callback info given). Only say a transcript was unavailable if the transcript section given to you is truly empty (no lines at all).

First, decide which of these three call types this call actually was, then output ONLY the matching format below - nothing else, no extra commentary, no headers announcing which type you picked:

1) CONSULTATION BOOKING - the customer booked (or already has) a free in-home design consultation. Use exactly this format, filling in every {placeholder}. If a detail was never mentioned, write "Not mentioned" for that placeholder rather than guessing or inventing it.

{Customer's name if they stated it themselves in the conversation - otherwise the exact "Customer phone number" value from the metadata above, formatted like (XXX) XXX-XXXX - see the phone number instructions above, never invent one} located at {Address, City, State (always assume CA unless a different state was specifically mentioned), ZIP}

Lead Source: {how the customer said they heard about Budget Blinds}
{number of windows or doors they want covered}. {product they're interested in, or that they need options/samples shown}, {any other specific instructions or context that came up - e.g. the customer mentioned getting multiple estimates, described something notable about their home, stated style preferences, or a team member set price expectations}, {special notes or requests, if any}.
Booked {date as MM/DD/YYYY} - {time, e.g. "10:00 AM" or a range like "10:00 AM - 10:30 AM"} - {name of the designer the appointment is with}
{Gate Code: #### - omit this whole line if no gate code was mentioned}

2) SERVICE/SUPPORT ISSUE - the customer is having a problem with an existing window treatment (something broken, not working, needs repair, etc.). Use exactly this format:

{Customer's name if they stated it themselves in the conversation - otherwise the exact "Customer phone number" value from the metadata above, formatted like (XXX) XXX-XXXX - see the phone number instructions above, never invent one} - {affected window(s) or room, as specifically as the call allows}
Problem: {what's broken or not working, in plain terms}
Order/product reference: {order number, purchase date, or product described, if the team member pulled one up or the customer mentioned one - otherwise "Not found"}
Photos/video requested: {Yes/No - whether the team member asked the customer to send photos or a video}
Escalated: {Yes/No - and to whom or what team if that was said, e.g. "Yes - escalated to install team"}

3) GENERAL INQUIRY - anything else (general questions, pricing questions with no booking, a voicemail message left with no live conversation, misc. calls). Write a short, factual paragraph (4-8 sentences) covering: why the call happened, what was said or resolved (or, for a voicemail, what message was left and any callback info given), and any follow-up action needed. Do not invent details not in the transcript.`;

// Sends the assembled call context to OpenAI and returns the formatted summary (already
// in whichever of the three shapes above matched this call). Throws on failure - the
// caller (src/interactions.js) catches and logs so a summarization failure never crashes
// the webhook handler.
async function summarizeInteraction({ legRecords, csrPath, externalName, externalNumber, direction, callCreated, callEnded }) {
          const conversationText = buildConversationText(legRecords);

  const contextLines = [
              `Customer phone number: ${driveClient.formatPhoneForDisplay(externalNumber)}`,
              direction !== 'OUTBOUND' && externalName
                ? `Caller ID on file for this number (a carrier/line label, not necessarily a person's name - see instructions above): ${externalName}`
                : null,
              `Team member path (in order, if transferred/parked): ${(csrPath || []).join(' -> ') || 'unknown'}`,
              `Call started: ${callCreated || 'unknown'}`,
              `Call ended: ${callEnded || 'unknown'}`,
            ].filter(Boolean);
          const context = contextLines.join('\n');

  const userPrompt = conversationText
            ? `${context}\n\nTranscript:\n${conversationText}`
              : `${context}\n\n(No transcript text was available for this call - summarize using only the metadata above, and say so explicitly.)`;

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
          const summary = data.choices?.[0]?.message?.content?.trim();
          if (!summary) {
                      throw new Error(`OpenAI response had no summary content: ${JSON.stringify(data)}`);
          }
          return summary;
}

module.exports = { summarizeInteraction, formatTranscriptForDoc };
