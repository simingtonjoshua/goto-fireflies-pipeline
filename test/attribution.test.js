const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callParties = require('../src/callParties');
const roster = require('../src/roster');
const interactions = require('../src/interactions');
const openaiClient = require('../src/openaiClient');

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);

const CUSTOMER = '5550101001';
const OTHER_CUSTOMER = '5550101002';
const DIALED = '5550101003';
const OFFICE = '5550101999';

function line({ id, extension, name, status, originator }) {
  return {
    participantId: id,
    originator: originator || id,
    legId: `leg-${id}`,
    status: { value: status },
    type: {
      value: 'LINE',
      extensionNumber: extension,
      name,
    },
  };
}

function phone({ id, originator, caller, callee, status, recordingId }) {
  const participant = {
    participantId: id,
    originator,
    legId: `leg-${id}`,
    status: { value: status || 'CONNECTED' },
    type: {
      value: 'PHONE_NUMBER',
      caller: caller ? { number: caller, name: 'WIRELESS CALLER' } : undefined,
      callee: callee ? { number: callee } : undefined,
    },
  };
  if (recordingId) participant.recordings = [{ id: recordingId }];
  return participant;
}

function callState({ conversationSpaceId, direction, callCreated, dialString, participants }) {
  return {
    content: {
      metadata: {
        conversationSpaceId,
        direction,
        callCreated,
        dialString,
      },
      state: { type: 'ACTIVE', participants },
    },
  };
}

function names(leg) {
  return (leg?.csrChain || []).map((entry) => `${entry.name} (${entry.extension})`);
}

describe('roster', () => {
  it('pads short extensions and links a GoTo user key without storing it in config', () => {
    const book = roster.createRoster(ROSTER_CONFIG);
    assert.equal(roster.normalizeExtension('6'), '00006');
    assert.equal(book.personByExtension('6').name, 'Emily Kingdon');
    assert.equal(book.personByExtension('00001').name, 'Amy Bullock');
    assert.equal(book.personByExtension('00005').name, 'Amy Bullock');
    assert.notEqual(book.personByExtension('00001'), book.personByExtension('00005'));
    assert.equal(book.indexApiUser({ userKey: 'user-josh', lines: [{ number: '3' }] }), true);
    assert.equal(book.personByUserKey('user-josh').extension, '00003');
    assert.equal(book.personByUserKey('user-josh').name, 'Joshua Simington');
  });

  it('treats a configured system number as a line, not a person', () => {
    const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
    assert.equal(book.isSystemNumber(OFFICE), true);
    assert.equal(book.extensionFrom(OFFICE), null);
    assert.equal(book.personByExtension(OFFICE), null);
  });
});

describe('call state and history', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  it('credits only the extension that answered an inbound call to the main line', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '11111111-1111-3111-8111-111111111111',
      direction: 'INBOUND',
      callCreated: '2026-10-01T15:00:00.000Z',
      dialString: OFFICE,
      participants: [
        phone({ id: 'cust', originator: 'cust', caller: `+1${CUSTOMER}`, callee: OFFICE, recordingId: 'rec-in' }),
        line({ id: 'main', extension: undefined, name: 'Main', status: 'CONNECTED', originator: 'cust' }),
        line({ id: 'emily', extension: '00006', name: 'Emily Kingdon', status: 'CONNECTED', originator: 'cust' }),
        line({ id: 'kristine', extension: '00007', name: 'Kristine Vandervort', status: 'RINGING', originator: 'cust' }),
      ],
    }), book);

    assert.equal(analysis.direction, 'INBOUND');
    assert.equal(analysis.callIdVersion, '3');
    assert.equal(roster.last10(analysis.externalNumber), CUSTOMER);
    assert.equal(analysis.recordingOwners['rec-in'].role, 'customer');
    const answered = analysis.lines.filter((entry) => entry.connected && !entry.isSystem);
    assert.deepEqual(answered.map((entry) => entry.extension), ['00006']);
    assert.equal(answered[0].name, 'Emily Kingdon');
  });

  it('keeps inbound direction when a later history leg looks outbound, and orders a transfer', () => {
    interactions.resetForTests();
    interactions.recordLegState('conv-transfer', {
      legId: 'leg-emily',
      lines: [
        { legId: 'leg-emily', extension: '00006', name: 'Emily Kingdon', connected: true, answerTime: '2026-10-01T15:00:05.000Z' },
      ],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T15:00:00.000Z',
    });
    interactions.recordLegState('conv-transfer', {
      legId: 'leg-emily',
      lines: [
        { legId: 'leg-kristine', extension: '00007', name: 'Kristine Vandervort', connected: true, answerTime: '2026-10-01T15:04:00.000Z' },
      ],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T15:00:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-transfer',
        legId: 'leg-kristine',
        direction: 'OUTBOUND',
        answerTime: '2026-10-01T15:04:00.000Z',
        caller: { number: CUSTOMER, name: 'Riley' },
        callee: { number: '00007', name: 'Kristine Vandervort' },
      },
    });
    const leg = interactions.peekLeg('conv-transfer');
    assert.equal(leg.direction, 'INBOUND');
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)', 'Kristine Vandervort (00007)']);
  });

  it('credits the outbound desk originator and uses the dialed customer number', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '22222222-2222-3222-8222-222222222222',
      direction: 'OUTBOUND',
      callCreated: '2026-10-01T16:00:00.000Z',
      dialString: DIALED,
      participants: [
        line({ id: 'josh', extension: '00003', name: 'Joshua Simington', status: 'RINGING', originator: 'josh' }),
      ],
    }), book);
    assert.equal(analysis.direction, 'OUTBOUND');
    assert.equal(roster.last10(analysis.externalNumber), DIALED);
    assert.equal(analysis.lines[0].isOriginator, true);
    assert.equal(analysis.lines[0].connected, false);

    interactions.resetForTests();
    interactions.recordLegState('conv-desk', {
      legId: 'leg-josh',
      lines: analysis.lines,
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: analysis.externalNumber,
      callCreated: '2026-10-01T16:00:00.000Z',
    });
    const leg = interactions.peekLeg('conv-desk');
    assert.equal(leg.direction, 'OUTBOUND');
    assert.deepEqual(names(leg), ['Joshua Simington (00003)']);
    assert.equal(roster.last10(leg.externalNumber), DIALED);
  });

  it('maps a softphone caller-id to the roster user and keeps the callee as the customer', () => {
    const bookWithKey = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
    bookWithKey.indexApiUser({ userKey: 'user-josh', lines: [{ number: '00003' }] });
    const analysis = callParties.analyzeCallHistory({
      originatorId: 'orig-soft',
      legId: 'leg-soft',
      direction: 'OUTBOUND',
      userKey: 'user-josh',
      caller: { number: '5550101888', name: 'Joshua Simington' },
      callee: { number: CUSTOMER, name: 'Jordan' },
      answerTime: '2026-10-01T16:05:02.000Z',
    }, bookWithKey);
    assert.equal(analysis.legDirection, 'OUTBOUND');
    assert.equal(analysis.teamMember.name, 'Joshua Simington');
    assert.equal(analysis.teamMember.extension, '00003');
    assert.equal(roster.last10(analysis.externalNumber), CUSTOMER);
    assert.equal(analysis.answered, true);
  });

  it('keeps only the ring-group member whose history leg has an answer time', () => {
    interactions.resetForTests();
    interactions.recordLegState('conv-ring', {
      legId: 'leg-ring-main',
      lines: [
        { legId: 'leg-emily', extension: '00006', name: 'Emily Kingdon', connected: false },
        { legId: 'leg-gala', extension: '00004', name: 'Gala Wilbur', connected: false },
        { legId: 'leg-kristine', extension: '00007', name: 'Kristine Vandervort', connected: false },
      ],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T17:00:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-ring',
        legId: 'leg-gala',
        direction: 'INBOUND',
        caller: { number: CUSTOMER },
        callee: { number: '00004', name: 'Gala Wilbur' },
      },
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-ring',
        legId: 'leg-kristine',
        direction: 'OUTBOUND',
        caller: { number: CUSTOMER },
        callee: { number: '00007', name: 'Kristine Vandervort' },
      },
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-ring',
        legId: 'leg-emily',
        direction: 'INBOUND',
        answerTime: '2026-10-01T17:00:09.000Z',
        caller: { number: CUSTOMER },
        callee: { number: '00006', name: 'Emily Kingdon' },
      },
    });
    const leg = interactions.peekLeg('conv-ring');
    assert.equal(leg.direction, 'INBOUND');
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)']);
  });

  it('applies call history that arrived before the leg, and refuses a different customer number', () => {
    interactions.resetForTests();
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-early',
        legId: 'leg-early',
        direction: 'INBOUND',
        answerTime: '2026-10-01T18:00:04.000Z',
        caller: { number: CUSTOMER, name: 'Riley' },
        callee: { number: '00006', name: 'Emily Kingdon' },
      },
    });
    assert.equal(interactions.peekLeg('conv-early'), null);
    interactions.recordLegState('conv-early', {
      legId: 'leg-early',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T18:00:00.000Z',
    });
    assert.deepEqual(names(interactions.peekLeg('conv-early')), ['Emily Kingdon (00006)']);

    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-early',
        legId: 'leg-early',
        direction: 'INBOUND',
        answerTime: '2026-10-01T18:00:04.000Z',
        caller: { number: OTHER_CUSTOMER, name: 'Jordan' },
        callee: { number: '00004', name: 'Gala Wilbur' },
      },
    });
    const leg = interactions.peekLeg('conv-early');
    assert.equal(roster.last10(leg.externalNumber), CUSTOMER);
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)']);
  });
});

describe('external number', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  it('keeps the number for a later event of the same call and drops it when the call id is reused', () => {
    const kept = callParties.chooseExternalNumber({
      proposed: null,
      existingNumber: CUSTOMER,
      existingCallCreated: '2026-10-01T15:00:00.000Z',
      callCreated: '2026-10-01T15:00:00.000Z',
      direction: 'INBOUND',
      dialString: null,
      roster: book,
    });
    assert.equal(kept.number, CUSTOMER);
    assert.equal(kept.reusedPrevious, false);

    const reused = callParties.chooseExternalNumber({
      proposed: null,
      existingNumber: CUSTOMER,
      existingCallCreated: '2026-10-01T15:00:00.000Z',
      callCreated: '2026-10-01T16:00:00.000Z',
      direction: 'OUTBOUND',
      dialString: null,
      roster: book,
    });
    assert.equal(reused.number, null);
    assert.equal(reused.reusedPrevious, true);
  });

  it('does not keep a previous call\'s number on the open leg', () => {
    interactions.resetForTests();
    interactions.recordLegState('conv-reuse', {
      legId: 'leg-old',
      lines: [
        { legId: 'leg-old', extension: '00006', name: 'Emily Kingdon', connected: true },
      ],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T15:00:00.000Z',
    });
    interactions.recordLegState('conv-reuse', {
      legId: 'leg-new',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      callCreated: '2026-10-01T16:00:00.000Z',
    });
    const leg = interactions.peekLeg('conv-reuse');
    assert.equal(leg.externalNumber, null);
    assert.deepEqual(leg.csrChain, []);
    assert.equal(leg.direction, 'OUTBOUND');
  });

  it('flags two different customer numbers instead of switching threads', () => {
    interactions.resetForTests();
    interactions.recordLegState('conv-conflict', {
      legId: 'leg-a',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-01T15:00:00.000Z',
    });
    interactions.recordLegState('conv-conflict', {
      legId: 'leg-a',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: OTHER_CUSTOMER,
      callCreated: '2026-10-01T15:00:00.000Z',
    });
    const leg = interactions.peekLeg('conv-conflict');
    assert.equal(leg.externalConflict, true);
    assert.equal(roster.last10(leg.externalNumber), CUSTOMER);
    assert.equal(callParties.postingPlan({
      externalNumber: null,
      externalConflict: true,
      direction: 'OUTBOUND',
      substantive: true,
    }).action, 'review');
    assert.equal(callParties.postingPlan({
      externalNumber: null,
      direction: 'OUTBOUND',
      substantive: true,
    }).action, 'review');
  });
});

