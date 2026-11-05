const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callIntent = require('../src/callIntent');
const callParties = require('../src/callParties');
const openaiClient = require('../src/openaiClient');
const roster = require('../src/roster');

// 2026-11-04 audit (live commit 576e621). Fixtures use the lines the audit quoted.
// Phone numbers are the real caller ids. Names that were not in the audit are
// shortened to the role the transcript actually showed.

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);

const FALSE_STAFF_CLAIM = /reached a team member|team member informed|answered by a team member|team member who informed|spoke with a team member/i;

function transcript(lines) {
  return {
    results: lines.map(([seconds, channel, text]) => ({
      transcript: text,
      channel,
      startTimeMs: seconds * 1000,
    })),
  };
}

function trainingLines(callerLine) {
  return [
    [0, 1, 'Thank you for calling Budget Blinds.'],
    [3, 1, 'To reach your nearest Budget Blinds location, please enter your zip code.'],
    [8, 1, 'Our entire team is currently in a company-wide training today, Wednesday, November 4th.'],
    [14, 1, 'The downtown crew is off site until late morning.'],
    [20, 1, 'We will return to our desks later this morning at 11 a.m.'],
    [26, 1, 'Thank you for your patience.'],
    [30, 1, 'Please leave a message after the tone.'],
    [34, 1, 'Music'],
    [36, 1, 'Beep'],
    callerLine,
  ];
}

const VOICEMAILS = [
  {
    name: 'Ronald Beals',
    number: '9162052801',
    callCreated: '2026-11-04T18:16:00.000Z',
    caller: [40, 0, 'Hi, this is Ronald Beals. Please call me back about blinds.'],
  },
  {
    name: '10:31 inbound',
    number: '9253818381',
    callCreated: '2026-11-04T18:31:00.000Z',
    caller: [40, 0, 'Hi, I was calling about shades for the kitchen. Please call me back.'],
  },
  {
    name: '9:57 inbound',
    number: '9163908378',
    callCreated: '2026-11-04T17:57:00.000Z',
    caller: [40, 0, 'Hello, please call me back about an estimate.'],
  },
];

function trainingLeg(sample) {
  return {
    direction: 'INBOUND',
    csrChain: [],
    callCreated: sample.callCreated,
    transcript: transcript(trainingLines(sample.caller)),
  };
}

function summaryFor(leg, extra = {}) {
  return openaiClient.buildSummaryMessages({
    legRecords: [leg],
    csrPath: extra.csrPath || [],
    externalNumber: extra.externalNumber,
    externalName: extra.externalName,
    direction: leg.direction,
    callCreated: leg.callCreated,
    callEnded: extra.callEnded || leg.callCreated,
    answered: Object.prototype.hasOwnProperty.call(extra, 'answered') ? extra.answered : null,
    reachedVoicemail: extra.reachedVoicemail,
  });
}

function jessicaLines(answer = 'This is Jessica.', booking = 'I can book you with our consultant Alex on November 13 at noon.') {
  return [
    [0, 1, 'Thank you for calling Budget Blinds.'],
    [6, 1, 'To reach your nearest Budget Blinds location, please enter your zip code.'],
    [18, 1, answer],
    [22, 0, 'Hi, I need blinds in El Dorado Hills.'],
    [28, 1, booking],
    [36, 0, 'Noon works.'],
  ];
}

function jessicaLeg(lines = jessicaLines()) {
  return {
    direction: 'INBOUND',
    csrChain: [],
    callCreated: '2026-11-04T22:15:00.000Z',
    transcript: transcript(lines),
  };
}

function withExtraPerson(person) {
  const config = {
    people: ROSTER_CONFIG.people.map((entry) => ({ ...entry })),
  };
  config.people.push(person);
  roster.setRosterForTests(roster.createRoster(config, []));
}

const BANK_IVR = [
  [0, 0, 'Para continuar en español, oprima el dos.'],
  [4, 0, "You've reached the Citrus Height Branch."],
  [10, 0, 'In observance of Veterans Day, the branch will be closed.'],
  [18, 0, 'This is your personal bank account, can I help you?'],
  [24, 0, 'Cash payments cannot be accepted at the teller line. You can pay by transfer.'],
];

const AMY_QUESTIONS = [
  [20, 1, 'Are you guys able to accept payments for a Costco Citi card?'],
  [30, 1, 'I need to pay the card at the branch.'],
];

function bankLeg(swapped) {
  const lines = swapped
    ? [...BANK_IVR, ...AMY_QUESTIONS]
    : [
      ...BANK_IVR.map(([seconds, , text]) => [seconds, 1, text]),
      ...AMY_QUESTIONS.map(([seconds, , text]) => [seconds, 0, text]),
    ];
  return {
    direction: 'OUTBOUND',
    recordingId: 'rec-citi',
    recordingOwners: swapped
      ? { 'rec-citi': { role: 'team', name: 'Amy Bullock', extension: '00001' } }
      : { 'rec-citi': { role: 'team', name: 'Amy Bullock', extension: '00001' } },
    csrChain: [{ name: 'Amy Bullock', extension: '00001', enteredAt: '2026-11-04T00:50:00.000Z' }],
    callCreated: '2026-11-04T00:50:00.000Z',
    transcript: transcript(lines),
  };
}

