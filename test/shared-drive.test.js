const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const driveClient = require('../src/driveClient');
const sheetsClient = require('../src/sheetsClient');

const savedEnv = {
  folder: process.env.GOOGLE_DRIVE_FOLDER_ID,
  intentSheet: process.env.INTENT_SHEET_ID,
  feedbackSheet: process.env.FEEDBACK_SHEET_ID,
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function restoreEnv() {
  if (savedEnv.folder === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
  else process.env.GOOGLE_DRIVE_FOLDER_ID = savedEnv.folder;
  if (savedEnv.intentSheet === undefined) delete process.env.INTENT_SHEET_ID;
  else process.env.INTENT_SHEET_ID = savedEnv.intentSheet;
  if (savedEnv.feedbackSheet === undefined) delete process.env.FEEDBACK_SHEET_ID;
  else process.env.FEEDBACK_SHEET_ID = savedEnv.feedbackSheet;
}

after(() => {
  restoreEnv();
  driveClient.resetDriveTransportForTests();
  sheetsClient.resetSheetsTransportForTests();
});

describe('Drive shared-drive flags', () => {
  it('lists and creates call folders with shared-drive parameters', async () => {
    driveClient.resetDriveTransportForTests();
    const calls = [];
    driveClient.setDriveTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if ((options.method || 'GET') === 'GET') return jsonResponse(200, { files: [] });
        return jsonResponse(200, { id: 'folder-new', webViewLink: 'https://drive.google.com/drive/folders/folder-new' });
      },
    });

    const created = await driveClient.getOrCreateCallFolder('parent-1', "O'Brien call");
    assert.equal(created.id, 'folder-new');
    const list = calls.find((call) => call.method === 'GET');
    assert.match(list.url, /supportsAllDrives=true/);
    assert.match(list.url, /includeItemsFromAllDrives=true/);
    assert.match(list.url, /parent-1/);
    const create = calls.find((call) => call.method === 'POST');
    assert.match(create.url, /supportsAllDrives=true/);
    assert.doesNotMatch(create.url, /includeItemsFromAllDrives/);
  });

  it('reuses a call folder from a shared-drive list', async () => {
    driveClient.resetDriveTransportForTests();
    const calls = [];
    driveClient.setDriveTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        return jsonResponse(200, { files: [{ id: 'existing', webViewLink: 'https://drive.google.com/drive/folders/existing' }] });
      },
    });
    const folder = await driveClient.getOrCreateCallFolder('parent-1', '2026-11-13 7:38 PM - Inbound - (916) 555-0100');
    assert.equal(folder.id, 'existing');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /supportsAllDrives=true/);
    assert.match(calls[0].url, /includeItemsFromAllDrives=true/);
  });

  it('patches a folder rename with supportsAllDrives', async () => {
    driveClient.resetDriveTransportForTests();
    let patched = '';
    driveClient.setDriveTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        patched = String(url);
        assert.equal(options.method, 'PATCH');
        return jsonResponse(200, { id: 'folder-1', name: 'Call Recordings & Transcriptions' });
      },
    });
    await driveClient.renameFolder('folder-1', 'Call Recordings & Transcriptions');
    assert.match(patched, /\/folder-1\?/);
    assert.match(patched, /supportsAllDrives=true/);
    assert.doesNotMatch(patched, /includeItemsFromAllDrives/);
  });

  it('uploads recordings and transcript docs with supportsAllDrives', async () => {
    driveClient.resetDriveTransportForTests();
    const urls = [];
    driveClient.setDriveTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        urls.push(String(url));
        assert.equal(options.method, 'POST');
        return jsonResponse(200, { id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
      },
    });
    await driveClient.uploadRecording(Buffer.from('audio'), 'audio/mpeg', 'call.mp3', 'folder-1');
    await driveClient.createTranscriptDoc('folder-1', 'Call summary', '<p>hi</p>');
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.equal(url, driveClient.UPLOAD_URL);
      assert.match(url, /uploadType=multipart/);
      assert.match(url, /supportsAllDrives=true/);
      assert.doesNotMatch(url, /includeItemsFromAllDrives/);
    }
  });
});

