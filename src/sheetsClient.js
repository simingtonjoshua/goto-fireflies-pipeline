// Reads and appends rows to a shared Google Sheet used as (1) a durable index of every
// finalized call and (2) a team feedback queue for the "@transcript" flagging feature
// (added 2026-07-30, per Joshua - see src/feedbackMonitor.js for how flags are
// detected). Reuses driveClient.js's existing OAuth access token rather than a second
// credential set - the token was authorized with the `drive.file` scope, which Google
// also honors for the separate Sheets API (sheets.googleapis.com) as long as the
// spreadsheet itself was created by this same app/token. getOrCreateFeedbackSheet
// below reuses that file by id.
//
// Two tabs live in one spreadsheet rather than two separate files, so there's only ever
// one thing to find in Drive:
// - "Calls": one row per finalized interaction (see src/interactions.js
//   finalizeInteraction) - phone, date, direction, team member(s), Drive folder link.
//   This is what lets feedbackMonitor.js match a flag note (which is attached to a
//   Heymarket CONTACT, not a specific call - see that file's header comment) back to
//   a specific call.
// - "Flags": one row per detected "@transcript" feedback note, written by
//   feedbackMonitor.js.
//
// FEEDBACK_SHEET_ID and INTENT_SHEET_ID pin the spreadsheets that already live in
// the shared drive (same ids as before the 2026-11-13 move). When either env var is
// unset, that default id is used directly: a failed name lookup must not create a
// new spreadsheet in My Drive. Set the env var to an empty string only to fall back
// to find-or-create by name under GOOGLE_DRIVE_FOLDER_ID. The other Google env vars
// are still GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN/
// GOOGLE_DRIVE_FOLDER_ID, exactly as driveClient.js already uses them.

const fetch = require('node-fetch');
const { getAccessToken, ALL_DRIVES_LIST_PARAMS, ALL_DRIVES_WRITE_PARAMS } = require('./driveClient');

const DEFAULT_FEEDBACK_SHEET_ID = '1Ik9Hyg1UK2_CP06aJcWeLU_2IsmyZCPOYyWS1ckf5qg';
const DEFAULT_INTENT_SHEET_ID = '1sNmgoaTApQt-bP5IDEUDZq4kKiJUO0N0sb50_boETHs';

let request = fetch;
let tokenProvider = getAccessToken;

function setSheetsTransportForTests(transport = {}) {
  request = transport.fetch || fetch;
  tokenProvider = transport.tokenProvider || getAccessToken;
}

function resetSheetsTransportForTests() {
  request = fetch;
  tokenProvider = getAccessToken;
  cachedSpreadsheetId = null;
  cachedIntentSpreadsheetId = null;
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SHEET_NAME = 'Call Feedback Log';
const INTENT_SHEET_NAME = 'Call Intent Master';
const INTENT_TAB = 'Calls';
const INTENT_HEADER = [
  'Date',
  'Caller ID',
  'Direction',
  'Team Member',
  'Call Type',
  'Intent',
  'Outcome',
  'Lead',
  'Transcript Link',
];

const CALLS_HEADER = ['Call ID', 'Date/Time (Pacific)', 'Direction', 'Phone', 'Team Member(s)', 'Folder Link'];
const FLAGS_HEADER = [
  'Detected At (Pacific)',
  'Note ID',
  'Phone',
  'Contact Name',
  'Note Author',
  'Note Date',
  'Urgent',
  'Flag Text',
  'Matched Call Date',
  'Matched Call Folder Link',
  'Other Recent Calls (context)',
  'Status',
];

// Cached in-memory per process (like driveClient's access token) - looked up once, then
// reused for the life of the dyno rather than searching Drive on every poll.
let cachedSpreadsheetId = null;
let cachedIntentSpreadsheetId = null;

function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// Appends one row to the given tab using the Sheets API's values.append, which always
// inserts after the last row with data - no need to track/compute the next empty row
// ourselves.
async function appendRow(spreadsheetId, sheetName, rowValues) {
  const accessToken = await tokenProvider();
  const range = encodeURIComponent(sheetName + '!A1');
  const res = await request(
    SHEETS_API_URL + '/' + spreadsheetId + '/values/' + range + ':append?valueInputOption=USER_ENTERED',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [rowValues] }),
    }
  );
  if (!res.ok) {
    throw new Error('Failed to append row to "' + sheetName + '" (' + res.status + '): ' + (await res.text()));
  }
  return res.json();
}

// Reads every data row (skipping the header row) from the given tab.
async function getSheetValues(spreadsheetId, sheetName) {
  const accessToken = await tokenProvider();
  const range = encodeURIComponent(sheetName + '!A2:Z');
  const res = await request(SHEETS_API_URL + '/' + spreadsheetId + '/values/' + range, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) {
    throw new Error('Failed to read "' + sheetName + '" values (' + res.status + '): ' + (await res.text()));
  }
  const data = await res.json();
  return data.values || [];
}