describe('2026-11-04 office training greeting is a recording', () => {
  beforeEach(() => roster.resetRosterForTests());
  after(() => {
    roster.resetRosterForTests();
    callIntent.setClassifierForTests(null);
  });

  for (const sample of VOICEMAILS) {
    it(`labels ${sample.name} as voicemail, including a greeting line with new wording`, () => {
      const leg = trainingLeg(sample);
      const novel = 'The downtown crew is off site until late morning.';
      assert.equal(callParties.isKnownPromptPhrase(novel, roster.getRoster()), false);
      const rows = openaiClient.formatLegTranscript(leg);
      const prompts = rows.filter((row) => row.seconds < 40);
      const spoken = rows.filter((row) => row.seconds >= 40);
      assert.deepEqual(prompts.map((row) => row.label), prompts.map(() => 'Recording'));
      assert.deepEqual(spoken.map((row) => row.label), ['Customer']);
      assert.equal(rows.some((row) => row.label === 'Team Member'), false);
      assert.match(rows.map((row) => row.text).join('\n'), /company-wide training/);
      assert.match(rows.map((row) => row.text).join('\n'), /Music/);
      assert.match(rows.map((row) => row.text).join('\n'), /Beep/);

      const built = summaryFor(leg, {
        externalNumber: sample.number,
        callEnded: sample.callCreated,
        answered: false,
        reachedVoicemail: true,
      });
      assert.equal(built.voicemail, true);
      assert.equal(built.routedAway, false);
      assert.match(built.user, /left a voicemail|left a message/);
      assert.doesNotMatch(built.user, /Team Member:/);
      assert.equal(callIntent.transcriptShowsLiveConversation(built.conversationText), false);
      const tags = callIntent.finalizeTags({
        model: { intent: 'New project', outcome: 'voicemail left', routedAway: false, bookedConsultation: false },
        transcriptText: built.conversationText,
        summary: 'The caller left a voicemail.',
        hasTranscript: true,
        direction: 'INBOUND',
        callType: 'customer',
      });
      assert.equal(tags.routedAway, false);
      assert.equal(tags.lead, 'Yes');
      assert.equal(tags.outcome, 'voicemail left');
    });
  }

  it('keeps a novel sentence on a roster member who actually answered', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true }],
      callCreated: '2026-11-04T18:00:00.000Z',
      transcript: transcript([
        [0, 1, 'Thank you for calling Budget Blinds.'],
        [4, 1, 'The downtown crew is off site until late morning.'],
        [8, 1, 'Beep'],
        [12, 0, 'Hi, this is Pat.'],
      ]),
    });
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Emily Kingdon', 'Recording', 'Customer']);
  });

  it('strips false team-member claims from the three voicemail summaries', () => {
    const samples = [
      'Ronald Beals called Budget Blinds but reached a team member during a company-wide training session.',
      'During the call, a team member informed her that the entire team was in a company-wide training.',
      'The call was answered by a team member who informed the caller that the team was in training.',
    ];
    for (const sample of samples) {
      const cleaned = openaiClient.guardVoicemailSummary(sample, { voicemail: true });
      assert.doesNotMatch(cleaned, FALSE_STAFF_CLAIM, cleaned);
      assert.match(cleaned, /voicemail|recorded greeting/i);
    }
  });
});

