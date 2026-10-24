// Turns GoTo call-state and call-history payloads into direction, the external
// number, and who actually answered — without guessing from transcript text.
//
// Direction: metadata.direction on the call-events notification is already the
// call's direction (INBOUND / OUTBOUND) and is kept as-is whenever GoTo sends it.
// Call-history leg direction is used only when that field is missing. It must not
// overwrite a direction GoTo already set: a queue leg that dials a ringing phone
// can look OUTBOUND even though the customer called in.
//
// Who answered: a LINE participant counts only when their status is CONNECTED (or
// on hold), or when their call-history leg shows an answer. RINGING devices, the
// main line, and the forwarded cell are not the answering person. The webhook
// subscription is STARTING and ENDING, and ENDING participants are empty, so the
// connected extension for an inbound queue or ring group is read from the Call
// Events Report (answerersFromCallReport) when those events never named anyone.
// Outbound calls
// still credit the originator LINE (the person who placed the call) even before
// the far end answers. Desk/cloud STARTING often has one non-system LINE whose
// originator id is a session id, not that participant — that line placed the call.
// Call history may put the answer time in `answered` (or another alias) rather
// than `answerTime`. No explicit signal means answered is unknown, not "no".
//
// Speakers: GoTo's transcription schema numbers channels from the recorded party —
// channel 0 is what that party said, channel 1 is what they heard
// (https://developer.goto.com/GoToConnect/#tag/Transcriptions). When the recording
// id is nested on a participant, that participant is channel 0. When it isn't, channel
// 0 is treated as the call originator (the external caller on an inbound call, the
// extension that dialed on an outbound call) and channel 1 as the other side.
//
// That originator fallback was confirmed wrong on a live outbound return call from
// Joshua's line on 2026-10-12: direction and the team-member credit were already
// correct, but channel 0 was the customer answering ("Hello") and channel 1 was
// Joshua ("this is Joshua over at Budget Blinds"). A missing recording owner, or a
// recording owner marked as the team line, therefore swapped every speaker.
// channelRolesForLeg() keeps the GoTo map and flips it only when one channel has a
// content-safe team self-introduction that the map labeled as the customer. Talk
// order is not used. See callIdVersion() for why some of Joshua's rows look different.

const rosterApi = require('./roster');

const CONNECTED_STATUSES = new Set(['CONNECTED', 'ON_HOLD', 'HOLD', 'HELD']);

