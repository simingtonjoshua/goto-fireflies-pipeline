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
// Speaker-role heuristic (per Joshua, 2026-07-21): GoTo's channel numbers aren't
// labeled by role, but per the CSR team's own call-handling habits, whichever side
// speaks FIRST on an inbound call is the CSR (they're trained to greet the customer
// first), while on an outbound call the SECOND side to speak is the CSR (the first
// "utterance" is usually ringback/voicemail-system audio or the customer picking up) -
// confirmed consistent with the one live sample seen so far (channel 1 = voicemail
// system spoke first, channel 0 = the outbound CSR spoke second). This is a heuristic,
// not a guarantee - Joshua's own words were "this isn't 100% always going to be
// accurate but should be close" - so inferChannelRoles() below is a best-effort label
// applied BEFORE handing the transcript to the model, rather than something the model
// is asked to guess blind.
//
// Call-type formatting (per Joshua, 2026-07-21): rather than one generic summary shape
// for every call, the model picks between three formats depending on what the call was
// actually about - see the three template blocks inside SYSTEM_PROMPT below.

const fetch = require('node-fetch');

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

// Labels each channel number as "CSR" or "Customer" for one leg's transcript, using the
// order-of-first-utterance + call-direction heuristic described in the header comment
// above. Returns {} (no labels) if there's only one channel with any speech at all -
// nothing to infer a role FROM in that case, so callers should fall back to generic
// "Channel N" labels rather than guessing.
function inferChannelRoles(utterances, direction) {
      const channelsInOrder = [];
      for (const u of utterances) {
              if (!channelsInOrder.includes(u.channel)) channelsInOrder.push(u.channel);
              if (channelsInOrder.length >= 2) break;
      }
      if (channelsInOrder.length < 2) return {};

  const [first, second] = channelsInOrder;
      const csrChannel = direction === 'OUTBOUND' ? second : first;
      const customerChannel = csrChannel === first ? second : first;
      return { [csrChannel]: 'CSR', [customerChannel]: 'Customer' };
}

// Formats one leg's transcript as speaker-labeled lines - e.g.
// "CSR (Josh Simington): Hello, this is Josh..." / "Customer: ...". Falls back to
// "Channel N:" when we can't infer roles (see inferChannelRoles) or don't have a CSR
// name on file for this leg. Shared by buildConversationText (what gets sent to the
// model) and formatTranscriptForDoc (what gets written into the Google Doc), so both
// show the exact same labeling.
function formatLegTranscript(leg) {
      const utterances = normalizeTranscript(leg.transcript);
      if (!utterances.length) return [];

  const roles = inferChannelRoles(utterances, leg.direction);
      const csrName = (leg.csrChain && leg.csrChain.length) ? leg.csrChain[leg.csrChain.length - 1].name : null;

  return utterances.map((u) => {
          const role = roles[u.channel];
          let label;
          if (role === 'CSR') label = csrName ? `CSR (${csrName})` : 'CSR';
          else if (role === 'Customer') label = 'Customer';
          else label = `Channel ${u.channel}`;
          return `${label}: ${u.text}`;
  });
}

// Concatenates every leg's transcript, in chronological order by the leg's own
// callCreated timestamp, into one plain-text conversation with speaker labels.
function buildConversationText(legRecords) {
      const ordered = [...legRecords].sort((a, b) =>
              (a.callCreated || '').localeCompare(b.callCreated || '')
                                             );
      const lines = [];
      for (const leg of ordered) {
              for (const line of formatLegTranscript(leg)) lines.push(line);
      }
      return lines.join('\n');
}

