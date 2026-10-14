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

  it('does not treat a customer asking for staff, a bare first name, or an open greeting as the team intro', () => {
    const asking = outboundUnknown("I'm calling for Emily. Is Emily available?");
    assert.deepEqual(asking.map((row) => row.label), ['Team Member', 'Customer']);

    const bare = outboundUnknown('Hey, this is Joshua. I am returning your call about the shade.');
    assert.deepEqual(bare.map((row) => row.label), ['Team Member', 'Customer']);

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