describe('posting plan', () => {
  const base = {
    externalNumber: CUSTOMER,
    direction: 'INBOUND',
    now: new Date('2026-10-01T15:01:00.000Z').getTime(),
  };

  it('folds a greeting leg into the real call and still posts two real calls and a crossed pair', () => {
    const greeting = callParties.postingPlan({
      ...base,
      callCreated: '2026-10-01T15:00:00.000Z',
      callEnded: '2026-10-01T15:00:20.000Z',
      substantive: false,
      openSiblings: [{
        groupKey: 'real',
        externalNumber: CUSTOMER,
        direction: 'INBOUND',
        callCreated: '2026-10-01T15:00:25.000Z',
        substantive: true,
      }],
    });
    assert.equal(greeting.action, 'suppress');

    const real = callParties.postingPlan({
      ...base,
      callCreated: '2026-10-01T15:00:25.000Z',
      callEnded: '2026-10-01T15:02:00.000Z',
      substantive: true,
      openSiblings: [{
        groupKey: 'greeting',
        externalNumber: CUSTOMER,
        direction: 'INBOUND',
        callCreated: '2026-10-01T15:00:00.000Z',
        callEnded: '2026-10-01T15:00:20.000Z',
        substantive: false,
      }],
    });
    assert.equal(real.action, 'post');
    assert.equal(real.suppressSibling, 'greeting');

    const redial = callParties.postingPlan({
      ...base,
      callCreated: '2026-10-01T15:00:40.000Z',
      callEnded: '2026-10-01T15:02:00.000Z',
      substantive: true,
      openSiblings: [{
        groupKey: 'first-real',
        externalNumber: CUSTOMER,
        direction: 'INBOUND',
        callCreated: '2026-10-01T15:00:00.000Z',
        callEnded: '2026-10-01T15:00:30.000Z',
        substantive: true,
      }],
    });
    assert.equal(redial.action, 'post');

    const crossed = callParties.postingPlan({
      ...base,
      direction: 'INBOUND',
      callCreated: '2026-10-01T15:00:00.000Z',
      callEnded: '2026-10-01T15:05:00.000Z',
      substantive: true,
      openSiblings: [{
        groupKey: 'outbound',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-01T15:00:00.000Z',
        callEnded: '2026-10-01T15:05:00.000Z',
        substantive: true,
      }],
    });
    assert.equal(crossed.action, 'post');
  });

  it('suppresses an overlapping same-direction leg and holds a greeting that has no sibling yet', () => {
    const duplicate = callParties.postingPlan({
      ...base,
      callCreated: '2026-10-01T15:00:00.000Z',
      callEnded: '2026-10-01T15:04:00.000Z',
      substantive: true,
      recent: {
        groupKey: 'already',
        externalNumber: CUSTOMER,
        direction: 'INBOUND',
        callCreated: '2026-10-01T15:00:01.000Z',
        callEnded: '2026-10-01T15:04:00.000Z',
      },
    });
    assert.equal(duplicate.action, 'suppress');

    const held = callParties.postingPlan({
      ...base,
      callCreated: '2026-10-01T15:00:00.000Z',
      callEnded: '2026-10-01T15:00:40.000Z',
      substantive: false,
    });
    assert.equal(held.action, 'hold');
  });
});

describe('speaker labels and summary facts', () => {
  beforeEach(() => interactions.resetForTests());

  it('labels inbound audio from the channel, not from who spoke first', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      recordingId: 'rec-in',
      recordingOwners: { 'rec-in': { role: 'customer' } },
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true, enteredAt: '2026-10-01T15:00:05.000Z' }],
      callCreated: '2026-10-01T15:00:00.000Z',
      transcript: {
        results: [
          { transcript: 'Hi, I am calling about blinds for Riley.', channel: 0, startTimeMs: 0 },
          { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 1200 },
          { transcript: 'This is Budget, how can I help?', channel: 1, startTimeMs: 4000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Recording', 'Emily Kingdon']);
    assert.equal(rows.some((row) => row.label === 'Budget'), false);
  });

  it('labels an outbound call by channel when the team member speaks first', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', enteredAt: '2026-10-01T16:00:00.000Z' }],
      callCreated: '2026-10-01T16:00:00.000Z',
      transcript: {
        results: [
          { transcript: 'Hi, this is Marie with Budget Blinds.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hello, this is Jordan.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Emily Kingdon', 'Customer']);
  });

  it('keeps a live greeting that names someone on the roster', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
      transcript: {
        results: [
          { transcript: "It's a great day here at Budget Blinds, this is Emily.", channel: 1, startTimeMs: 0 },
        ],
      },
    });
    assert.equal(rows[0].label, 'Emily Kingdon');
  });

  it('leaves channels unlabeled when direction is missing, and marks the queue greeting as a recording', () => {
    const unlabeled = openaiClient.formatLegTranscript({
      transcript: {
        results: [
          { transcript: 'Hello there.', channel: 0, startTimeMs: 0 },
          { transcript: 'Who is this?', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(unlabeled.map((row) => row.label), ['Channel 0', 'Channel 1']);

    const greeting = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Hi there, this is Josh. Please leave your name after the tone.', channel: 1, startTimeMs: 0 },
        ],
      },
    });
    assert.deepEqual(greeting.map((row) => row.label), ['Recording']);

    const unknownName = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'This is Marie, how can I help you?', channel: 1, startTimeMs: 0 },
        ],
      },
    });
    assert.equal(unknownName[0].label, 'Team Member');
  });

  it('does not say a caller was connected unless the phone system shows the call was answered', () => {
    const missed = openaiClient.buildNoTranscriptSummary({
      csrPath: [],
      externalNumber: CUSTOMER,
      direction: 'INBOUND',
      callCreated: '2026-10-01T15:00:00.000Z',
      answered: false,
    });
    assert.equal(/connected/i.test(missed), false);
    assert.match(missed, /does not show that a team member answered/);

    const answered = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: CUSTOMER,
      direction: 'INBOUND',
      callCreated: '2026-10-01T15:00:00.000Z',
      answered: true,
    });
    assert.equal(/connected/i.test(answered), false);
    assert.match(answered, /answered by Emily Kingdon/);

    const outbound = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: DIALED,
      direction: 'OUTBOUND',
      callCreated: '2026-10-01T16:00:00.000Z',
      answered: false,
    });
    assert.equal(/connected/i.test(outbound), false);
    assert.equal(/reached/i.test(outbound), false);
    assert.match(outbound, /does not show that the call was answered/);

    const transferred = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Emily Kingdon (00006)', 'Joshua Simington (00003)'],
      externalNumber: '5032604268',
      direction: 'OUTBOUND',
      callCreated: '2026-10-14T21:12:00.000Z',
      answered: null,
    });
    assert.match(transferred, /Emily Kingdon placed an outbound call/);
    assert.equal(/Joshua Simington placed an outbound call/.test(transferred), false);
  });

  it('gives the summarizer fixed facts and the known system recordings', () => {
    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'INBOUND',
        csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
        transcript: { results: [{ transcript: 'Hello.', channel: 0, startTimeMs: 0 }] },
      }],
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: CUSTOMER,
      direction: 'INBOUND',
      callCreated: '2026-10-01T15:00:00.000Z',
      callEnded: '2026-10-01T15:03:00.000Z',
      answered: true,
    });
    const text = `${built.system}\n${built.user}`;
    assert.match(text, /do not change/i);
    assert.match(text, /Call direction: INBOUND/);
    assert.match(text, /Answered: yes/);
    assert.match(text, /Emily Kingdon \(00006\)/);
    assert.match(text, /System recordings/);
    assert.match(text, /who spoke first/);
    assert.match(text, /ground truth/i);
    assert.match(text, /service order/i);
    assert.match(text, /customer signs it and pays/i);
    assert.match(text, /Never write that the customer will send a service order for a team member to sign or pay/);
    assert.match(text, /that would be me, Karen/);
    assert.match(text, /first person in the team member path/);
    assert.match(text, /hold call/i);
  });

  // Live outbound return call, 2026-10-12: direction and the team-member credit were
  // right, but channel 0 was the customer answering and channel 1 was the staff
  // introduction. Synthetic names and no real phone numbers.
  function outboundDeskSwap(extra = {}) {
    return openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003', enteredAt: '2026-10-12T16:19:00.000Z' }],
      callCreated: '2026-10-12T16:19:00.000Z',
      transcript: {
        results: [
          { transcript: 'Hello.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, Jordan, this is Joshua over at Budget Blinds.', channel: 1, startTimeMs: 1000 },
          { transcript: 'Yeah, this shade is no longer working on one of my windows.', channel: 0, startTimeMs: 18000 },
          { transcript: 'I will email you a service order. Once you get that, you will sign it online and pay.', channel: 1, startTimeMs: 486000 },
        ],
      },
      ...extra,
    });
  }

  it('corrects an outbound desk call when channel 0 is the customer answering', () => {
    const rows = outboundDeskSwap();
    assert.deepEqual(rows.map((row) => row.label), [
      'Customer',
      'Joshua Simington',
      'Customer',
      'Joshua Simington',
    ]);
  });

  it('corrects the same swap when the recording owner was marked as the team member', () => {
    const rows = outboundDeskSwap({
      recordingId: 'rec-desk',
      recordingOwners: { 'rec-desk': { role: 'team', name: 'Joshua Simington', extension: '00003' } },
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Customer',
      'Joshua Simington',
      'Customer',
      'Joshua Simington',
    ]);
  });

  it('corrects channel labels from a roster-name introduction without the business name', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Hello?', channel: 0, startTimeMs: 0 },
          { transcript: 'Hey, this is Josh. I am returning your call about the shade.', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Joshua Simington']);
  });

  it('still corrects the swap when speech-to-text mishears Budget Blinds', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
      transcript: {
        results: [
          { transcript: 'Hello.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, this is Emily over at Budget Minds.', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Emily Kingdon']);
  });

  it('does not relabel an outbound call from talk order when nobody introduces themselves', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Hello?', channel: 0, startTimeMs: 0 },
          { transcript: 'The shade in my living room stopped working.', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Joshua Simington', 'Customer']);
  });

  it('does not treat a customer introducing themselves as the team member', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Hi, this is Joshua over at Budget Blinds.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, this is Jordan.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Joshua Simington', 'Customer']);
  });

  it('does not let the after-hours greeting flip an inbound call', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
      transcript: {
        results: [
          { transcript: 'Hi there, this is Josh. Please leave your name after the tone.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, I need a shade repaired.', channel: 1, startTimeMs: 8000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Emily Kingdon']);
  });

  it('labels speakers from a team introduction when direction is missing', () => {
    const rows = openaiClient.formatLegTranscript({
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Hello.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, this is Joshua over at Budget Blinds.', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Joshua Simington']);
  });

  function outboundUnknown(teamLine) {
    return openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Hello?', channel: 0, startTimeMs: 0 },
          { transcript: teamLine, channel: 1, startTimeMs: 1000 },
        ],
      },
    });
  }

  it('corrects an outbound intro when the team member is unknown and the business name is misheard', () => {
    assert.match(callParties.BUSINESS_NAME_ALT, /lions/);
    assert.match(callParties.BUSINESS_NAME_ALT, /blends/);
    assert.match(callParties.BUSINESS_NAME_ALT, /blind/);
    const phrases = [
      "Hi there, my name is Emily, I'm calling on behalf of Budget Lions.",
      "I'm giving a call on behalf of Budget Blinds.",
      "I'm giving you a call on behalf of Budget Blends.",
      "I'm giving you a call from Budget Blind.",
      "I'm reaching out on behalf of Budget Minds.",
      "I'm calling from Budget Lines.",
      "I'm with Budget Lions.",
      'Hi, this is Emily with Budget Lions.',
      'Hi there, my name is Emily. Budget Lions.',
      'Hi, this is for Jordan. Jordan, this is Joshua. Budget Blinds can come measure.',
    ];
    for (const phrase of phrases) {
      const rows = outboundUnknown(phrase);
      assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Team Member'], phrase);
    }
  });

  it('labels a carrier voicemail as Recording and the unknown team member from the outbound script', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Your call has been forwarded to voicemail.', channel: 0, startTimeMs: 0 },
          { transcript: "The person you're trying to reach is not available.", channel: 0, startTimeMs: 1500 },
          { transcript: 'The person you are trying to reach is not available.', channel: 0, startTimeMs: 1800 },
          { transcript: 'At the tone, please record your message.', channel: 0, startTimeMs: 3000 },
          { transcript: 'Your call has been forwarded to an automatic voice message system.', channel: 0, startTimeMs: 3600 },
          {
            transcript: "Hi, this is for Jordan. Jordan, this is Joshua. I'm giving a call on behalf of Budget Blinds.",
            channel: 1,
            startTimeMs: 5000,
          },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Recording',
      'Recording',
      'Recording',
      'Recording',
      'Recording',
      'Team Member',
    ]);
  });

  it('does not treat a customer asking for staff or an open greeting as the team intro', () => {
    const asking = outboundUnknown("I'm calling for Emily. Is Emily available?");
    assert.deepEqual(asking.map((row) => row.label), ['Team Member', 'Customer']);

    // "this is Joshua" with no business name used to stay on the customer channel.
    // On an outbound call that is the dialer, and the "Hello?" that answered is the far end.
    const bare = outboundUnknown('Hey, this is Joshua. I am returning your call about the shade.');
    assert.deepEqual(bare.map((row) => row.label), ['Customer', 'Team Member']);

    const itsJosh = outboundUnknown("It's Josh actually, is this Jerry?");
    assert.deepEqual(itsJosh.map((row) => row.label), ['Customer', 'Team Member']);

    const greeting = outboundUnknown("It's a great day here at Budget Blinds, this is Emily.");
    assert.deepEqual(greeting.map((row) => row.label), ['Team Member', 'Customer']);

    const thanks = outboundUnknown('Thank you for calling Budget Blinds.');
    assert.deepEqual(thanks.map((row) => row.label), ['Team Member', 'Recording']);

    const afterHours = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'I was calling back about the shade.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi there, this is Josh. Please leave your name after the tone.', channel: 1, startTimeMs: 1000 },
        ],
      },
    });
    assert.deepEqual(afterHours.map((row) => row.label), ['Team Member', 'Recording']);
  });
});

