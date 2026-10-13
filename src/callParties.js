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
// main line, and the forwarded cell are not the answering person. Outbound calls
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
  /forwarded to an automatic voice message system/i,
  /the person you(?:['’]re| are) trying to reach is not available/i,
  /at the tone, please record your message/i,
  /\bour (normal )?business hours\b/i,
  /\bwe are (currently )?closed\b/i,
  /\bpress [0-9]\b/i,
  /\bfor (sales|service|the operator), press\b/i,
];

const SCRIPT_UNLESS_LIVE = [
  /\bthank you for calling\b/i,
  /\bit'?s a (great|good) day here at\b/i,
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
  const fromUser = [type.userFirstName, type.userLastName].filter(Boolean).join(' ').trim();
  return fromUser || type.name || null;
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
  return 'System recordings (never a live person, even if a name is spoken): the "this call may be recorded" announcement, the "thank you for calling" greeting, the "we are currently assisting other callers" queue message, the after-hours greeting in Joshua\'s voice that asks the caller to leave their name, carrier voicemail prompts ("your call has been forwarded to voicemail", "at the tone, please record your message"), business-hours messages, and IVR "press 1" menus.';
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

function pickExternalFromParticipants({ direction, participants, dialString, roster }) {
  const candidates = [];
  for (const participant of participants) {
    const kind = participantKind(participant);
    if (kind !== 'PHONE_NUMBER' && kind !== 'PHONE_NUMBER_UNKNOWN') continue;
    const type = typeOf(participant);
    if (type.caller?.number) candidates.push({ number: type.caller.number, name: type.caller.name || null, role: 'caller' });
    if (type.callee?.number) candidates.push({ number: type.callee.number, name: type.callee.name || null, role: 'callee' });
    if (type.number) candidates.push({ number: type.number, name: type.name || null, role: 'number' });
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

function extensionFromType(type, roster) {
  if (!type) return null;
  return roster.extensionFrom(type.extensionNumber)
    || roster.extensionFrom(type.extension)
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
  const extension = extensionFromType(type, roster);
  const userKey = type.userKey || type.userId || participant.userKey || participant.userId || null;
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

function partyPerson(party, roster) {
  const extension = partyExtension(party, roster);
  const byExtension = roster.personByExtension(extension);
  if (byExtension) {
    return { person: byExtension, extension: byExtension.extension || extension, matchedBy: 'extension' };
  }
  if (partyLooksInternal(party, extension)) {
    const byName = roster.personByName(party && party.name);
    if (byName) return { person: byName, extension: byName.extension, matchedBy: 'name' };
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

function analyzeCallHistory(content = {}, roster = rosterApi.getRoster()) {
  const caller = content.caller || {};
  const callee = content.callee || {};
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

  return {
    legId: content.legId || null,
    originatorId: content.originatorId || null,
    conversationSpaceId: content.conversationSpaceId || null,
    legDirection,
    answered,
    explicitlyUnanswered,
    answerTime: answerTime && answerTime !== true ? answerTime : null,
    teamMember,
    externalNumber,
    externalName,
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

// GoTo's channel map, corrected when a single channel's own introduction
// contradicts it. Does not look at which channel spoke first.
function channelRolesForLeg(utterances, leg, roster = rosterApi.getRoster()) {
  const present = [];
  for (const utterance of utterances || []) {
    const channel = Number(utterance && utterance.channel);
    if (!Number.isFinite(channel) || present.includes(channel)) continue;
    present.push(channel);
  }
  const roles = {};
  for (const channel of present) roles[channel] = channelRole(channel, leg || {});

  const signalChannels = present.filter((channel) => {
    const text = (utterances || [])
      .filter((utterance) => Number(utterance.channel) === channel && utteranceCanProveTeamChannel(utterance.text, roster))
      .map((utterance) => utterance.text)
      .join(' ');
    return textHasTeamSelfIdentification(text, leg || {}, roster);
  });
  if (signalChannels.length !== 1) return { roles, corrected: false };

  const teamChannel = signalChannels[0];
  const current = roles[teamChannel];
  if (current === 'team') return { roles, corrected: false };
  // Only override a customer label, or fill in a side GoTo did not label.
  // A system-owned channel is left alone.
  if (current !== 'customer' && current != null) return { roles, corrected: false };

  roles[teamChannel] = 'team';
  for (const channel of present) {
    if (channel === teamChannel) continue;
    if (roles[channel] === 'team' || roles[channel] == null) roles[channel] = 'customer';
  }
  return { roles, corrected: true, teamChannel };
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
function postingPlan({
  externalNumber,
  externalConflict,
  direction,
  callCreated,
  callEnded,
  substantive,
  hasTranscript = false,
  hasRecording = false,
  answered = null,
  now = Date.now(),
  openSiblings = [],
  recent = null,
}) {
  if (externalConflict) return { action: 'review', reason: 'conflicting external numbers' };
  if (!externalNumber) return { action: 'review', reason: 'missing external number' };

  const sameCall = (other) => other
    && other.direction === direction
    && sameCustomer(other.externalNumber, externalNumber);

  if (recent && recent.groupKey && sameCall(recent) && timeRangesOverlap(recent, { callCreated, callEnded })) {
    if (!substantive && recent.substantive === false) {
      return { action: 'suppress', reason: 'same-minute duplicate with no conversation', skipArtifacts: true };
    }
    return { action: 'suppress', reason: 'overlapping duplicate leg' };
  }
  if (
    recent
    && recent.groupKey
    && sameCall(recent)
    && !substantive
    && recent.substantive === false
    && withinWindow(recent.callCreated, callCreated, SIBLING_WINDOW_MS)
  ) {
    return { action: 'suppress', reason: 'same-minute duplicate with no conversation', skipArtifacts: true };
  }

  const sibling = openSiblings.find((other) => sameCall(other) && withinWindow(other.callCreated, callCreated, SIBLING_WINDOW_MS));
  if (sibling) {
    if (!substantive && sibling.substantive) {
      return { action: 'suppress', reason: 'announcement leg of an open conversation', mergeInto: sibling.groupKey };
    }
    if (substantive && !sibling.substantive) {
      return { action: 'post', reason: 'substantive leg', suppressSibling: sibling.groupKey };
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
      return { action: 'suppress', reason: 'overlapping open duplicate', mergeInto: sibling.groupKey };
    }
    return { action: 'post', reason: 'separate substantive call' };
  }

  if (!substantive && callEnded && (now - new Date(callEnded).getTime()) < ANNOUNCEMENT_HOLD_MS) {
    return { action: 'hold', reason: 'announcement-only hold' };
  }
  return { action: 'post', reason: 'ready' };
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
