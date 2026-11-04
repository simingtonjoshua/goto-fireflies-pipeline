// Intent, outcome, and lead for one finalized call.
//
// The summary prose is unchanged. This module only classifies the call into a
// fixed intent, a short outcome, and Lead Yes/No/Unknown, then builds the header
// lines shared by the transcript Google Doc and the Heymarket note.
//
// Lead is decided here, not by the model:
// - Yes: intent New project on an inbound call (including inbound voicemail).
// - Yes: an outbound New project call that books a consultation AND matches a
//   Pipedrive deal (id + title), so a later dedupe can tie the online lead to
//   the booked visit. Quote follow-ups stay No even when a deal is found.
// - No: routed to another franchisee (zip-code call tracking, another territory).
//   Outcome is forced to say "routed away to another franchisee".
// - No: internal, vendor, quote follow-up, scheduling, service, billing, and
//   every other outbound call.
// - Unknown: no transcript, and the caller is not a known internal/vendor party
//   and the call is not outbound.
//
// No transcript always uses intent "No conversation or no transcript".
// A transcript where both a team member and the other party speak live never
// does, even when GoTo marked the call unanswered or the model says so. There
// is no call-duration cutoff in this module. Short calls were mis-tagged
// because Answered: no / Voicemail: yes was handed to the classifier and the
// result was trusted over the transcript.
// Spam, wrong number, and no-conversation calls that were not already internal
// or vendor are Call type Other. The four call types stay Customer, Internal
// team, Vendor, and Other.

const fetch = require('node-fetch');
const driveClient = require('./driveClient');
const callTypes = require('./callType');
const callParties = require('./callParties');
const pipedriveClient = require('./pipedriveClient');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const INTENTS = [
  'New project',
  'Existing quote follow-up',
  'Appointment scheduling for an existing job',
  'Order status',
  'Service or post-install support',
  'Billing or financing',
  'Product or general info',
  'Vendor or other business',
  'Internal team',
  'Spam or solicitation',
  'Wrong number',
  'No conversation or no transcript',
];

const NO_CONVERSATION = 'No conversation or no transcript';

const OUTCOME_SUGGESTIONS = [
  'booked consultation',
  'booked/rescheduled appointment',
  'transferred',
  'voicemail left',
  'no answer',
  'resolved',
  'callback promised',
  'info given',
  'abandoned',
];

const ROUTED_PHRASE = 'routed away to another franchisee';

const INTENT_COLUMNS = [
  'Date',
  'Caller ID',
  'Direction',
  'Team Member',
  'Call Type',
  'Intent',
  'Outcome',
  'Lead',
  'Transcript Link',
];

const ALIASES = {
  'appointment scheduling (existing job)': 'Appointment scheduling for an existing job',
  'appointment scheduling': 'Appointment scheduling for an existing job',
  'billing / financing': 'Billing or financing',
  'billing/financing': 'Billing or financing',
  'service / post-install support': 'Service or post-install support',
  'service/post-install support': 'Service or post-install support',
  'wrong number / misdirected': 'Wrong number',
  'spam / solicitation': 'Spam or solicitation',
  'no conversation / no transcript': 'No conversation or no transcript',
  'vendor / other business': 'Vendor or other business',
  'product / general info': 'Product or general info',
  'existing quote follow up': 'Existing quote follow-up',
};

const ROUTED_AWAY_PATTERNS = [
  /\bschab\b/i,
  /\bwrong franchise\b/i,
  /\banother franchise/i,
  /\bother franchisee\b/i,
  /\bdifferent franchise\b/i,
  /\bnot (?:our|this) (?:territory|franchise)\b/i,
  /\boutside (?:our|this) (?:territory|service area)\b/i,
  /\bzip(?:\s|-)?code (?:call )?tracking\b/i,
  /\bcall tracking number\b/i,
  /\brouted away\b/i,
];

const OTHER_OFFICE = new RegExp(
  `\\bbudget\\s*(?:${callParties.BUSINESS_NAME_ALT})\\s+of\\s+(?!sacramento\\b)[a-z]`,
  'i',
);

let classifierOverride = null;