describe('desk phone attribution and answer signals', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  it('credits the sole outbound desk line when the originator id is not the participant, and takes the callee from history', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '33333333-3333-3333-8333-333333333333',
      direction: 'OUTBOUND',
      callCreated: '2026-10-12T18:41:00.000Z',
      participants: [
        line({ id: 'device', extension: '00006', name: 'Emily Kingdon', status: 'RINGING', originator: 'session-not-the-device' }),
      ],
    }), book);
    assert.equal(analysis.callIdVersion, '3');
    assert.equal(analysis.lines[0].isOriginator, true);
    assert.equal(analysis.lines[0].connected, false);
    assert.equal(analysis.externalNumber, null);

    interactions.resetForTests();
    interactions.recordLegState('conv-desk-emily', {
      legId: analysis.lines[0].legId,
      lines: analysis.lines,
      participantLegIds: ['leg-device', 'leg-pstn'],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      callCreated: '2026-10-12T18:41:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-desk-emily',
        legId: 'leg-pstn',
        direction: 'OUTBOUND',
        caller: { name: 'Emily Kingdon', number: '00006' },
        callee: { name: 'Jordan', number: CUSTOMER },
        answered: '2026-10-12T18:41:08.000Z',
      },
    });
    const leg = interactions.peekLeg('conv-desk-emily');
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)']);
    assert.equal(roster.last10(leg.externalNumber), CUSTOMER);
    assert.equal(leg.teamMemberSource, 'STARTING originator');
    assert.equal(leg.customerAnswered, true);
  });

  it('names the inbound answerer from call history when the answer field is not answerTime', () => {
    interactions.resetForTests();
    interactions.recordLegState('conv-in-emily', {
      legId: 'leg-ring',
      lines: [
        { legId: 'leg-emily', extension: '00006', name: 'Emily Kingdon', connected: false },
        { legId: 'leg-kristine', extension: '00007', name: 'Kristine Vandervort', connected: false },
      ],
      participantLegIds: ['leg-emily', 'leg-kristine'],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-12T17:00:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-in',
        legId: 'leg-kristine',
        direction: 'INBOUND',
        caller: { number: CUSTOMER, name: 'Jordan' },
        callee: { number: '00007', name: 'Kristine Vandervort' },
        answered: false,
      },
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-in',
        legId: 'leg-emily',
        direction: 'INBOUND',
        caller: { number: CUSTOMER, name: 'Jordan' },
        callee: { extensionNumber: '00006', number: OFFICE, name: 'Emily Kingdon' },
        answered: '2026-10-12T17:00:06.000Z',
      },
    });
    const leg = interactions.peekLeg('conv-in-emily');
    assert.equal(leg.direction, 'INBOUND');
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)']);
    assert.equal(leg.teamMemberSource, 'call history');
    assert.equal(roster.last10(leg.externalNumber), CUSTOMER);
  });

  it('credits an outbound extension from history when the user directory was not refreshed', () => {
    const analysis = callParties.analyzeCallHistory({
      direction: 'OUTBOUND',
      userKey: 'user-not-indexed',
      caller: { name: 'Emily Kingdon', number: '5550101777', extensionNumber: '00006' },
      callee: { number: CUSTOMER },
    }, book);
    assert.equal(analysis.teamMember.name, 'Emily Kingdon');
    assert.equal(analysis.teamMember.extension, '00006');
    assert.notEqual(analysis.teamMember.matchedBy, 'userKey');
    assert.equal(roster.last10(analysis.externalNumber), CUSTOMER);
    assert.equal(analysis.answered, false);
    assert.equal(analysis.explicitlyUnanswered, false);
  });

  it('does not credit extra ringing devices or the main line on an outbound call', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '44444444-4444-3444-8444-444444444444',
      direction: 'OUTBOUND',
      callCreated: '2026-10-12T18:00:00.000Z',
      participants: [
        line({ id: 'emily', extension: '00006', name: 'Emily Kingdon', status: 'RINGING', originator: 'emily' }),
        line({ id: 'kristine', extension: '00007', name: 'Kristine Vandervort', status: 'RINGING', originator: 'emily' }),
        line({ id: 'main', name: 'Main', status: 'RINGING', originator: 'emily' }),
      ],
    }), book);
    assert.equal(analysis.lines.find((entry) => entry.participantId === 'main').isSystem, true);
    interactions.resetForTests();
    interactions.recordLegState('conv-multi', {
      lines: analysis.lines,
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-12T18:00:00.000Z',
    });
    assert.deepEqual(names(interactions.peekLeg('conv-multi')), ['Emily Kingdon (00006)']);
  });

  it('keeps an office number off the customer and still reads a history callee', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '55555555-5555-3555-8555-555555555555',
      direction: 'OUTBOUND',
      callCreated: '2026-10-12T19:00:00.000Z',
      dialString: OFFICE,
      participants: [
        line({ id: 'josh', extension: '00003', name: 'Joshua Simington', status: 'RINGING', originator: 'other-session' }),
        phone({ id: 'pstn', originator: 'josh', caller: OFFICE, callee: OFFICE }),
      ],
    }), book);
    assert.equal(analysis.externalNumber, null);
    assert.equal(analysis.lines[0].isOriginator, true);

    interactions.resetForTests();
    interactions.recordLegState('conv-desk-josh', {
      lines: analysis.lines,
      participantLegIds: analysis.participantLegIds,
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: analysis.externalNumber,
      callCreated: '2026-10-12T19:00:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-desk-josh',
        legId: 'leg-pstn',
        direction: 'OUTBOUND',
        userKey: 'not-in-the-roster',
        caller: { name: 'Joshua Simington', number: OFFICE },
        callee: { number: DIALED, name: 'Jordan' },
        disposition: 'ANSWERED',
      },
    });
    const leg = interactions.peekLeg('conv-desk-josh');
    assert.deepEqual(names(leg), ['Joshua Simington (00003)']);
    assert.equal(roster.last10(leg.externalNumber), DIALED);
    assert.equal(leg.teamMemberSource, 'STARTING originator');
  });
});

describe('answered is unknown unless GoTo says so', () => {
  it('does not call a two-sided transcript unanswered when GoTo has no answer', () => {
    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'OUTBOUND',
        csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
        callCreated: '2026-10-12T17:11:00.000Z',
        transcript: {
          results: [
            { transcript: 'Hi, this is Emily with Budget Blinds. I have you down for Thursday.', channel: 0, startTimeMs: 0 },
            { transcript: 'Yes, that time works for me.', channel: 1, startTimeMs: 4000 },
          ],
        },
      }],
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      callCreated: '2026-10-12T17:11:00.000Z',
      callEnded: '2026-10-12T17:16:00.000Z',
      answered: null,
    });
    assert.match(built.user, /two-sided conversation/);
    assert.doesNotMatch(built.user, /Answered: no/);
    assert.doesNotMatch(built.user, /Answered: unknown/);
  });

  it('still describes the conversation when GoTo explicitly says the call was not answered', () => {
    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'INBOUND',
        csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
        callCreated: '2026-10-12T17:20:00.000Z',
        transcript: {
          results: [
            { transcript: 'Hi, I need a shade measured.', channel: 0, startTimeMs: 0 },
            { transcript: 'This is Emily with Budget Blinds, I can help with that.', channel: 1, startTimeMs: 1500 },
          ],
        },
      }],
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: CUSTOMER,
      direction: 'INBOUND',
      callCreated: '2026-10-12T17:20:00.000Z',
      callEnded: '2026-10-12T17:21:00.000Z',
      answered: false,
    });
    assert.match(built.user, /two-sided conversation/);
    assert.doesNotMatch(built.user, /Answered: no/);
  });

  it('leaves a no-transcript call unknown when GoTo did not say it was missed', () => {
    const text = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      callCreated: '2026-10-12T17:11:00.000Z',
      answered: null,
    });
    assert.match(text, /did not say whether the call was answered/);
    assert.doesNotMatch(text, /does not show that the call was answered/);
  });
});

describe('same-minute empty duplicates', () => {
  const now = new Date('2026-10-12T23:33:00.000Z').getTime();

  it('posts one of two non-substantive legs that start within two minutes and do not overlap', () => {
    const loser = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-12T23:29:05.000Z',
      callEnded: '2026-10-12T23:29:06.000Z',
      substantive: false,
      answered: false,
      openSiblings: [{
        groupKey: 'first',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-12T23:29:00.000Z',
        callEnded: '2026-10-12T23:29:01.000Z',
        substantive: false,
        answered: true,
      }],
    });
    assert.equal(loser.action, 'suppress');
    assert.equal(loser.skipArtifacts, true);

    const winner = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-12T23:29:00.000Z',
      callEnded: '2026-10-12T23:29:01.000Z',
      substantive: false,
      answered: true,
      openSiblings: [{
        groupKey: 'second',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-12T23:29:05.000Z',
        callEnded: '2026-10-12T23:29:06.000Z',
        substantive: false,
        answered: false,
      }],
    });
    assert.equal(winner.action, 'post');
    assert.equal(winner.suppressSibling, 'second');
    assert.equal(winner.skipSiblingArtifacts, true);
  });

  it('prefers the leg that has a transcript over a more specific status', () => {
    const plan = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-12T23:29:05.000Z',
      callEnded: '2026-10-12T23:29:06.000Z',
      substantive: false,
      hasTranscript: true,
      answered: false,
      openSiblings: [{
        groupKey: 'status-only',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-12T23:29:00.000Z',
        callEnded: '2026-10-12T23:29:01.000Z',
        substantive: false,
        answered: true,
      }],
    });
    assert.equal(plan.action, 'post');
    assert.equal(plan.suppressSibling, 'status-only');
  });

  it('suppresses a second empty leg after the first empty leg already finalized', () => {
    const plan = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-12T23:30:00.000Z',
      callEnded: '2026-10-12T23:30:01.000Z',
      substantive: false,
      recent: {
        groupKey: 'first',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-12T23:29:00.000Z',
        callEnded: '2026-10-12T23:29:01.000Z',
        substantive: false,
      },
    });
    assert.equal(plan.action, 'suppress');
    assert.equal(plan.skipArtifacts, true);
  });

  it('still posts two substantive calls that start a minute apart', () => {
    const second = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-12T23:30:00.000Z',
      callEnded: '2026-10-12T23:32:00.000Z',
      substantive: true,
      openSiblings: [{
        groupKey: 'first-real',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-12T23:29:00.000Z',
        callEnded: '2026-10-12T23:29:40.000Z',
        substantive: true,
      }],
    });
    assert.equal(second.action, 'post');
    assert.equal(second.suppressSibling, undefined);
  });
});

describe('call id version', () => {
  it('reads the UUID version nibble', () => {
    assert.equal(callParties.callIdVersion('11111111-1111-3111-8111-111111111111'), '3');
    assert.equal(callParties.callIdVersion('11111111-1111-4111-8111-111111111111'), '4');
    assert.equal(callParties.callIdVersion('not-a-uuid'), null);
  });
});