// An explicit empty FEEDBACK_SHEET_ID / INTENT_SHEET_ID disables the pin. Unset uses
// the production spreadsheet, so a lookup miss cannot create another file in My Drive.
function pinnedSheetId(envName, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, envName)) {
    const value = String(process.env[envName] ?? '').trim();
    return value || null;
  }
  return fallback;
}

async function readErrorDetail(res) {
  if (!res || typeof res.text !== 'function') return '';
  try {
    return await res.text();
  } catch (err) {
    return '';
  }
}

// Confirms a pinned spreadsheet is readable. A miss logs and throws; it never falls
// through to spreadsheets.create, which is what littered My Drive with stray copies
// after the folder moved onto the shared drive.
async function assertPinnedSheetReachable(spreadsheetId, title, accessToken) {
  const res = await request(
    SHEETS_API_URL + '/' + encodeURIComponent(spreadsheetId) + '?fields=spreadsheetId',
    { headers: { Authorization: 'Bearer ' + accessToken } },
  );
  if (res.ok) return;
  const detail = await readErrorDetail(res);
  console.error(
    'Pinned "' + title + '" spreadsheet ' + spreadsheetId + ' is unreachable ('
    + res.status + '): ' + detail + '. Refusing to create a stray spreadsheet.',
  );
  throw new Error('Pinned "' + title + '" spreadsheet ' + spreadsheetId + ' is unreachable (' + res.status + ')');
}

async function findSheetInFolder(parentId, name, accessToken) {
  const q = "'" + parentId + "' in parents and name = '" + name + "' and mimeType = '" + SHEET_MIME + "' and trashed = false";
  const listRes = await request(
    DRIVE_FILES_URL + '?q=' + encodeURIComponent(q) + '&fields=files(id)&' + ALL_DRIVES_LIST_PARAMS,
    { headers: { Authorization: 'Bearer ' + accessToken } },
  );
  if (!listRes.ok) {
    const detail = await readErrorDetail(listRes);
    console.error(
      '"' + name + '" lookup failed (' + listRes.status + '): ' + detail
      + '. Refusing to create a stray spreadsheet.',
    );
    throw new Error('"' + name + '" lookup failed (' + listRes.status + ')');
  }
  const listData = await listRes.json();
  if (listData.files && listData.files[0]) return listData.files[0].id;
  return null;
}

async function moveSheetIntoFolder(spreadsheetId, parentId, title, accessToken) {
  const moveRes = await request(
    DRIVE_FILES_URL + '/' + spreadsheetId + '?addParents=' + parentId + '&fields=id,parents&' + ALL_DRIVES_WRITE_PARAMS,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken },
    },
  );
  if (!moveRes.ok) {
    const detail = await readErrorDetail(moveRes);
    console.error('Warning: created "' + title + '" but failed to move it into the destination folder (' + moveRes.status + '): ' + detail);
  }
}

// Finds (or, only when FEEDBACK_SHEET_ID is explicitly empty, creates) the shared
// "Call Feedback Log" spreadsheet. The default pin is the sheet that already lives
// in the shared-drive folder, so interactions.js and feedbackMonitor.js cannot each
// create a duplicate when Drive's name search misses.
async function getOrCreateFeedbackSheet() {
  if (cachedSpreadsheetId) return cachedSpreadsheetId;
  const accessToken = await tokenProvider();
  const pinned = pinnedSheetId('FEEDBACK_SHEET_ID', DEFAULT_FEEDBACK_SHEET_ID);
  if (pinned) {
    await assertPinnedSheetReachable(pinned, SHEET_NAME, accessToken);
    cachedSpreadsheetId = pinned;
    return cachedSpreadsheetId;
  }

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const existingId = await findSheetInFolder(parentId, SHEET_NAME, accessToken);
  if (existingId) {
    cachedSpreadsheetId = existingId;
    return cachedSpreadsheetId;
  }

  // Create a blank spreadsheet with both tabs named up front via the Sheets API itself
  // (rather than Drive's generic file-create), since Sheets' create endpoint lets us
  // name every tab in the same request. Sheets' create endpoint doesn't accept a
  // `parents` field, so the new spreadsheet lands in "My Drive" root by default - a
  // second Drive API call below moves it into GOOGLE_DRIVE_FOLDER_ID alongside every
  // call's own per-call subfolder. This path runs only when the pin is turned off.
  const createRes = await request(SHEETS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: SHEET_NAME },
      sheets: [{ properties: { title: 'Calls' } }, { properties: { title: 'Flags' } }],
    }),
  });
  if (!createRes.ok) {
    throw new Error('Failed to create "' + SHEET_NAME + '" spreadsheet (' + createRes.status + '): ' + (await readErrorDetail(createRes)));
  }
  const created = await createRes.json();
  const spreadsheetId = created.spreadsheetId;

  await moveSheetIntoFolder(spreadsheetId, parentId, SHEET_NAME, accessToken);

  await appendRow(spreadsheetId, 'Calls', CALLS_HEADER);
  await appendRow(spreadsheetId, 'Flags', FLAGS_HEADER);

  cachedSpreadsheetId = spreadsheetId;
  return spreadsheetId;
}

