const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callParties = require('../src/callParties');
const roster = require('../src/roster');
const interactions = require('../src/interactions');

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);

// Fictional NANP range. The public repo must not gain real customer numbers.
const CUSTOMER = '5550101201';
const OTHER = '5550101202';
const DIALED = '5550101203';
const DID = '5550101888';
const OFFICE = '5550101999';

function callState({ direction, participants, dialString }) {
  return {
    content: {
      metadata: {
        conversationSpaceId: 'aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa',
        direction,
        callCreated: '2026-10-23T22:38:00.000Z',
        dialString,
      },
      state: { type: 'STARTING', participants },
    },
  };
}

describe('external number on call-state and the call events report', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  it('reads a nested phoneNumber caller and does not use the dialed DID', () => {
    const analysis = callParties.analyzeCallState(callState({
      direction: 'INBOUND',
      participants: [
        {
          participantId: 'cust',
          originator: 'cust',
          legId: 'leg-cust',
          status: { value: 'CONNECTED' },
          type: {
            value: 'PHONE_NUMBER',
            phoneNumber: {
              number: `+1${DID}`,
              name: 'Main',
              caller: { name: 'Pat Example', number: `+1${CUSTOMER}` },
            },
          },
        },
      ],
    }), book);
    assert.equal(roster.last10(analysis.externalNumber), CUSTOMER);
    assert.equal(analysis.externalName, 'Pat Example');
    assert.equal(roster.last10(analysis.originatorNumber), CUSTOMER);
  });

  it('reads a nested outbound callee and does not use our caller-id', () => {
    const analysis = callParties.analyzeCallState(callState({
      direction: 'OUTBOUND',
      dialString: null,
      participants: [
        {
          participantId: 'far',
          originator: 'agent',
          legId: 'leg-far',
          status: { value: 'CONNECTED' },
          type: {
            value: 'PHONE_NUMBER',
            phoneNumber: {
              number: `+1${DID}`,
              callee: { name: '', number: `+1${DIALED}` },
            },
          },
        },
      ],
    }), book);
    assert.equal(roster.last10(analysis.externalNumber), DIALED);
  });

  it('prefers the report summary caller over the DID on caller.type.number', () => {
    const found = callParties.customerNumberFromReport({
      direction: 'INBOUND',
      caller: {
        name: 'Pat Example',
        number: `+1${CUSTOMER}`,
        type: { value: 'PHONE_NUMBER', number: `+1${DID}`, name: 'Main' },
      },
      participants: [
        {
          type: {
            value: 'PHONE_NUMBER',
            number: `+1${DID}`,
            name: 'Main',
            caller: { name: 'Pat Example', number: `+1${CUSTOMER}` },
          },
        },
      ],
      callStates: [
        {
          sequenceNumber: 4,
          type: 'ACTIVE',
          participants: [
            {
              status: { value: 'CONNECTED' },
              type: {
                value: 'PHONE_NUMBER',
                phoneNumber: {
                  number: `+1${DID}`,
                  name: 'Main',
                  caller: { name: 'Pat Example', number: `+1${CUSTOMER}` },
                },
              },
            },
          ],
        },
      ],
    }, book);
    assert.equal(roster.last10(found.number), CUSTOMER);
    assert.equal(found.name, 'Pat Example');
  });

  it('uses a bare participant number when the report has no caller or callee object', () => {
    const found = callParties.customerNumberFromReport({
      direction: 'INBOUND',
      callStates: [
        {
          sequenceNumber: 2,
          participants: [
            {
              status: { value: 'CONNECTED' },
              type: { value: 'PHONE_NUMBER', phoneNumber: { number: `+1${CUSTOMER}` } },
            },
          ],
        },
      ],
    }, book);
    assert.equal(roster.last10(found.number), CUSTOMER);
  });

  it('does not treat an outbound caller-id DID as the customer', () => {
    const found = callParties.customerNumberFromReport({
      direction: 'OUTBOUND',
      participants: [
        { type: { value: 'PHONE_NUMBER', number: `+1${DID}`, name: 'Main' } },
      ],
    }, book);
    assert.equal(found.number, null);

    const callee = callParties.customerNumberFromReport({
      direction: 'OUTBOUND',
      callStates: [
        {
          participants: [
            {
              type: {
                value: 'PHONE_NUMBER',
                phoneNumber: {
                  number: `+1${DID}`,
                  callee: { number: `+1${DIALED}` },
                },
              },
            },
          ],
        },
      ],
    }, book);
    assert.equal(roster.last10(callee.number), DIALED);
  });

  it('does not pick a caller when the report has two different outside numbers', () => {
    const found = callParties.customerNumberFromReport({
      direction: 'INBOUND',
      participants: [
        { type: { value: 'PHONE_NUMBER', caller: { number: `+1${CUSTOMER}` } } },
        { type: { value: 'PHONE_NUMBER', caller: { number: `+1${OTHER}` } } },
      ],
    }, book);
    assert.equal(found.number, null);
  });

  it('ignores a system number and a caller-id name of unknown', () => {
    const found = callParties.customerNumberFromReport({
      direction: 'INBOUND',
      participants: [
        {
          type: {
            value: 'PHONE_NUMBER',
            number: `+1${OFFICE}`,
            caller: { name: 'unknown', number: `+1${CUSTOMER}` },
          },
        },
      ],
    }, book);
    assert.equal(roster.last10(found.number), CUSTOMER);
    assert.equal(found.name, null);
  });
});