describe('inbound answerer', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  it('credits an inbound callee named on a DID when history joins by the customer number', () => {
    interactions.recordLegState('conv-in-did', {
      legId: 'leg-customer-only',
      lines: [],
      participantLegIds: ['leg-customer-only'],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-13T20:27:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-in-did',
        legId: 'leg-not-in-starting',
        direction: 'INBOUND',
        caller: { name: 'Jordan', number: CUSTOMER },
        callee: { name: 'Emily Kingdon', number: '5550101888' },
        talkTime: 87000,
      },
    });
    const leg = interactions.peekLeg('conv-in-did');
    assert.deepEqual(names(leg), ['Emily Kingdon (00006)']);
    assert.equal(leg.teamMemberSource, 'call history');
    assert.equal(roster.last10(leg.externalNumber), CUSTOMER);
    interactions.resetForTests();
  });

  it('does not attach inbound history when two open calls share the number', () => {
    interactions.recordLegState('conv-in-a', {
      legId: 'leg-a',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-13T20:27:00.000Z',
    });
    interactions.recordLegState('conv-in-b', {
      legId: 'leg-b',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-13T20:28:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-ambiguous',
        legId: 'leg-not-indexed',
        direction: 'INBOUND',
        caller: { number: CUSTOMER, name: 'Jordan' },
        callee: { name: 'Emily Kingdon', number: OFFICE },
        answerTime: '2026-10-13T20:27:05.000Z',
      },
    });
    assert.deepEqual(interactions.peekLeg('conv-in-a').csrChain, []);
    assert.deepEqual(interactions.peekLeg('conv-in-b').csrChain, []);
    interactions.resetForTests();
  });

  it('falls back to a roster introduction on the team channel', () => {
    interactions.recordLegState('conv-josh-intro', {
      legId: 'leg-josh-intro',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-13T17:06:00.000Z',
    });
    interactions.recordTranscript('conv-josh-intro', 'rec-josh', {
      results: [
        { transcript: 'Hello?', channel: 0, startTimeMs: 0 },
        { transcript: 'This is Josh speaking. How can I help you?', channel: 1, startTimeMs: 1000 },
      ],
    });
    interactions.applyTranscriptAnswerers('conv-josh-intro');
    const leg = interactions.peekLeg('conv-josh-intro');
    assert.equal(leg.csrChain[0].name, 'Joshua Simington');
    assert.equal(leg.csrChain[0].extension, '00003');
    assert.equal(leg.teamMemberSource, 'transcript introduction');
    interactions.resetForTests();
  });

  it('credits the person the caller asked for when the team member says that is them', () => {
    const found = callParties.answererFromTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Hi, is Emily there?', channel: 0, startTimeMs: 0 },
          { transcript: 'That would be me.', channel: 1, startTimeMs: 1500 },
        ],
      },
    }, book);
    assert.equal(found.name, 'Emily Kingdon');
    assert.equal(found.extension, '00006');
  });

  it('credits Josh from the Oct 14 lines even when a non-roster line is on the chain and a channel is missing', () => {
    interactions.recordLegState('conv-josh-352', {
      legId: 'leg-josh-352',
      lines: [{ legId: 'queue', extension: '00801', name: null, connected: true, answered: true }],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: '7073726803',
      callCreated: '2026-10-14T22:52:00.000Z',
    });
    interactions.recordTranscript('conv-josh-352', 'rec-352', {
      results: [
        { transcript: 'Yes, this is Christine. I missed your call.', channel: 1, startTimeMs: 0 },
        { transcript: 'Please note that your call may be recorded for quality assurance or training purposes.', channel: 0, startTimeMs: 1000 },
        { transcript: "It's a great day here at Budget Blind.", channel: 0, startTimeMs: 7000 },
        { transcript: 'This is Josh speaking.', startTimeMs: 13000 },
      ],
    });
    interactions.applyTranscriptAnswerers('conv-josh-352');
    const leg = interactions.peekLeg('conv-josh-352');
    assert.equal(leg.csrChain.length, 1);
    assert.equal(leg.csrChain[0].name, 'Joshua Simington');
    assert.equal(leg.csrChain[0].extension, '00003');
    assert.equal(leg.teamMemberSource, 'transcript introduction');

    const fourTen = callParties.answererFromTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Please note that your call may be recorded for quality assurance or training purposes.', channel: 1, startTimeMs: 0 },
          { transcript: 'We can hear a bunch of blinds. This is Josh speaking. How can I help you?', channel: 1, startTimeMs: 6000 },
          { transcript: "Where's your showroom?", channel: 0, startTimeMs: 10000 },
        ],
      },
    }, book);
    assert.equal(fourTen.name, 'Joshua Simington');
  });

  it('credits Emily from the Oct 14 confirmations and leaves an unnamed greeting unknown', () => {
    const emilyPlease = callParties.answererFromTranscript({
      direction: 'INBOUND',
      transcript: {
        results: [
          { transcript: 'Please note that your call may be recorded for quality assurance or training purposes.', channel: 1, startTimeMs: 0 },
          { transcript: "It's a great day here, I'm going to help you.", channel: 1, startTimeMs: 10000 },
          { transcript: 'Hi, Emily, please.', channel: 0, startTimeMs: 13000 },
          { transcript: "It's me, I'm going to help you.", channel: 1, startTimeMs: 15000 },
        ],
      },
    }, book);
    assert.equal(emilyPlease.name, 'Emily Kingdon');

    const yesItIs = callParties.answererFromTranscript({
      direction: 'INBOUND',
      transcript: {
        results: [
          { transcript: "It's a great day here at Budget Bullion, second day hope", channel: 1, startTimeMs: 7000 },
          { transcript: 'Hi, is this Emily?', channel: 0, startTimeMs: 11000 },
          { transcript: 'yes it is.', channel: 1, startTimeMs: 12000 },
        ],
      },
    }, book);
    assert.equal(yesItIs.name, 'Emily Kingdon');

    const callingFor = callParties.answererFromTranscript({
      direction: 'INBOUND',
      transcript: {
        results: [
          { transcript: 'Hi, I was calling for Emily.', channel: 0, startTimeMs: 0 },
          { transcript: 'Oh, that would be me, Karen.', channel: 1, startTimeMs: 1500 },
        ],
      },
    }, book);
    assert.equal(callingFor.name, 'Emily Kingdon');

    const unnamed = callParties.answererFromTranscript({
      direction: 'INBOUND',
      transcript: {
        results: [
          { transcript: 'Budget Blinds, can you please hold?', channel: 1, startTimeMs: 0 },
          { transcript: 'Okay, thanks.', channel: 0, startTimeMs: 2000 },
        ],
      },
    }, book);
    assert.equal(unnamed, null);
  });

  it('does not treat the after-hours recording as Joshua answering', () => {
    const found = callParties.answererFromTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Hi there, this is Josh. Please leave your name after the tone.', channel: 0, startTimeMs: 0 },
          { transcript: 'Hi, I need a shade repaired.', channel: 1, startTimeMs: 8000 },
        ],
      },
    }, book);
    assert.equal(found, null);
  });
});

describe('substantive leg and fragment dedup', () => {
  const now = new Date('2026-10-13T20:31:00.000Z').getTime();

  it('posts the real inbound conversation when an empty leg for that number already finalized', () => {
    const plan = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'INBOUND',
      now,
      callCreated: '2026-10-13T20:27:00.000Z',
      callEnded: '2026-10-13T20:28:30.000Z',
      substantive: true,
      fragment: false,
      recent: {
        groupKey: 'parked',
        externalNumber: CUSTOMER,
        direction: 'INBOUND',
        callCreated: '2026-10-13T20:26:10.000Z',
        callEnded: '2026-10-13T20:26:40.000Z',
        substantive: false,
      },
    });
    assert.equal(plan.action, 'post');
    assert.equal(plan.skipArtifacts, undefined);
  });

  it('drops a one-line fragment when a sibling recording has the conversation', () => {
    const fragment = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-13T20:25:00.000Z',
      callEnded: '2026-10-13T20:25:04.000Z',
      substantive: true,
      fragment: true,
      openSiblings: [{
        groupKey: 'voicemail',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-13T20:25:05.000Z',
        callEnded: '2026-10-13T20:25:40.000Z',
        substantive: true,
        fragment: false,
      }],
    });
    assert.equal(fragment.action, 'suppress');
    assert.equal(fragment.skipArtifacts, true);

    const real = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-13T20:25:05.000Z',
      callEnded: '2026-10-13T20:25:40.000Z',
      substantive: true,
      fragment: false,
      openSiblings: [{
        groupKey: 'greeting-fragment',
        externalNumber: CUSTOMER,
        direction: 'OUTBOUND',
        callCreated: '2026-10-13T20:25:00.000Z',
        callEnded: '2026-10-13T20:25:04.000Z',
        substantive: true,
        fragment: true,
      }],
    });
    assert.equal(real.action, 'post');
    assert.equal(real.suppressSibling, 'greeting-fragment');
    assert.equal(real.skipSiblingArtifacts, true);
  });

  it('holds a fragment briefly when the rest of the recording has not arrived', () => {
    const held = callParties.postingPlan({
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      now,
      callCreated: '2026-10-13T20:30:00.000Z',
      callEnded: '2026-10-13T20:30:03.000Z',
      substantive: true,
      fragment: true,
    });
    assert.equal(held.action, 'hold');
    assert.equal(callParties.callIsFragment({
      transcript: { results: [{ transcript: 'Hey, this is Sue.' }] },
    }), true);
    assert.equal(callParties.callIsFragment({
      transcript: {
        results: [
          { transcript: 'Hey, this is Sue. Please leave a message.' },
          { transcript: 'Hi Sue, this is Emily with Budget Blinds, calling about Thursday.' },
        ],
      },
    }), false);
  });
});

describe('inbound speaker sanity', () => {
  it('flips an inbound call when the open greeting was labeled as the customer', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: "It's a great day here at Budget Blinds, how can I help you?", channel: 0, startTimeMs: 0 },
          { transcript: "My name's Paul and I was trying to get an appointment.", channel: 1, startTimeMs: 2000 },
          { transcript: 'We can do Thursday between 10 and 2.', channel: 0, startTimeMs: 5000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Customer', 'Team Member']);
  });

  it('leaves a correctly channeled inbound greeting on the team side', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006' }],
      transcript: {
        results: [
          { transcript: "My name's Paul and I was trying to get an appointment.", channel: 0, startTimeMs: 0 },
          { transcript: "It's a great day here at Budget Blinds, how can I help you?", channel: 1, startTimeMs: 1500 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Customer', 'Recording']);
  });

  it('labels vendor hold menus and the carrier hang-up prompt as recordings', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Thank you for calling Hunter Douglas.', channel: 1, startTimeMs: 0 },
          { transcript: 'You have reached the budget blinds dedicated support line.', channel: 1, startTimeMs: 2000 },
          { transcript: 'For customer and technical support, press one.', channel: 1, startTimeMs: 15000 },
          { transcript: 'Your estimated wait time is less than 10 minutes.', channel: 1, startTimeMs: 290000 },
          { transcript: 'If you would like to save your place in line and have an agent call you back.', channel: 1, startTimeMs: 37000 },
          { transcript: 'Welcome to Bright, our new dealer portal replacing the link.', channel: 1, startTimeMs: 80000 },
          { transcript: 'When you have finished recording, you may hang up.', channel: 1, startTimeMs: 8000 },
          { transcript: 'Do you know how many minutes?', channel: 0, startTimeMs: 47000 },
          { transcript: "It's a great day.", channel: 0, startTimeMs: 485000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => `${row.seconds}:${row.label}:${row.text.slice(0, 24)}`), [
      '0:Recording:Thank you for calling Hu',
      '2:Recording:You have reached the bud',
      '8:Recording:When you have finished r',
      '15:Recording:For customer and technic',
      '37:Recording:If you would like to sav',
      '47:Team Member:Do you know how many min',
      '80:Recording:Welcome to Bright, our n',
      '290:Recording:Your estimated wait time',
      '485:Team Member:It\'s a great day.',
    ]);
  });

  it('labels park and zip-code prompts as recordings', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Amy Bullock', extension: '00001' }],
      transcript: {
        results: [
          { transcript: 'I am sorry, but there is no call parked on that extension. Please try again.', channel: 1, startTimeMs: 0 },
          { transcript: 'Please enter your zip code.', channel: 0, startTimeMs: 2000 },
        ],
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Recording']);
  });
});

describe('outbound intro attribution', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  it('credits Emily from the voicemail intro when call-state named nobody', () => {
    interactions.recordLegState('conv-vm', {
      legId: 'leg-vm',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: '4157131063',
      callCreated: '2026-10-14T16:14:00.000Z',
    });
    interactions.recordTranscript('conv-vm', 'rec-vm', {
      results: [
        { transcript: 'your call has been forwarded to voicemail.', channel: 0, startTimeMs: 0 },
        { transcript: 'When you have finished recording, you may hang up.', channel: 0, startTimeMs: 8000 },
        { transcript: "Hi there, my name is Emily. I'm calling on behalf of Budget Blinds.", channel: 1, startTimeMs: 11000 },
      ],
    });
    interactions.applyTranscriptAnswerers('conv-vm');
    const leg = interactions.peekLeg('conv-vm');
    assert.equal(leg.csrChain[0].name, 'Emily Kingdon');
    assert.equal(leg.csrChain[0].extension, '00006');
    assert.equal(leg.teamMemberSource, 'outbound introduction');

    const ron = callParties.outboundIntroAnswerer({
      direction: 'OUTBOUND',
      transcript: {
        results: [
          { transcript: 'At the tone, please record your message.', channel: 0, startTimeMs: 0 },
          { transcript: "Hi Ron, my name is Emily. I'm calling on behalf of Budget Blinds.", channel: 1, startTimeMs: 4000 },
        ],
      },
    }, book);
    assert.equal(ron.name, 'Emily Kingdon');

    const unnamed = callParties.outboundIntroAnswerer({
      direction: 'OUTBOUND',
      transcript: {
        results: [
          { transcript: "I'm calling on behalf of Budget Blinds.", channel: 1, startTimeMs: 0 },
        ],
      },
    }, book);
    assert.equal(unnamed, null);
  });
});

