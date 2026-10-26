const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callParties = require('../src/callParties');
const callType = require('../src/callType');
const openaiClient = require('../src/openaiClient');
const roster = require('../src/roster');

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);

const WILL_CELL = '5555550199';
const WILL_MAP = JSON.stringify({
  '+1 (555) 555-0199': { name: 'Will Maldonado', role: 'designer' },
});

function willRoster() {
  const book = roster.createRoster(ROSTER_CONFIG, ['5550101999']);
  roster.applyTeamMemberPhones(book, roster.parseTeamMemberPhones(WILL_MAP));
  return book;
}

function messages(book, extra) {
  roster.setRosterForTests(book);
  return openaiClient.buildSummaryMessages({
    legRecords: [{
      direction: extra.direction || 'INBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: extra.transcript,
    }],
    csrPath: ['Joshua Simington (00003)'],
    externalNumber: extra.externalNumber || WILL_CELL,
    externalName: extra.externalName || 'WIRELESS CALLER',
    direction: extra.direction || 'INBOUND',
    callCreated: '2026-10-26T18:44:00.000Z',
    callEnded: '2026-10-26T18:50:00.000Z',
    answered: true,
  });
}

after(() => {
  delete process.env.TEAM_MEMBER_PHONES;
  roster.resetRosterForTests();
});

describe('Heymarket note format', () => {
  it('posts only the summary and the recording link', () => {
    const summary = 'Call type: Customer\n\nGENERAL INQUIRY - The caller asked about shades.';
    const folderLink = 'https://drive.google.com/drive/folders/example';
    const note = callType.formatCallNote({
      summary,
      callTypeLabel: 'Customer',
      folderLink,
    });
    const adminNote = openaiClient.formatCallNote({ summary, folderLink });
    assert.equal(note, adminNote);
    assert.equal(
      note,
      'The caller asked about shades.\n\nCall recording & transcript: https://drive.google.com/drive/folders/example',
    );
    assert.doesNotMatch(note, /Call type/i);
    assert.doesNotMatch(note, /GENERAL INQUIRY/);
    assert.equal(
      callType.formatCallNote({ summary: 'Joshua called back.\n\nCall type: Internal team' }),
      'Joshua called back.',
    );
    assert.equal(
      callType.formatCallNote({ summary: 'Call type: Vendor' }),
      '',
    );
  });
});

describe('team member cell numbers', () => {
  it('parses the documented JSON map and ignores blank or invalid values', () => {
    const parsed = roster.parseTeamMemberPhones(WILL_MAP);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'Will Maldonado');
    assert.equal(parsed[0].role, 'designer');
    assert.equal(roster.last10(parsed[0].phone), WILL_CELL);
    assert.deepEqual(roster.parseTeamMemberPhones(''), []);
    assert.deepEqual(roster.parseTeamMemberPhones('   '), []);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      assert.deepEqual(roster.parseTeamMemberPhones('{'), []);
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /not valid JSON/);
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8');
    assert.equal(raw.includes('5555550199'), false);
    assert.equal(raw.includes('"phones"'), false);
  });

  it('labels a configured cell with that person and role', () => {
    const book = willRoster();
    assert.equal(book.personByPhone(WILL_CELL).name, 'Will Maldonado');
    assert.equal(book.personByPhone(WILL_CELL).role, 'designer');
    assert.equal(book.personByPhone(WILL_CELL).extension, null);
    assert.equal(book.firstNames.includes('Will'), false);

    const built = messages(book, {
      transcript: {
        results: [
          { transcript: 'The customer let me in. What is an inexpensive drapery option?', channel: 0, startTimeMs: 0 },
          { transcript: 'This is Joshua. Use the opening price book.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'internal');
    assert.equal(built.callTypeSource, 'phone');
    assert.equal(built.partyName, 'Will Maldonado');
    assert.equal(built.partyRole, 'designer');
    assert.match(built.system, /internal phone calls/i);
    assert.match(built.system, /Name \(role\)/);
    assert.match(built.user, /Caller identity: Will Maldonado \(designer\)/);
    assert.match(built.user, /\[0s\] Will Maldonado \(designer\): The customer let me in/);
    assert.doesNotMatch(built.system, /You summarize customer phone calls/);
    assert.doesNotMatch(built.user, /Customer phone number/);

    const history = callParties.analyzeCallHistory({
      direction: 'INBOUND',
      caller: { name: 'WIRELESS CALLER', number: WILL_CELL },
      callee: { name: 'Joshua Simington', extensionNumber: '00003' },
      answerTime: '2026-10-26T18:44:05.000Z',
    }, book);
    assert.equal(history.teamMember.name, 'Joshua Simington');
    assert.equal(history.otherParty.name, 'Will Maldonado');
    assert.equal(history.otherParty.matchedBy, 'phone');

    const assignment = callParties.channelRolesForLeg([
      { channel: 0, text: 'This is Will. What fabric should I quote?', startTimeMs: 0 },
      { channel: 1, text: 'The opening price book.', startTimeMs: 1000 },
    ], { direction: 'INBOUND', csrChain: [{ name: 'Joshua Simington', extension: '00003' }] }, book);
    assert.equal(assignment.corrected, false);
    assert.equal(assignment.roles[0], 'customer');
    assert.equal(assignment.roles[1], 'team');

    const noTranscript = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: WILL_CELL,
      direction: 'INBOUND',
      callCreated: '2026-10-26T18:44:00.000Z',
      answered: true,
      callType: 'internal',
      partyName: 'Will Maldonado',
      partyRole: 'designer',
    });
    assert.match(noTranscript, /Will Maldonado \(designer\) called Budget Blinds/);
    assert.doesNotMatch(noTranscript, /the customer/i);
    roster.resetRosterForTests();
  });

  it('keeps an unconfigured cell on the customer prompt', () => {
    roster.resetRosterForTests();
    const built = messages(roster.getRoster(), {
      transcript: {
        results: [
          { transcript: 'The customer let me in. What is an inexpensive drapery option?', channel: 0, startTimeMs: 0 },
          { transcript: 'This is Joshua. Use the opening price book.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'customer');
    assert.equal(built.partyName, null);
    assert.equal(built.partyRole, null);
    assert.match(built.system, /You summarize customer phone calls/);
    assert.match(built.user, /\[0s\] Customer:/);
    roster.resetRosterForTests();
  });

  it('loads TEAM_MEMBER_PHONES from the environment without duplicating an existing name', () => {
    const previous = process.env.TEAM_MEMBER_PHONES;
    process.env.TEAM_MEMBER_PHONES = JSON.stringify({
      '5555550199': { name: 'Will Maldonado', role: 'designer' },
      '5555550188': { name: 'James Bullock', role: 'owner' },
    });
    try {
      roster.resetRosterForTests();
      const book = roster.getRoster();
      assert.equal(book.personByPhone('5555550199').name, 'Will Maldonado');
      assert.equal(book.personByPhone('5555550188').name, 'James Bullock');
      assert.equal(book.personByPhone('5555550188').role, 'owner');
      assert.equal(book.personByExtension('00002').role, 'owner');
      assert.equal(book.peopleNamed('James Bullock').length, 1);
      assert.equal(book.personByName('James Bullock').extension, '00002');
    } finally {
      if (previous === undefined) delete process.env.TEAM_MEMBER_PHONES;
      else process.env.TEAM_MEMBER_PHONES = previous;
      roster.resetRosterForTests();
    }
  });
});