describe('2026-11-04 zip-code routing is not our lead', () => {
  beforeEach(() => roster.resetRosterForTests());
  after(() => roster.resetRosterForTests());

  function tagsFor(lines) {
    const leg = jessicaLeg(lines);
    const built = summaryFor(leg, {
      externalNumber: '5105996623',
      externalName: 'MYERS LINDA',
      callEnded: '2026-11-04T22:25:00.000Z',
      answered: null,
    });
    const tags = callIntent.finalizeTags({
      model: {
        intent: 'New project',
        outcome: 'booked consultation',
        routedAway: false,
        bookedConsultation: true,
      },
      transcriptText: built.conversationText,
      summary: 'The team member booked a consultation with our consultant Alex for El Dorado Hills on November 13 at noon.',
      hasTranscript: true,
      direction: 'INBOUND',
      callType: built.callType,
    });
    return { built, tags };
  }

  it('routes a non-roster answer after the zip prompt away from our leads', () => {
    const rows = openaiClient.formatLegTranscript(jessicaLeg());
    assert.deepEqual(rows.map((row) => row.label), [
      'Recording',
      'Recording',
      'Team Member',
      'Customer',
      'Team Member',
      'Customer',
    ]);
    const { built, tags } = tagsFor();
    assert.equal(built.routedAway, true);
    assert.match(built.user, /another Budget Blinds location/);
    assert.match(built.user, /not on our roster/);
    assert.equal(tags.routedAway, true);
    assert.equal(tags.outcome, callIntent.ROUTED_PHRASE);
    assert.equal(tags.lead, 'No');
    assert.equal(tags.bookedConsultation, false);
    assert.equal(tags.intent, 'New project');

    const cleaned = openaiClient.guardRoutedAwaySummary(
      'The team member booked a consultation with our consultant Alex for El Dorado Hills on November 13 at noon.',
      { routedAway: true },
    );
    assert.match(cleaned, /Budget Blinds location/);
    assert.doesNotMatch(cleaned, /the team member booked/i);
    assert.equal(
      openaiClient.guardRoutedAwaySummary('Emily Kingdon booked a consultation.', { routedAway: false }),
      'Emily Kingdon booked a consultation.',
    );
  });

  it('uses roster membership for the answerer and the named consultant', () => {
    const emily = tagsFor(jessicaLines(
      'This is Emily.',
      'I can book you with our consultant Alex on November 13 at noon.',
    ));
    assert.equal(emily.built.routedAway, false);
    assert.equal(emily.tags.routedAway, false);
    assert.equal(emily.tags.lead, 'Yes');

    const consultantOnly = jessicaLines(
      'I can help with that.',
      'I can book you with our consultant Alex on November 13 at noon.',
    );
    assert.equal(tagsFor(consultantOnly).tags.routedAway, true);

    withExtraPerson({ name: 'Jessica Nguyen', phones: ['5550101888'] });
    assert.equal(tagsFor().tags.routedAway, false, 'Jessica is on the roster');

    roster.resetRosterForTests();
    withExtraPerson({ name: 'Alex Consultant', role: 'designer', phones: ['5550101777'] });
    assert.equal(tagsFor(consultantOnly).tags.routedAway, false, 'Alex is on the roster');

    roster.resetRosterForTests();
    withExtraPerson({ name: 'Heather Ubaldo', role: 'designer', phones: ['5550101666'] });
    const heather = tagsFor(jessicaLines('This is Heather.', 'I can book Thursday.'));
    assert.equal(heather.tags.routedAway, false);

    roster.resetRosterForTests();
    const unknownHeather = tagsFor(jessicaLines('This is Heather.', 'I can book Thursday.'));
    assert.equal(unknownHeather.tags.routedAway, true);
  });
});

describe('2026-11-04 outbound bank IVR is the external party', () => {
  beforeEach(() => roster.resetRosterForTests());
  after(() => roster.resetRosterForTests());

  function labelsOf(swapped) {
    return openaiClient.formatLegTranscript(bankLeg(swapped))
      .map((row) => `${row.label}: ${row.text.slice(0, 42)}`);
  }

  it('does not label the bank IVR or the bank rep as Amy', () => {
    const swapped = labelsOf(true);
    const straight = labelsOf(false);
    for (const rows of [swapped, straight]) {
      assert.match(rows.join('\n'), /Recording: Para continuar en español/);
      assert.match(rows.join('\n'), /Recording: You've reached the Citrus Height Branch/);
      assert.match(rows.join('\n'), /Recording: In observance of Veterans Day/);
      assert.match(rows.join('\n'), /Customer: This is your personal bank account/);
      assert.match(rows.join('\n'), /Customer: Cash payments cannot be accepted/);
      assert.match(rows.join('\n'), /Amy Bullock: Are you guys able to accept payments/);
      assert.match(rows.join('\n'), /Amy Bullock: I need to pay the card at the branch/);
      assert.equal(rows.some((row) => row.startsWith('Amy Bullock: Para continuar')), false);
      assert.equal(rows.some((row) => row.startsWith('Amy Bullock: You\'ve reached')), false);
      assert.equal(rows.some((row) => row.startsWith('Amy Bullock: Cash payments')), false);
      assert.equal(rows.some((row) => row.startsWith('Customer: Are you guys able')), false);
    }
  });

  it('classifies the bank call as vendor business, not a wrong number', () => {
    const leg = bankLeg(true);
    const built = summaryFor(leg, {
      csrPath: ['Amy Bullock (00001)'],
      externalNumber: '9164592034',
      callEnded: '2026-11-04T00:55:00.000Z',
      answered: true,
    });
    assert.equal(built.callType, 'vendor');
    assert.match(built.user, /Amy Bullock: Are you guys able to accept payments/);
    assert.match(built.user, /Recording: You've reached the Citrus Height Branch/);
    assert.doesNotMatch(built.user, /Amy Bullock: You've reached/);
    assert.doesNotMatch(built.user, /Amy Bullock: Para continuar/);

    const tags = callIntent.finalizeTags({
      model: { intent: 'Wrong number', outcome: 'wrong number', routedAway: false, bookedConsultation: false },
      transcriptText: built.conversationText,
      summary: 'Amy confirmed that cash payments cannot be accepted at the teller line.',
      hasTranscript: true,
      direction: 'OUTBOUND',
      answered: true,
      callType: 'customer',
    });
    assert.equal(tags.intent, 'Vendor or other business');
    assert.equal(tags.callType, 'vendor');
    assert.equal(tags.lead, 'No');
    assert.equal(tags.outcome, 'info given');
    assert.equal(tags.routedAway, false);
  });
});