describe('inbound caller recovery', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  const maryTranscript = {
    results: [
      { transcript: 'Hi, is this Emily?', channel: 0, startTimeMs: 0 },
      { transcript: 'yes it is.', channel: 1, startTimeMs: 1200 },
      { transcript: "Hi, Emily. This is Mary. I've decided not to proceed because of the delivery time.", channel: 0, startTimeMs: 3000 },
    ],
  };

  it('posts a substantive inbound when only call history had the caller number', () => {
    interactions.recordLegState('conv-mary', {
      legId: 'leg-mary-state',
      lines: [],
      participantLegIds: ['leg-mary-state'],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      callCreated: '2026-10-14T20:16:00.000Z',
      callEnded: '2026-10-14T20:17:00.000Z',
    });
    interactions.recordTranscript('conv-mary', 'rec-mary', maryTranscript);
    interactions.applyTranscriptAnswerers('conv-mary');
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-mary',
        legId: 'leg-not-in-starting',
        direction: 'INBOUND',
        startTime: '2026-10-14T20:16:02.000Z',
        caller: { name: 'MERRY CROSLIN', number: '+19168350499' },
        callee: { name: 'Direct DID', number: '5550101888' },
        talkTime: 60000,
      },
    });
    const described = interactions.describeForTests('conv-mary');
    assert.equal(roster.last10(described.externalNumber), '9168350499');
    assert.equal(described.externalConflict, false);
    assert.equal(described.csrChain[0].name, 'Emily Kingdon');
    const plan = callParties.postingPlan({
      externalNumber: described.externalNumber,
      externalConflict: described.externalConflict,
      direction: described.direction,
      substantive: described.substantive,
      hasTranscript: described.hasTranscript,
      callCreated: described.callCreated,
      callEnded: described.callEnded,
      answered: described.answered,
    });
    assert.equal(plan.action, 'post');
  });

  it('uses the STARTING originator number when call-state did not pick a caller', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '44444444-4444-3444-8444-444444444444',
      direction: 'INBOUND',
      callCreated: '2026-10-14T21:14:00.000Z',
      participants: [
        {
          participantId: 'orig',
          originator: 'orig',
          legId: 'leg-orig',
          status: { value: 'CONNECTED' },
          type: { value: 'PHONE_NUMBER', callerNumber: '+15032604268', callee: { number: '5550101777' } },
        },
      ],
    }), book);
    assert.equal(analysis.externalNumber, null);
    assert.equal(roster.last10(analysis.originatorNumber), '5032604268');

    interactions.recordLegState('conv-caryn', {
      legId: 'leg-orig',
      lines: analysis.lines,
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      originatorNumber: analysis.originatorNumber,
      callCreated: '2026-10-14T21:14:00.000Z',
      callEnded: '2026-10-14T21:16:00.000Z',
    });
    interactions.recordTranscript('conv-caryn', 'rec-caryn', {
      results: [
        { transcript: 'Hi, I was calling for Emily.', channel: 0, startTimeMs: 0 },
        { transcript: 'Oh, that would be me, Karen.', channel: 1, startTimeMs: 1500 },
        { transcript: 'I need to book an install for Friday between 12 and 4.', channel: 0, startTimeMs: 4000 },
      ],
    });
    interactions.applyTranscriptAnswerers('conv-caryn');
    const described = interactions.describeForTests('conv-caryn');
    assert.equal(roster.last10(described.externalNumber), '5032604268');
    assert.equal(described.csrChain[0].name, 'Emily Kingdon');
  });

  it('does not invent a number for a greeting with no conversation', () => {
    interactions.recordLegState('conv-greeting', {
      legId: 'leg-greeting',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      originatorNumber: '+15308487479',
      callCreated: '2026-10-14T15:24:00.000Z',
      callEnded: '2026-10-14T15:24:20.000Z',
    });
    interactions.recordTranscript('conv-greeting', 'rec-greeting', {
      results: [
        { transcript: "It's a great day here at Budget Blinds. Our normal business hours are 9 to 5.", channel: 0, startTimeMs: 0 },
      ],
    });
    const described = interactions.describeForTests('conv-greeting');
    assert.equal(described.substantive, false);
    assert.equal(described.externalNumber, null);
  });

  it('posts the history caller when call-state reported two numbers', () => {
    interactions.recordLegState('conv-conflict', {
      legId: 'leg-conflict',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER,
      callCreated: '2026-10-14T20:16:00.000Z',
      callEnded: '2026-10-14T20:17:00.000Z',
    });
    interactions.recordLegState('conv-conflict', {
      legId: 'leg-conflict',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: OTHER_CUSTOMER,
      callCreated: '2026-10-14T20:16:00.000Z',
      callEnded: '2026-10-14T20:17:00.000Z',
    });
    interactions.recordTranscript('conv-conflict', 'rec-conflict', maryTranscript);
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-conflict',
        legId: 'leg-conflict',
        direction: 'INBOUND',
        startTime: '2026-10-14T20:16:02.000Z',
        caller: { number: CUSTOMER, name: 'Mary' },
        callee: { name: 'Emily Kingdon', number: OFFICE },
        talkTime: 60000,
      },
    });
    const described = interactions.describeForTests('conv-conflict');
    assert.equal(roster.last10(described.externalNumber), CUSTOMER);
    assert.equal(described.externalConflict, false);
  });

  it('does not pick a caller when two different caller numbers were seen', () => {
    interactions.recordLegState('conv-two', {
      legId: 'leg-two',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      originatorNumber: CUSTOMER,
      callCreated: '2026-10-14T20:16:00.000Z',
      callEnded: '2026-10-14T20:17:00.000Z',
    });
    interactions.recordTranscript('conv-two', 'rec-two', maryTranscript);
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-two',
        legId: 'leg-not-indexed',
        direction: 'INBOUND',
        startTime: '2026-10-14T20:16:02.000Z',
        caller: { number: OTHER_CUSTOMER, name: 'Someone Else' },
        callee: { name: 'Direct', number: '5550101888' },
        talkTime: 60000,
      },
    });
    const described = interactions.describeForTests('conv-two');
    assert.equal(described.externalNumber, null);
  });
});

describe('parked orphan transcripts', () => {
  beforeEach(() => interactions.resetForTests());
  after(() => interactions.resetForTests());

  it('attaches a transcript once the recording is linked to a conversation', () => {
    interactions.parkOrphanTranscript('rec-twinkle', {
      results: [
        { transcript: 'I need a second remote for the shade at the top of the stairs.', channel: 0, startTimeMs: 0 },
        { transcript: 'I will get the cost and call you back.', channel: 1, startTimeMs: 4000 },
      ],
    });
    assert.equal(interactions.peekLeg('conv-twinkle'), null);
    assert.equal(interactions.attachParkedOrphan('rec-twinkle', 'conv-twinkle'), true);
    assert.equal(interactions.peekLeg('conv-twinkle').recordingId, 'rec-twinkle');
    assert.equal(interactions.attachParkedOrphan('rec-twinkle', 'conv-twinkle'), false);
  });

  it('logs and drops an orphan that never gets a conversation', () => {
    interactions.parkOrphanTranscript('rec-michelle', { results: [{ transcript: 'Hello?', channel: 0, startTimeMs: 0 }] });
    assert.equal(interactions.abandonOrphan('rec-michelle'), true);
    assert.equal(interactions.abandonOrphan('rec-michelle'), false);
    assert.equal(interactions.attachParkedOrphan('rec-michelle', 'conv-late'), false);
  });
});

describe('Oct 15 inbound answerer on an outbound-tagged leg', () => {
  beforeEach(() => interactions.resetForTests());
  after(() => interactions.resetForTests());

  it('credits Josh when the recording leg is tagged outbound and the call is inbound', () => {
    interactions.recordLegState('conv-in-1056', {
      legId: 'leg-in-1056',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: '9165051285',
      callCreated: '2026-10-15T17:56:00.000Z',
      callEnded: '2026-10-15T18:02:00.000Z',
    });
    interactions.recordLegState('conv-agent-1056', {
      legId: 'leg-agent-1056',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      callCreated: '2026-10-15T17:56:05.000Z',
      callEnded: '2026-10-15T18:02:00.000Z',
    });
    interactions.recordTranscript('conv-agent-1056', 'rec-1056', {
      results: [
        { transcript: 'Please note that your call may be recorded for quality assurance or training purposes.', channel: 1, startTimeMs: 0 },
        { transcript: "It's a great day here at Budget Blinds.", channel: 1, startTimeMs: 7000 },
        { transcript: 'This is Josh speaking. How can I help you?', channel: 0, startTimeMs: 12000 },
        { transcript: 'Hi Josh, how are you?', channel: 1, startTimeMs: 14000 },
      ],
    });
    interactions.recordCallHistoryEvent({ content: { originatorId: 'orig-1056', legId: 'leg-in-1056', direction: 'INBOUND' } });
    interactions.recordCallHistoryEvent({ content: { originatorId: 'orig-1056', legId: 'leg-agent-1056', direction: 'OUTBOUND' } });
    interactions.applyTranscriptAnswerers('orig-1056');
    const described = interactions.describeForTests('orig-1056');
    assert.equal(described.direction, 'INBOUND');
    assert.deepEqual(described.csrPath, ['Joshua Simington (00003)']);
    const rows = openaiClient.formatLegTranscript(described.legRecords.find((leg) => leg.transcript));
    assert.match(rows.map((row) => `${row.label}: ${row.text}`).join('\n'), /Joshua Simington: This is Josh speaking/);
  });

  it('leaves an unnamed hold request unknown on that same outbound-tagged leg', () => {
    interactions.recordLegState('conv-in-hold', {
      legId: 'leg-in-hold',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      callCreated: '2026-10-15T16:01:00.000Z',
    });
    interactions.recordLegState('conv-agent-hold', {
      legId: 'leg-agent-hold',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      callCreated: '2026-10-15T16:01:05.000Z',
    });
    interactions.recordTranscript('conv-agent-hold', 'rec-hold', {
      results: [
        { transcript: 'Budget Blinds, can you please hold?', channel: 0, startTimeMs: 0 },
        { transcript: 'Okay, thanks.', channel: 1, startTimeMs: 2000 },
      ],
    });
    interactions.recordCallHistoryEvent({ content: { originatorId: 'orig-hold', legId: 'leg-in-hold', direction: 'INBOUND' } });
    interactions.recordCallHistoryEvent({ content: { originatorId: 'orig-hold', legId: 'leg-agent-hold', direction: 'OUTBOUND' } });
    interactions.applyTranscriptAnswerers('orig-hold');
    const described = interactions.describeForTests('orig-hold');
    assert.deepEqual(described.csrPath, []);
  });
});

describe('Oct 15 franchisee speaker swap', () => {
  it('keeps our Josh on the team side when the other franchise answers', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Good morning budget blinds.', channel: 0, startTimeMs: 0 },
          { transcript: 'This is Leigh T.', channel: 0, startTimeMs: 1000 },
          { transcript: "Hey, ladies, it's Josh with budget blinds and Sacramento.", channel: 1, startTimeMs: 3000 },
          { transcript: 'How are you doing?', channel: 1, startTimeMs: 5000 },
          { transcript: "Hey Josh, I'm good.", channel: 0, startTimeMs: 6000 },
        ],
      },
    });
    const labeled = rows.map((row) => `${row.label}: ${row.text}`);
    assert.match(labeled[0], /^Customer: Good morning budget blinds/);
    assert.match(labeled[1], /^Customer: This is Leigh T/);
    assert.match(labeled[2], /^Joshua Simington: Hey, ladies, it's Josh with budget blinds/);
    assert.match(labeled[4], /^Customer: Hey Josh, I'm good/);
  });
});

describe('Oct 15 short inbound caller number', () => {
  const ended = '2026-10-15T16:02:00.000Z';
  const justAfter = new Date('2026-10-15T16:02:30.000Z').getTime();
  const later = new Date('2026-10-15T16:06:00.000Z').getTime();

  it('holds a substantive inbound with no number and reviews a hours greeting immediately', () => {
    const held = callParties.postingPlan({
      externalNumber: null,
      direction: 'INBOUND',
      substantive: true,
      callEnded: ended,
      now: justAfter,
    });
    assert.equal(held.action, 'hold');
    assert.match(held.reason, /caller number/);

    const gaveUp = callParties.postingPlan({
      externalNumber: null,
      direction: 'INBOUND',
      substantive: true,
      callEnded: ended,
      now: later,
    });
    assert.equal(gaveUp.action, 'review');

    const greeting = callParties.postingPlan({
      externalNumber: null,
      direction: 'INBOUND',
      substantive: false,
      callEnded: ended,
      now: justAfter,
    });
    assert.equal(greeting.action, 'review');
  });
});

describe('Oct 15 vendor menu labels', () => {
  it('labels the Hunter Douglas training menu as a recording, and Josh\'s name as Joshua', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Thank you for calling Hunter Douglas.', channel: 0, startTimeMs: 0 },
          { transcript: 'Our team is currently in training', channel: 0, startTimeMs: 2000 },
          { transcript: 'and will be back on the phones at the top of the hour.', channel: 0, startTimeMs: 3000 },
          { transcript: 'To avoid waiting on hold,', channel: 0, startTimeMs: 7000 },
          { transcript: 'please select the callback option', channel: 0, startTimeMs: 9000 },
          { transcript: 'The system will automatically disconnect this call to schedule', channel: 0, startTimeMs: 91000 },
          { transcript: 'Josh?', channel: 1, startTimeMs: 71000 },
        ],
      },
    });
    const labels = rows.map((row) => `${row.label}: ${row.text.slice(0, 24)}`);
    assert.deepEqual(labels, [
      'Recording: Thank you for calling Hu',
      'Recording: Our team is currently in',
      'Recording: and will be back on the ',
      'Recording: To avoid waiting on hold',
      'Recording: please select the callba',
      'Joshua Simington: Josh?',
      'Recording: The system will automati',
    ]);
  });
});

