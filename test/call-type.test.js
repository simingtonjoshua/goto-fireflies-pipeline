const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callParties = require('../src/callParties');
const callType = require('../src/callType');
const interactions = require('../src/interactions');
const openaiClient = require('../src/openaiClient');
const roster = require('../src/roster');

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);

const CUSTOMER = '5550101001';
const JAMES_CELL = '5550101444';
const JOSH_CELL = '5550101777';
const OFFICE = '5550101999';

function bookWithPhones() {
  const config = {
    people: ROSTER_CONFIG.people.map((person) => ({ ...person })),
  };
  const james = config.people.find((person) => person.extension === '00002');
  const josh = config.people.find((person) => person.extension === '00003');
  james.phones = [JAMES_CELL];
  josh.phones = [JOSH_CELL];
  return roster.createRoster(config, [OFFICE]);
}

function messages(extra) {
  return openaiClient.buildSummaryMessages({
    legRecords: [{
      direction: extra.direction || 'OUTBOUND',
      csrChain: [{ name: 'Joshua Simington', extension: '00003' }],
      transcript: extra.transcript,
    }],
    csrPath: ['Joshua Simington (00003)'],
    externalNumber: extra.externalNumber || CUSTOMER,
    externalName: extra.externalName,
    contactName: extra.contactName,
    otherParty: extra.otherParty,
    direction: extra.direction || 'OUTBOUND',
    callCreated: '2026-10-22T00:30:00.000Z',
    callEnded: '2026-10-22T00:36:00.000Z',
    answered: true,
  });
}

after(() => {
  interactions.resetForTests();
  roster.resetRosterForTests();
});

describe('team phones stay out of git and are learned at runtime', () => {
  it('does not commit phone numbers in the roster file', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8');
    assert.equal(raw.includes('"phones"'), false);
    assert.equal(/\d{10}/.test(raw), false);
  });

  it('remembers a direct number from a GoTo user record and ignores extensions and system numbers', () => {
    const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
    assert.equal(book.indexApiUser({
      userKey: 'user-james',
      lines: [{ number: '00002' }],
      phoneNumbers: [{ number: `+1${JAMES_CELL}` }, { number: OFFICE }],
    }), true);
    assert.equal(book.personByPhone(JAMES_CELL).name, 'James Bullock');
    assert.equal(book.personByPhone('00002'), null);
    assert.equal(book.personByPhone(OFFICE), null);
    assert.equal(book.personByExtension('2').name, 'James Bullock');
  });

  it('matches a roster full name, a middle initial, and Last, First', () => {
    const book = roster.createRoster(ROSTER_CONFIG);
    assert.equal(book.matchTeamName('JAMES BULLOCK').name, 'James Bullock');
    assert.equal(book.matchTeamName('James C Bullock').name, 'James Bullock');
    assert.equal(book.matchTeamName('Bullock, James').name, 'James Bullock');
    assert.equal(book.matchTeamName('James'), null);
    assert.equal(book.matchTeamName('WIRELESS CALLER'), null);
    assert.equal(book.matchTeamName('Amy Bullock').name, 'Amy Bullock');
  });
});

