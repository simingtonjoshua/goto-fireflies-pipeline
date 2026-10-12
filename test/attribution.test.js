const { describe, it, beforeEach } = require('node:test');
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
});

describe('call id version', () => {
  it('reads the UUID version nibble', () => {
    assert.equal(callParties.callIdVersion('11111111-1111-3111-8111-111111111111'), '3');
    assert.equal(callParties.callIdVersion('11111111-1111-4111-8111-111111111111'), '4');
    assert.equal(callParties.callIdVersion('not-a-uuid'), null);
  });
});