describe('Oct 19 inbound answerer on the live transcript shape', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  // GoTo transcription JSON, the shape fetchTranscript returns and recordTranscript stores.
  // Channel 1 is the inbound team side (what the caller heard). Channel 0 is the caller.
  function liveGoto(lines, teamChannel) {
    const customerChannel = teamChannel === 0 ? 1 : 0;
    return {
      version: '1.0.0',
      results: lines.map(([seconds, role, text]) => ({
        type: 'utterances',
        transcript: text,
        final: true,
        startTimeMs: seconds * 1000,
        endTimeMs: seconds * 1000 + 800,
        channel: role === 'customer' ? customerChannel : teamChannel,
        languageCode: 'en-US',
      })),
    };
  }

  function play(id, lines, teamChannel, extra = {}) {
    interactions.recordLegState(id, {
      legId: `leg-${id}`,
      lines: [],
      participantLegIds: [`leg-${id}`],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: extra.externalNumber || '9166285645',
      externalName: extra.externalName || 'MARIA FERGUSON',
      callCreated: extra.callCreated || '2026-10-19T19:08:00.000Z',
      callEnded: extra.callEnded || '2026-10-19T19:09:00.000Z',
    });
    interactions.recordTranscript(id, `rec-${id}`, liveGoto(lines, teamChannel));
    interactions.applyTranscriptAnswerers(id);
    const described = interactions.describeForTests(id);
    const leg = described.legRecords.find((entry) => entry.transcript);
    return {
      described,
      rows: openaiClient.formatLegTranscript(leg),
    };
  }

  // 12:08 PM PT IN (916) 628-5645. The Drive doc labeled the intro "Team Member"
  // and the header unknown. With the roster file loaded, the same utterances credit Joshua.
  const maria = [
    [0, 'team', 'Please note that your call may be recorded for quality assurance or training purposes.'],
    [9, 'team', "It's a great day here at Budget Blinds."],
    [11, 'team', "This is Josh speaking. I'm going to help you."],
    [13, 'customer', 'Hey, Josh, I think that was you that I spoke with earlier.'],
    [16, 'team', 'Yes, Maria. And I think actually'],
    [19, 'team', 'your daughter had called in Nicole, correct?'],
    [22, 'customer', 'Yes, yes.'],
    [23, 'team', 'Okay. I think she'],
    [23, 'customer', 'I was just going to say,'],
    [24, 'team', 'called in. She got you all set up actually with an appointment. You guys are on the schedule'],
    [28, 'team', 'for the 21st with an arrival time between 2.30 and 3.'],
    [34, 'customer', "yeah, that's what she told me."],
    [35, 'customer', "That's why I was calling you."],
    [37, 'customer', "I didn't watch."],
    [37, 'team', 'Yeah, my colleague is the one who...'],
    [39, 'team', 'who intercepted that part of the call.'],
    [41, 'team', "So I didn't hear that."],
    [42, 'team', 'I was just returning the call'],
    [43, 'team', 'as I had promised 30 minutes later.'],
    [46, 'team', 'So, but my colleague just let me know'],
    [48, 'team', 'that she got you guys all on the calendar.'],
    [50, 'team', 'And we look forward to seeing you on the 21st.'],
    [53, 'customer', 'Well, there you go. We were both trying to be polite, and I called you just as a courtesy'],
    [56, 'team', 'Well, I appreciate you letting me know here, Maria.'],
    [58, 'customer', 'call to say, well, my daughter has it all set up. Here you go, ladies.'],
    [65, 'team', 'You have a wonderful day'],
    [67, 'team', 'and we look forward to seeing you soon.'],
    [69, 'team', 'Thank you.'],
    [69, 'customer', 'Alrighty, thank you so much. You have a great day. Bye.'],
    [71, 'team', 'Take care.'],
  ];

  // 4:16 PM PT IN (510) 220-7533.
  const usher = [
    [0, 'team', 'Please note that your call may be recorded for quality assurance or training purposes.'],
    [6, 'team', "It's a great day here at Budget Blind."],
    [9, 'team', "It's Josh speaking."],
    [11, 'customer', 'Hi Josh, my last name is Usher.'],
    [14, 'customer', 'I had an appointment with Heather tomorrow at 11.30,'],
    [17, 'customer', "and I'd like to cancel."],
    [19, 'team', 'Yeah, can I ask the reason for cancellation, Mr. Asher?'],
    [22, 'customer', 'I just made different choices,'],
    [24, 'team', "Yeah, so you've already completed the window treatment"],
    [25, 'team', 'project elsewhere.'],
    [27, 'customer', 'I believe so.'],
    [28, 'team', 'OK.'],
    [29, 'team', "We'd love an opportunity to provide you an estimate"],
    [31, 'team', 'or highly rated in the area.'],
    [33, 'team', 'So if you wanted to end up getting back on our schedule,'],
    [35, 'team', 'just please reach out.'],
    [36, 'team', "And we'd be more than happy to provide an estimate."],
    [39, 'customer', 'I appreciate that. Thank you so much, Josh.'],
    [40, 'team', 'You have a great day.'],
    [42, 'customer', 'You too. Be well.'],
  ];

  it('credits Joshua from the Oct 19 docs when the roster file is loaded', () => {
    const noon = play('conv-1019-1208', maria, 1);
    assert.deepEqual(noon.described.csrPath, ['Joshua Simington (00003)']);
    assert.equal(noon.described.teamMemberSource, 'transcript introduction');
    const noonText = noon.rows.map((row) => `[${row.seconds}s] ${row.label}: ${row.text}`).join('\n');
    assert.match(noonText, /\[9s\] Recording: It's a great day here at Budget Blinds\./);
    assert.match(noonText, /\[11s\] Joshua Simington: This is Josh speaking\. I'm going to help you\./);

    const flipped = play('conv-1019-1208-ch0', maria, 0);
    assert.deepEqual(flipped.described.csrPath, ['Joshua Simington (00003)']);
    assert.match(
      flipped.rows.map((row) => `[${row.seconds}s] ${row.label}: ${row.text}`).join('\n'),
      /\[11s\] Joshua Simington: This is Josh speaking/,
    );

    const afternoon = play('conv-1019-1616', usher, 1, {
      externalNumber: '5102207533',
      externalName: 'EMON USHER',
      callCreated: '2026-10-19T23:16:00.000Z',
      callEnded: '2026-10-19T23:17:00.000Z',
    });
    assert.deepEqual(afternoon.described.csrPath, ['Joshua Simington (00003)']);
    assert.match(
      afternoon.rows.map((row) => `[${row.seconds}s] ${row.label}: ${row.text}`).join('\n'),
      /\[9s\] Joshua Simington: It's Josh speaking\./,
    );
  });

  it('reproduces the Oct 19 unknown header when the roster is empty, as in the Docker image', () => {
    roster.setRosterForTests(roster.createRoster({ people: [] }));
    const played = play('conv-1019-empty-roster', maria, 1);
    assert.deepEqual(played.described.csrPath, []);
    assert.equal(played.described.teamMemberSource, 'none');
    const text = played.rows.map((row) => `[${row.seconds}s] ${row.label}: ${row.text}`).join('\n');
    assert.match(text, /\[9s\] Recording: It's a great day here at Budget Blinds\./);
    assert.match(text, /\[11s\] Team Member: This is Josh speaking\. I'm going to help you\./);
    assert.equal(text.includes('Joshua Simington'), false);
  });

  it('ships the roster file in the image the server actually runs', () => {
    roster.resetRosterForTests();
    assert.equal(roster.getRoster().personByExtension('00003').name, 'Joshua Simington');
    assert.equal(roster.getRoster().firstNames.includes('Josh'), true);
    const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    assert.match(docker, /COPY config \.\/config/);
  });
});

describe('Oct 19 recordings mislabeled as people', () => {
  it('labels the queue continuation, the IVR tagline, and the carrier mailbox as recordings', () => {
    const queue = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Please note that your call may be recorded for quality assurance or training purposes.', channel: 1, startTimeMs: 0 },
          { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 25000 },
          { transcript: 'We are currently assisting other callers.', channel: 1, startTimeMs: 28000 },
          { transcript: 'However, your call is very important to us.', channel: 1, startTimeMs: 30000 },
          { transcript: 'Please stay on the line.', channel: 1, startTimeMs: 32000 },
        ],
      },
    });
    assert.deepEqual(queue.map((row) => row.label), ['Recording', 'Recording', 'Recording', 'Recording', 'Recording']);

    const ivr = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 0 },
          { transcript: 'The best in custom blinds, shades, shutters, drapes and more.', channel: 1, startTimeMs: 2000 },
          { transcript: "It's a great day here.", channel: 1, startTimeMs: 40000 },
          { transcript: "That's a great day here, budget blind.", channel: 1, startTimeMs: 8000 },
          { transcript: 'Blimey speaking, can I start?', channel: 1, startTimeMs: 41000 },
        ],
      },
    });
    assert.deepEqual(ivr.map((row) => row.label), ['Recording', 'Recording', 'Recording', 'Recording', 'Team Member']);

    const mailbox = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'Your call has been forwarded to an automated voice messaging system.', channel: 0, startTimeMs: 0 },
          { transcript: 'is not available.', channel: 0, startTimeMs: 15000 },
          { transcript: 'The mailbox is full and cannot accept any messages at this time.', channel: 0, startTimeMs: 19000 },
          { transcript: 'Goodbye.', channel: 0, startTimeMs: 22000 },
        ],
      },
    });
    assert.deepEqual(mailbox.map((row) => `${row.label}: ${row.text}`), [
      'Recording: Your call has been forwarded to an automated voice messaging system.',
      'Recording: is not available.',
      'Recording: The mailbox is full and cannot accept any messages at this time.',
      'Joshua Simington: Goodbye.',
    ]);
  });
});

describe('Oct 19 caller name in the summary prompt', () => {
  it('tells the model to keep a confirmed caller and not a designer mentioned in passing', () => {
    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'INBOUND',
        csrChain: [],
        callCreated: '2026-10-19T17:16:00.000Z',
        transcript: {
          results: [
            { transcript: 'Okay, is this Rick?', channel: 1, startTimeMs: 64000 },
            { transcript: 'yes it is.', channel: 0, startTimeMs: 66000 },
          ],
        },
      }],
      csrPath: [],
      externalName: 'RICHARD BROWN',
      externalNumber: '5309067201',
      direction: 'INBOUND',
      callCreated: '2026-10-19T17:16:00.000Z',
      callEnded: '2026-10-19T17:18:00.000Z',
      answered: null,
    });
    assert.match(built.system, /is this Rick/);
    assert.match(built.system, /yes it is/);
    assert.match(built.system, /RICHARD BROWN/);
    assert.match(built.system, /Heather/);
    assert.match(built.system, /appointment with Heather/);
    assert.match(built.user, /RICHARD BROWN/);
  });
});