describe('call type classification', () => {
  it('keeps a customer call on the customer prompt', () => {
    roster.resetRosterForTests();
    const built = messages({
      direction: 'INBOUND',
      externalNumber: CUSTOMER,
      externalName: 'Jordan Hale',
      transcript: {
        results: [
          { transcript: 'I want Hunter Douglas shades for three windows.', channel: 0, startTimeMs: 0 },
          { transcript: 'This is Joshua with Budget Blinds. I can book a measure.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'customer');
    assert.equal(built.callTypeLabel, 'Customer');
    assert.match(built.system, /You summarize customer phone calls/);
    assert.match(built.user, /Customer phone number/);
    assert.match(built.user, /to the customer/);
    assert.match(built.user, /customer signs it and pays/i);
    assert.doesNotMatch(built.user, /Other party/);
    assert.doesNotMatch(built.system, /Decide the call type/);
  });

  it('classifies a known team phone as an internal call and does not use customer framing', () => {
    roster.setRosterForTests(bookWithPhones());
    const built = messages({
      externalNumber: JAMES_CELL,
      externalName: 'WIRELESS CALLER',
      transcript: {
        results: [
          { transcript: 'Hey, did you see the text about Lauren?', channel: 0, startTimeMs: 0 },
          { transcript: 'Yeah, I was confused about the invoice.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'internal');
    assert.equal(built.callTypeSource, 'phone');
    assert.equal(built.partyName, 'James Bullock');
    assert.match(built.system, /internal phone calls/i);
    assert.match(built.system, /do not say "the customer's needs"/i);
    assert.match(built.user, /James Bullock/);
    assert.match(built.user, /Fixed call type: Internal team/);
    assert.doesNotMatch(built.system, /You summarize customer phone calls/);
    assert.doesNotMatch(built.user, /Customer phone number/);
    assert.doesNotMatch(built.user, /to the customer/);
    roster.resetRosterForTests();
  });

  it('does not treat the credited team member\'s own phone as the other party', () => {
    roster.setRosterForTests(bookWithPhones());
    const built = messages({
      externalNumber: JOSH_CELL,
      transcript: {
        results: [
          { transcript: 'Hi, I need a shade repaired.', channel: 1, startTimeMs: 0 },
          { transcript: 'I can help with that.', channel: 0, startTimeMs: 1500 },
        ],
      },
    });
    assert.equal(built.callType, 'customer');
    roster.resetRosterForTests();
  });

  it('classifies an extension, a GoTo party name, and a Heymarket contact name as internal', () => {
    roster.resetRosterForTests();
    const byExtension = messages({ externalNumber: '00002', transcript: { results: [] } });
    assert.equal(byExtension.callType, 'internal');
    assert.equal(byExtension.partyName, 'James Bullock');
    assert.equal(byExtension.callTypeSource, 'extension');

    const byName = messages({
      externalName: 'James C Bullock',
      transcript: {
        results: [
          { transcript: 'Can you bring the paperwork home?', channel: 1, startTimeMs: 0 },
          { transcript: 'Yes.', channel: 0, startTimeMs: 1000 },
        ],
      },
    });
    assert.equal(byName.callType, 'internal');
    assert.equal(byName.callTypeSource, 'caller-id-name');

    const byContact = messages({
      contactName: 'James Bullock',
      externalName: 'WIRELESS CALLER',
      transcript: {
        results: [
          { transcript: 'Hello.', channel: 1, startTimeMs: 0 },
          { transcript: 'Hello.', channel: 0, startTimeMs: 1000 },
        ],
      },
    });
    assert.equal(byContact.callType, 'internal');
    assert.equal(byContact.callTypeSource, 'contact-name');
    assert.equal(callType.contactName({ display_name: '(555) 010-1444', first: 'James', last: 'Bullock' }), 'James Bullock');
    assert.equal(callType.contactName({ display_name: '5550101444' }), null);
  });

  it('reads the far-end teammate from GoTo call history without dropping the number', () => {
    const book = roster.createRoster(ROSTER_CONFIG, [OFFICE]);
    const analysis = callParties.analyzeCallHistory({
      direction: 'OUTBOUND',
      caller: { name: 'Joshua Simington', extensionNumber: '00003', number: OFFICE },
      callee: { name: 'James Bullock', number: JAMES_CELL },
      answerTime: '2026-10-22T00:30:05.000Z',
    }, book);
    assert.equal(analysis.teamMember.name, 'Joshua Simington');
    assert.equal(analysis.otherParty.name, 'James Bullock');
    assert.equal(analysis.otherParty.matchedBy, 'name');
    assert.equal(roster.last10(analysis.externalNumber), JAMES_CELL);

    const customer = callParties.analyzeCallHistory({
      direction: 'OUTBOUND',
      userKey: 'user-josh',
      caller: { name: 'Joshua Simington', number: JOSH_CELL },
      callee: { name: 'Jordan', number: CUSTOMER },
    }, book);
    assert.equal(customer.otherParty, null);
    assert.equal(roster.last10(customer.externalNumber), CUSTOMER);

    const extensionToExtension = callParties.analyzeCallHistory({
      direction: 'OUTBOUND',
      caller: { name: 'Joshua Simington', extensionNumber: '00003' },
      callee: { name: 'James Bullock', extensionNumber: '00002' },
    }, book);
    assert.equal(extensionToExtension.teamMember.name, 'Joshua Simington');
    assert.equal(extensionToExtension.otherParty.name, 'James Bullock');
    assert.equal(extensionToExtension.externalNumber, null);

    interactions.resetForTests();
    roster.setRosterForTests(book);
    interactions.recordLegState('conv-team-call', {
      legId: 'leg-team-call',
      lines: [{ extension: '00003', name: 'Joshua Simington', connected: true, isOriginator: true }],
      direction: 'OUTBOUND',
      directionSource: 'metadata',
      externalNumber: JAMES_CELL,
      callCreated: '2026-10-22T00:30:00.000Z',
    });
    interactions.recordCallHistoryEvent({
      content: {
        originatorId: 'orig-team-call',
        legId: 'leg-team-call',
        direction: 'OUTBOUND',
        caller: { name: 'Joshua Simington', extensionNumber: '00003', number: OFFICE },
        callee: { name: 'James Bullock', number: JAMES_CELL },
        answerTime: '2026-10-22T00:30:05.000Z',
      },
    });
    const leg = interactions.peekLeg('conv-team-call');
    assert.equal(leg.otherParty.name, 'James Bullock');
    assert.equal(roster.last10(leg.externalNumber), JAMES_CELL);
    assert.deepEqual(
      (leg.csrChain || []).map((entry) => entry.name),
      ['Joshua Simington'],
    );
    interactions.resetForTests();
    roster.resetRosterForTests();
  });

  it('classifies vendor menus and company introductions, and leaves product talk as a customer call', () => {
    roster.resetRosterForTests();
    const vendor = messages({
      transcript: {
        results: [
          { transcript: 'Calling Hunter Douglas.', channel: 0, startTimeMs: 0 },
          { transcript: 'This is Natalie from Clear Channel Outdoor.', channel: 1, startTimeMs: 3000 },
        ],
      },
    });
    assert.equal(vendor.callType, 'vendor');
    assert.equal(vendor.callTypeSource, 'transcript-company');
    assert.match(vendor.system, /vendor and supplier/i);
    assert.match(vendor.user, /Fixed call type: Vendor/);
    assert.match(vendor.user, /Clear Channel Outdoor/);
    assert.doesNotMatch(vendor.system, /You summarize customer phone calls/);
    assert.doesNotMatch(vendor.user, /Customer phone number/);

    const menu = messages({
      transcript: {
        results: [
          { transcript: 'You have reached Hunter Douglas support. This is a dedicated support line. Your estimated wait time is five minutes.', channel: 1, startTimeMs: 0 },
          { transcript: 'I am waiting on the order desk.', channel: 0, startTimeMs: 8000 },
        ],
      },
    });
    assert.equal(menu.callType, 'vendor');
    assert.equal(menu.callTypeSource, 'transcript-ivr');

    const ourGreeting = messages({
      direction: 'INBOUND',
      transcript: {
        results: [
          { transcript: 'Thank you for calling Budget Blinds.', channel: 1, startTimeMs: 0 },
          { transcript: 'I need shades measured.', channel: 0, startTimeMs: 4000 },
        ],
      },
    });
    assert.equal(ourGreeting.callType, 'customer');
  });

  it('keeps one outside mention of the customer as a customer call, and uses a roster full name', () => {
    roster.resetRosterForTests();
    const staff = messages({
      externalName: 'WIRELESS CALLER',
      transcript: {
        results: [
          { transcript: 'What did the customer say about the shade?', channel: 0, startTimeMs: 0 },
          { transcript: 'The customer did not like it, so I told her we would replace it.', channel: 1, startTimeMs: 2500 },
        ],
      },
    });
    assert.equal(staff.callType, 'customer');
    assert.match(staff.system, /You summarize customer phone calls/);

    const introduced = messages({
      transcript: {
        results: [
          { transcript: 'Hey, James Bullock, are you on the way?', channel: 0, startTimeMs: 0 },
          { transcript: 'This is James Bullock. I am heading to the install.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(introduced.callType, 'internal');
    assert.equal(introduced.partyName, 'James Bullock');
  });

  it('keeps purchase-order talk on the customer prompt', () => {
    roster.resetRosterForTests();
    const built = messages({
      transcript: {
        results: [
          { transcript: 'I am calling about the purchase order.', channel: 1, startTimeMs: 0 },
          { transcript: 'Which one?', channel: 0, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'customer');
    assert.equal(built.callTypeLabel, 'Customer');
    assert.match(built.system, /You summarize customer phone calls/);
    assert.doesNotMatch(built.system, /Decide the call type/);
    assert.match(built.user, /Customer phone number/);
    assert.doesNotMatch(built.user, /Call type: not yet determined/);
    assert.equal(callType.parseCallTypeLine('Call type: Vendor\n\nThe rep confirmed the backorder.'), 'vendor');
    assert.equal(callType.parseCallTypeLine('Call type: Other\n\nUnclear.'), 'other');
    assert.equal(callType.callTypeForNote('unknown', 'Call type: Other\n\nUnclear.'), 'customer');
    assert.equal(callType.callTypeForNote('unknown', 'Call type: unknown\n\nUnclear.'), 'customer');
    assert.equal(callType.callTypeForNote('customer', 'Call type: Other\n\nThe backorder on my shades.'), 'customer');
    const note = callType.formatCallNote({
      summary: callType.stripCallTypeLine('Call type: Other\n\nUnclear.'),
      callTypeLabel: callType.labelFor(callType.callTypeForNote('unknown', 'Call type: Other\n\nUnclear.')),
    });
    assert.equal(note, 'Unclear.');
    assert.doesNotMatch(note, /Call type/);
    assert.doesNotMatch(note, /Other/);
    assert.equal(
      callType.stripCallTypeLine('Call type: Internal team\n\nJames and Joshua compared the invoice.'),
      'James and Joshua compared the invoice.',
    );
  });

  it('writes an internal no-transcript sentence and keeps the customer sentence', () => {
    const internal = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: JAMES_CELL,
      direction: 'OUTBOUND',
      callCreated: '2026-10-22T00:30:00.000Z',
      answered: true,
      callType: 'internal',
      partyName: 'James Bullock',
    });
    assert.match(internal, /internal call to James Bullock/);
    assert.doesNotMatch(internal, /the customer/i);

    const customer = openaiClient.buildNoTranscriptSummary({
      csrPath: ['Joshua Simington (00003)'],
      externalNumber: CUSTOMER,
      direction: 'OUTBOUND',
      callCreated: '2026-10-22T00:30:00.000Z',
      answered: true,
    });
    assert.match(customer, /placed an outbound call to \(555\) 010-1001/);
    assert.doesNotMatch(customer, /internal call/);
  });

  it('keeps the call type line off the note and on the doc header', () => {
    const note = openaiClient.formatCallNote({
      summary: 'Joshua and James compared an invoice for a customer.',
      callTypeLabel: 'Internal team',
      folderLink: 'https://drive.google.com/drive/folders/example',
    });
    assert.equal(note, 'Joshua and James compared an invoice for a customer.\n\nCall recording & transcript: https://drive.google.com/drive/folders/example');
    assert.doesNotMatch(note, /Call type/);

    const html = interactions.buildTranscriptDocHtml({
      externalNumber: JAMES_CELL,
      direction: 'OUTBOUND',
      csrPath: ['Joshua Simington (00003)'],
      callCreated: '2026-10-22T00:30:00.000Z',
      callEnded: '2026-10-22T00:36:00.000Z',
      summaryText: 'Joshua and James compared an invoice.',
      legRecords: [],
      callTypeLabel: 'Internal team',
    });
    assert.match(html, /<b>Call type:<\/b> Internal team/);
    assert.match(html, /<h2>Summary<\/h2>/);
    assert.match(html, /Joshua and James compared an invoice\./);
  });

  it('classifies an outside caller as internal only with two coworker signals', () => {
    roster.resetRosterForTests();
    const built = messages({
      externalName: 'WIRELESS CALLER',
      transcript: {
        results: [
          { transcript: 'Where are you?', channel: 0, startTimeMs: 0 },
          { transcript: 'I am heading to the install. I will meet you at the measure.', channel: 1, startTimeMs: 2000 },
        ],
      },
    });
    assert.equal(built.callType, 'internal');
    assert.equal(built.callTypeSource, 'transcript-staff');
    assert.match(built.system, /internal phone calls/i);
  });
});

describe('ordinary customer phrasing stays a customer call', () => {
  const phrases = [
    "I'm calling from my cell",
    'I am here with my husband',
    "I'm John at 4521 Oak Street",
    'Hi this is Mary from Elk Grove',
    'Thank you for calling Budget Brinds of Sacramento',
    'the backorder on my shades',
    'the purchase order on my shades',
    'please check the order desk for my shades',
    'our customer wants shutters',
    'is somebody on the install tomorrow',
    'the homeowner is ready for the measure',
  ];

  for (const phrase of phrases) {
    it(`keeps the customer prompt for: ${phrase}`, () => {
      roster.resetRosterForTests();
      const built = messages({
        externalName: 'WIRELESS CALLER',
        transcript: {
          results: [
            { transcript: phrase, channel: 1, startTimeMs: 0 },
            { transcript: 'I can help with that.', channel: 0, startTimeMs: 2000 },
          ],
        },
      });
      assert.equal(built.callType, 'customer', phrase);
      assert.equal(built.callTypeLabel, 'Customer');
      assert.equal(built.callTypeSource, 'default');
      assert.match(built.system, /You summarize customer phone calls/);
      assert.doesNotMatch(built.system, /Decide the call type/);
      assert.match(built.user, /Customer phone number/);
      assert.match(built.user, /to the customer/);
      assert.doesNotMatch(built.user, /Fixed call type/);
      assert.doesNotMatch(built.user, /Call type: not yet determined/);
    });
  }

  it('does not call Heymarket or log when resolving a contact name', async () => {
    const http = require('http');
    const https = require('https');
    const saved = {
      id: process.env.HEYMARKET_API_SECRET_ID,
      key: process.env.HEYMARKET_API_SECRET_KEY,
    };
    const originalHttp = http.request;
    const originalHttps = https.request;
    const originalError = console.error;
    const errors = [];
    let requests = 0;
    process.env.HEYMARKET_API_SECRET_ID = 'test-secret-id';
    process.env.HEYMARKET_API_SECRET_KEY = 'test-secret-key';
    console.error = (...args) => {
      errors.push(args.map((part) => String(part)).join(' '));
    };
    http.request = function (...args) {
      requests += 1;
      return originalHttp.apply(this, args);
    };
    https.request = function (...args) {
      requests += 1;
      return originalHttps.apply(this, args);
    };
    try {
      assert.equal(await openaiClient.lookupContactName(CUSTOMER), null);
      assert.equal(requests, 0);
      assert.deepEqual(errors, []);
    } finally {
      http.request = originalHttp;
      https.request = originalHttps;
      console.error = originalError;
      if (saved.id === undefined) delete process.env.HEYMARKET_API_SECRET_ID;
      else process.env.HEYMARKET_API_SECRET_ID = saved.id;
      if (saved.key === undefined) delete process.env.HEYMARKET_API_SECRET_KEY;
      else process.env.HEYMARKET_API_SECRET_KEY = saved.key;
    }
  });
});