// Phrases that are system audio on this account: the recording announcement, the
// open greeting, the queue hold message, the after-hours greeting (Joshua's voice
// on a recording — not him picking up), business-hours messages, and IVR menus.
const ALWAYS_SYSTEM = [
  /call may be recorded/i,
  /currently assisting other callers/i,
  /please leave (your )?name/i,
  /please leave a (message|voicemail)/i,
  /hi there,\s+this is josh\b/i,
  /your call has been forwarded to voicemail/i,
  /forwarded to an automat(?:ic|ed) voice messag(?:e|ing) system/i,
  /\bmailbox is full\b/i,
  /\bcannot accept any messages\b/i,
  /^\s*is not available[.!]?\s*$/i,
  /\byour call is (?:very )?important to us\b/i,
  /\bplease stay on the line\b/i,
  /\bbest in custom blinds\b/i,
  /the person you(?:['’]re| are) trying to reach is not available/i,
  /at the tone, please record your message/i,
  /no call parked/i,
  /please enter your (?:zip|postal|pin|extension|account)/i,
  /\bhours of \d/i,
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\s+to\s+\d/i,
  /\bour (normal )?business hours\b/i,
  /\bwe are (currently )?closed\b/i,
  /\bpress [0-9]\b/i,
  /\bpress\s+(?:one|two|three|four|five|six|seven|eight|nine|zero|pound|star)\b/i,
  /\bfor (sales|service|the operator), press\b/i,
  /\bestimated wait time\b/i,
  /\bsave your place in line\b/i,
  /\bplease continue to hold\b/i,
  /\bwelcome to bright\b/i,
  /\bbright (?:resource hub|homepage|home page|dealer portal)\b/i,
  /\bcalendar syncing with\b/i,
  /\btransition to bright\b/i,
  /\bwhen you have finished recording,\s+you may hang up\b/i,
  /\byou have reached the\b/i,
  /\bdedicated support line\b/i,
  /\byour call may be monitored\b/i,
  /\bthis call may be monitored\b/i,
  /\bour team is currently in training\b/i,
  /\bback on the phones\b/i,
  /\bto avoid waiting on hold\b/i,
  /\bplease select the callback\b/i,
  /\bwe will call you back\b/i,
  /\bwe appreciate your patience\b/i,
  /\bto check the status of an order\b/i,
  /\bfor customer and technical support\b/i,
  /\bfor warranty support\b/i,
  /\bto place a (?:new|parts) order\b/i,
  /\bthe system will automatically disconnect\b/i,
  /\bschedule your callback\b/i,
  /\bplease do not hang up\b/i,
  /\bplease state your name after the tone\b/i,
  /\bnumber we will call you back\b/i,
];

const SCRIPT_UNLESS_LIVE = [
  /\bthank you for calling\b/i,
  /\bit'?s a (?:great|good) day here\b/i,
  /\bthat'?s a (?:great|good) day here\b/i,
];

const SIBLING_WINDOW_MS = 2 * 60 * 1000;
const ANNOUNCEMENT_HOLD_MS = 2 * 60 * 1000;

function normalizeDirection(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'INBOUND' || text === 'OUTBOUND') return text;
  return null;
}

function participantKind(participant) {
  if (!participant) return null;
  if (typeof participant.type === 'string') return participant.type;
  return participant.type?.value || null;
}

function typeOf(participant) {
  if (participant && participant.type && typeof participant.type === 'object') return participant.type;
  return {};
}

function statusOf(participant) {
  const status = participant?.status;
  if (!status) return null;
  if (typeof status === 'string') return status.toUpperCase();
  return String(status.value || '').toUpperCase();
}

function isGenericLineName(name) {
  if (!name) return false;
  const text = String(name).trim();
  return /^(main|main line|ring group|queue|reception|operator|auto attendant|ivr|office)$/i.test(text)
    || /forward/i.test(text);
}

function payloadPersonName(type) {
  const nested = type.line && typeof type.line === 'object' ? type.line : {};
  const fromUser = [type.userFirstName || nested.userFirstName, type.userLastName || nested.userLastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return fromUser || type.name || nested.name || null;
}

// UUID version nibble. GoTo desk/cloud conversation ids observed in production are
// version 3 (name-based). Joshua's rows are version 4 (random) and are the only
// rows whose direction was missing — consistent with the mobile/softphone session
// id, which this service does not generate itself. Confirm with a version=4 log
// line next to a STARTING payload; this function only classifies the id.
function callIdVersion(id) {
  const text = String(id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return null;
  return text.charAt(14);
}

function mentionsLivePerson(text, roster) {
  const names = (roster && roster.firstNames) || [];
  return names.some((name) => {
    if (/^josh$/i.test(name) && /hi there,\s+this is josh\b/i.test(text)) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(this is|i'm|i am|it's|it is)\\s+${escaped}\\b`, 'i').test(text);
  });
}

function isSystemRecordingUtterance(text, roster) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (ALWAYS_SYSTEM.some((pattern) => pattern.test(value))) return true;
  if (SCRIPT_UNLESS_LIVE.some((pattern) => pattern.test(value)) && !mentionsLivePerson(value, roster)) {
    return true;
  }
  return false;
}

function systemRecordingPromptLine() {
  return 'System recordings (never a live person, even if a name is spoken): the "this call may be recorded" announcement, the "thank you for calling" / "it\'s a great day here" greeting, the "we are currently assisting other callers" queue message and its continuation ("your call is very important to us", "please stay on the line"), the "best in custom blinds" tagline, the after-hours greeting in Joshua\'s voice that asks the caller to leave their name, carrier voicemail prompts ("your call has been forwarded to voicemail", "automated voice messaging system", "mailbox is full", "at the tone, please record your message", "when you have finished recording, you may hang up"), the "no call parked on that extension" message, business-hours messages, IVR menus ("press 1", "press one"), vendor hold queues ("estimated wait time", "save your place in line", "welcome to Bright"), and prompts that ask the caller to enter a zip code.';
}

function customerDialString(dialString, roster) {
  if (!dialString) return null;
  if (roster.isSystemNumber(dialString) || roster.extensionFrom(dialString)) return null;
  if (rosterApi.digitsOnly(dialString).length < 10) return null;
  return dialString;
}

// Keep a number already stored for THIS call (later events, including an ENDING
// with an empty participants array, often omit it). Never keep a number from an
// earlier call that reused the conversation id, and never borrow one.
function chooseExternalNumber({ proposed, existingNumber, existingCallCreated, callCreated, direction, dialString, roster }) {
  const sameCall = !existingCallCreated || !callCreated || existingCallCreated === callCreated;
  const fromDial = direction === 'OUTBOUND' ? customerDialString(dialString, roster) : null;
  const candidate = proposed || fromDial;
  if (candidate && !roster.isSystemNumber(candidate) && !roster.extensionFrom(candidate)) {
    return { number: candidate, reusedPrevious: false };
  }
  if (sameCall && existingNumber) return { number: existingNumber, reusedPrevious: false };
  if (!sameCall && existingNumber) return { number: null, reusedPrevious: true };
  return { number: null, reusedPrevious: false };
}

function usableCustomerNumber(number, roster) {
  if (!number) return false;
  if (roster.isSystemNumber(number)) return false;
  if (roster.extensionFrom(number)) return false;
  return rosterApi.digitsOnly(number).length >= 10;
}

// Call-state webhooks put caller/callee on type. The call events report's
// callStates wrap the same fields under type.phoneNumber. type.number is the
// DID that was dialed (or our outbound caller-id) whenever caller/callee is set.
function phoneBlock(participant) {
  const type = typeOf(participant);
  const nested = type.phoneNumber && typeof type.phoneNumber === 'object' ? type.phoneNumber : null;
  if (!nested) return type;
  return {
    ...type,
    ...nested,
    caller: nested.caller || type.caller,
    callee: nested.callee || type.callee,
    number: nested.number || type.number,
    name: nested.name || type.name,
  };
}

function stringNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function pickExternalFromParticipants({ direction, participants, dialString, roster }) {
  const candidates = [];
  for (const participant of participants) {
    const kind = participantKind(participant);
    if (kind !== 'PHONE_NUMBER' && kind !== 'PHONE_NUMBER_UNKNOWN') continue;
    const block = phoneBlock(participant);
    const caller = block.caller && typeof block.caller === 'object' ? block.caller : null;
    const callee = block.callee && typeof block.callee === 'object' ? block.callee : null;
    if (caller?.number) candidates.push({ number: caller.number, name: caller.name || null, role: 'caller' });
    if (callee?.number) candidates.push({ number: callee.number, name: callee.name || null, role: 'callee' });
    // phoneNumber.number / type.number is the outside party only when this
    // participant has no caller and no callee entry. When either entry exists,
    // that number is the dialed DID or our caller-id, even if the entry itself
    // has no number (blocked or anonymous).
    if (!caller && !callee && stringNumber(block.number)) {
      candidates.push({ number: block.number, name: block.name || null, role: 'number' });
    }
  }
  const usable = (candidate) => usableCustomerNumber(candidate.number, roster);
  if (direction === 'OUTBOUND') {
    const callee = candidates.find((candidate) => candidate.role === 'callee' && usable(candidate));
    if (callee) return { number: callee.number, name: callee.name };
    const other = candidates.find((candidate) => candidate.role !== 'caller' && usable(candidate));
    if (other) return { number: other.number, name: other.name };
    const dial = customerDialString(dialString, roster);
    if (dial) return { number: dial, name: null };
  } else if (direction === 'INBOUND') {
    const caller = candidates.find((candidate) => candidate.role === 'caller' && usable(candidate));
    if (caller) return { number: caller.number, name: caller.name };
    const other = candidates.find((candidate) => candidate.role !== 'callee' && usable(candidate));
    if (other) return { number: other.number, name: other.name };
  } else {
    const any = candidates.find(usable);
    if (any) return { number: any.number, name: any.name };
  }
  return { number: null, name: null };
}

// Inbound STARTING's originator is the outside caller. Call-state sometimes puts
// their number on callerNumber / ani / phoneNumber instead of type.caller, and the
// callee on a forwarded or direct-DID leg is our line. Only the originator's own
// caller fields count here — a callee DID is not the customer.
function originatorCustomerNumber(participants, roster) {
  for (const participant of participants || []) {
    if (!participantIsOriginator(participant)) continue;
    const type = typeOf(participant);
    const block = phoneBlock(participant);
    const callerObject = block.caller && typeof block.caller === 'object' ? block.caller.number : null;
    const candidates = [
      callerObject,
      typeof block.caller === 'string' ? block.caller : null,
      type.callerNumber,
      block.callerNumber,
      type.ani,
      typeof type.phoneNumber === 'string' ? type.phoneNumber : null,
      participant.callerNumber,
      typeof participant.phoneNumber === 'string' ? participant.phoneNumber : null,
      !block.caller && !block.callee ? block.number : null,
    ];
    for (const candidate of candidates) {
      if (usableCustomerNumber(candidate, roster)) return candidate;
    }
  }
  return null;
}

function extensionFromType(type, roster) {
  if (!type) return null;
  const nested = type.line && typeof type.line === 'object' ? type.line : {};
  return roster.extensionFrom(type.extensionNumber)
    || roster.extensionFrom(nested.extensionNumber)
    || roster.extensionFrom(type.extension)
    || roster.extensionFrom(nested.extension)
    || roster.extensionFrom(type.lineNumber)
    || roster.extensionFrom(type.number);
}

// Desk phones often set originator to the user session while participantId is the
// device. Accept either id, plus a leg id, so the placing line is not dropped.
function participantIsOriginator(participant) {
  if (!participant || !participant.originator) return false;
  const id = participant.participantId || participant.id || null;
  if (id && id === participant.originator) return true;
  if (participant.legId && participant.legId === participant.originator) return true;
  return false;
}

function lineFromParticipant(participant, roster) {
  const type = typeOf(participant);
  const nested = type.line && typeof type.line === 'object' ? type.line : {};
  const extension = extensionFromType(type, roster);
  const userKey = type.userKey || nested.userKey || type.userId || participant.userKey || participant.userId || null;
  const byKey = userKey ? roster.personByUserKey(userKey) : null;
  const byExtension = roster.personByExtension(extension);
  const known = byKey || byExtension;
  const payloadName = payloadPersonName(type);
  const generic = isGenericLineName(payloadName) || isGenericLineName(type.name);
  const isSystem = Boolean(!known && (roster.isSystemNumber(type.number) || generic));
  const status = statusOf(participant);
  return {
    participantId: participant.participantId || participant.id || null,
    legId: participant.legId || null,
    extension: known?.extension || extension || null,
    userKey: userKey || known?.userKey || null,
    name: known?.name || (isSystem ? null : payloadName),
    status,
    isOriginator: participantIsOriginator(participant),
    isSystem,
    connected: CONNECTED_STATUSES.has(status),
    matchedBy: byKey ? 'userKey' : (byExtension ? 'extension' : null),
  };
}

function ownerFromParticipant(participant, roster) {
  const kind = participantKind(participant);
  const type = typeOf(participant);
  if (kind === 'LINE') {
    const line = lineFromParticipant(participant, roster);
    if (line.isSystem) return { role: 'system' };
    return { role: 'team', extension: line.extension, name: line.name };
  }
  if (kind === 'PHONE_NUMBER' || kind === 'PHONE_NUMBER_UNKNOWN') {
    return { role: 'customer' };
  }
  return null;
}

function analyzeCallState(payload, roster = rosterApi.getRoster()) {
  const content = payload?.content || {};
  const metadata = content.metadata || {};
  const state = content.state || {};
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const direction = normalizeDirection(metadata.direction);
  const lines = [];
  const recordingOwners = {};
  let externalConnected = false;

  for (const participant of participants) {
    const kind = participantKind(participant);
    if (kind === 'LINE') lines.push(lineFromParticipant(participant, roster));
    if ((kind === 'PHONE_NUMBER' || kind === 'PHONE_NUMBER_UNKNOWN') && CONNECTED_STATUSES.has(statusOf(participant))) {
      externalConnected = true;
    }
    const type = typeOf(participant);
    const recordings = [].concat(participant.recordings || [], type.recordings || []);
    for (const recording of recordings) {
      const id = recording && (recording.id || recording.recordingId);
      if (!id) continue;
      const owner = ownerFromParticipant(participant, roster);
      if (owner) recordingOwners[id] = owner;
    }
  }

  for (const recording of state.recordings || []) {
    const id = recording && (recording.id || recording.recordingId);
    if (!id || recordingOwners[id]) continue;
    const ownerParticipant = participants.find((participant) => (
      (recording.participantId && participant.participantId === recording.participantId)
      || (recording.legId && participant.legId === recording.legId)
    ));
    if (!ownerParticipant) continue;
    const owner = ownerFromParticipant(ownerParticipant, roster);
    if (owner) recordingOwners[id] = owner;
  }

  const external = pickExternalFromParticipants({
    direction,
    participants,
    dialString: metadata.dialString,
    roster,
  });
  const originatorNumber = originatorCustomerNumber(participants, roster);

  // One non-system LINE on an outbound STARTING event is the person who dialed,
  // even when GoTo's originator id is the session rather than that device, and
  // even while the line is still RINGING. Extra ringing devices stay excluded.
  if (direction === 'OUTBOUND') {
    const human = lines.filter((line) => !line.isSystem && (line.name || line.extension));
    if (human.length === 1 && !human[0].isOriginator) human[0].isOriginator = true;
  }

  const participantLegIds = [];
  for (const participant of participants) {
    if (participant && participant.legId && !participantLegIds.includes(participant.legId)) {
      participantLegIds.push(participant.legId);
    }
  }

  return {
    direction,
    directionSource: direction ? 'metadata' : null,
    callCreated: metadata.callCreated || null,
    dialString: metadata.dialString || null,
    accountKey: metadata.accountKey || null,
    externalNumber: external.number,
    externalName: external.name,
    originatorNumber,
    lines,
    participantLegIds,
    recordingOwners,
    externalConnected,
    participantsEmpty: participants.length === 0,
    callIdVersion: callIdVersion(metadata.conversationSpaceId),
  };
}

const HISTORY_ANSWER_FIELDS = [
  'answerTime',
  'answerTimestamp',
  'answeredAt',
  'answeredTime',
  'connectTime',
  'connectedTime',
  'pickupTime',
  'callAnswered',
];

const EXPLICIT_ANSWERED = new Set(['ANSWERED', 'CONNECTED']);
const EXPLICIT_UNANSWERED = new Set([
  'NO_ANSWER',
  'NOANSWER',
  'NOT_ANSWERED',
  'UNANSWERED',
  'MISSED',
  'BUSY',
  'USER_BUSY',
  'ORIGINATOR_CANCEL',
  'CANCEL',
  'CANCELLED',
  'CANCELED',
  'CALL_REJECTED',
  'NO_USER_RESPONSE',
]);

function historyDisposition(content) {
  return String(
    content.disposition || content.callDisposition || content.result || content.callResult || '',
  ).trim().toUpperCase();
}

function historyAnswerTime(content) {
  if (!content || typeof content !== 'object') return null;
  for (const key of HISTORY_ANSWER_FIELDS) {
    if (content[key]) return content[key];
  }
  if (content.answered === true) return content.startTime || true;
  if (typeof content.answered === 'string') {
    const text = content.answered.trim();
    if (text && !/^(false|no)$/i.test(text)) return text;
  }
  if (EXPLICIT_ANSWERED.has(historyDisposition(content))) return content.startTime || true;
  // Talk time is connected conversation time. Ring duration is not an answer.
  const talk = Number(content.talkTime ?? content.talkDuration ?? content.talkTimeMs);
  if (Number.isFinite(talk) && talk > 0) return content.startTime || true;
  return null;
}

function historyExplicitlyUnanswered(content) {
  if (!content || typeof content !== 'object') return false;
  if (historyAnswerTime(content)) return false;
  if (content.answered === false) return true;
  if (typeof content.answered === 'string' && /^(false|no)$/i.test(content.answered.trim())) return true;
  if (EXPLICIT_UNANSWERED.has(historyDisposition(content))) return true;
  const cause = String(content.hangupCause || '').trim().toUpperCase();
  return EXPLICIT_UNANSWERED.has(cause);
}

function partyExtension(party, roster) {
  if (!party || typeof party !== 'object') return null;
  return roster.extensionFrom(party.extensionNumber)
    || roster.extensionFrom(party.extension)
    || roster.extensionFrom(party.number);
}

function partyLooksInternal(party, extension) {
  if (extension) return true;
  if (!party || typeof party !== 'object') return false;
  const kind = String(party.type || party.participantType || '').toUpperCase();
  if (kind === 'LINE') return true;
  return Boolean(party.userKey || party.userId || party.extensionNumber || party.extension);
}

// Call-history parties sometimes nest the line under `type`, the same way
// call-state participants do. Lift the fields partyExtension/partyPerson read.
function flattenParty(party) {
  if (!party || typeof party !== 'object') return {};
  const type = party.type && typeof party.type === 'object' ? party.type : {};
  const name = party.name || type.name || null;
  const number = party.number || party.phoneNumber || type.number || type.phoneNumber || null;
  return {
    ...type,
    ...party,
    name,
    number,
    phoneNumber: party.phoneNumber || type.phoneNumber || number,
    extensionNumber: party.extensionNumber || type.extensionNumber || party.extension || type.extension || null,
    extension: party.extension || type.extension || null,
    userKey: party.userKey || type.userKey || null,
    userId: party.userId || type.userId || null,
    type: typeof party.type === 'string' ? party.type : (type.value || party.participantType || null),
  };
}

function partyPerson(party, roster) {
  const extension = partyExtension(party, roster);
  const byExtension = roster.personByExtension(extension);
  if (byExtension) {
    return { person: byExtension, extension: byExtension.extension || extension, matchedBy: 'extension' };
  }
  const byInternalName = partyLooksInternal(party, extension) ? roster.personByName(party && party.name) : null;
  if (byInternalName) return { person: byInternalName, extension: byInternalName.extension, matchedBy: 'name' };
  // Desk caller-id: the roster name beside the office DID, not an extension.
  const number = party && (party.number || party.phoneNumber);
  const byDidName = roster.personByName(party && party.name);
  if (byDidName && number && roster.isSystemNumber(number)) {
    return { person: byDidName, extension: byDidName.extension, matchedBy: 'name' };
  }
  if (extension) return { person: null, extension, matchedBy: 'extension' };
  return { person: null, extension: null, matchedBy: null };
}

function firstCustomerNumber(candidates, roster) {
  for (const candidate of candidates) {
    if (usableCustomerNumber(candidate, roster)) return candidate;
  }
  return null;
}

// The far end is a teammate when GoTo's party name or a learned phone matches the
// roster. This does not change who is credited as the answering/placing line, and
// it does not drop the number — the note still posts on that phone's thread.
function teamMatchFromParty(party, roster) {
  if (!party || !roster) return null;
  const number = party.number || party.phoneNumber;
  const byPhone = typeof roster.personByPhone === 'function' ? roster.personByPhone(number) : null;
  if (byPhone) return { person: byPhone, matchedBy: 'phone' };
  const byName = typeof roster.matchTeamName === 'function' ? roster.matchTeamName(party.name) : null;
  if (byName) return { person: byName, matchedBy: 'name' };
  return null;
}

function sameTeamMember(person, teamMember) {
  if (!person || !teamMember) return false;
  if (person.extension && teamMember.extension && person.extension === teamMember.extension) return true;
  const left = String(person.name || '').trim().toLowerCase();
  const right = String(teamMember.name || '').trim().toLowerCase();
  return Boolean(left && right && left === right);
}

function otherPartyRecord(person, matchedBy) {
  if (!person || (!person.name && !person.extension)) return null;
  return {
    name: person.name || null,
    extension: person.extension || null,
    matchedBy: matchedBy || null,
  };
}

function otherPartyFromHistory({
  caller, callee, callerIsInternal, calleeIsInternal, callerInfo, calleeInfo, teamMember, roster,
}) {
  if (callerIsInternal && calleeIsInternal) {
    const callerIsCredited = sameTeamMember(
      (callerInfo && callerInfo.person) || { name: caller.name, extension: callerInfo && callerInfo.extension },
      teamMember,
    );
    const otherRaw = callerIsCredited ? callee : caller;
    const info = callerIsCredited ? calleeInfo : callerInfo;
    const matched = teamMatchFromParty(otherRaw, roster);
    const person = (info && info.person) || (matched && matched.person) || {
      name: otherRaw.name || null,
      extension: (info && info.extension) || null,
    };
    const matchedBy = (info && info.extension) ? 'extension' : ((matched && matched.matchedBy) || 'name');
    return otherPartyRecord(person, matchedBy);
  }
  const far = callerIsInternal && !calleeIsInternal
    ? callee
    : (!callerIsInternal && calleeIsInternal ? caller : null);
  if (!far) return null;
  const match = teamMatchFromParty(far, roster);
  if (!match || sameTeamMember(match.person, teamMember)) return null;
  return otherPartyRecord(match.person, match.matchedBy);
}

function analyzeCallHistory(content = {}, roster = rosterApi.getRoster()) {
  const caller = flattenParty(content.caller);
  const callee = flattenParty(content.callee);
  const legDirection = normalizeDirection(content.direction);
  const callerInfo = partyPerson(caller, roster);
  const calleeInfo = partyPerson(callee, roster);
  const userKey = content.userKey || content.userId || caller.userKey || callee.userKey || caller.userId || callee.userId || null;
  const userPerson = roster.personByUserKey(userKey);
  const callerIsInternal = Boolean(callerInfo.extension || callerInfo.person);
  const calleeIsInternal = Boolean(calleeInfo.extension || calleeInfo.person);
  const answerTime = historyAnswerTime(content);
  const answered = Boolean(answerTime);
  const explicitlyUnanswered = historyExplicitlyUnanswered(content);

  let person = null;
  let extension = null;
  let matchedBy = null;
  let externalNumber = null;
  let externalName = null;

  const calleeNumber = firstCustomerNumber([
    callee.number,
    callee.phoneNumber,
    content.dialString,
    content.dialedNumber,
    content.dialed,
  ], roster);
  const callerNumber = firstCustomerNumber([caller.number, caller.phoneNumber], roster);

  if (callerIsInternal && !calleeIsInternal) {
    person = callerInfo.person || (callerInfo.extension ? { name: caller.name || null, extension: callerInfo.extension } : null);
    extension = person?.extension || callerInfo.extension;
    matchedBy = callerInfo.matchedBy;
    if (calleeNumber) {
      externalNumber = calleeNumber;
      externalName = callee.name || null;
    }
  } else if (calleeIsInternal && !callerIsInternal) {
    person = calleeInfo.person || (calleeInfo.extension ? { name: callee.name || null, extension: calleeInfo.extension } : null);
    extension = person?.extension || calleeInfo.extension;
    matchedBy = calleeInfo.matchedBy;
    if (callerNumber) {
      externalNumber = callerNumber;
      externalName = caller.name || null;
    }
  } else if (userPerson && legDirection === 'OUTBOUND' && calleeNumber) {
    person = userPerson;
    extension = userPerson.extension;
    matchedBy = 'userKey';
    externalNumber = calleeNumber;
    externalName = callee.name || null;
  } else if (userPerson && legDirection === 'INBOUND' && callerNumber) {
    person = userPerson;
    extension = userPerson.extension;
    matchedBy = 'userKey';
    externalNumber = callerNumber;
    externalName = caller.name || null;
  } else if (userPerson && legDirection === 'OUTBOUND') {
    person = userPerson;
    extension = userPerson.extension;
    matchedBy = 'userKey';
  } else if (legDirection === 'OUTBOUND') {
    // Desk history often shows the person's name with a caller-id DID, and the
    // users API may 403 before userKey can be linked. A unique roster name is enough.
    const byName = roster.personByName(caller.name);
    if (byName) {
      person = byName;
      extension = byName.extension;
      matchedBy = 'name';
    }
  } else if (!person && (legDirection === 'INBOUND' || !legDirection)) {
    // Inbound history often names the answerer on the callee and puts the office
    // DID in the number, so the extension match never sees them.
    const byName = roster.personByName(callee.name);
    if (byName) {
      person = byName;
      extension = byName.extension;
      matchedBy = 'name';
      if (!externalNumber && callerNumber) {
        externalNumber = callerNumber;
        externalName = caller.name || null;
      }
    }
  }

  // STARTING on a desk phone often has no callee. The dialed number is on history.
  if (!externalNumber && legDirection === 'OUTBOUND' && calleeNumber) {
    externalNumber = calleeNumber;
    externalName = externalName || callee.name || null;
  }
  if (!externalNumber && legDirection === 'INBOUND' && callerNumber) {
    externalNumber = callerNumber;
    externalName = externalName || caller.name || null;
  }

  const canonical = roster.personByExtension(extension) || person;
  const resolvedBy = matchedBy === 'userKey' ? 'userKey' : (matchedBy || null);
  const teamMember = (canonical && (canonical.name || canonical.extension || extension))
    ? {
      name: canonical.name || null,
      extension: canonical.extension || extension || null,
      userKey: userKey || canonical.userKey || null,
      answered,
      answerTime: answerTime && answerTime !== true ? answerTime : null,
      matchedBy: resolvedBy,
    }
    : null;

  const otherParty = otherPartyFromHistory({
    caller,
    callee,
    callerIsInternal,
    calleeIsInternal,
    callerInfo,
    calleeInfo,
    teamMember,
    roster,
  });

  return {
    legId: content.legId || null,
    originatorId: content.originatorId || null,
    conversationSpaceId: content.conversationSpaceId || null,
    legDirection,
    answered,
    explicitlyUnanswered,
    answerTime: answerTime && answerTime !== true ? answerTime : null,
    teamMember,
    otherParty,
    externalNumber,
    externalName,
    startTime: content.startTime || content.callCreated || content.timestamp || null,
  };
}

function oppositeRole(role) {
  if (role === 'team') return 'customer';
  if (role === 'customer') return 'team';
  if (role === 'system') return 'customer';
  return null;
}

// role is 'team' | 'customer' | 'system' | null
function channelRole(channel, leg) {
  const number = Number(channel);
  const owner = leg.recordingOwner || (leg.recordingOwners && leg.recordingId && leg.recordingOwners[leg.recordingId]) || null;
  if (owner && owner.role && (number === 0 || number === 1)) {
    return number === 0 ? owner.role : oppositeRole(owner.role);
  }
  if (leg.direction === 'INBOUND') {
    if (number === 0) return 'customer';
    if (number === 1) return 'team';
  }
  if (leg.direction === 'OUTBOUND') {
    if (number === 0) return 'team';
    if (number === 1) return 'customer';
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// First names the leg already credits as staff. "Josh" counts for Joshua because
// that is how the after-hours greeting and live intros refer to him. Customer
// first names are not included.
function teamIntroNames(leg) {
  const names = [];
  const push = (name) => {
    const cleaned = String(name || '').trim();
    if (!cleaned) return;
    if (names.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) return;
    names.push(cleaned);
  };
  for (const entry of (leg && leg.csrChain) || []) {
    const first = String(entry.name || '').trim().split(/\s+/)[0];
    if (!first) continue;
    push(first);
    if (/^joshua$/i.test(first)) push('Josh');
  }
  return names;
}

// "Budget Blinds" plus mishearings seen in live transcripts, including
// "Lions", "Blends", and singular "Blind".
const BUSINESS_NAME_ALT = 'blinds|lines|minds|binds|lions|blends|blind';
const BUSINESS_NAME = `budget\\s*(?:${BUSINESS_NAME_ALT})`;
const NOT_A_PERSON_NAME = '(?:the|a|an|my|your|our|that|it|just)\\b';
// "this is Joshua over at Budget Blinds" / "this is Marie with Budget Blinds".
const TEAM_SELF_ID_AT_BUSINESS = new RegExp(
  `\\bthis is\\s+(?!${NOT_A_PERSON_NAME}\\b)[A-Za-z][A-Za-z']+(?:\\s+[A-Za-z][A-Za-z']+){0,2}\\s+(?:over\\s+at|at|with|from)\\s+${BUSINESS_NAME}\\b`,
  'i',
);
const TEAM_I_AM_AT_BUSINESS = new RegExp(
  `\\b(?:i'm|i am)\\s+(?!${NOT_A_PERSON_NAME}\\b)[A-Za-z][A-Za-z']+\\s+(?:over\\s+at|at|with|from)\\s+${BUSINESS_NAME}\\b`,
  'i',
);
const TEAM_I_AM_WITH_BUSINESS = new RegExp(`\\b(?:i'm|i am)\\s+with\\s+${BUSINESS_NAME}\\b`, 'i');
// "it's Josh with budget blinds and Sacramento" — our rep calling another franchise.
// "it's a great day" is not a name (NOT_A_PERSON_NAME).
const TEAM_ITS_NAME_AT_BUSINESS = new RegExp(
  `\\bit(?:'s| is)\\s+(?!${NOT_A_PERSON_NAME}\\b)[A-Za-z][A-Za-z']+(?:\\s+[A-Za-z][A-Za-z']+){0,2}\\s+(?:over\\s+at|at|with|from)\\s+${BUSINESS_NAME}\\b`,
  'i',
);
// "calling on behalf of", "giving a call on behalf of", "giving you a call from",
// "reaching out on behalf of", "calling from", and the same frames with the business name.
const TEAM_ON_BEHALF = new RegExp(
  `\\b(?:calling on behalf of|giving(?: you)? a call on behalf of|giving(?: you)? a call from|reaching out on behalf of|calling from|on behalf of)\\s+${BUSINESS_NAME}\\b`,
  'i',
);
// A played open greeting can name a person without proving which stereo channel
// is the live team member. The after-hours greeting is already system audio.
const GREETING_NOT_CHANNEL_PROOF = /\b(?:it'?s a (?:great|good) day here at|thank you for calling)\b/i;

function utteranceCanProveTeamChannel(text, roster) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (isSystemRecordingUtterance(value, roster)) return false;
  if (GREETING_NOT_CHANNEL_PROOF.test(value)) return false;
  return true;
}

// First names on the active roster. Josh counts for Joshua. Used only when the
// leg does not already name a team member — a bare "this is Emily" is not enough.
function rosterIntroNames(roster) {
  const names = [];
  const push = (name) => {
    const cleaned = String(name || '').trim();
    if (!cleaned) return;
    if (names.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) return;
    names.push(cleaned);
  };
  for (const name of (roster && roster.firstNames) || []) push(name);
  if (names.some((name) => /^joshua$/i.test(name))) push('Josh');
  return names;
}

// "my name is Emily ... Budget Lions" / "this is Joshua ... on behalf of".
// A few words, punctuation included. Not "I'm calling for Emily" or "is Emily available".
function rosterIntroNearBusiness(text, roster) {
  return rosterIntroNames(roster).some((name) => {
    const pattern = new RegExp(
      `\\b(?:this is|i'm|i am|my name is)\\s+${escapeRegExp(name)}\\b(?!['’])` +
      `(?:[\\s,.;:!?]+\\S+){0,8}[\\s,.;:!?]+(?:on behalf of\\b|${BUSINESS_NAME}\\b)`,
      'i',
    );
    return pattern.test(text);
  });
}

function textHasTeamSelfIdentification(text, leg, roster) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (TEAM_SELF_ID_AT_BUSINESS.test(value)) return true;
  if (TEAM_ITS_NAME_AT_BUSINESS.test(value)) return true;
  if (TEAM_I_AM_AT_BUSINESS.test(value)) return true;
  if (TEAM_I_AM_WITH_BUSINESS.test(value)) return true;
  if (TEAM_ON_BEHALF.test(value)) return true;
  const credited = teamIntroNames(leg);
  if (credited.some((name) => {
    const pattern = new RegExp(
      `\\b(?:this is|i'm|i am|my name is)\\s+${escapeRegExp(name)}\\b(?!['’])`,
      'i',
    );
    return pattern.test(value);
  })) return true;
  // No name on the leg: any roster first name still counts when the business
  // (or "on behalf of") follows within a few words.
  if (!credited.length && rosterIntroNearBusiness(value, roster)) return true;
  return false;
}

// The live open greeting proves which inbound channel is the company side.
// The after-hours recording and the park/queue prompts do not: those can sit
// on the caller's channel without the team member being there.
function inboundLiveTeamCue(text) {
  const value = String(text || '');
  if (/please leave (your )?name/i.test(value)) return false;
  if (/hi there,\s+this is josh\b/i.test(value)) return false;
  if (/no call parked/i.test(value)) return false;
  if (/currently assisting other callers/i.test(value)) return false;
  if (/\bit'?s a (?:great|good) day\b/i.test(value)) return true;
  if (/\bhow can i help you\b/i.test(value)) return true;
  if (/\bthank you for calling\b/i.test(value) && new RegExp(BUSINESS_NAME, 'i').test(value)) return true;
  return false;
}

function liveRosterSpeakingIntro(text, roster) {
  const value = String(text || '');
  if (!value.trim() || isSystemRecordingUtterance(value, roster)) return false;
  return rosterIntroNames(roster).some((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(`\\b(?:this is|i'm|i am)\\s+${escaped}\\b`, 'i').test(value)
      || new RegExp(`\\b${escaped}\\s+speaking\\b`, 'i').test(value);
  });
}

function channelProvesInboundTeam(utterances, channel, leg, roster) {
  return (utterances || []).some((utterance) => {
    if (Number(utterance.channel) !== channel) return false;
    if (inboundLiveTeamCue(utterance.text)) return true;
    if (liveRosterSpeakingIntro(utterance.text, roster)) return true;
    if (!utteranceCanProveTeamChannel(utterance.text, roster)) return false;
    return textHasTeamSelfIdentification(utterance.text, leg || {}, roster);
  });
}

function claimTeamChannel(roles, present, teamChannel) {
  roles[teamChannel] = 'team';
  for (const channel of present) {
    if (channel === teamChannel) continue;
    if (roles[channel] === 'team' || roles[channel] == null) roles[channel] = 'customer';
  }
}

// GoTo's channel map, corrected when a single channel's own introduction
// contradicts it. Does not look at which channel spoke first.
// Inbound calls also flip when the open greeting ("Budget Blinds, how can I
// help you") or a live roster introduction landed on the customer channel.
function channelRolesForLeg(utterances, leg, roster = rosterApi.getRoster()) {
  const present = [];
  for (const utterance of utterances || []) {
    const channel = Number(utterance && utterance.channel);
    if (!Number.isFinite(channel) || present.includes(channel)) continue;
    present.push(channel);
  }
  const roles = {};
  for (const channel of present) roles[channel] = channelRole(channel, leg || {});

  let signalChannels = present.filter((channel) => {
    const text = (utterances || [])
      .filter((utterance) => Number(utterance.channel) === channel && utteranceCanProveTeamChannel(utterance.text, roster))
      .map((utterance) => utterance.text)
      .join(' ');
    return textHasTeamSelfIdentification(text, leg || {}, roster);
  });
  // Both sides can say "Budget Blinds" when one franchise calls another.
  // The channel that names the person who placed the call stays the team side.
  if (signalChannels.length > 1) {
    const credited = teamIntroNames(leg || {});
    const named = signalChannels.filter((channel) => {
      const text = (utterances || [])
        .filter((utterance) => Number(utterance.channel) === channel)
        .map((utterance) => utterance.text)
        .join(' ');
      return credited.some((name) => new RegExp(
        `\\b(?:this is|i'm|i am|my name is|it(?:'s| is))\\s+${escapeRegExp(name)}\\b`,
        'i',
      ).test(text));
    });
    if (named.length === 1) signalChannels = named;
  }
  if (signalChannels.length === 1) {
    const teamChannel = signalChannels[0];
    const current = roles[teamChannel];
    if (current !== 'team' && (current === 'customer' || current == null)) {
      claimTeamChannel(roles, present, teamChannel);
      return { roles, corrected: true, teamChannel };
    }
  }

  if ((leg && leg.direction) === 'INBOUND') {
    const proof = present.filter((channel) => channelProvesInboundTeam(utterances, channel, leg || {}, roster));
    if (proof.length === 1 && roles[proof[0]] === 'customer') {
      claimTeamChannel(roles, present, proof[0]);
      return { roles, corrected: true, teamChannel: proof[0] };
    }
  }
  return { roles, corrected: false };
}

function simpleUtterances(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.results || raw.items || raw.transcriptions || [];
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && (item.transcript || item.text))
    .map((item) => ({ text: String(item.transcript || item.text || '').trim() }))
    .filter((item) => item.text);
}

function transcriptIsSubstantive(raw, roster = rosterApi.getRoster()) {
  const utterances = simpleUtterances(raw);
  if (!utterances.length) return false;
  return utterances.some((utterance) => !isSystemRecordingUtterance(utterance.text, roster));
}

function detailedUtterances(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.results || raw.items || raw.transcriptions || [];
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && (item.transcript || item.text))
    .map((item) => ({
      text: String(item.transcript || item.text || '').trim(),
      // A missing channel is what the doc labels as channel 0. Number(undefined)
      // is NaN, which dropped the line from the answerer while the doc still
      // showed it as Team Member.
      channel: item.channel == null || item.channel === '' ? 0 : Number(item.channel),
      startTimeMs: Number(item.startTimeMs ?? item.start_time_ms) || 0,
    }))
    .filter((item) => item.text);
}

// One short non-system line (the start of a voicemail greeting, a one-second
// fragment) is not a separate conversation when a sibling recording has the rest.
function callIsFragment({ transcript, callCreated, callEnded } = {}, roster = rosterApi.getRoster()) {
  if (!transcriptIsSubstantive(transcript, roster)) return false;
  const utterances = simpleUtterances(transcript).filter((utterance) => !isSystemRecordingUtterance(utterance.text, roster));
  if (utterances.length !== 1) return false;
  const words = utterances[0].text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 8) return true;
  if (callCreated && callEnded) {
    const ms = new Date(callEnded).getTime() - new Date(callCreated).getTime();
    if (ms >= 0 && ms < 3000) return true;
  }
  return false;
}

function peopleMatchingIntroToken(roster, token) {
  const target = String(token || '').trim().toLowerCase();
  if (!target) return [];
  const canonical = target === 'josh' ? 'joshua' : target;
  const matches = [];
  for (const entry of roster.byExtension.values()) {
    const first = String(entry.name || '').trim().split(/\s+/)[0].toLowerCase();
    if (first === canonical) matches.push(entry);
  }
  return matches;
}

function personFromIntroTokens(roster, tokens) {
  const matched = [];
  for (const token of tokens) {
    for (const entry of peopleMatchingIntroToken(roster, token)) {
      if (!matched.some((existing) => existing.name === entry.name && existing.extension === entry.extension)) {
        matched.push(entry);
      }
    }
  }
  const names = [...new Set(matched.map((entry) => entry.name))];
  if (names.length !== 1) return null;
  const same = matched.filter((entry) => entry.name === names[0]);
  // Roster order. Amy Bullock is listed on 00001 and again on 00005 (home
  // office); a spoken "Amy" with no extension from GoTo uses the first line.
  const extensions = [];
  for (const entry of same) {
    if (entry.extension && !extensions.includes(entry.extension)) extensions.push(entry.extension);
  }
  return { name: names[0], extension: extensions[0] || null };
}

function statedRosterPerson(text, roster) {
  // The earliest live introduction wins. A later "this is Emily" must not
  // erase "This is Josh speaking" by making the whole call ambiguous.
  let best = null;
  for (const name of rosterIntroNames(roster)) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      `\\b(?:this is|i'm|i am)\\s+${escaped}\\b|\\b${escaped}\\s+speaking\\b`,
      'ig',
    );
    let match = pattern.exec(text);
    while (match) {
      if (!best || match.index < best.index) best = { index: match.index, name };
      match = pattern.exec(text);
    }
  }
  if (!best) return null;
  return personFromIntroTokens(roster, [best.name]);
}

function askedRosterPerson(text, roster) {
  const tokens = [];
  for (const name of rosterIntroNames(roster)) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      `\\b(?:is|for)\\s+${escaped}\\s+there\\b` +
      `|\\b(?:speak|talk|speaking)\\s+(?:to|with)\\s+${escaped}\\b` +
      `|\\b${escaped}\\s+there\\b` +
      `|\\bis this\\s+${escaped}\\b` +
      `|\\b(?:was\\s+)?calling for\\s+${escaped}\\b` +
      `|\\b${escaped}\\s*,\\s*please\\b`,
      'i',
    );
    if (pattern.test(text)) tokens.push(name);
  }
  return personFromIntroTokens(roster, tokens);
}

