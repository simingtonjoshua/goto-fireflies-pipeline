const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const callParties = require('../src/callParties');
const interactions = require('../src/interactions');
const openaiClient = require('../src/openaiClient');
const roster = require('../src/roster');

// The false HeyMarket wording from the 2026-10-27 Courtney Toner voicemail.
const FALSE_STAFF_CLAIM = /connected to (?:a |the )?(?:budget blinds )?team member|answered by (?:a |the )?(?:budget blinds )?team member|spoke with (?:a |the )?(?:budget blinds )?team member/i;

// Verbatim lines from the 4:28 PM PT inbound. Channel 1 is what the caller heard
// (IVR, queue, voicemail greeting). Channel 0 is the caller.
function courtneyTranscript() {
  const lines = [
    [0, 1, 'Thank you for calling Budget Blinds.'],
    [2, 1, 'The best in custom blinds, shades, shutters, drapes and more.'],
    [7, 1, 'This call may be monitored or recorded for quality assurance and training purposes.'],
    [12, 1, 'To reach your nearest Budget Blinds location, please enter your zip code.'],
    [25, 1, 'To reach your nearest budget blinds location, please enter your zip code.'],
    [37, 1, 'Thank you for calling Budget Blinds.'],
    [40, 1, 'If you would like to schedule a free in-home consultation, please press 1.'],
    [45, 1, 'For all other calls, please press 2.'],
    [69, 1, 'We apologize for the extended wait.'],
    [73, 1, 'Our representatives are currently helping other customers.'],
    [76, 1, 'In order to most efficiently process your call, please leave a message after the tone'],
    [80, 1, 'and we will call you as soon as possible.'],
    [83, 1, 'Thank you.'],
    [88, 0, 'Hi, my name is Courtney Toner.'],
    [90, 0, 'I was calling to hopefully get a consult'],
    [93, 0, 'for window treatments for our new house.'],
    [99, 0, 'I live in Lincoln, California.'],
    [103, 0, "I'd like to set up some, thank you."],
    [111, 0, 'My phone number is 408-607-8340.'],
  ];
  return {
    results: lines.map(([seconds, channel, transcript]) => ({
      transcript,
      channel,
      startTimeMs: seconds * 1000,
    })),
  };
}

function courtneyLeg(extra = {}) {
  return {
    direction: 'INBOUND',
    csrChain: [],
    callCreated: '2026-10-27T23:28:00.000Z',
    transcript: courtneyTranscript(),
    ...extra,
  };
}