describe('interaction number recovery', () => {
  const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);

  beforeEach(() => {
    interactions.resetForTests();
    roster.setRosterForTests(book);
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  const customerSpeech = {
    results: [
      { transcript: 'I need to move my install to Thursday afternoon.', channel: 0, startTimeMs: 0 },
      { transcript: 'I can look at the schedule.', channel: 1, startTimeMs: 2500 },
    ],
  };

  function inboundLeg(id, extra = {}) {
    interactions.recordLegState(id, {
      legId: `leg-${id}`,
      lines: [],
      participantLegIds: [`leg-${id}`],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      callCreated: '2026-10-23T22:38:00.000Z',
      callEnded: '2026-10-23T22:42:00.000Z',
      ...extra,
    });
  }

  it('recovers the inbound caller from the report that also names the answerer', async () => {
    const fetched = [];
    interactions.setCallReportFetcherForTests(async (id) => {
      fetched.push(id);
      return {
        direction: 'INBOUND',
        participants: [
          {
            legId: 'leg-caller',
            type: {
              value: 'PHONE_NUMBER',
              number: `+1${DID}`,
              name: 'Main',
              caller: { name: 'Pat Example', number: `+1${CUSTOMER}` },
            },
          },
        ],
        callStates: [
          {
            sequenceNumber: 2,
            timestamp: '2026-10-23T22:38:08.000Z',
            participants: [
              {
                legId: 'leg-caller',
                status: { value: 'CONNECTED' },
                type: {
                  value: 'PHONE_NUMBER',
                  phoneNumber: {
                    number: `+1${DID}`,
                    caller: { name: 'Pat Example', number: `+1${CUSTOMER}` },
                  },
                },
              },
              {
                legId: 'leg-answerer',
                status: { value: 'CONNECTED' },
                type: { value: 'LINE', line: { extensionNumber: '00006', name: 'Emily Kingdon' } },
              },
            ],
          },
          { sequenceNumber: 3, type: 'ENDING', participants: [] },
        ],
      };
    });
    inboundLeg('conv-report');
    interactions.recordTranscript('conv-report', 'rec-report', customerSpeech);
    await interactions.attributeInboundAnswerers('conv-report');

    const described = interactions.describeForTests('conv-report');
    assert.deepEqual(fetched, ['conv-report']);
    assert.equal(roster.last10(described.externalNumber), CUSTOMER);
    assert.notEqual(roster.last10(described.externalNumber), DID);
    assert.equal(described.externalName, 'Pat Example');
    assert.equal(described.externalConflict, false);
    assert.deepEqual(described.csrPath, ['Emily Kingdon (00006)']);
    assert.equal(described.teamMemberSource, 'call events report');
    assert.equal(callParties.missingInboundNumberWarning(described), null);
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

  it('reads the caller from an associated conversation when this leg only named the answerer', async () => {
    const fetched = [];
    interactions.setCallReportFetcherForTests(async (id) => {
      fetched.push(id);
      if (id === 'conv-primary') {
        return {
          direction: 'INBOUND',
          associatedConversations: ['conv-other-leg'],
          callStates: [
            {
              sequenceNumber: 2,
              participants: [
                {
                  status: { value: 'CONNECTED' },
                  type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' },
                },
              ],
            },
          ],
        };
      }
      if (id === 'conv-other-leg') {
        return {
          direction: 'INBOUND',
          participants: [
            {
              type: {
                value: 'PHONE_NUMBER',
                number: `+1${DID}`,
                caller: { name: 'Sam Example', number: `+1${CUSTOMER}` },
              },
            },
          ],
        };
      }
      return null;
    });
    inboundLeg('conv-primary');
    interactions.recordTranscript('conv-primary', 'rec-primary', customerSpeech);
    await interactions.attributeInboundAnswerers('conv-primary');

    const described = interactions.describeForTests('conv-primary');
    assert.deepEqual(fetched, ['conv-primary', 'conv-other-leg']);
    assert.equal(roster.last10(described.externalNumber), CUSTOMER);
    assert.equal(described.externalName, 'Sam Example');
    assert.deepEqual(described.csrPath, ['Emily Kingdon (00006)']);
  });

  it('recovers an outbound callee from the report when call-state had no dial string', async () => {
    interactions.setCallReportFetcherForTests(async () => ({
      direction: 'OUTBOUND',
      callStates: [
        {
          sequenceNumber: 3,
          type: 'ACTIVE',
          participants: [
            {
              status: { value: 'CONNECTED' },
              type: {
                value: 'PHONE_NUMBER',
                phoneNumber: {
                  number: `+1${DID}`,
                  callee: { number: `+1${DIALED}` },
                },
              },
            },
          ],
        },
      ],
    }));
    interactions.recordLegState('conv-out', {
      legId: 'leg-out',
      lines: [],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: null,
      callCreated: '2026-10-23T21:44:00.000Z',
      callEnded: '2026-10-23T21:46:00.000Z',
    });
    interactions.recordTranscript('conv-out', 'rec-out', {
      results: [
        { transcript: 'Hi, this is Emily with Budget Blinds.', channel: 0, startTimeMs: 0 },
        { transcript: 'Hello, I can talk now.', channel: 1, startTimeMs: 2000 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-out');
    const described = interactions.describeForTests('conv-out');
    assert.equal(roster.last10(described.externalNumber), DIALED);
    assert.notEqual(roster.last10(described.externalNumber), DID);
  });

  it('leaves a greeting without customer speech unnumbered', async () => {
    interactions.setCallReportFetcherForTests(async () => ({
      direction: 'INBOUND',
      participants: [
        { type: { value: 'PHONE_NUMBER', caller: { number: `+1${CUSTOMER}`, name: 'Pat Example' } } },
      ],
    }));
    inboundLeg('conv-greeting');
    interactions.recordTranscript('conv-greeting', 'rec-greeting', {
      results: [
        { transcript: "It's a great day here at Budget Blinds. Our normal business hours are 9 to 5.", channel: 0, startTimeMs: 0 },
      ],
    });
    await interactions.attributeInboundAnswerers('conv-greeting');
    const described = interactions.describeForTests('conv-greeting');
    assert.equal(described.substantive, false);
    assert.equal(described.externalNumber, null);
    assert.equal(callParties.missingInboundNumberWarning(described), null);
  });

  it('warns with the conversation id when customer speech still has no number', async () => {
    interactions.setCallReportFetcherForTests(async () => ({
      direction: 'INBOUND',
      participants: [
        { type: { value: 'PHONE_NUMBER', caller: { number: `+1${CUSTOMER}` } } },
        { type: { value: 'PHONE_NUMBER', caller: { number: `+1${OTHER}` } } },
      ],
    }));
    inboundLeg('conv-ambiguous');
    interactions.recordTranscript('conv-ambiguous', 'rec-ambiguous', customerSpeech);
    await interactions.attributeInboundAnswerers('conv-ambiguous');
    const described = interactions.describeForTests('conv-ambiguous');
    assert.equal(described.externalNumber, null);
    assert.equal(
      callParties.missingInboundNumberWarning(described),
      'WARNING: inbound interaction has customer speech but no phone number conversationSpaceId=conv-ambiguous',
    );
  });
});