const CONFIRM_ME = /\b(?:that would be me|that'?s me|this is (?:she|her|he|him)|you'?re speaking with(?: me)?|it'?s me|yes it is)\b/i;

function roleForUtterance(assignment, utterance, leg) {
  const channel = Number(utterance.channel);
  if (Object.prototype.hasOwnProperty.call(assignment.roles, channel)) return assignment.roles[channel];
  return channelRole(channel, leg);
}

// Team vs customer text using the same channel map the doc labels use.
function speakerTexts(leg, roster) {
  const utterances = detailedUtterances(leg && leg.transcript);
  if (!utterances.length) return null;
  const assignment = channelRolesForLeg(utterances, leg, roster);
  const textFor = (role) => utterances
    .filter((utterance) => roleForUtterance(assignment, utterance, leg) === role && !isSystemRecordingUtterance(utterance.text, roster))
    .map((utterance) => utterance.text)
    .join(' ');
  return { teamText: textFor('team'), customerText: textFor('customer') };
}

// The person speaking on the channel the doc labels as the team side.
// Does not require the leg's own direction: a queue leg of an inbound call is
// often tagged OUTBOUND, and that tag used to skip this match entirely.
function teamChannelAnswerer(leg, roster = rosterApi.getRoster()) {
  const texts = speakerTexts(leg, roster);
  if (!texts) return null;
  const stated = statedRosterPerson(texts.teamText, roster);
  if (stated) return stated;
  const asked = askedRosterPerson(texts.customerText, roster);
  if (asked && CONFIRM_ME.test(texts.teamText)) return asked;
  return null;
}

// Used only when call history and call-state never named an inbound answerer.
// Reads the team channel after the same channel correction the transcript uses.
function answererFromTranscript(leg, roster = rosterApi.getRoster()) {
  if (!leg || (leg.direction && leg.direction !== 'INBOUND')) return null;
  const asInbound = leg.direction ? leg : { ...leg, direction: 'INBOUND' };
  return teamChannelAnswerer(asInbound, roster);
}

// "my name is Emily ... on behalf of Budget Blinds" / "this is Emily with Budget Blinds".
// Same window as rosterIntroNearBusiness. A greeting with no roster name stays unknown.
function personFromOutboundIntro(text, roster) {
  const tokens = [];
  for (const name of rosterIntroNames(roster)) {
    const pattern = new RegExp(
      `\\b(?:this is|i'm|i am|my name is)\\s+${escapeRegExp(name)}\\b(?!['’])` +
      `(?:[\\s,.;:!?]+\\S+){0,8}[\\s,.;:!?]+(?:on behalf of\\b|${BUSINESS_NAME}\\b)`,
      'i',
    );
    if (pattern.test(text)) tokens.push(name);
  }
  return personFromIntroTokens(roster, tokens);
}

function outboundIntroAnswerer(leg, roster = rosterApi.getRoster()) {
  if (!leg || leg.direction !== 'OUTBOUND') return null;
  const texts = speakerTexts(leg, roster);
  if (!texts || !texts.teamText) return null;
  return personFromOutboundIntro(texts.teamText, roster);
}

function last10(value) {
  return rosterApi.last10(value);
}

function sameCustomer(a, b) {
  if (!a || !b) return false;
  const left = last10(a);
  const right = last10(b);
  return Boolean(left && right && left === right);
}

function timeRangesOverlap(a, b) {
  const aStart = a.callCreated ? new Date(a.callCreated).getTime() : null;
  const aEnd = a.callEnded ? new Date(a.callEnded).getTime() : null;
  const bStart = b.callCreated ? new Date(b.callCreated).getTime() : null;
  const bEnd = b.callEnded ? new Date(b.callEnded).getTime() : null;
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return true;
  const margin = 5 * 1000;
  return bStart < aEnd + margin && aStart < bEnd + margin;
}

function withinWindow(aIso, bIso, windowMs) {
  if (!aIso || !bIso) return false;
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) <= windowMs;
}