function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function cleanOutcome(value) {
  const text = oneLine(value);
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function canonicalizeIntent(value) {
  const text = oneLine(value).replace(/\.+$/, '');
  if (!text) return null;
  const exact = INTENTS.find((intent) => intent.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  return ALIASES[text.toLowerCase()] || null;
}

function textShowsRoutedAway(text) {
  const value = String(text || '');
  if (!value) return false;
  if (ROUTED_AWAY_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return OTHER_OFFICE.test(value);
}

function fallbackIntent({ conversationText, callType } = {}) {
  if (!oneLine(conversationText)) return NO_CONVERSATION;
  if (callType === 'internal') return 'Internal team';
  if (callType === 'vendor') return 'Vendor or other business';
  return 'Product or general info';
}

function noTranscriptOutcome({ direction, answered, reachedVoicemail, voicemail } = {}) {
  if (direction === 'OUTBOUND') {
    return answered === false ? 'no answer' : 'unknown';
  }
  if (voicemail || reachedVoicemail || answered === false) return 'abandoned';
  return 'unknown';
}

function ensureRoutedOutcome(outcome) {
  const text = cleanOutcome(outcome);
  if (!text) return ROUTED_PHRASE;
  if (text.toLowerCase().includes(ROUTED_PHRASE)) return text;
  return `${ROUTED_PHRASE} (${text})`;
}

function asBool(value) {
  return value === true || value === 'true' || value === 1;
}

function consultationBooked(model, outcome) {
  if (model && asBool(model.bookedConsultation)) return true;
  const text = String(outcome || '');
  if (/\b(?:did not|didn't|never|not|no)\b[^.]{0,40}\bbook(?:ed)? (?:a )?consultation\b/i.test(text)) {
    return false;
  }
  return /\bbooked (?:a )?consultation\b/i.test(text);
}

function callTypeAfterIntent(existingType, intent) {
  if (existingType === 'internal' || existingType === 'vendor') return existingType;
  if (
    intent === 'Spam or solicitation'
    || intent === 'Wrong number'
    || intent === NO_CONVERSATION
  ) {
    return 'other';
  }
  if (existingType === 'other') return 'other';
  return 'customer';
}

function resolveLead({
  intent, direction, callType, hasTranscript, routedAway, bookedConsultation, pipedriveDeal,
}) {
  if (routedAway) return 'No';
  if (callType === 'internal' || callType === 'vendor') return 'No';
  if (intent === 'Internal team' || intent === 'Vendor or other business') return 'No';
  if (intent === 'New project' && direction === 'INBOUND') return 'Yes';
  if (
    direction === 'OUTBOUND'
    && intent === 'New project'
    && bookedConsultation
    && pipedriveDeal
  ) {
    return 'Yes';
  }
  if (!hasTranscript || intent === NO_CONVERSATION) {
    if (direction === 'OUTBOUND') return 'No';
    return 'Unknown';
  }
  return 'No';
}

function classifierSystemPrompt() {
  const intents = INTENTS.map((intent) => `- ${intent}`).join('\n');
  const outcomes = OUTCOME_SUGGESTIONS.join(', ');
  return `You classify phone calls for Budget Blinds of Sacramento. Reply with JSON only, no markdown, using exactly these keys: intent, outcome, routedAway, bookedConsultation.

intent must be exactly one of:
${intents}

Definitions:
- New project: wants window treatments for windows not yet purchased (a consult or quote), including a past customer adding new windows or rooms.
- Existing quote follow-up: a customer with an open estimate calling to buy, revise, or ask about it.
- Appointment scheduling for an existing job: booking, moving, or confirming an already-set install, service visit, or consult.
- Order status: where an existing order is.
- Service or post-install support: warranty, repair, remake, parts, or a product problem after install.
- Billing or financing: payments, balances, or Service Finance.
- Product or general info: a general question with no project behind it.
- Vendor or other business: a supplier, manufacturer, or other business.
- Internal team: a designer, installer, or staff member.
- Spam or solicitation: solicitation or a robocall.
- Wrong number: the caller reached the wrong place.
- No conversation or no transcript: missed, abandoned, silent, or no transcript. Use this only when there is nothing to classify. If both a team member and the other party have live lines in the transcript, do not choose this intent. Do not use "no answer", "voicemail", or "abandoned" as the outcome of that call.

outcome is one short line. Prefer one of: ${outcomes}. You may add a brief specific detail after it. Do not write the call summary.

routedAway is true only when this call was sent to another Budget Blinds franchise or territory (zip-code call tracking, a named team such as Schab, "wrong franchise", another city's franchise). Our own Sacramento office is not routed away.

bookedConsultation is true only when a new consultation was actually booked on this call. Confirming, moving, or asking about an existing appointment is false. An install booking is false.

Do not decide whether the call is a sales lead. Do not invent a deal id.`;
}

function classifierUser(input) {
  const lines = [
    `Call direction: ${input.direction || 'unknown'}`,
    `Answered: ${input.answered === true ? 'yes' : input.answered === false ? 'no' : 'unknown'}`,
    `Voicemail: ${input.voicemail || input.reachedVoicemail ? 'yes' : 'no'}`,
    `Existing call type (a hint, not the intent): ${input.callType || 'unknown'}`,
  ];
  if (input.liveConversation) {
    lines.push('Live conversation: yes. Both a team member and the other party spoke. This call was answered.');
  }
  lines.push('', 'Transcript:', input.conversationText);
  return lines.join('\n');
}

const LIVE_CLOSER = /^\s*(?:thanks|thank you)[.!]?\s*$/i;

// Labeled transcript lines ("[3s] Emily Kingdon: ..."). Recording closers and
// system prompts do not count. Both sides must have said something live.
function transcriptShowsLiveConversation(text) {
  const rows = [];
  const pattern = /^\[(\d+)s\]\s+([^:\n]+):\s*(.+)$/gm;
  let match = pattern.exec(String(text || ''));
  while (match) {
    rows.push({ label: match[2].trim(), text: match[3].trim() });
    match = pattern.exec(String(text || ''));
  }
  const substantive = rows.filter((row) => {
    if (!row.label || !row.text || row.label === 'Recording') return false;
    if (row.label.startsWith('Channel ')) return false;
    if (row.label !== 'Customer' && LIVE_CLOSER.test(row.text)) return false;
    return true;
  });
  const customer = substantive.some((row) => row.label === 'Customer');
  const team = substantive.some((row) => row.label !== 'Customer');
  return customer && team;
}

function withLiveConversationFacts(input = {}) {
  if (!transcriptShowsLiveConversation(input.conversationText)) return input;
  return {
    ...input,
    answered: true,
    voicemail: false,
    reachedVoicemail: false,
    liveConversation: true,
  };
}

function outcomeContradictsLiveConversation(outcome) {
  return /\b(no answer|voicemails?|abandoned|ended quickly|did not engage|didn't engage|didnt engage)\b/i.test(String(outcome || ''));
}

function liveConversationOutcome(summary) {
  const text = oneLine(summary);
  if (/\b(?:call(?:\s+\w+){0,4}\s+back|callbacks?|talk next week|next week|another time)\b/i.test(text)) {
    return 'callback promised';
  }
  if (/\bdeclin\w*/i.test(text)) return 'declined';
  if (/\bbooked\b/i.test(text)) return 'booked consultation';
  return 'info given';
}

function parseModelJson(content) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function requestModel(input) {
  if (typeof classifierOverride === 'function') return classifierOverride(input);
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: classifierSystemPrompt() },
        { role: 'user', content: classifierUser(input) },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Intent classification failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return parseModelJson(data.choices?.[0]?.message?.content);
}

function normalizeModel(payload, input) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const intent = canonicalizeIntent(body.intent) || fallbackIntent(input);
  const outcome = cleanOutcome(body.outcome) || 'unknown';
  const routedAway = asBool(body.routedAway)
    || asBool(body.routed_away)
    || textShowsRoutedAway(input.conversationText);
  const bookedConsultation = asBool(body.bookedConsultation) || asBool(body.booked_consultation);
  return { intent, outcome, routedAway, bookedConsultation };
}

async function interpret(input = {}) {
  const request = withLiveConversationFacts(input);
  if (!oneLine(request.conversationText)) {
    return {
      intent: NO_CONVERSATION,
      outcome: noTranscriptOutcome(input),
      routedAway: false,
      bookedConsultation: false,
      source: 'no-transcript',
    };
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await requestModel(request);
      return { ...normalizeModel(payload, request), source: 'model' };
    } catch (err) {
      lastError = err;
    }
  }
  console.error(`Intent classification failed (using fallback): ${lastError.message}`);
  return {
    intent: fallbackIntent(input),
    outcome: 'unknown',
    routedAway: textShowsRoutedAway(input.conversationText),
    bookedConsultation: false,
    source: 'fallback',
  };
}

function finalizeTags(input = {}) {
  const model = input.model || {};
  const hasTranscript = Boolean(input.hasTranscript);
  let intent = canonicalizeIntent(model.intent) || fallbackIntent({
    conversationText: hasTranscript ? 'yes' : '',
    callType: input.callType,
  });
  if (!hasTranscript) intent = NO_CONVERSATION;

  const routedAway = Boolean(model.routedAway)
    || textShowsRoutedAway(input.summary)
    || textShowsRoutedAway(input.transcriptText);
  let outcome = cleanOutcome(model.outcome) || (hasTranscript ? 'unknown' : noTranscriptOutcome(input));
  if (!hasTranscript) outcome = noTranscriptOutcome(input);

  const live = hasTranscript && transcriptShowsLiveConversation(input.transcriptText);
  if (live && intent === NO_CONVERSATION) {
    intent = fallbackIntent({
      conversationText: input.transcriptText,
      callType: input.callType,
    });
  }
  if (live && !routedAway && outcomeContradictsLiveConversation(outcome)) {
    outcome = liveConversationOutcome(input.summary);
  }
  if (routedAway) outcome = ensureRoutedOutcome(outcome);

  const adjustedType = callTypeAfterIntent(input.callType, intent);
  const bookedConsultation = consultationBooked(
    { bookedConsultation: asBool(model.bookedConsultation) },
    outcome,
  );
  const pipedriveDeal = input.pipedriveDeal || null;
  const lead = resolveLead({
    intent,
    direction: input.direction,
    callType: adjustedType,
    hasTranscript,
    routedAway,
    bookedConsultation,
    pipedriveDeal,
  });
  return {
    intent,
    outcome,
    lead,
    callType: adjustedType,
    callTypeLabel: callTypes.labelFor(adjustedType),
    routedAway,
    bookedConsultation,
    pipedriveDeal,
    hasTranscript,
  };
}

async function applyPipedrive(result, context = {}) {
  const deals = await pipedriveClient.findDealsByPhone(context.externalNumber);
  const pipedriveDeal = formatDealRefs(deals);
  const tags = finalizeTags({
    model: {
      intent: result.intent,
      outcome: result.outcome,
      routedAway: result.routedAway,
      bookedConsultation: result.bookedConsultation,
    },
    summary: result.summary,
    direction: context.direction,
    answered: context.answered,
    reachedVoicemail: context.reachedVoicemail,
    voicemail: context.voicemail,
    callType: result.callType,
    hasTranscript: result.hasTranscript,
    pipedriveDeal,
  });
  return { ...result, ...tags };
}

function formatDealRef(deal) {
  if (!deal || deal.id == null || deal.id === '') return null;
  const title = oneLine(deal.title);
  return title ? `${deal.id} — ${title}` : String(deal.id);
}

function formatDealRefs(deals) {
  const lines = [];
  for (const deal of deals || []) {
    const ref = formatDealRef(deal);
    if (ref && !lines.includes(ref)) lines.push(ref);
    if (lines.length === 3) break;
  }
  return lines.length ? lines.join('; ') : null;
}

function headerRows(fields = {}) {
  const rows = [
    ['Phone number', driveClient.formatPhoneForDisplay(fields.externalNumber)],
  ];
  if (fields.direction !== 'OUTBOUND' && fields.externalName) {
    rows.push(['Caller ID', oneLine(fields.externalName)]);
  }
  rows.push(
    ['Direction', oneLine(fields.direction || 'unknown')],
    ['Team Member(s)', oneLine((fields.csrPath || []).join(' → ') || 'unknown')],
  );
  if (fields.callTypeLabel) rows.push(['Call type', oneLine(fields.callTypeLabel)]);
  if (fields.partyName) {
    const who = fields.partyRole ? `${fields.partyName} (${fields.partyRole})` : fields.partyName;
    rows.push(['Other party', oneLine(who)]);
  }
  rows.push(
    ['Call started', driveClient.formatPacific(fields.callCreated)],
    ['Call ended', driveClient.formatPacific(fields.callEnded)],
  );
  if (fields.intent) {
    rows.push(
      ['Intent', oneLine(fields.intent)],
      ['Outcome', oneLine(fields.outcome || 'unknown')],
      ['Lead', oneLine(fields.lead || 'Unknown')],
    );
    if (fields.pipedriveDeal) rows.push(['Pipedrive deal', oneLine(fields.pipedriveDeal)]);
  }
  return rows;
}

function intentSheetRow(fields = {}) {
  const values = {
    Date: driveClient.formatPacific(fields.callCreated),
    'Caller ID': driveClient.formatPhoneForDisplay(fields.externalNumber),
    Direction: fields.direction || 'unknown',
    'Team Member': (fields.csrPath || []).join(' → ') || 'unknown',
    'Call Type': fields.callTypeLabel || 'Other',
    Intent: fields.intent || '',
    Outcome: fields.outcome || '',
    Lead: fields.lead || '',
    'Transcript Link': fields.transcriptLink || '',
  };
  return INTENT_COLUMNS.map((column) => values[column]);
}

function setClassifierForTests(fn) {
  classifierOverride = typeof fn === 'function' ? fn : null;
}

module.exports = {
  INTENTS,
  NO_CONVERSATION,
  OUTCOME_SUGGESTIONS,
  INTENT_COLUMNS,
  ROUTED_PHRASE,
  canonicalizeIntent,
  textShowsRoutedAway,
  transcriptShowsLiveConversation,
  interpret,
  finalizeTags,
  applyPipedrive,
  formatDealRef,
  formatDealRefs,
  headerRows,
  intentSheetRow,
  classifierSystemPrompt,
  setClassifierForTests,
};
