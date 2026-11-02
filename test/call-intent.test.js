const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const callIntent = require('../src/callIntent');
const callType = require('../src/callType');
const driveClient = require('../src/driveClient');
const interactions = require('../src/interactions');
const openaiClient = require('../src/openaiClient');
const pipedrive = require('../src/pipedriveClient');
const roster = require('../src/roster');
const sheetsClient = require('../src/sheetsClient');

const ROSTER_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'team-roster.json'), 'utf8'),
);
const JAMES_CELL = '5550101444';

const savedEnv = {
  pipedrive: process.env.PIPEDRIVE_API_TOKEN,
  folder: process.env.GOOGLE_DRIVE_FOLDER_ID,
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

after(() => {
  callIntent.setClassifierForTests(null);
  pipedrive.resetForTests();
  sheetsClient.resetSheetsTransportForTests();
  interactions.resetForTests();
  roster.resetRosterForTests();
  if (savedEnv.pipedrive === undefined) delete process.env.PIPEDRIVE_API_TOKEN;
  else process.env.PIPEDRIVE_API_TOKEN = savedEnv.pipedrive;
  if (savedEnv.folder === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
  else process.env.GOOGLE_DRIVE_FOLDER_ID = savedEnv.folder;
});

describe('intent list', () => {
  it('is the twelve intents and no others', () => {
    assert.deepEqual(callIntent.INTENTS, [
      'New project',
      'Existing quote follow-up',
      'Appointment scheduling for an existing job',
      'Order status',
      'Service or post-install support',
      'Billing or financing',
      'Product or general info',
      'Vendor or other business',
      'Internal team',
      'Spam or solicitation',
      'Wrong number',
      'No conversation or no transcript',
    ]);
    const prompt = callIntent.classifierSystemPrompt();
    for (const intent of callIntent.INTENTS) {
      assert.equal(prompt.includes(intent), true, intent);
    }
    assert.equal(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(prompt), false);
  });

  it('maps close labels onto the fixed list and drops anything else', () => {
    assert.equal(callIntent.canonicalizeIntent('Spam / solicitation'), 'Spam or solicitation');
    assert.equal(callIntent.canonicalizeIntent('new project'), 'New project');
    assert.equal(
      callIntent.canonicalizeIntent('Appointment scheduling (existing job)'),
      'Appointment scheduling for an existing job',
    );
    assert.equal(callIntent.canonicalizeIntent('Lead source'), null);
  });
});

describe('lead rules', () => {
  const cases = [
    ['inbound new project', { model: { intent: 'New project', outcome: 'callback promised' } }, 'Yes'],
    ['inbound new project voicemail', {
      model: { intent: 'New project', outcome: 'voicemail left' },
      direction: 'INBOUND',
    }, 'Yes'],
    ['quote follow-up', { model: { intent: 'Existing quote follow-up', outcome: 'info given' } }, 'No'],
    ['appointment', { model: { intent: 'Appointment scheduling for an existing job', outcome: 'booked/rescheduled appointment' } }, 'No'],
    ['service', { model: { intent: 'Service or post-install support', outcome: 'resolved' } }, 'No'],
    ['billing', { model: { intent: 'Billing or financing', outcome: 'info given' } }, 'No'],
    ['order status', { model: { intent: 'Order status', outcome: 'voicemail left' } }, 'No'],
    ['spam becomes other', { model: { intent: 'Spam or solicitation', outcome: 'abandoned' } }, 'No'],
    ['wrong number becomes other', { model: { intent: 'Wrong number', outcome: 'resolved' } }, 'No'],
    ['internal intent', { model: { intent: 'Internal team', outcome: 'resolved' } }, 'No'],
    ['vendor intent', { model: { intent: 'Vendor or other business', outcome: 'info given' } }, 'No'],
    ['outbound new project voicemail', {
      model: { intent: 'New project', outcome: 'voicemail left' },
      direction: 'OUTBOUND',
    }, 'No'],
    ['outbound booked consult without a deal', {
      model: { intent: 'New project', outcome: 'booked consultation', bookedConsultation: true },
      direction: 'OUTBOUND',
    }, 'No'],
    ['outbound booked consult with a deal', {
      model: { intent: 'New project', outcome: 'booked consultation', bookedConsultation: true },
      direction: 'OUTBOUND',
      pipedriveDeal: '42 — Greg consult',
    }, 'Yes'],
    ['outbound quote follow-up with a deal', {
      model: { intent: 'Existing quote follow-up', outcome: 'info given' },
      direction: 'OUTBOUND',
      pipedriveDeal: '42 — Greg consult',
    }, 'No'],
    ['routed new project is not our lead', {
      model: { intent: 'New project', outcome: 'transferred', routedAway: true },
    }, 'No'],
    ['inbound no transcript is unknown', {
      model: { intent: 'New project', outcome: 'booked consultation' },
      hasTranscript: false,
      direction: 'INBOUND',
      answered: false,
    }, 'Unknown'],
    ['outbound no transcript is no', {
      model: { intent: 'New project' },
      hasTranscript: false,
      direction: 'OUTBOUND',
      answered: false,
    }, 'No'],
    ['internal no transcript stays internal and is not a lead', {
      model: { intent: 'New project' },
      hasTranscript: false,
      direction: 'INBOUND',
      callType: 'internal',
    }, 'No'],
  ];

  for (const [name, input, lead] of cases) {
    it(name, () => {
      const result = callIntent.finalizeTags({
        summary: 'Noted.',
        direction: 'INBOUND',
        callType: 'customer',
        hasTranscript: true,
        ...input,
        model: {
          outcome: 'info given',
          routedAway: false,
          bookedConsultation: false,
          ...(input.model || {}),
        },
      });
      assert.equal(result.lead, lead, name);
      if (name.startsWith('spam') || name.startsWith('wrong') || name.startsWith('inbound no transcript') || name.startsWith('outbound no transcript')) {
        assert.equal(result.callType, 'other');
        assert.equal(result.callTypeLabel, 'Other');
      }
      if (name.startsWith('internal no transcript')) {
        assert.equal(result.callType, 'internal');
        assert.equal(result.intent, callIntent.NO_CONVERSATION);
      }
      if (name.startsWith('routed')) {
        assert.match(result.outcome, /routed away to another franchisee/);
        assert.equal(result.intent, 'New project');
      }
      if (name.startsWith('inbound no transcript')) {
        assert.equal(result.intent, callIntent.NO_CONVERSATION);
        assert.equal(result.outcome, 'abandoned');
      }
      if (name.startsWith('outbound no transcript')) {
        assert.equal(result.outcome, 'no answer');
      }
    });
  }

  it('does not treat our Sacramento office or a customer zip code as routed away', () => {
    assert.equal(callIntent.textShowsRoutedAway("It's a great day at Budget Blinds of Sacramento"), false);
    assert.equal(callIntent.textShowsRoutedAway('my zip code is 95831'), false);
    assert.equal(callIntent.textShowsRoutedAway('Budget Blinds of Folsom covers that zip'), true);
    assert.equal(callIntent.textShowsRoutedAway('transfer this to the Schab team'), true);
    assert.equal(callIntent.textShowsRoutedAway('you have reached the wrong franchise'), true);
  });
});

describe('headers', () => {
  const fields = {
    externalNumber: '9164346929',
    externalName: 'Sandra H.',
    direction: 'INBOUND',
    csrPath: ['Jessica'],
    callTypeLabel: 'Customer',
    partyName: null,
    callCreated: '2026-10-26T18:56:00.000Z',
    callEnded: '2026-10-26T19:08:00.000Z',
    intent: 'New project',
    outcome: 'callback promised',
    lead: 'Yes',
    pipedriveDeal: '15 — A & B',
  };

  it('uses the same lines on the doc and the Heymarket note', () => {
    const rows = callIntent.headerRows(fields);
    assert.deepEqual(rows.map((row) => row[0]), [
      'Phone number',
      'Caller ID',
      'Direction',
      'Team Member(s)',
      'Call type',
      'Call started',
      'Call ended',
      'Intent',
      'Outcome',
      'Lead',
      'Pipedrive deal',
    ]);
    const note = callType.formatCallNote({
      summary: 'Intent: New project\n\nSandra called about two windows.',
      folderLink: 'https://drive.google.com/drive/folders/abc',
      headerLines: rows,
    });
    const header = rows.map(([label, value]) => `${label}: ${value}`).join('\n');
    assert.equal(
      note,
      `${header}\n\nSummary\nSandra called about two windows.\n\nCall recording & transcript: https://drive.google.com/drive/folders/abc`,
    );
    assert.match(note, /Phone number: \(916\) 434-6929/);
    assert.match(note, /Intent: New project/);
    assert.match(note, /Lead: Yes/);
    assert.match(note, /Pipedrive deal: 15 — A & B/);
    assert.doesNotMatch(note, /Lead Source/);

    const html = interactions.buildTranscriptDocHtml({
      ...fields,
      summaryText: 'Sandra called about two windows.',
      legRecords: [],
    });
    assert.match(html, /<b>Phone number:<\/b> \(916\) 434-6929/);
    assert.match(html, /<b>Caller ID:<\/b> Sandra H\./);
    assert.match(html, /<b>Direction:<\/b> INBOUND/);
    assert.match(html, /<b>Team Member\(s\):<\/b> Jessica/);
    assert.match(html, /<b>Call type:<\/b> Customer/);
    assert.match(html, /<b>Intent:<\/b> New project/);
    assert.match(html, /<b>Outcome:<\/b> callback promised/);
    assert.match(html, /<b>Lead:<\/b> Yes/);
    assert.match(html, /<b>Pipedrive deal:<\/b> 15 — A &amp; B/);
    assert.match(html, /<h2>Summary<\/h2>/);
    assert.match(html, /Sandra called about two windows\./);
    assert.doesNotMatch(html, /Lead Source/);
  });

  it('omits Caller ID on outbound calls and omits Pipedrive when there is no deal', () => {
    const rows = callIntent.headerRows({
      ...fields,
      direction: 'OUTBOUND',
      externalName: 'Budget Blinds',
      pipedriveDeal: null,
    });
    assert.equal(rows.some((row) => row[0] === 'Caller ID'), false);
    assert.equal(rows.some((row) => row[0] === 'Pipedrive deal'), false);
    assert.equal(rows.some((row) => row[0] === 'Intent'), true);
  });
});

describe('intent sheet row', () => {
  it('uses the exact columns and the doc link', () => {
    assert.deepEqual(callIntent.INTENT_COLUMNS, [
      'Date',
      'Caller ID',
      'Direction',
      'Team Member',
      'Call Type',
      'Intent',
      'Outcome',
      'Lead',
      'Transcript Link',
    ]);
    assert.equal(callIntent.INTENT_COLUMNS.includes('Lead Source'), false);
    const created = '2026-10-26T18:56:00.000Z';
    const row = callIntent.intentSheetRow({
      callCreated: created,
      externalNumber: '9164346929',
      direction: 'INBOUND',
      csrPath: ['Jessica'],
      callTypeLabel: 'Customer',
      intent: 'New project',
      outcome: 'callback promised',
      lead: 'Yes',
      transcriptLink: 'https://docs.google.com/document/d/abc/edit',
    });
    assert.equal(row.length, 9);
    assert.equal(row[0], driveClient.formatPacific(created));
    assert.equal(row[1], '(916) 434-6929');
    assert.equal(row[2], 'INBOUND');
    assert.equal(row[3], 'Jessica');
    assert.equal(row[4], 'Customer');
    assert.equal(row[5], 'New project');
    assert.equal(row[6], 'callback promised');
    assert.equal(row[7], 'Yes');
    assert.equal(row[8], 'https://docs.google.com/document/d/abc/edit');
  });
});

describe('classification without changing the summary call', () => {
  it('does not call the model when there is no transcript', async () => {
    let called = false;
    callIntent.setClassifierForTests(() => {
      called = true;
      return {};
    });
    const inbound = await openaiClient.summarizeInteraction({
      legRecords: [{ direction: 'INBOUND', transcript: null, csrChain: [] }],
      csrPath: ['Emily Kingdon'],
      externalNumber: '9164346929',
      direction: 'INBOUND',
      callCreated: '2026-10-26T18:56:00.000Z',
      callEnded: '2026-10-26T18:57:00.000Z',
      answered: false,
    });
    assert.equal(called, false);
    assert.equal(inbound.intent, 'No conversation or no transcript');
    assert.equal(inbound.lead, 'Unknown');
    assert.equal(inbound.callType, 'other');
    assert.match(inbound.summary, /No transcript was available/);

    const outbound = await openaiClient.summarizeInteraction({
      legRecords: [{ direction: 'OUTBOUND', transcript: null, csrChain: [{ name: 'Joshua Simington' }] }],
      csrPath: ['Joshua Simington'],
      externalNumber: '9167177099',
      direction: 'OUTBOUND',
      callCreated: '2026-10-27T17:37:00.000Z',
      callEnded: '2026-10-27T17:38:00.000Z',
      answered: false,
    });
    assert.equal(outbound.lead, 'No');
    assert.equal(outbound.outcome, 'no answer');
    assert.equal(outbound.callType, 'other');
  });

  it('keeps a known teammate internal when the transcript is empty', async () => {
    const config = { people: ROSTER_CONFIG.people.map((person) => ({ ...person })) };
    const james = config.people.find((person) => person.extension === '00002');
    james.phones = [JAMES_CELL];
    roster.setRosterForTests(roster.createRoster(config, []));
    const result = await openaiClient.summarizeInteraction({
      legRecords: [{ direction: 'INBOUND', transcript: null, csrChain: [] }],
      csrPath: ['Joshua Simington'],
      externalNumber: JAMES_CELL,
      direction: 'INBOUND',
      callCreated: '2026-10-26T18:56:00.000Z',
      callEnded: '2026-10-26T18:57:00.000Z',
      answered: false,
    });
    assert.equal(result.callType, 'internal');
    assert.equal(result.intent, 'No conversation or no transcript');
    assert.equal(result.lead, 'No');
    roster.resetRosterForTests();
  });

  it('canonicalizes the model and falls back when classification fails', async () => {
    callIntent.setClassifierForTests(async () => ({
      intent: 'Spam / solicitation',
      outcome: 'abandoned',
      routedAway: false,
      bookedConsultation: false,
    }));
    const spam = await callIntent.interpret({
      conversationText: 'This is a recorded sales pitch.',
      direction: 'INBOUND',
      callType: 'customer',
    });
    assert.equal(spam.intent, 'Spam or solicitation');
    assert.equal(spam.source, 'model');

    callIntent.setClassifierForTests(async () => {
      throw new Error('classifier down');
    });
    const fallback = await callIntent.interpret({
      conversationText: 'I need shades for three windows.',
      direction: 'INBOUND',
      callType: 'customer',
    });
    assert.equal(fallback.source, 'fallback');
    assert.equal(fallback.intent, 'Product or general info');
    assert.equal(fallback.outcome, 'unknown');

    callIntent.setClassifierForTests(async () => ({
      intent: 'New project',
      outcome: 'transferred',
      routedAway: false,
      bookedConsultation: false,
    }));
    const routed = await callIntent.interpret({
      conversationText: 'You have reached the wrong franchise. I will send you to the Schab team.',
      direction: 'INBOUND',
      callType: 'customer',
    });
    assert.equal(routed.routedAway, true);
  });
});

describe('Pipedrive phone lookup', () => {
  it('returns no deals and does not call the API when the token is unset', async () => {
    delete process.env.PIPEDRIVE_API_TOKEN;
    let called = 0;
    pipedrive.setFetchForTests(async () => {
      called += 1;
      return jsonResponse(500, 'nope');
    });
    assert.deepEqual(await pipedrive.findDealsByPhone('(916) 555-0100'), []);
    assert.equal(called, 0);
  });

  it('keeps the phone match, prefers open deals, and leaves the token out of the URL', async () => {
    process.env.PIPEDRIVE_API_TOKEN = 'secret-token';
    const calls = [];
    pipedrive.setFetchForTests(async (url) => {
      calls.push(url);
      assert.equal(url.includes('secret-token'), false);
      if (url.includes('/persons/search')) {
        return jsonResponse(200, {
          data: {
            items: [
              { item: { id: 9, phones: ['+1 (916) 555-0100'] } },
              { item: { id: 8, phones: ['+1 (415) 555-0199'] } },
            ],
          },
        });
      }
      if (url.includes('/persons/9/deals')) {
        return jsonResponse(200, {
          data: [
            { id: 3, title: 'Old won', status: 'won', update_time: '2026-10-01T00:00:00Z' },
            { id: 7, title: 'Kitchen shades', status: 'open', update_time: '2026-10-20T00:00:00Z' },
            { id: 8, title: 'Older open', status: 'open', update_time: '2026-09-01T00:00:00Z' },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const deals = await pipedrive.findDealsByPhone('(916) 555-0100');
    assert.deepEqual(deals.map((deal) => deal.id), [7, 8, 3]);
    assert.equal(callIntent.formatDealRefs(deals), '7 — Kitchen shades; 8 — Older open; 3 — Old won');
    assert.equal(calls.length, 2);
  });

  it('degrades to no deal when Pipedrive errors', async () => {
    process.env.PIPEDRIVE_API_TOKEN = 'secret-token';
    pipedrive.setFetchForTests(async () => {
      throw new Error('timeout');
    });
    assert.deepEqual(await pipedrive.findDealsByPhone('9165550100'), []);
  });

  it('marks an outbound booked consultation Yes only when a deal matches', async () => {
    delete process.env.PIPEDRIVE_API_TOKEN;
    const without = await callIntent.applyPipedrive({
      summary: 'Joshua booked the consult.',
      intent: 'New project',
      outcome: 'booked consultation',
      routedAway: false,
      bookedConsultation: true,
      callType: 'customer',
      hasTranscript: true,
    }, { externalNumber: '9167177099', direction: 'OUTBOUND' });
    assert.equal(without.lead, 'No');
    assert.equal(without.pipedriveDeal, null);

    process.env.PIPEDRIVE_API_TOKEN = 'secret-token';
    pipedrive.setFetchForTests(async (url) => {
      if (url.includes('/persons/search')) {
        return jsonResponse(200, {
          data: { items: [{ item: { id: 1, phones: ['9167177099'] } }] },
        });
      }
      return jsonResponse(200, {
        data: [{ id: 42, title: 'Greg consult', status: 'open', update_time: '2026-10-27T00:00:00Z' }],
      });
    });
    const booked = await callIntent.applyPipedrive({
      summary: 'Joshua booked the consult.',
      intent: 'New project',
      outcome: 'booked consultation',
      routedAway: false,
      bookedConsultation: true,
      callType: 'customer',
      hasTranscript: true,
    }, { externalNumber: '9167177099', direction: 'OUTBOUND' });
    assert.equal(booked.lead, 'Yes');
    assert.equal(booked.pipedriveDeal, '42 — Greg consult');

    const quote = await callIntent.applyPipedrive({
      summary: 'Called about the open estimate.',
      intent: 'Existing quote follow-up',
      outcome: 'info given',
      routedAway: false,
      bookedConsultation: false,
      callType: 'customer',
      hasTranscript: true,
    }, { externalNumber: '9167177099', direction: 'INBOUND' });
    assert.equal(quote.lead, 'No');
    assert.equal(quote.pipedriveDeal, '42 — Greg consult');
  });
});

describe('Call Intent Master sheet', () => {
  it('creates the sheet in the Drive folder and reuses it', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-1';
    const calls = [];
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET', body: options.body });
        if (String(url).includes('/drive/v3/files?')) return jsonResponse(200, { files: [] });
        if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && options.method === 'POST') {
          const body = JSON.parse(options.body);
          assert.equal(body.properties.title, 'Call Intent Master');
          assert.equal(body.sheets[0].properties.title, 'Calls');
          return jsonResponse(200, { spreadsheetId: 'sheet123' });
        }
        if (String(url).includes('/drive/v3/files/sheet123') && options.method === 'PATCH') {
          assert.match(String(url), /addParents=folder-1/);
          return jsonResponse(200, { id: 'sheet123' });
        }
        if (String(url).includes(':append')) {
          assert.deepEqual(JSON.parse(options.body).values[0], sheetsClient.INTENT_HEADER);
          return jsonResponse(200, {});
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    const created = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(created.url, 'https://docs.google.com/spreadsheets/d/sheet123/edit');
    assert.equal(created.created, true);
    const afterCreate = calls.length;
    const again = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(again.created, false);
    assert.equal(again.url, created.url);
    assert.equal(calls.length, afterCreate);
  });

  it('does not create a second file when the sheet already exists', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-1';
    const calls = [];
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET' });
        if (String(url).includes('/drive/v3/files?')) return jsonResponse(200, { files: [{ id: 'abc' }] });
        if (String(url).includes('/values/')) return jsonResponse(200, { values: [sheetsClient.INTENT_HEADER] });
        throw new Error(`unexpected ${options.method || 'GET'} ${url}`);
      },
    });
    const sheet = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(sheet.id, 'abc');
    assert.equal(sheet.created, false);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  });

  it('swallows sheet failures', async () => {
    sheetsClient.resetSheetsTransportForTests();
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => {
        throw new Error('no google');
      },
      fetch: async () => {
        throw new Error('should not fetch');
      },
    });
    const result = await sheetsClient.appendIntentCall(['x']);
    assert.equal(result.ok, false);
    assert.match(result.error, /no google/);
  });
});