// Prefer a leg that actually has audio, then an explicit answered/not-answered
// status. A tie keeps the earlier start.
function detailScore(info = {}) {
  let score = 0;
  if (info.hasTranscript) score += 8;
  if (info.hasRecording) score += 4;
  if (info.answered === true) score += 2;
  else if (info.answered === false) score += 1;
  return score;
}

// How to post one interaction given other open/recent calls. Never invents a phone
// number. Same-direction split legs (greeting, then the answered call) collapse.
// Opposite-direction calls and two real back-to-back conversations stay separate.
// Two same-direction legs for one number that both lack a conversation, and that
// start within SIBLING_WINDOW_MS, post once — overlap was missing the ~1s twins.
function otherHasContent(other) {
  return Boolean(other && other.substantive && !other.fragment);
}

function postingPlan({
  externalNumber,
  externalConflict,
  direction,
  callCreated,
  callEnded,
  substantive,
  fragment = false,
  hasTranscript = false,
  hasRecording = false,
  answered = null,
  now = Date.now(),
  openSiblings = [],
  recent = null,
}) {
  if (externalConflict) return { action: 'review', reason: 'conflicting external numbers' };
  if (!externalNumber) {
    // A one-minute answered inbound often ends before call history delivers the
    // caller id. Hold, using the same 3-minute backstop as transcripts, so the
    // number can still land on the first note. A hours-only greeting is not
    // substantive and still closes without a number.
    if (direction === 'INBOUND' && substantive && callEnded) {
      const age = now - new Date(callEnded).getTime();
      if (Number.isFinite(age) && age >= 0 && age < 3 * 60 * 1000) {
        return { action: 'hold', reason: 'waiting for inbound caller number' };
      }
    }
    return { action: 'review', reason: 'missing external number' };
  }

  const sameCall = (other) => other
    && other.direction === direction
    && sameCustomer(other.externalNumber, externalNumber);

  if (recent && recent.groupKey && sameCall(recent)) {
    const close = withinWindow(recent.callCreated, callCreated, SIBLING_WINDOW_MS);
    const overlap = timeRangesOverlap(recent, { callCreated, callEnded });
    if (close || overlap) {
      // A real conversation is never the leg we drop, including when an empty
      // or one-line fragment for the same number already posted.
      if (substantive && !fragment && (recent.substantive === false || recent.fragment)) {
        return { action: 'post', reason: 'substantive conversation' };
      }
      if (fragment && otherHasContent(recent)) {
        return { action: 'suppress', reason: 'fragment leg of a conversation', skipArtifacts: true };
      }
      if (!substantive && recent.substantive === false && (close || overlap)) {
        return { action: 'suppress', reason: 'same-minute duplicate with no conversation', skipArtifacts: true };
      }
      if (overlap) {
        return { action: 'suppress', reason: 'overlapping duplicate leg', skipArtifacts: true };
      }
    }
  }

  const sibling = openSiblings.find((other) => sameCall(other) && withinWindow(other.callCreated, callCreated, SIBLING_WINDOW_MS));
  if (sibling) {
    if (fragment && otherHasContent(sibling)) {
      return { action: 'suppress', reason: 'fragment leg of a conversation', skipArtifacts: true };
    }
    if (substantive && !fragment && sibling.fragment) {
      return {
        action: 'post',
        reason: 'substantive conversation',
        suppressSibling: sibling.groupKey,
        skipSiblingArtifacts: true,
      };
    }
    if (!substantive && sibling.substantive) {
      return { action: 'suppress', reason: 'announcement leg of an open conversation', mergeInto: sibling.groupKey, skipArtifacts: true };
    }
    if (substantive && !sibling.substantive) {
      return { action: 'post', reason: 'substantive leg', suppressSibling: sibling.groupKey, skipSiblingArtifacts: true };
    }
    if (!substantive && !sibling.substantive) {
      const age = callEnded ? now - new Date(callEnded).getTime() : 0;
      const siblingEnded = Boolean(sibling.callEnded);
      const siblingAge = siblingEnded ? now - new Date(sibling.callEnded).getTime() : 0;
      const waitingOnUs = !callEnded || age < ANNOUNCEMENT_HOLD_MS;
      const waitingOnSibling = siblingEnded && siblingAge < ANNOUNCEMENT_HOLD_MS;
      if (waitingOnUs || waitingOnSibling) {
        return { action: 'hold', reason: 'waiting to see which leg has the conversation' };
      }
      if (siblingEnded) {
        const currentScore = detailScore({ hasTranscript, hasRecording, answered });
        const siblingScore = detailScore(sibling);
        const currentEarlier = !sibling.callCreated || (callCreated && String(callCreated) <= String(sibling.callCreated));
        const currentWins = currentScore > siblingScore || (currentScore === siblingScore && currentEarlier);
        if (currentWins) {
          return {
            action: 'post',
            reason: 'preferred same-minute leg',
            suppressSibling: sibling.groupKey,
            skipSiblingArtifacts: true,
          };
        }
        return { action: 'suppress', reason: 'same-minute duplicate with no conversation', skipArtifacts: true };
      }
    }
    if (timeRangesOverlap({ callCreated, callEnded }, sibling)) {
      return { action: 'suppress', reason: 'overlapping open duplicate', mergeInto: sibling.groupKey, skipArtifacts: true };
    }
    return { action: 'post', reason: 'separate substantive call' };
  }

  if (fragment && callEnded && (now - new Date(callEnded).getTime()) < ANNOUNCEMENT_HOLD_MS) {
    return { action: 'hold', reason: 'fragment hold' };
  }
  if (!substantive && callEnded && (now - new Date(callEnded).getTime()) < ANNOUNCEMENT_HOLD_MS) {
    return { action: 'hold', reason: 'announcement-only hold' };
  }
  return { action: 'post', reason: 'ready' };
}

