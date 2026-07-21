// Summarizes a finalized call interaction (see src/interactions.js) using OpenAI, for
// posting into Heymarket as a private note. Plain fetch, no SDK, to match the rest of
// this codebase's dependency-light style.
//
// UNVERIFIED as of 2026-07-21: the exact shape of the transcript JSON returned by
// GoTo's Transcriptions endpoint (src/gotoClient.js fetchTranscript) - no live call has
// gone through this path yet. normalizeTranscript() below defensively handles the
// documented shape plus a couple of plausible wrapper shapes; once a real transcript
// comes through, confirm the shape and simplify this if it's overbuilt.
//
// Also UNVERIFIED: which physical channel (0 or 1) is the CSR vs. the customer (see
// the comment above fetchTranscript in src/gotoClient.js and the README's "Known
// unverified areas"). Rather than guess a fixed mapping, transcript lines are labeled
// by raw channel number and the model is asked to infer speaker roles from context
// (names, who's helping whom) using the CSR chain and external-party info passed
// alongside the transcript.

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
              text: item.transcript || item.text || '',
              startTimeMs: item.startTimeMs ?? item.start_time_ms ?? 0,
      }))
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
}

// Concatenates every leg's transcript, in chronological order by the leg's own
// callCreated timestamp, into one plain-text conversation labeled by channel number.
function buildConversationText(legRecords) {
    const ordered = [...legRecords].sort((a, b) =>
          (a.callCreated || '').localeCompare(b.callCreated || '')
                                           );
    const lines = [];
    for (const leg of ordered) {
          for (const u of normalizeTranscript(leg.transcript)) {
                  if (u.text) lines.push(`[Channel ${u.channel}] ${u.text}`);
          }
    }
    return lines.join('\n');
}

// Sends the assembled call context to OpenAI and returns a short, Heymarket-ready
// summary. Throws on failure - the caller (src/interactions.js) catches and logs so a
// summarization failure never crashes the webhook handler.
async function summarizeInteraction({ legRecords, csrPath, externalName, externalNumber, callCreated, callEnded }) {
    const conversationText = buildConversationText(legRecords);

  const context = [
        `External party: ${externalName || 'unknown'} (${externalNumber || 'unknown number'})`,
        `CSR path: ${(csrPath || []).join(' -> ') || 'unknown'}`,
        `Call started: ${callCreated || 'unknown'}`,
        `Call ended: ${callEnded || 'unknown'}`,
      ].join('\n');

  const systemPrompt =
        'You summarize customer phone calls for a Budget Blinds franchise CRM. Write a short, ' +
        'factual private note (4-8 sentences) covering: why the customer called, what was ' +
        'discussed or resolved, and any follow-up action needed. Do not invent details not in ' +
        'the transcript. Transcript lines are labeled by channel number, not by speaker role - ' +
        'infer who is the CSR and who is the customer from context (names, tone, who is helping ' +
        'whom) rather than assuming a fixed channel-to-role mapping.';

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
                  { role: 'system', content: systemPrompt },
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

module.exports = { summarizeInteraction };