describe('queue and voicemail are not a team member', () => {
  beforeEach(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  after(() => {
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  it('labels the Courtney Toner queue, IVR, and voicemail greeting as Recording', () => {
    const rows = openaiClient.formatLegTranscript(courtneyLeg());
    const heard = rows.filter((row) => row.seconds < 88);
    const spoken = rows.filter((row) => row.seconds >= 88);
    assert.deepEqual(heard.map((row) => row.label), heard.map(() => 'Recording'));
    assert.deepEqual(spoken.map((row) => row.label), spoken.map(() => 'Customer'));
    assert.equal(rows.some((row) => row.label === 'Team Member'), false);
    assert.match(rows.map((row) => row.text).join('\n'), /Courtney Toner/);
    assert.match(rows.map((row) => row.text).join('\n'), /408-607-8340/);

    const prior = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [],
      transcript: {
        results: [
          { transcript: 'Hi there, this is Josh.', channel: 1, startTimeMs: 0 },
          { transcript: 'Please leave your name.', channel: 1, startTimeMs: 2000 },
          { transcript: 'If you have reached this message, our office is closed.', channel: 1, startTimeMs: 4000 },
          { transcript: 'Hi, this is Pat. Please call me back.', channel: 0, startTimeMs: 8000 },
        ],
      },
    });
    assert.deepEqual(prior.map((row) => row.label), ['Recording', 'Recording', 'Recording', 'Customer']);
  });

  it('tells the summarizer the caller left a message and does not claim a person joined', () => {
    const built = openaiClient.buildSummaryMessages({
      legRecords: [courtneyLeg()],
      csrPath: [],
      externalNumber: '4086078340',
      direction: 'INBOUND',
      callCreated: '2026-10-27T23:28:00.000Z',
      callEnded: '2026-10-27T23:30:00.000Z',
      answered: null,
    });
    const prompt = `${built.system}\n${built.user}`;
    assert.equal(built.voicemail, true);
    assert.doesNotMatch(prompt, FALSE_STAFF_CLAIM);
    assert.match(built.user, /reached the queue and voicemail and left a message/);
    assert.match(built.user, /callback number/i);
    assert.match(built.user, /408-607-8340/);
    assert.match(built.user, /Lincoln/);
    assert.doesNotMatch(built.user, /Team Member:/);
    assert.match(built.user, /\[83s\] Recording: Thank you\./);

    const posted = 'Courtney Toner called about window treatments for a new house in Lincoln, California. The call included a lengthy wait time before she was connected to a team member. Her callback number is 408-607-8340.';
    const cleaned = openaiClient.guardVoicemailSummary(posted, { voicemail: true });
    assert.doesNotMatch(cleaned, FALSE_STAFF_CLAIM);
    assert.match(cleaned, /voicemail/i);
    assert.match(cleaned, /window treatments/);
    assert.match(cleaned, /Lincoln/);
    assert.match(cleaned, /408-607-8340/);

    const answeredBy = openaiClient.guardVoicemailSummary(
      'She was answered by a team member, then spoke with a team member about blinds.',
      { voicemail: true },
    );
    assert.doesNotMatch(answeredBy, FALSE_STAFF_CLAIM);
    assert.match(answeredBy, /voicemail|left a message/i);

    const note = openaiClient.formatCallNote({
      summary: cleaned,
      folderLink: 'https://drive.google.com/drive/folders/example',
    });
    assert.equal(note, `${cleaned}\n\nCall recording & transcript: https://drive.google.com/drive/folders/example`);
    assert.doesNotMatch(note, /Transcript/);
    assert.doesNotMatch(note, FALSE_STAFF_CLAIM);
  });

  it('keeps a normal answered inbound call attributed to the person who picked up', () => {
    const transcript = {
      results: [
        { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 0 },
        { transcript: 'We apologize for the extended wait.', channel: 1, startTimeMs: 4000 },
        { transcript: 'Thank you.', channel: 1, startTimeMs: 7000 },
        { transcript: 'This is Emily, how can I help you?', channel: 1, startTimeMs: 9000 },
        { transcript: 'I need a consultation for three windows.', channel: 0, startTimeMs: 12000 },
        { transcript: 'I can book that for Thursday.', channel: 1, startTimeMs: 15000 },
        { transcript: 'Thank you.', channel: 1, startTimeMs: 18000 },
      ],
    };
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true }],
      transcript,
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Recording',
      'Recording',
      'Recording',
      'Emily Kingdon',
      'Customer',
      'Emily Kingdon',
      'Emily Kingdon',
    ]);

    const built = openaiClient.buildSummaryMessages({
      legRecords: [{
        direction: 'INBOUND',
        csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true }],
        transcript,
      }],
      csrPath: ['Emily Kingdon (00006)'],
      externalNumber: '5550101001',
      direction: 'INBOUND',
      callCreated: '2026-10-27T20:00:00.000Z',
      callEnded: '2026-10-27T20:04:00.000Z',
      answered: true,
    });
    assert.equal(built.voicemail, false);
    assert.match(built.user, /two-sided conversation/);
    assert.match(built.user, /Emily Kingdon \(00006\)/);
    assert.doesNotMatch(built.user, /reached the queue and voicemail and left a message/);
    assert.equal(
      openaiClient.guardVoicemailSummary('Emily Kingdon answered and booked a consultation.', { voicemail: false }),
      'Emily Kingdon answered and booked a consultation.',
    );
  });

  it('uses the call events report when nobody connected and the call went to voicemail', () => {
    const ringing = callParties.reportHumanAnswer({
      callStates: [
        {
          sequenceNumber: 1,
          type: 'ACTIVE',
          participants: [
            { status: { value: 'RINGING' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
          ],
        },
        { sequenceNumber: 2, type: 'VOICEMAIL_NEW', voicemailId: 'vm-1', participants: [] },
      ],
    });
    assert.equal(ringing.answered, false);
    assert.equal(ringing.voicemail, true);

    const connected = callParties.reportHumanAnswer({
      callStates: [
        {
          sequenceNumber: 1,
          timestamp: '2026-10-27T20:00:08.000Z',
          participants: [
            { status: { value: 'CONNECTED' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
          ],
        },
      ],
    });
    assert.equal(connected.answered, true);
    assert.equal(connected.voicemail, false);

    interactions.recordLegState('conv-toner', {
      legId: 'leg-toner',
      lines: [],
      direction: 'INBOUND',
      directionSource: 'metadata',
      externalNumber: '4086078340',
      callCreated: '2026-10-27T23:28:00.000Z',
      callEnded: '2026-10-27T23:30:00.000Z',
    });
    interactions.recordCallReport('conv-toner', {
      direction: 'INBOUND',
      callStates: [
        {
          sequenceNumber: 1,
          type: 'ACTIVE',
          participants: [
            { status: { value: 'CONNECTED' }, type: { value: 'PHONE_NUMBER', caller: { number: '+14086078340' } } },
            { status: { value: 'RINGING' }, type: { value: 'LINE', extensionNumber: '00006', name: 'Emily Kingdon' } },
          ],
        },
        { sequenceNumber: 2, type: 'VOICEMAIL_NEW', voicemailId: 'vm-toner', participants: [] },
      ],
    });
    interactions.recordTranscript('conv-toner', 'rec-toner', courtneyTranscript());
    const described = interactions.describeForTests('conv-toner');
    assert.equal(described.answered, false);
    assert.equal(described.reachedVoicemail, true);
    assert.deepEqual(described.csrPath, []);

    const built = openaiClient.buildSummaryMessages({
      legRecords: described.legRecords,
      csrPath: described.csrPath,
      externalNumber: described.externalNumber,
      direction: described.direction,
      callCreated: described.callCreated,
      callEnded: described.callEnded,
      answered: described.answered,
      reachedVoicemail: described.reachedVoicemail,
    });
    assert.equal(built.voicemail, true);
    assert.doesNotMatch(`${built.system}\n${built.user}`, FALSE_STAFF_CLAIM);
    assert.match(built.user, /No representative joined this call/);
    assert.doesNotMatch(built.user, /Team Member:/);
  });
});