function reportBody(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.callStates || report.participants) return report;
  if (report.content && typeof report.content === 'object') return report.content;
  return report;
}

function reportLineFields(participant) {
  const type = typeOf(participant);
  const nested = type.line && typeof type.line === 'object' ? type.line : {};
  const fromUser = [type.userFirstName || nested.userFirstName, type.userLastName || nested.userLastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return {
    extensionNumber: type.extensionNumber || nested.extensionNumber || (participant && participant.number) || null,
    name: type.name || nested.name || (participant && participant.name) || fromUser || null,
    userKey: type.userKey || nested.userKey || (participant && participant.userKey) || null,
    userFirstName: type.userFirstName || nested.userFirstName || null,
    userLastName: type.userLastName || nested.userLastName || null,
  };
}

function mergeReportFields(primary, extra) {
  if (!extra) return primary;
  return {
    extensionNumber: primary.extensionNumber || extra.extensionNumber,
    name: primary.name || extra.name,
    userKey: primary.userKey || extra.userKey,
    userFirstName: primary.userFirstName || extra.userFirstName,
    userLastName: primary.userLastName || extra.userLastName,
  };
}

// Extension GoTo sent wins. A name with no extension uses the first configured
// line (Amy's 00001), which personByName deliberately does not guess.
function rosterLineFromFields(fields, roster) {
  if (!fields) return null;
  const extension = roster.extensionFrom(fields.extensionNumber);
  const byExtension = extension ? roster.personByExtension(extension) : null;
  const byKey = fields.userKey ? roster.personByUserKey(fields.userKey) : null;
  const fullName = [fields.userFirstName, fields.userLastName].filter(Boolean).join(' ').trim();
  const named = (value) => {
    if (!value || isGenericLineName(value)) return null;
    return roster.personByName(value) || roster.primaryByName(value);
  };
  const byUserName = named(fullName);
  const byPayloadName = named(fields.name);
  const person = byExtension || byKey || byUserName || byPayloadName;
  if (!person) return null;
  return {
    name: person.name,
    extension: (byExtension && byExtension.extension) || person.extension || null,
    userKey: person.userKey || fields.userKey || null,
    matchedBy: byExtension ? 'extension' : (byKey ? 'userKey' : 'name'),
  };
}

// Who picked up, from a Call Events Report, without reading the transcript.
// callStates carry status. A LINE counts only when CONNECTED or on hold, so the
// other ringing phones in a ring group are not the answerer. The queue itself
// is an interactiveVoiceResponseSystems entry, not a roster line. A summary
// with no call states credits a roster line only when there is exactly one.
function answerersFromCallReport(report, roster = rosterApi.getRoster()) {
  const body = reportBody(report);
  if (!body) return [];

  const byLeg = new Map();
  for (const participant of body.participants || []) {
    if (participantKind(participant) !== 'LINE' || !participant.legId) continue;
    byLeg.set(participant.legId, reportLineFields(participant));
  }

  const states = Array.isArray(body.callStates) ? [...body.callStates] : [];
  states.sort((a, b) => (Number(a.sequenceNumber) || 0) - (Number(b.sequenceNumber) || 0));

  const connected = new Map();
  let sawLine = false;
  for (const state of states) {
    for (const participant of state.participants || []) {
      if (participantKind(participant) !== 'LINE') continue;
      sawLine = true;
      if (!CONNECTED_STATUSES.has(statusOf(participant))) continue;
      const fields = mergeReportFields(
        reportLineFields(participant),
        participant.legId ? byLeg.get(participant.legId) : null,
      );
      const line = rosterLineFromFields(fields, roster);
      if (!line) continue;
      const key = line.extension || line.name;
      if (connected.has(key)) continue;
      connected.set(key, {
        ...line,
        answered: true,
        answerTime: state.timestamp || null,
      });
    }
  }
  if (connected.size) return [...connected.values()];
  if (sawLine) return [];

  const summary = [];
  const seen = new Set();
  for (const participant of body.participants || []) {
    if (participantKind(participant) !== 'LINE') continue;
    const line = rosterLineFromFields(reportLineFields(participant), roster);
    if (!line) continue;
    const key = line.extension || line.name;
    if (seen.has(key)) continue;
    seen.add(key);
    summary.push({ ...line, answered: true, answerTime: body.callAnswered || null });
  }
  if (summary.length === 1) return summary;
  return [];
}

function cleanExternalName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  if (/^(unknown|anonymous|restricted|unavailable|private)$/i.test(text)) return null;
  if (rosterApi.digitsOnly(text).length >= 10) return null;
  return text;
}