describe('Oct 20 inbound answerer from the call events report', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
  const CUSTOMER_20 = '5550101047';

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  // Documented report shape, trimmed: callStates LINE status, nested line.extensionNumber,
  // and the summary participant's userKey / userFirstName / userLastName. Phone numbers
  // and ids here are synthetic. ENDING participants are empty, matching the live webhook.
  function queueReport({ connectedExtension, connectedName, alsoRinging, userKey, extensionOnSummary }) {
    const emilyLeg = 'leg-answerer';
    const states = [
      {
        sequenceNumber: 1,
        type: 'ACTIVE',
        timestamp: '2026-10-20T16:43:02.000Z',
        participants: [
          {
            legId: 'leg-caller',
            status: { value: 'CONNECTED' },
            type: { value: 'PHONE_NUMBER', number: `+1${CUSTOMER_20}` },
          },
          ...(alsoRinging || []).map((entry) => ({
            legId: `leg-${entry.extension}`,
            status: { value: 'RINGING' },
            type: { value: 'LINE', extensionNumber: entry.extension, name: entry.name },
          })),
          {
            legId: emilyLeg,
            status: { value: 'RINGING' },
            type: { value: 'LINE', extensionNumber: connectedExtension, name: connectedName },
          },
        ],
      },
      {
        sequenceNumber: 2,
        type: 'ACTIVE',
        timestamp: '2026-10-20T16:43:08.000Z',
        participants: [
          {
            legId: 'leg-caller',
            status: { value: 'CONNECTED' },
            type: { value: 'PHONE_NUMBER', phoneNumber: { number: `+1${CUSTOMER_20}` } },
          },
          {
            legId: emilyLeg,
            status: { value: 'CONNECTED' },
            type: { value: 'LINE', line: { extensionNumber: connectedExtension, name: connectedName } },
          },
        ],
      },
      { sequenceNumber: 3, type: 'ENDING', timestamp: '2026-10-20T16:47:00.000Z', participants: [] },
    ];
    return {
      direction: 'INBOUND',
      callAnswered: '2026-10-20T16:43:08.000Z',
      participants: [
        {
          legId: emilyLeg,
          name: connectedName,
          number: extensionOnSummary || connectedExtension,
          type: {
            value: 'LINE',
            userKey: userKey || null,
            userFirstName: connectedName.split(' ')[0],
            userLastName: connectedName.split(' ').slice(1).join(' '),
          },
        },
      ],
      interactiveVoiceResponseSystems: [
        { type: { value: 'CALL_QUEUE', queueName: 'Main' } },
      ],
      callStates: states,
    };
  }

  function greetingTranscript() {
    return {
      results: [
        { transcript: "It's a great day here at Budget Blinds, how can I help you?", channel: 1, startTimeMs: 0 },
        { transcript: 'I need to check on an order.', channel: 0, startTimeMs: 4000 },
        { transcript: 'I can look that up for you.', channel: 1, startTimeMs: 7000 },
      ],
    };
  }

  it('keeps a unique full name unresolved when two extensions share it, and uses the first line for a spoken name', () => {
    assert.equal(book.personByName('Amy Bullock'), null);
    assert.equal(book.primaryByName('Amy Bullock').extension, '00001');
    assert.equal(book.personByExtension('00005').name, 'Amy Bullock');
  });

  it('reads a connected nested line on a call-state payload', () => {
    const analysis = callParties.analyzeCallState(callState({
      conversationSpaceId: '66666666-6666-3666-8666-666666666666',
      direction: 'INBOUND',
      callCreated: '2026-10-20T16:43:00.000Z',
      participants: [
        {
          participantId: 'emily',
          originator: 'caller',
          legId: 'leg-emily',
          status: { value: 'CONNECTED' },
          type: { value: 'LINE', line: { extensionNumber: '6', name: 'Emily Kingdon' } },
        },
      ],
    }), book);
    assert.equal(analysis.lines[0].name, 'Emily Kingdon');
    assert.equal(analysis.lines[0].extension, '00006');
    assert.equal(analysis.lines[0].connected, true);
  });

  it('credits only the connected roster line, not the phones that were still ringing', () => {
    const found = callParties.answerersFromCallReport(queueReport({
      connectedExtension: '00006',
      connectedName: 'Emily Kingdon',
      alsoRinging: [
        { extension: '00007', name: 'Kristine Vandervort' },
        { extension: '00004', name: 'Gala Wilbur' },
      ],
    }), book);
    assert.deepEqual(found.map((entry) => entry.name), ['Emily Kingdon']);
    assert.equal(found[0].extension, '00006');

    const ringingOnly = callParties.answerersFromCallReport({
      callStates: [
        {
          sequenceNumber: 1,
          participants: [
            { status: { value: 'RINGING' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
            { status: { value: 'RINGING' }, type: { value: 'LINE', extensionNumber: '00003', name: 'Joshua Simington' } },
          ],
        },
        { sequenceNumber: 2, type: 'ENDING', participants: [] },
      ],
    }, book);
    assert.deepEqual(ringingOnly, []);

    const twoSummaries = callParties.answerersFromCallReport({
      participants: [
        { name: 'Emily Kingdon', number: '00006', type: { value: 'LINE' } },
        { name: 'Joshua Simington', number: '00003', type: { value: 'LINE' } },
      ],
    }, book);
    assert.deepEqual(twoSummaries, []);

    const oneSummary = callParties.answerersFromCallReport({
      participants: [
        { name: 'Emily Kingdon', number: '6', type: { value: 'LINE', userKey: 'user-emily', userFirstName: 'Emily', userLastName: 'Kingdon' } },
      ],
      callAnswered: '2026-10-20T16:43:08.000Z',
    }, book);
    assert.equal(oneSummary[0].name, 'Emily Kingdon');
    assert.equal(oneSummary[0].extension, '00006');

    const keyed = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
    keyed.indexApiUser({ userKey: 'user-emily', lines: [{ number: '00006' }] });
    const byKey = callParties.answerersFromCallReport({
      callStates: [{
        sequenceNumber: 1,
        timestamp: '2026-10-20T16:43:08.000Z',
        participants: [{
          status: { value: 'CONNECTED' },
          type: { value: 'LINE', userKey: 'user-emily', userFirstName: 'Emily', userLastName: 'Kingdon' },
        }],
      }],
    }, keyed);
    assert.equal(byKey[0].name, 'Emily Kingdon');
    assert.equal(byKey[0].extension, '00006');
    assert.equal(byKey[0].matchedBy, 'userKey');
  });

  it('names the inbound answerer from the report when the greeting never says a name', async () => {
    const fetched = [];
    interactions.setCallReportFetcherForTests(async (id) => {
      fetched.push(id);
      if (id !== 'conv-1020-greeting') return null;
      return queueReport({ connectedExtension: '00006', connectedName: 'Emily Kingdon' });
    });
    interactions.recordLegState('conv-1020-greeting', {
      legId: 'leg-1020-greeting',
      lines: [{ legId: 'queue', extension: '00801', name: null, connected: true, answered: true }],
      participantLegIds: ['leg-1020-greeting'],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T16:43:00.000Z',
      callEnded: '2026-10-20T16:47:00.000Z',
    });
    interactions.recordTranscript('conv-1020-greeting', 'rec-1020', greetingTranscript());
    await interactions.attributeInboundAnswerers('conv-1020-greeting');

    const described = interactions.describeForTests('conv-1020-greeting');
    assert.deepEqual(fetched, ['conv-1020-greeting']);
    assert.deepEqual(described.csrPath, ['Emily Kingdon (00006)']);
    assert.equal(described.teamMemberSource, 'call events report');
    assert.equal(described.csrPath.join(' -> '), 'Emily Kingdon (00006)');

    const rows = openaiClient.formatLegTranscript(described.legRecords.find((leg) => leg.transcript));
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Customer', 'Emily Kingdon']);

    const built = openaiClient.buildSummaryMessages({
      legRecords: described.legRecords,
      csrPath: described.csrPath,
      externalNumber: described.externalNumber,
      direction: described.direction,
      callCreated: described.callCreated,
      callEnded: described.callEnded,
      answered: described.answered,
    });
    assert.match(built.user, /Team member path \(in order, if transferred\/parked\): Emily Kingdon \(00006\)/);

    const html = interactions.buildTranscriptDocHtml({
      externalNumber: described.externalNumber,
      direction: described.direction,
      csrPath: described.csrPath,
      callCreated: described.callCreated,
      callEnded: described.callEnded,
      summaryText: 'Emily looked up the order.',
      legRecords: described.legRecords,
    });
    assert.match(html, /<b>Team Member\(s\):<\/b> Emily Kingdon \(00006\)/);
  });

  it('keeps the report answerer when the transcript introduces someone else', async () => {
    interactions.setCallReportFetcherForTests(async () => queueReport({
      connectedExtension: '00006',
      connectedName: 'Emily Kingdon',
    }));
    interactions.recordLegState('conv-1020-disagree', {
      legId: 'leg-1020-disagree',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T17:00:00.000Z',
      callEnded: '2026-10-20T17:04:00.000Z',
    });
    interactions.recordTranscript('conv-1020-disagree', 'rec-disagree', {
      results: [
        { transcript: 'This is Josh speaking.', channel: 1, startTimeMs: 0 },
        { transcript: 'Hi Josh.', channel: 0, startTimeMs: 2000 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-1020-disagree');
    const described = interactions.describeForTests('conv-1020-disagree');
    assert.deepEqual(described.csrPath, ['Emily Kingdon (00006)']);
    assert.equal(described.teamMemberSource, 'call events report');
  });

  it('uses the extension GoTo sent when Amy answers on the home-office line', () => {
    const found = callParties.answerersFromCallReport(queueReport({
      connectedExtension: '00005',
      connectedName: 'Amy Bullock',
    }), book);
    assert.equal(found[0].name, 'Amy Bullock');
    assert.equal(found[0].extension, '00005');
  });

  it('falls back to the spoken name and fills Amy\'s extension from the roster', async () => {
    interactions.setCallReportFetcherForTests(async () => null);
    interactions.recordLegState('conv-1020-amy', {
      legId: 'leg-1020-amy',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T20:29:00.000Z',
      callEnded: '2026-10-20T20:33:00.000Z',
    });
    interactions.recordTranscript('conv-1020-amy', 'rec-amy', {
      results: [
        { transcript: 'Hello?', channel: 0, startTimeMs: 0 },
        { transcript: 'This is Amy speaking.', channel: 1, startTimeMs: 1000 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-1020-amy');
    const described = interactions.describeForTests('conv-1020-amy');
    assert.deepEqual(described.csrPath, ['Amy Bullock (00001)']);
    assert.equal(described.teamMemberSource, 'transcript introduction');
    assert.equal(roster.formatTeamMember({ name: 'Amy Bullock' }, book), 'Amy Bullock (00001)');
  });

  it('credits the answering leg of a queue call when that leg is a separate conversation', async () => {
    interactions.setCallReportFetcherForTests(async (id) => {
      if (id === 'conv-1020-queue') {
        return {
          direction: 'INBOUND',
          participants: [],
          callStates: [{ sequenceNumber: 1, type: 'ENDING', participants: [] }],
          associatedConversations: ['conv-1020-agent'],
        };
      }
      if (id === 'conv-1020-agent') {
        return queueReport({ connectedExtension: '00003', connectedName: 'Joshua Simington' });
      }
      return null;
    });
    interactions.recordLegState('conv-1020-queue', {
      legId: 'leg-1020-queue',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T18:00:00.000Z',
      callEnded: '2026-10-20T18:06:00.000Z',
    });
    interactions.recordTranscript('conv-1020-queue', 'rec-queue', greetingTranscript());
    await interactions.attributeInboundAnswerers('conv-1020-queue');
    const described = interactions.describeForTests('conv-1020-queue');
    assert.deepEqual(described.csrPath, ['Joshua Simington (00003)']);
    assert.equal(described.teamMemberSource, 'call events report');
  });

  it('does not ask the report to rename an outbound call', async () => {
    const fetched = [];
    interactions.setCallReportFetcherForTests(async (id) => {
      fetched.push(id);
      return queueReport({ connectedExtension: '00003', connectedName: 'Joshua Simington' });
    });
    interactions.recordLegState('conv-1020-out', {
      legId: 'leg-1020-out',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T19:00:00.000Z',
      callEnded: '2026-10-20T19:02:00.000Z',
    });
    interactions.recordTranscript('conv-1020-out', 'rec-out', {
      results: [
        { transcript: 'Hi, this is Emily with Budget Blinds.', channel: 0, startTimeMs: 0 },
        { transcript: 'Hello.', channel: 1, startTimeMs: 2000 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-1020-out');
    const described = interactions.describeForTests('conv-1020-out');
    assert.deepEqual(fetched, []);
    assert.deepEqual(described.csrPath, ['Emily Kingdon (00006)']);
    assert.equal(described.teamMemberSource, 'outbound introduction');
  });

  it('keeps a transfer in answer order and still falls back when the report request fails', async () => {
    const transfer = callParties.answerersFromCallReport({
      callStates: [
        {
          sequenceNumber: 2,
          timestamp: '2026-10-20T21:00:10.000Z',
          participants: [
            { status: { value: 'CONNECTED' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
          ],
        },
        {
          sequenceNumber: 4,
          timestamp: '2026-10-20T21:03:00.000Z',
          participants: [
            { status: { value: 'CONNECTED' }, type: { value: 'LINE', extensionNumber: '00003', name: 'Joshua Simington' } },
            { status: { value: 'ON_HOLD' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
          ],
        },
      ],
    }, book);
    assert.deepEqual(transfer.map((entry) => `${entry.name} (${entry.extension})`), [
      'Emily Kingdon (00006)',
      'Joshua Simington (00003)',
    ]);

    interactions.setCallReportFetcherForTests(async () => {
      throw new Error('report unavailable');
    });
    interactions.recordLegState('conv-1020-fail', {
      legId: 'leg-1020-fail',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: CUSTOMER_20,
      callCreated: '2026-10-20T21:10:00.000Z',
      callEnded: '2026-10-20T21:12:00.000Z',
    });
    interactions.recordTranscript('conv-1020-fail', 'rec-fail', {
      results: [
        { transcript: 'This is Josh speaking.', channel: 1, startTimeMs: 0 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-1020-fail');
    const described = interactions.describeForTests('conv-1020-fail');
    assert.deepEqual(described.csrPath, ['Joshua Simington (00003)']);
    assert.equal(described.teamMemberSource, 'transcript introduction');
  });
});

describe('2026-10-28 outbound dialer, prompt fragments, and missing transcript', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  function jerryTranscript() {
    return {
      results: [
        { transcript: 'James?', channel: 0, startTimeMs: 0 },
        { transcript: "It's Josh actually, is this Jerry?", channel: 1, startTimeMs: 1000 },
        { transcript: 'Oh, Josh. Yeah, hi.', channel: 0, startTimeMs: 3000 },
        { transcript: "Jerry, I'm just touching bases with you", channel: 1, startTimeMs: 5000 },
        { transcript: 'on behalf of James though.', channel: 1, startTimeMs: 7000 },
      ],
    };
  }

  it('keeps an outbound far-end answer as the customer when the dialer says it is Josh', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [],
      transcript: jerryTranscript(),
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Customer',
      'Team Member',
      'Customer',
      'Team Member',
      'Team Member',
    ]);
    assert.equal(rows[0].text, 'James?');
    assert.match(rows[1].text, /It's Josh actually/);

    const named = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: jerryTranscript(),
    });
    assert.deepEqual(named.map((row) => row.label), [
      'Customer',
      'Joshua Simington',
      'Customer',
      'Joshua Simington',
      'Joshua Simington',
    ]);

    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'OUTBOUND',
        csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
        transcript: jerryTranscript(),
      }],
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: '9165489035',
      direction: 'OUTBOUND',
      callCreated: '2026-10-28T19:09:00.000Z',
      callEnded: '2026-10-28T19:12:00.000Z',
      answered: true,
    });
    assert.match(built.user, /Call direction: OUTBOUND/);
    assert.match(built.user, /Never describe an outbound call as something the customer did/);
    assert.match(built.user, /\[0s\] Customer: James\?/);
    assert.match(built.user, /\[1s\] Joshua Simington: It's Josh actually/);
    assert.doesNotMatch(built.user, /Team Member: James\?/);
  });

  it('credits both of Joshua\'s ringing devices as one outbound dialer, and not two different people', () => {
    const samePerson = callParties.analyzeCallState(callState({
      conversationSpaceId: '8fe2067d-4092-3162-b673-d7b0540f2482',
      direction: 'OUTBOUND',
      callCreated: '2026-10-28T19:09:00.000Z',
      participants: [
        line({ id: 'desk', extension: '00003', name: 'Joshua Simington', status: 'RINGING', originator: 'session-not-a-device' }),
        line({ id: 'softphone', extension: '00003', name: 'Joshua Simington', status: 'RINGING', originator: 'session-not-a-device' }),
      ],
    }), book);
    assert.equal(samePerson.lines.some((entry) => entry.isOriginator), true);
    interactions.recordLegState('conv-josh-devices', {
      lines: samePerson.lines,
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: '9165489035',
      callCreated: '2026-10-28T19:09:00.000Z',
    });
    const leg = interactions.peekLeg('conv-josh-devices');
    assert.deepEqual(names(leg), ['Joshua Simington (00003)']);
    assert.equal(leg.teamMemberSource, 'STARTING originator');

    const twoPeople = callParties.analyzeCallState(callState({
      conversationSpaceId: '72576f95-2c2b-34ba-b301-d936c8d3dbd9',
      direction: 'OUTBOUND',
      callCreated: '2026-10-28T22:44:00.000Z',
      participants: [
        line({ id: 'josh', extension: '00003', name: 'Joshua Simington', status: 'RINGING', originator: 'session-not-a-device' }),
        line({ id: 'emily', extension: '00006', name: 'Emily Kingdon', status: 'RINGING', originator: 'session-not-a-device' }),
      ],
    }), book);
    assert.equal(twoPeople.lines.some((entry) => entry.isOriginator), false);
    interactions.recordLegState('conv-two-ringing', {
      lines: twoPeople.lines,
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: '8662607521',
      callCreated: '2026-10-28T22:44:00.000Z',
    });
    assert.deepEqual(names(interactions.peekLeg('conv-two-ringing')), []);
  });

  it('names an outbound dialer from the caller extension or the call events report', async () => {
    book.rememberPhone(book.personByExtension('00003'), '9165550144');
    const fromPhone = callParties.analyzeCallHistory({
      direction: 'OUTBOUND',
      caller: { number: '9165550144' },
      callee: { number: '9165489035', name: 'Jerry' },
    }, book);
    assert.equal(fromPhone.teamMember.name, 'Joshua Simington');
    assert.equal(fromPhone.teamMember.extension, '00003');
    assert.equal(fromPhone.teamMember.matchedBy, 'phone');

    const fromCaller = callParties.dialersFromCallReport({
      direction: 'OUTBOUND',
      caller: { name: 'Joshua Simington', number: OFFICE, extensionNumber: '00003' },
      callee: { number: '9165489035', name: 'Jerry' },
    }, book);
    assert.equal(fromCaller[0].name, 'Joshua Simington');
    assert.equal(fromCaller[0].extension, '00003');

    const connected = callParties.dialersFromCallReport({
      direction: 'OUTBOUND',
      callStates: [
        {
          sequenceNumber: 2,
          timestamp: '2026-10-28T19:09:04.000Z',
          participants: [
            {
              status: { value: 'CONNECTED' },
              type: { value: 'LINE', extensionNumber: '00003', name: 'Joshua Simington' },
            },
            {
              status: { value: 'CONNECTED' },
              type: { value: 'PHONE_NUMBER', callee: { number: '9165489035' } },
            },
          ],
        },
        { sequenceNumber: 3, type: 'ENDING', participants: [] },
      ],
    }, book);
    assert.deepEqual(connected.map((entry) => entry.name), ['Joshua Simington']);
    assert.deepEqual(callParties.dialersFromCallReport({ direction: 'INBOUND', caller: { name: 'Emily Kingdon', extensionNumber: '00006' } }, book), []);

    const fetched = [];
    interactions.setCallReportFetcherForTests(async (id) => {
      fetched.push(id);
      return {
        direction: 'OUTBOUND',
        caller: { name: 'Joshua Simington', extensionNumber: '00003', number: OFFICE },
        callee: { number: '8662607521', name: 'Hunter Douglas' },
      };
    });
    interactions.recordLegState('conv-josh-report', {
      legId: 'leg-josh-report',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: '8662607521',
      callCreated: '2026-10-28T22:44:00.000Z',
      callEnded: '2026-10-28T23:32:00.000Z',
    });
    interactions.recordTranscript('conv-josh-report', 'rec-josh-report', {
      results: [
        { transcript: 'Thank you for calling Hunter Douglas.', channel: 1, startTimeMs: 0 },
        { transcript: 'I need a status on the shade order.', channel: 0, startTimeMs: 8000 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-josh-report');
    const described = interactions.describeForTests('conv-josh-report');
    assert.deepEqual(fetched, ['conv-josh-report']);
    assert.deepEqual(described.csrPath, ['Joshua Simington (00003)']);
    assert.equal(described.teamMemberSource, 'call events report');

    interactions.recordLegState('conv-josh-said', {
      legId: 'leg-josh-said',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: '9165489035',
      callCreated: '2026-10-28T19:09:00.000Z',
    });
    interactions.recordTranscript('conv-josh-said', 'rec-josh-said', jerryTranscript());
    interactions.setCallReportFetcherForTests(async () => {
      throw new Error('report should not be required once Josh introduced himself');
    });
    await interactions.attributeInboundAnswerers('conv-josh-said');
    const spoken = interactions.describeForTests('conv-josh-said');
    assert.deepEqual(spoken.csrPath, ['Joshua Simington (00003)']);
    assert.equal(spoken.teamMemberSource, 'outbound introduction');
  });

  it('labels queue and IVR prompt fragments as Recording, and keeps a live answer', () => {
    const queue = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 0 },
          { transcript: 'Our normal business hours are Monday through Friday, 9am to 5pm, excluding holidays.', channel: 1, startTimeMs: 2000 },
          { transcript: 'If you have reached this message during normal business hours, we are likely on the other', channel: 1, startTimeMs: 8000 },
          { transcript: 'line assisting another customer.', channel: 1, startTimeMs: 12000 },
          { transcript: 'Please leave your name.', channel: 1, startTimeMs: 15000 },
          { transcript: 'telephone number and zip code and we will return your phone call as soon as', channel: 1, startTimeMs: 16000 },
          { transcript: 'possible.', channel: 1, startTimeMs: 19000 },
        ],
      },
    });
    assert.deepEqual(queue.map((row) => row.label), queue.map(() => 'Recording'));

    const ivr = openaiClient.formatLegTranscript({
      direction: 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: {
        results: [
          { transcript: 'This call may be monitored to check the status', channel: 1, startTimeMs: 5000 },
          { transcript: 'of an order.', channel: 1, startTimeMs: 11000 },
          { transcript: 'For customer and technical support, press one.', channel: 1, startTimeMs: 14000 },
        ],
      },
    });
    assert.deepEqual(ivr.map((row) => row.label), ['Recording', 'Recording', 'Recording']);

    const jessica = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true }],
      transcript: {
        results: [
          { transcript: 'This is Jessica.', channel: 1, startTimeMs: 58000 },
          { transcript: 'I think you have reached the wrong franchise, the wrong branch.', channel: 1, startTimeMs: 75000 },
          { transcript: 'I think you want the Sacramento location. I can give you their phone number.', channel: 1, startTimeMs: 80000 },
        ],
      },
    });
    assert.deepEqual(jessica.map((row) => row.label), [
      'Emily Kingdon',
      'Emily Kingdon',
      'Emily Kingdon',
    ]);
    assert.equal(jessica.some((row) => row.label === 'Recording'), false);
  });

  it('says the recording is in Drive when audio exists and no transcript does', async () => {
    const withAudio = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: '9164127218',
      direction: 'INBOUND',
      callCreated: '2026-10-28T16:57:00.000Z',
      answered: true,
      hasRecording: true,
    });
    assert.match(withAudio, /answered by Emily Kingdon/);
    assert.match(withAudio, /No transcript was available; the recording is in the Drive folder\./);
    assert.doesNotMatch(withAudio, /no conversation audio/);

    const withoutAudio = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: '9257193810',
      direction: 'INBOUND',
      callCreated: '2026-10-28T18:10:00.000Z',
      answered: true,
    });
    assert.match(withoutAudio, /no conversation audio or transcript was captured/);
    assert.doesNotMatch(withoutAudio, /recording is in the Drive folder/);

    const outboundAudio = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: '8662607521',
      direction: 'OUTBOUND',
      callCreated: '2026-10-28T22:44:00.000Z',
      answered: true,
      hasRecording: true,
      callType: 'vendor',
      partyName: 'Hunter Douglas',
    });
    assert.match(outboundAudio, /No transcript was available; the recording is in the Drive folder\./);
    assert.doesNotMatch(outboundAudio, /no conversation audio/);

    const fetched = [];
    interactions.setTranscriptFetcherForTests(async (id) => {
      fetched.push(id);
      return {
        results: [
          { transcript: 'This is Emily, how can I help you?', channel: 1, startTimeMs: 0 },
          { transcript: 'I need a measurement.', channel: 0, startTimeMs: 2000 },
        ],
      };
    });
    interactions.recordLegState('conv-retry', {
      legId: 'leg-retry',
      lines: [{ extension: '00006', name: 'Emily Kingdon', connected: true, answered: true }],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: '9164127218',
      callCreated: '2026-10-28T16:57:00.000Z',
      callEnded: '2026-10-28T17:00:00.000Z',
    });
    interactions.recordRecordingLink('conv-retry', 'rec-retry', 'https://drive.google.com/file/d/example', {
      id: 'folder-retry',
      webViewLink: 'https://drive.google.com/drive/folders/example',
      name: 'folder',
    });
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let recovered = false;
    try {
      recovered = await interactions.recoverMissingTranscripts('conv-retry');
    } finally {
      console.log = original;
    }
    assert.equal(recovered, true);
    assert.deepEqual(fetched, ['rec-retry']);
    assert.match(logs.join('\n'), /recording rec-retry exists but the GoTo transcript never arrived/);
    assert.equal(interactions.peekLeg('conv-retry').transcriptReceived, true);

    interactions.setTranscriptFetcherForTests(async () => null);
    interactions.recordLegState('conv-retry-empty', {
      legId: 'leg-retry-empty',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: '9257193810',
      callCreated: '2026-10-28T18:10:00.000Z',
      callEnded: '2026-10-28T18:11:00.000Z',
    });
    interactions.recordRecordingLink('conv-retry-empty', 'rec-empty', 'https://drive.google.com/file/d/empty', {
      id: 'folder-empty',
      webViewLink: 'https://drive.google.com/drive/folders/empty',
    });
    const emptyLogs = [];
    console.log = (...args) => emptyLogs.push(args.join(' '));
    let second = false;
    let third = true;
    try {
      second = await interactions.recoverMissingTranscripts('conv-retry-empty');
      third = await interactions.recoverMissingTranscripts('conv-retry-empty');
    } finally {
      console.log = original;
    }
    assert.equal(second, false);
    assert.equal(third, false);
    assert.match(emptyLogs.join('\n'), /returned no transcript/);
    assert.equal(interactions.peekLeg('conv-retry-empty').transcript, null);
  });
});
