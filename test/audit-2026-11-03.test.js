const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const callIntent = require('../src/callIntent');
const openaiClient = require('../src/openaiClient');
const roster = require('../src/roster');

// 2026-11-03 audit (live commit 2ff35a1). The voicemail transcript is the Drive
// doc text. The four intent calls and the hold transfer are reconstructed from
// the audit's description of who spoke, because the attachment did not include
// those transcripts verbatim.

const FALSE_STAFF_CLAIM = /connected to (?:a |the )?(?:budget blinds )?team member|answered by (?:a |the )?(?:budget blinds )?team member|spoke with (?:a |the )?(?:budget blinds )?team member|spoke with someone/i;
const NON_CONVERSATION_OUTCOME = /\b(no answer|voicemail|abandoned)\b/i;

function transcript(lines) {
  return {
    results: lines.map(([seconds, channel, text]) => ({
      transcript: text,
      channel,
      startTimeMs: seconds * 1000,
    })),
  };
}

// 2:26 PM PT inbound. Channel 1 is what the caller heard (IVR, queue, voicemail).
// Channel 0 is the caller. No roster member joined.
function wesolowskiLeg() {
  return {
    direction: 'INBOUND',
    csrChain: [],
    callCreated: '2026-11-03T22:26:00.000Z',
    transcript: transcript([
      [0, 1, 'Thank you for calling Budget Blinds.'],
      [12, 1, 'To reach your nearest Budget Blinds location, please enter your zip code.'],
      [25, 1, 'Thank you for calling Budget Blinds.'],
      [27, 1, 'If you would like to schedule a free in-home consultation,'],
      [31, 1, 'please press 1.'],
      [59, 1, 'We apologize for the extended wait.'],
      [63, 1, 'Our representatives are currently helping other customers.'],
      [69, 1, 'please leave a message after the tone,'],
      [74, 1, 'Thank you.'],
      [78, 0, 'Hi, my name is Cynthia Atherton. I had an appointment today for an in-home consultation.'],
      [86, 0, 'No one has shown up or call in. So just please take me off of your list of potential customers.'],
    ]),
  };
}

function summaryFor(leg, extra = {}) {
  return openaiClient.buildSummaryMessages({
    legRecords: [leg],
    csrPath: extra.csrPath || [],
    externalNumber: extra.externalNumber || '9162769055',
    externalName: extra.externalName,
    direction: leg.direction,
    callCreated: leg.callCreated,
    callEnded: extra.callEnded || leg.callCreated,
    answered: Object.prototype.hasOwnProperty.call(extra, 'answered') ? extra.answered : false,
    reachedVoicemail: extra.reachedVoicemail,
  });
}

describe('2026-11-03 voicemail was not a team member', () => {
  beforeEach(() => roster.resetRosterForTests());
  after(() => {
    roster.resetRosterForTests();
    callIntent.setClassifierForTests(null);
  });

  it('labels the split consultation menu, queue, and voicemail closer as Recording', () => {
    const rows = openaiClient.formatLegTranscript(wesolowskiLeg());
    const prompts = rows.filter((row) => row.seconds < 78);
    const spoken = rows.filter((row) => row.seconds >= 78);
    assert.deepEqual(prompts.map((row) => row.label), prompts.map(() => 'Recording'));
    assert.deepEqual(spoken.map((row) => row.label), spoken.map(() => 'Customer'));
    assert.equal(rows.some((row) => row.label === 'Team Member'), false);
    assert.match(rows.map((row) => row.text).join('\n'), /Cynthia Atherton/);
    assert.match(rows.map((row) => `${row.seconds} ${row.label}: ${row.text}`).join('\n'), /27 Recording: If you would like to schedule a free in-home consultation/);
    assert.match(rows.map((row) => `${row.seconds} ${row.label}: ${row.text}`).join('\n'), /74 Recording: Thank you/);
  });

  it('does not treat a live scheduling offer as the IVR menu', () => {
    const rows = openaiClient.formatLegTranscript({
      direction: 'INBOUND',
      csrChain: [{ name: 'Emily Kingdon', extension: '00006', answered: true }],
      callCreated: '2026-11-03T22:00:00.000Z',
      transcript: transcript([
        [0, 1, 'If you would like to schedule Thursday at 3, I can book that.'],
        [4, 0, 'Thursday works.'],
      ]),
    });
    assert.deepEqual(rows.map((row) => row.label), ['Emily Kingdon', 'Customer']);
  });

  it('tells the summarizer the caller left a voicemail and strips a false staff claim', () => {
    const built = summaryFor(wesolowskiLeg(), {
      externalName: 'WESOLOWSKI,PAUL',
      callEnded: '2026-11-03T22:28:00.000Z',
      answered: false,
      reachedVoicemail: true,
    });
    assert.equal(built.voicemail, true);
    assert.equal(callIntent.transcriptShowsLiveConversation(built.conversationText), false);
    assert.match(built.user, /reached the queue and voicemail and left a message/);
    assert.match(built.user, /left a voicemail/);
    assert.doesNotMatch(built.user, /Team Member:/);
    assert.doesNotMatch(built.user, /two-sided conversation/);
    assert.match(built.conversationText, /\[27s\] Recording: If you would like to schedule a free in-home consultation/);
    assert.match(built.conversationText, /\[74s\] Recording: Thank you\./);
    assert.match(built.conversationText, /\[78s\] Customer: Hi, my name is Cynthia Atherton/);

    const cleaned = openaiClient.guardVoicemailSummary(
      'Paul Wesolowski called Budget Blinds and was placed on hold for a brief period. After the hold, Cynthia Atherton spoke with a team member, expressing her frustration that no one showed up and asking to be taken off the list.',
      { voicemail: true },
    );
    assert.doesNotMatch(cleaned, FALSE_STAFF_CLAIM);
    assert.match(cleaned, /voicemail/i);
    assert.match(cleaned, /Cynthia Atherton/);
    assert.match(cleaned, /taken off the list/);

    const tags = callIntent.finalizeTags({
      model: { intent: 'No conversation or no transcript', outcome: 'voicemail left' },
      transcriptText: built.conversationText,
      summary: cleaned,
      hasTranscript: true,
      direction: 'INBOUND',
      answered: false,
      voicemail: true,
      callType: 'customer',
    });
    assert.equal(tags.outcome, 'voicemail left');
  });
});