function pushReportNumber(bucket, number, name, roster) {
  if (!usableCustomerNumber(number, roster)) return;
  bucket.push({ number: stringNumber(number) || number, name: cleanExternalName(name) });
}

// The live webhook is STARTING and ENDING. ENDING participants are empty, and the
// outside party's number is often only on an ACTIVE state. That state is in the
// call events report, which this service already fetches to name the answerer.
// Summary participants keep caller/callee on type. callStates nest them under
// type.phoneNumber. On either shape, type.number (or phoneNumber.number) is the
// dialed DID or our outbound caller-id when caller or callee is also present.
// Report summaries put the outside party on the top-level caller.number and the
// DID on caller.type.number.
function customerNumberFromReport(report, roster = rosterApi.getRoster()) {
  const body = reportBody(report);
  if (!body) return { number: null, name: null, direction: null };
  const direction = normalizeDirection(body.direction || (body.metadata && body.metadata.direction));
  const callers = [];
  const callees = [];
  const parties = [];

  const topCaller = body.caller && typeof body.caller === 'object' ? body.caller : null;
  if (topCaller) {
    pushReportNumber(callers, topCaller.number, topCaller.name, roster);
    const nested = topCaller.type && typeof topCaller.type === 'object' ? topCaller.type : null;
    if (nested && nested.caller) pushReportNumber(callers, nested.caller.number, nested.caller.name, roster);
    if (nested && nested.callee) pushReportNumber(callees, nested.callee.number, nested.callee.name, roster);
  }
  const topCallee = body.callee && typeof body.callee === 'object' ? body.callee : null;
  if (topCallee) pushReportNumber(callees, topCallee.number, topCallee.name, roster);
  const dialString = body.dialString || (body.metadata && body.metadata.dialString);
  if (direction !== 'INBOUND') pushReportNumber(callees, dialString, null, roster);

  const participants = [...(body.participants || [])];
  for (const state of body.callStates || []) {
    for (const participant of state.participants || []) participants.push(participant);
  }
  for (const participant of participants) {
    const kind = participantKind(participant);
    if (kind !== 'PHONE_NUMBER' && kind !== 'PHONE_NUMBER_UNKNOWN') continue;
    const block = phoneBlock(participant);
    const caller = block.caller && typeof block.caller === 'object' ? block.caller : null;
    const callee = block.callee && typeof block.callee === 'object' ? block.callee : null;
    if (caller) pushReportNumber(callers, caller.number, caller.name, roster);
    if (callee) pushReportNumber(callees, callee.number, callee.name, roster);
    // No separate caller/callee: the participant number is the outside party
    // (the shape some report states use). When caller/callee exist, that
    // number is the DID or our caller-id and must not be the customer.
    if (!caller && !callee) {
      pushReportNumber(parties, block.number, block.name, roster);
      if (participant.number && participant.number !== block.number) {
        pushReportNumber(parties, participant.number, participant.name, roster);
      }
    }
  }

  const uniqueOf = (bucket) => uniqueExternalNumbers(bucket.map((item) => item.number));
  let chosen = [];
  if (direction === 'OUTBOUND') chosen = uniqueOf(callees);
  else if (direction === 'INBOUND') chosen = uniqueOf(callers);
  else chosen = uniqueExternalNumbers([...callers, ...callees].map((item) => item.number));
  if (chosen.length !== 1 && direction !== 'OUTBOUND') {
    const party = uniqueOf(parties);
    if (chosen.length === 0 && party.length === 1) chosen = party;
  }
  if (chosen.length !== 1) return { number: null, name: null, direction };
  const number = chosen[0];
  const named = [...callers, ...callees, ...parties].find((item) => item.name && sameCustomer(item.number, number));
  return { number, name: named ? named.name : null, direction };
}

