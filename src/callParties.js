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
// on hold), or when their call-history leg has answerTime. RINGING devices, the
// main line, and the forwarded cell are not the answering person. Outbound calls
// still credit the originator LINE (the person who placed the call) even before
// the far end answers.
//
// Speakers: GoTo's transcription schema numbers channels from the recorded party —
// channel 0 is what that party said, channel 1 is what they heard
// (https://developer.goto.com/GoToConnect/#tag/Transcriptions). When the recording
// id is nested on a participant, that participant is channel 0. When it isn't, channel
// 0 is treated as the call originator (the external caller on an inbound call, the
// extension that dialed on an outbound call) and channel 1 as the other side. Talk
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
  return 'System recordings (never a live person, even if a name is spoken): the "this call may be recorded" announcement, the "thank you for calling" greeting, the "we are currently assisting other callers" queue message, the after-hours greeting in Joshua\'s voice that asks the caller to leave their name, business-hours messages, and IVR "press 1" menus.';
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

function lineFromParticipant(participant, roster) {
  const type = typeOf(participant);
  const extension = roster.extensionFrom(type.extensionNumber) || roster.extensionFrom(type.number);
  const userKey = type.userKey || participant.userKey || null;
  const known = roster.personByUserKey(userKey) || roster.personByExtension(extension);
  const payloadName = payloadPersonName(type);
  const generic = isGenericLineName(payloadName);
  const isSystem = Boolean(!known && (roster.isSystemNumber(type.number) || generic));
  const status = statusOf(participant);
  return {
    participantId: participant.participantId || null,
    legId: participant.legId || null,
    extension: known?.extension || extension || null,
    userKey: userKey || known?.userKey || null,
    name: known?.name || (isSystem ? null : payloadName),
    status,
    isOriginator: Boolean(participant.participantId && participant.originator && participant.participantId === participant.originator),
    isSystem,
    connected: CONNECTED_STATUSES.has(status),
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

  return {
    direction,
    directionSource: direction ? 'metadata' : null,
    callCreated: metadata.callCreated || null,
    dialString: metadata.dialString || null,
    accountKey: metadata.accountKey || null,
    externalNumber: external.number,
    externalName: external.name,
    lines,
    recordingOwners,
    externalConnected,
    participantsEmpty: participants.length === 0,
    callIdVersion: callIdVersion(metadata.conversationSpaceId),
  };
}

function historyAnswerTime(content) {
  return content.answerTime || content.answerTimestamp || content.answeredAt || null;
}

function analyzeCallHistory(content = {}, roster = rosterApi.getRoster()) {
  const caller = content.caller || {};
  const callee = content.callee || {};
  const legDirection = normalizeDirection(content.direction);
  const callerExt = roster.extensionFrom(caller.number);
  const calleeExt = roster.extensionFrom(callee.number);
  const callerPerson = roster.personByExtension(caller.number);
  const calleePerson = roster.personByExtension(callee.number);
  const userPerson = roster.personByUserKey(content.userKey);
  const callerIsInternal = Boolean(callerExt || callerPerson);
  const calleeIsInternal = Boolean(calleeExt || calleePerson);
  const answered = Boolean(historyAnswerTime(content));

  let person = userPerson;
  let extension = userPerson?.extension || null;
  let externalNumber = null;
  let externalName = null;

  if (callerIsInternal && !calleeIsInternal) {
    person = callerPerson || person || (callerExt ? { name: caller.name || null, extension: callerExt } : null);
    extension = extension || person?.extension || callerExt;
    if (usableCustomerNumber(callee.number, roster)) {
      externalNumber = callee.number;
      externalName = callee.name || null;
    }
  } else if (calleeIsInternal && !callerIsInternal) {
    person = calleePerson || person || (calleeExt ? { name: callee.name || null, extension: calleeExt } : null);
    extension = extension || person?.extension || calleeExt;
    if (usableCustomerNumber(caller.number, roster)) {
      externalNumber = caller.number;
      externalName = caller.name || null;
    }
  } else if (userPerson && legDirection === 'OUTBOUND' && usableCustomerNumber(callee.number, roster)) {
    person = userPerson;
    extension = userPerson.extension;
    externalNumber = callee.number;
    externalName = callee.name || null;
  } else if (userPerson && legDirection === 'INBOUND' && usableCustomerNumber(caller.number, roster)) {
    person = userPerson;
    extension = userPerson.extension;
    externalNumber = caller.number;
    externalName = caller.name || null;
  }

  const canonical = roster.personByExtension(extension) || person;
  const teamMember = (canonical && (canonical.name || canonical.extension || extension))
    ? {
      name: canonical.name || null,
      extension: canonical.extension || extension || null,
      userKey: content.userKey || canonical.userKey || null,
      answered,
      answerTime: historyAnswerTime(content),
    }
    : null;

  return {
    legId: content.legId || null,
    originatorId: content.originatorId || null,
    legDirection,
    answered,
    answerTime: historyAnswerTime(content),
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

// How to post one interaction given other open/recent calls. Never invents a phone
// number. Same-direction split legs (greeting, then the answered call) collapse.
// Opposite-direction calls and two real back-to-back conversations stay separate.
function postingPlan({
  externalNumber,
  externalConflict,
  direction,
  callCreated,
  callEnded,
  substantive,
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
    return { action: 'suppress', reason: 'overlapping duplicate leg' };
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
      if (!callEnded || age < ANNOUNCEMENT_HOLD_MS) {
        return { action: 'hold', reason: 'waiting to see which leg has the conversation' };
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
};