// If a sheet with this title already exists but has no header row, write one.
// A different header is left in place and logged; rows are still appended.
async function ensureIntentHeader(spreadsheetId, accessToken) {
  const range = encodeURIComponent(INTENT_TAB + '!A1:I1');
  const res = await request(SHEETS_API_URL + '/' + spreadsheetId + '/values/' + range, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) return;
  const data = await res.json();
  const first = (data.values && data.values[0]) || [];
  if (!first.length) {
    await appendRow(spreadsheetId, INTENT_TAB, INTENT_HEADER);
    return;
  }
  const same = INTENT_HEADER.every((column, index) => first[index] === column);
  if (!same) {
    console.error(
      'Call Intent Master header does not match the expected columns. New rows are still appended. Expected: '
      + INTENT_HEADER.join(', '),
    );
  }
}

// Finds or creates the "Call Intent Master" spreadsheet. The default pin is the
// sheet already in the shared drive, used directly. Find-or-create by name runs
// only when INTENT_SHEET_ID is explicitly empty. The header row is written when
// this process creates the file, or when a reused file has an empty header.
async function getOrCreateIntentSheet() {
  if (cachedIntentSpreadsheetId) {
    return {
      id: cachedIntentSpreadsheetId,
      url: spreadsheetUrl(cachedIntentSpreadsheetId),
      created: false,
    };
  }
  const accessToken = await tokenProvider();
  const pinned = pinnedSheetId('INTENT_SHEET_ID', DEFAULT_INTENT_SHEET_ID);
  if (pinned) {
    await assertPinnedSheetReachable(pinned, INTENT_SHEET_NAME, accessToken);
    cachedIntentSpreadsheetId = pinned;
    await ensureIntentHeader(pinned, accessToken);
    return {
      id: pinned,
      url: spreadsheetUrl(pinned),
      created: false,
    };
  }

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const existingId = await findSheetInFolder(parentId, INTENT_SHEET_NAME, accessToken);
  if (existingId) {
    cachedIntentSpreadsheetId = existingId;
    await ensureIntentHeader(existingId, accessToken);
    return {
      id: existingId,
      url: spreadsheetUrl(existingId),
      created: false,
    };
  }

  const createRes = await request(SHEETS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: INTENT_SHEET_NAME },
      sheets: [{ properties: { title: INTENT_TAB } }],
    }),
  });
  if (!createRes.ok) {
    const detail = await readErrorDetail(createRes);
    throw new Error('Failed to create "' + INTENT_SHEET_NAME + '" spreadsheet (' + createRes.status + '): ' + detail);
  }
  const created = await createRes.json();
  const spreadsheetId = created.spreadsheetId;

  await moveSheetIntoFolder(spreadsheetId, parentId, INTENT_SHEET_NAME, accessToken);

  await appendRow(spreadsheetId, INTENT_TAB, INTENT_HEADER);
  cachedIntentSpreadsheetId = spreadsheetId;
  const url = spreadsheetUrl(spreadsheetId);
  console.log('Created Google Sheet "' + INTENT_SHEET_NAME + '": ' + url);
  return { id: spreadsheetId, url, created: true };
}

async function announceIntentSheet() {
  const sheet = await getOrCreateIntentSheet();
  console.log('Call Intent Master sheet: ' + sheet.url);
  return sheet;
}

// Appends one call. Never throws — a sheet problem must not block the Doc or note.
async function appendIntentCall(rowValues) {
  try {
    const sheet = await getOrCreateIntentSheet();
    await appendRow(sheet.id, INTENT_TAB, rowValues);
    return { ok: true, url: sheet.url, spreadsheetId: sheet.id };
  } catch (err) {
    console.error('Call Intent Master sheet update failed (Doc and HeyMarket note are unaffected): ' + err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getOrCreateFeedbackSheet,
  appendRow,
  getSheetValues,
  getOrCreateIntentSheet,
  announceIntentSheet,
  appendIntentCall,
  INTENT_SHEET_NAME,
  INTENT_TAB,
  INTENT_HEADER,
  DEFAULT_FEEDBACK_SHEET_ID,
  DEFAULT_INTENT_SHEET_ID,
  spreadsheetUrl,
  setSheetsTransportForTests,
  resetSheetsTransportForTests,
};