describe('2026-11-03 live calls were not "no conversation"', () => {
  beforeEach(() => {
    roster.resetRosterForTests();
    callIntent.setClassifierForTests(null);
  });
  after(() => {
    roster.resetRosterForTests();
    callIntent.setClassifierForTests(null);
  });

  const cases = [
    {
      name: 'Amy and Valerie agreed to talk next week',
      direction: 'OUTBOUND',
      callCreated: '2026-11-03T23:08:00.000Z',
      callEnded: '2026-11-03T23:08:25.000Z',
      externalNumber: '9259638436',
      csrPath: ['Amy Bullock (00001)'],
      chain: [{ name: 'Amy Bullock', extension: '00001', enteredAt: '2026-11-03T23:08:00.000Z' }],
      lines: [
        [0, 0, 'Hi Valerie, this is Amy with Budget Blinds.'],
        [4, 1, 'I am busy at the end of the week.'],
        [8, 0, 'No problem. We can talk next week.'],
      ],
      modelOutcome: 'no answer, call ended quickly',
      summary: 'Valerie answered and said she is busy at the end of the week. Amy Bullock agreed to talk next week.',
      outcome: /callback promised/,
    },
    {
      name: 'Emily and Cindy set a callback',
      direction: 'OUTBOUND',
      callCreated: '2026-11-03T20:32:00.000Z',
      callEnded: '2026-11-03T20:32:20.000Z',
      externalNumber: '4082189596',
      csrPath: ['Emily Kingdon (00006)'],
      chain: [{ name: 'Emily Kingdon', extension: '00006', enteredAt: '2026-11-03T20:32:00.000Z' }],
      lines: [
        [0, 0, 'Hi Cindy, this is Emily with Budget Blinds.'],
        [3, 1, 'I am in a meeting. Can you call me back?'],
        [6, 0, 'Sure, I will call you back.'],
      ],
      modelOutcome: 'no answer',
      summary: 'Cindy answered, said she was in a meeting, and asked Emily Kingdon for a callback.',
      outcome: /callback promised/,
    },
    {
      name: 'Marina answered and declined',
      direction: 'OUTBOUND',
      callCreated: '2026-11-03T16:51:00.000Z',
      callEnded: '2026-11-03T16:51:30.000Z',
      externalNumber: '9166952571',
      csrPath: ['Emily Kingdon (00006)'],
      chain: [{ name: 'Emily Kingdon', extension: '00006', enteredAt: '2026-11-03T16:51:00.000Z' }],
      lines: [
        [0, 0, 'Hi Marina, this is Emily with Budget Blinds. I am calling about a consultation.'],
        [5, 1, 'No thank you. I do not want a consultation.'],
        [8, 0, 'I understand. Thank you for your time.'],
      ],
      modelOutcome: 'voicemail left, customer did not engage',
      summary: 'Marina answered and declined the consultation.',
      outcome: /declined/,
    },
    {
      name: 'Emily answered an inbound question about filters',
      direction: 'INBOUND',
      callCreated: '2026-11-03T17:34:00.000Z',
      callEnded: '2026-11-03T17:34:40.000Z',
      externalNumber: '5103337088',
      csrPath: ['Emily Kingdon (00006)'],
      chain: [{ name: 'Emily Kingdon', extension: '00006', enteredAt: '2026-11-03T17:34:00.000Z', answered: true }],
      lines: [
        [2, 0, 'Hi, I had a question about some filters.'],
        [5, 1, 'This is Emily with Budget Blinds. What kind of filters?'],
        [9, 0, 'The ones for the windows.'],
      ],
      modelOutcome: 'abandoned',
      summary: 'The caller asked Emily Kingdon about some filters.',
      outcome: /info given/,
    },
  ];

  for (const sample of cases) {
    it(`${sample.name}: unanswered metadata does not override the transcript`, async () => {
      const leg = {
        direction: sample.direction,
        callCreated: sample.callCreated,
        csrChain: sample.chain,
        transcript: transcript(sample.lines),
      };
      const built = summaryFor(leg, {
        csrPath: sample.csrPath,
        externalNumber: sample.externalNumber,
        callEnded: sample.callEnded,
        answered: false,
        reachedVoicemail: sample.modelOutcome.includes('voicemail'),
      });
      assert.equal(callIntent.transcriptShowsLiveConversation(built.conversationText), true, built.conversationText);
      assert.match(built.user, /two-sided conversation/);
      assert.doesNotMatch(built.user, /Answered: no/);

      let seen = null;
      callIntent.setClassifierForTests((input) => {
        seen = input;
        return {
          intent: 'No conversation or no transcript',
          outcome: sample.modelOutcome,
          routedAway: false,
          bookedConsultation: false,
        };
      });
      const interpreted = await callIntent.interpret({
        conversationText: built.conversationText,
        direction: sample.direction,
        answered: false,
        voicemail: sample.modelOutcome.includes('voicemail'),
        reachedVoicemail: sample.modelOutcome.includes('voicemail'),
        callType: 'customer',
      });
      assert.equal(seen.answered, true);
      assert.equal(seen.voicemail, false);
      assert.equal(seen.reachedVoicemail, false);
      assert.equal(seen.liveConversation, true);
      assert.match(callIntent.classifierSystemPrompt(), /both a team member and the other party have live lines/);

      const tags = callIntent.finalizeTags({
        model: interpreted,
        transcriptText: built.conversationText,
        summary: sample.summary,
        hasTranscript: true,
        direction: sample.direction,
        answered: false,
        voicemail: sample.modelOutcome.includes('voicemail'),
        callType: 'customer',
      });
      assert.notEqual(tags.intent, 'No conversation or no transcript');
      assert.equal(tags.intent, 'Product or general info');
      assert.doesNotMatch(tags.outcome, NON_CONVERSATION_OUTCOME);
      assert.match(tags.outcome, sample.outcome);
      assert.equal(tags.callType, 'customer');
      assert.equal(tags.lead, 'No');
    });
  }

  it('keeps a real intent and only replaces a contradictory outcome', () => {
    const tags = callIntent.finalizeTags({
      model: { intent: 'New project', outcome: 'no answer' },
      transcriptText: '[0s] Emily Kingdon: Hi Marina, this is Emily with Budget Blinds.\n[5s] Customer: No thank you.',
      summary: 'Marina answered and declined the consultation.',
      hasTranscript: true,
      direction: 'OUTBOUND',
      answered: false,
      callType: 'customer',
    });
    assert.equal(tags.intent, 'New project');
    assert.equal(tags.outcome, 'declined');
  });
});