// A real inbound conversation (the customer said something that is not a
// recording) that still has no number after every GoTo source was checked.
function missingInboundNumberWarning(described, roster = rosterApi.getRoster()) {
  if (!described || described.direction !== 'INBOUND' || described.externalNumber) return null;
  const spoke = (described.legRecords || []).some((leg) => {
    const texts = speakerTexts(leg, roster);
    return Boolean(texts && texts.customerText && texts.customerText.trim());
  });
  if (!spoke) return null;
  const ids = [...(described.conversationSpaceIds || [])].filter(Boolean);
  if (!ids.length) return null;
  return `WARNING: inbound interaction has customer speech but no phone number conversationSpaceId=${ids.join(',')}`;
}

function uniqueExternalNumbers(numbers) {
  const seen = new Map();
  for (const number of numbers) {
    const key = last10(number);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, number);
  }
  return [...seen.values()];
}

module.exports = {
  analyzeCallState,
  analyzeCallHistory,
  chooseExternalNumber,
  channelRole,
  channelRolesForLeg,
  isSystemRecordingUtterance,
  systemRecordingPromptLine,
  transcriptIsSubstantive,
  callIsFragment,
  answererFromTranscript,
  answerersFromCallReport,
  customerNumberFromReport,
  missingInboundNumberWarning,
  teamChannelAnswerer,
  outboundIntroAnswerer,
  postingPlan,
  callIdVersion,
  uniqueExternalNumbers,
  sameCustomer,
  timeRangesOverlap,
  SIBLING_WINDOW_MS,
  ANNOUNCEMENT_HOLD_MS,
  CONNECTED_STATUSES,
  BUSINESS_NAME_ALT,
};