// Same speaker-labeled lines as buildConversationText, but HTML-escaped and wrapped as
// <p> tags for direct inclusion in the transcript+summary Google Doc (see
// driveClient.createTranscriptDoc / interactions.js finalizeInteraction).
function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTranscriptForDoc(legRecords) {
      const ordered = [...legRecords].sort((a, b) =>
              (a.callCreated || '').localeCompare(b.callCreated || '')
                                             );
      const lines = [];
      for (const leg of ordered) {
              for (const line of formatLegTranscript(leg)) lines.push(line);
      }
      if (!lines.length) return '<p><i>No transcript was available for this call.</i></p>';

  return lines
        .map((line) => {
                  const colonIndex = line.indexOf(': ');
                  if (colonIndex === -1) return `<p>${escapeHtml(line)}</p>`;
                  const label = line.slice(0, colonIndex);
                  const text = line.slice(colonIndex + 2);
                  return `<p><b>${escapeHtml(label)}:</b> ${escapeHtml(text)}</p>`;
        })
        .join('\n');
}

// The three call-type formats, spelled out exactly as specified (2026-07-21). The model
// picks whichever one actually matches the call rather than us pre-classifying it in a
// separate step - keeps this to one OpenAI call per interaction instead of two.
const SYSTEM_PROMPT = `You summarize customer phone calls for a Budget Blinds franchise CRM. You will be given call metadata and a speaker-labeled transcript (labels are "CSR" and "Customer" where we could tell, or "Channel 0"/"Channel 1" where we couldn't - infer speaker identity from context in that case).

First, decide which of these three call types this call actually was, then output ONLY the matching format below - nothing else, no extra commentary, no headers announcing which type you picked:

1) CONSULTATION BOOKING - the customer booked (or already has) a free in-home design consultation. Use exactly this format, filling in every {placeholder}. If a detail was never mentioned, write "Not mentioned" for that placeholder rather than guessing or inventing it. Try hard to identify the customer's actual name from the conversation (people usually state it); only use "Unknown" if truly never said.

{Customer Name} located at {Address, City, State (always assume CA unless a different state was specifically mentioned), ZIP}

Lead Source: {how the customer said they heard about Budget Blinds}
{number of windows or doors they want covered}. {product they're interested in, or that they need options/samples shown}, {any other specific instructions or context that came up - e.g. the customer mentioned getting multiple estimates, described something notable about their home, stated style preferences, or a CSR set price expectations}, {special notes or requests, if any}.
Booked {date as MM/DD/YYYY} - {time, e.g. "10:00 AM" or a range like "10:00 AM - 10:30 AM"} - {name of the designer the appointment is with}
{Gate Code: #### - omit this whole line if no gate code was mentioned}

2) SERVICE/SUPPORT ISSUE - the customer is having a problem with an existing window treatment (something broken, not working, needs repair, etc.). Use exactly this format:

{Customer Name} - {affected window(s) or room, as specifically as the call allows}
Problem: {what's broken or not working, in plain terms}
Order/product reference: {order number, purchase date, or product described, if the CSR pulled one up or the customer mentioned one - otherwise "Not found"}
Photos/video requested: {Yes/No - whether the CSR asked the customer to send photos or a video}
Escalated: {Yes/No - and to whom or what team if that was said, e.g. "Yes - escalated to install team"}

3) GENERAL INQUIRY - anything else (general questions, pricing questions with no booking, misc. calls). Write a short, factual paragraph (4-8 sentences) covering: why the customer called, what was discussed or resolved, and any follow-up action needed. Do not invent details not in the transcript.

If there was no transcript text available for this call, say so explicitly and summarize using only the metadata provided.`;

// Sends the assembled call context to OpenAI and returns the formatted summary
// (already in whichever of the three shapes above matched this call). Throws on
// failure - the caller (src/interactions.js) catches and logs so a summarization
// failure never crashes the webhook handler.
async function summarizeInteraction({ legRecords, csrPath, externalName, externalNumber, callCreated, callEnded }) {
      const conversationText = buildConversationText(legRecords);

  const context = [
          `External party phone number: ${externalNumber || 'unknown'}`,
          `Caller ID name (often just a location, not a person - confirm the real name from the transcript if possible): ${externalName || 'unknown'}`,
          `CSR path (in order, if transferred/parked): ${(csrPath || []).join(' -> ') || 'unknown'}`,
          `Call started: ${callCreated || 'unknown'}`,
          `Call ended: ${callEnded || 'unknown'}`,
        ].join('\n');

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