describe('pinned spreadsheets', () => {
  it('uses the default Call Intent Master id and does not create a sheet', async () => {
    sheetsClient.resetSheetsTransportForTests();
    delete process.env.INTENT_SHEET_ID;
    const calls = [];
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (String(url).includes('?fields=spreadsheetId')) {
          assert.match(String(url), new RegExp(sheetsClient.DEFAULT_INTENT_SHEET_ID));
          return jsonResponse(200, { spreadsheetId: sheetsClient.DEFAULT_INTENT_SHEET_ID });
        }
        if (String(url).includes('/values/')) {
          return jsonResponse(200, { values: [sheetsClient.INTENT_HEADER] });
        }
        throw new Error(`unexpected ${options.method || 'GET'} ${url}`);
      },
    });
    const sheet = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(sheet.id, sheetsClient.DEFAULT_INTENT_SHEET_ID);
    assert.equal(sheet.created, false);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
    assert.equal(calls.some((call) => call.url.includes('/drive/v3/files')), false);
    const afterProbe = calls.length;
    const again = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(again.id, sheet.id);
    assert.equal(calls.length, afterProbe);
  });

  it('uses INTENT_SHEET_ID when set', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.INTENT_SHEET_ID = 'custom-intent';
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url) => {
        assert.match(String(url), /custom-intent/);
        if (String(url).includes('?fields=spreadsheetId')) return jsonResponse(200, { spreadsheetId: 'custom-intent' });
        if (String(url).includes('/values/')) return jsonResponse(200, { values: [sheetsClient.INTENT_HEADER] });
        throw new Error(`unexpected ${url}`);
      },
    });
    const sheet = await sheetsClient.getOrCreateIntentSheet();
    assert.equal(sheet.id, 'custom-intent');
    assert.equal(sheet.created, false);
  });

  it('logs and does not create a sheet when the pinned intent sheet is unreachable', async () => {
    sheetsClient.resetSheetsTransportForTests();
    delete process.env.INTENT_SHEET_ID;
    const calls = [];
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        return jsonResponse(404, { error: { message: 'File not found' } });
      },
    });
    try {
      await assert.rejects(
        () => sheetsClient.getOrCreateIntentSheet(),
        /Pinned "Call Intent Master" spreadsheet .* is unreachable \(404\)/,
      );
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /Refusing to create a stray spreadsheet/);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
    assert.equal(calls.some((call) => String(call.url).includes('/drive/v3/files')), false);
  });

  it('uses the default Call Feedback Log id and does not create a sheet', async () => {
    sheetsClient.resetSheetsTransportForTests();
    delete process.env.FEEDBACK_SHEET_ID;
    const calls = [];
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        assert.match(String(url), new RegExp(sheetsClient.DEFAULT_FEEDBACK_SHEET_ID));
        return jsonResponse(200, { spreadsheetId: sheetsClient.DEFAULT_FEEDBACK_SHEET_ID });
      },
    });
    const id = await sheetsClient.getOrCreateFeedbackSheet();
    assert.equal(id, sheetsClient.DEFAULT_FEEDBACK_SHEET_ID);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
    const again = await sheetsClient.getOrCreateFeedbackSheet();
    assert.equal(again, id);
    assert.equal(calls.length, 1);
  });

  it('uses FEEDBACK_SHEET_ID when set', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.FEEDBACK_SHEET_ID = 'custom-feedback';
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url) => {
        assert.match(String(url), /custom-feedback/);
        return jsonResponse(200, { spreadsheetId: 'custom-feedback' });
      },
    });
    const id = await sheetsClient.getOrCreateFeedbackSheet();
    assert.equal(id, 'custom-feedback');
  });

  it('logs and does not create a sheet when the pinned feedback sheet is unreachable', async () => {
    sheetsClient.resetSheetsTransportForTests();
    delete process.env.FEEDBACK_SHEET_ID;
    const calls = [];
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        return jsonResponse(403, 'forbidden');
      },
    });
    try {
      await assert.rejects(
        () => sheetsClient.getOrCreateFeedbackSheet(),
        /Pinned "Call Feedback Log" spreadsheet .* is unreachable \(403\)/,
      );
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /Refusing to create a stray spreadsheet/);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  });

  it('does not create a sheet when an unpinned lookup fails', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.INTENT_SHEET_ID = '   ';
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-1';
    const calls = [];
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        assert.match(String(url), /supportsAllDrives=true/);
        assert.match(String(url), /includeItemsFromAllDrives=true/);
        return jsonResponse(500, 'backend error');
      },
    });
    try {
      await assert.rejects(() => sheetsClient.getOrCreateIntentSheet(), /lookup failed \(500\)/);
    } finally {
      console.error = original;
    }
    assert.match(errors.join('\n'), /Refusing to create a stray spreadsheet/);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  });

  it('creates a feedback sheet only when the pin is empty and the shared-drive list is empty', async () => {
    sheetsClient.resetSheetsTransportForTests();
    process.env.FEEDBACK_SHEET_ID = '';
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-1';
    const calls = [];
    sheetsClient.setSheetsTransportForTests({
      tokenProvider: async () => 'token',
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (String(url).includes('/drive/v3/files?')) {
          assert.match(String(url), /supportsAllDrives=true/);
          assert.match(String(url), /includeItemsFromAllDrives=true/);
          assert.match(decodeURIComponent(String(url)), /Call Feedback Log/);
          return jsonResponse(200, { files: [] });
        }
        if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && options.method === 'POST') {
          return jsonResponse(200, { spreadsheetId: 'new-feedback' });
        }
        if (String(url).includes('/drive/v3/files/new-feedback') && options.method === 'PATCH') {
          assert.match(String(url), /addParents=folder-1/);
          assert.match(String(url), /supportsAllDrives=true/);
          assert.doesNotMatch(String(url), /includeItemsFromAllDrives/);
          return jsonResponse(200, { id: 'new-feedback' });
        }
        if (String(url).includes(':append')) return jsonResponse(200, {});
        throw new Error(`unexpected ${options.method || 'GET'} ${url}`);
      },
    });
    const id = await sheetsClient.getOrCreateFeedbackSheet();
    assert.equal(id, 'new-feedback');
    assert.equal(calls.filter((call) => call.method === 'POST' && call.url === 'https://sheets.googleapis.com/v4/spreadsheets').length, 1);
  });
});