describe('2026-11-03 inbound hold is not credited to the member who only said hold', () => {
  beforeEach(() => roster.resetRosterForTests());
  after(() => roster.resetRosterForTests());

  const callCreated = '2026-11-03T20:44:00.000Z';
  const chain = [
    { name: 'Amy Bullock', extension: '00001', enteredAt: callCreated, answered: true },
    { name: 'Emily Kingdon', extension: '00006', enteredAt: '2026-11-03T20:44:45.000Z', answered: true },
  ];
  const csrPath = ['Amy Bullock (00001)', 'Emily Kingdon (00006)'];

  function meyerLeg() {
    return {
      direction: 'INBOUND',
      callCreated,
      csrChain: chain,
      transcript: transcript([
        [0, 1, 'This call may be monitored or recorded for quality assurance.'],
        [15, 1, 'Budget Blinds, can you please hold?'],
        [70, 0, 'I need to schedule the in-home consultation.'],
        [78, 0, 'Monday November 9 works for me.'],
      ]),
    };
  }

  it('keeps the hold line on Amy and tells the summary to credit Emily', () => {
    const rows = openaiClient.formatLegTranscript(meyerLeg());
    assert.deepEqual(rows.map((row) => row.label), ['Recording', 'Amy Bullock', 'Customer', 'Customer']);
    const built = summaryFor(meyerLeg(), {
      csrPath,
      externalNumber: '9169961979',
      externalName: 'PHILIP MEYER',
      callEnded: '2026-11-03T20:48:00.000Z',
      answered: true,
    });
    assert.equal(built.voicemail, false);
    assert.match(built.user, /\[15s\] Amy Bullock: Budget Blinds, can you please hold\?/);
    assert.match(built.user, /Post-hold credit: Amy Bullock only asked the caller to hold/);
    assert.match(built.user, /Attribute scheduling and everything after the hold to Emily Kingdon/);
    assert.match(built.user, /Do not credit that work to Amy Bullock/);
    assert.doesNotMatch(built.user, /Emily Kingdon: /);

    const cleaned = openaiClient.guardHoldHandoffSummary(
      'Amy Bullock assisted him with scheduling the appointment.',
      built.holdHandoff,
    );
    assert.match(cleaned, /Emily Kingdon assisted him with scheduling the appointment/);
    assert.doesNotMatch(cleaned, /Amy Bullock assisted/);

    const held = openaiClient.guardHoldHandoffSummary(
      'Amy Bullock asked him to hold.',
      built.holdHandoff,
    );
    assert.equal(held, 'Amy Bullock asked him to hold.');

    const mixed = openaiClient.guardHoldHandoffSummary(
      'Amy Bullock asked him to hold and then scheduled the appointment for Monday, November 9.',
      built.holdHandoff,
    );
    assert.match(mixed, /Amy Bullock asked him to hold/);
    assert.match(mixed, /Emily Kingdon scheduled the appointment/);
    assert.doesNotMatch(mixed, /Amy Bullock scheduled/);
  });

  it('does not apply post-hold credit to an outbound dialer chain', () => {
    const callStarted = '2026-10-30T21:37:00.000Z';
    const leg = {
      direction: 'OUTBOUND',
      callCreated: callStarted,
      csrChain: [
        { name: 'Emily Kingdon', extension: '00006', enteredAt: callStarted },
        { name: 'Joshua Simington', extension: '00003', enteredAt: '2026-10-30T21:37:01.000Z' },
      ],
      transcript: transcript([
        [0, 1, 'Hello?'],
        [3, 0, "I'm fair. My name is Emily. I'm calling a Baffle Budget Blinds."],
        [7, 0, 'I was just returning a call. It looks like we had just missed.'],
        [10, 1, "Oh, I'm talking to Amy right now."],
        [13, 0, "Oh, gotcha. No problem. I'll leave you to it. Bye-bye."],
      ]),
    };
    const rows = openaiClient.formatLegTranscript(leg);
    assert.deepEqual(rows.map((row) => row.label), [
      'Customer',
      'Emily Kingdon',
      'Emily Kingdon',
      'Customer',
      'Emily Kingdon',
    ]);
    const built = summaryFor(leg, {
      csrPath: ['Emily Kingdon (00006)', 'Joshua Simington (00003)'],
      externalNumber: '9168013215',
      callEnded: '2026-10-30T21:37:20.000Z',
      answered: true,
    });
    assert.equal(built.holdHandoff, null);
    assert.doesNotMatch(built.user, /Post-hold credit/);
    assert.doesNotMatch(built.user, /Joshua Simington:/);
  });

  it('leaves a real inbound handoff on the member who had already joined', () => {
    const leg = {
      direction: 'INBOUND',
      callCreated,
      csrChain: chain,
      transcript: transcript([
        [5, 1, 'I can help with that.'],
        [50, 1, 'I have Monday November 9 available.'],
        [55, 0, 'That works.'],
      ]),
    };
    const rows = openaiClient.formatLegTranscript(leg);
    assert.deepEqual(rows.map((row) => row.label), ['Amy Bullock', 'Emily Kingdon', 'Customer']);
    const built = summaryFor(leg, {
      csrPath,
      externalNumber: '9169961979',
      callEnded: '2026-11-03T20:48:00.000Z',
      answered: true,
    });
    assert.equal(built.holdHandoff, null);
    assert.doesNotMatch(built.user, /Post-hold credit/);
  });
});
