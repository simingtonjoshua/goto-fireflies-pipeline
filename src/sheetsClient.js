// Reads and appends rows to a shared Google Sheet used as (1) a durable index of every
// finalized call and (2) a team feedback queue for the "@transcript" flagging feature
// (added 2026-07-30, per Joshua - see src/feedbackMonitor.js for how flags are
// detected). Reuses driveClient.js's existing OAuth access token rather than a second
// credential set - the token was authorized with the `drive.file` scope, which Google
// also honors for the separate Sheets API (sheets.googleapis.com) as long as the
// spreadsheet itself was created by this same app/token, which getOrCreateFeedbackSheet
// below always does.
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
// No new env vars - this reuses GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
// GOOGLE_REFRESH_TOKEN/GOOGLE_DRIVE_FOLDER_ID, exactly as driveClient.js already does.

const fetch = require('node-fetch');
const { getAccessToken } = require('./driveClient');

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SHEET_NAME = 'Call Feedback Log';

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

// Appends one row to the given tab using the Sheets API's values.append, which always
// inserts after the last row with data - no need to track/compute the next empty row
// ourselves.
async function appendRow(spreadsheetId, sheetName, rowValues) {
  const accessToken = await getAccessToken();
  const range = encodeURIComponent(sheetName + '!A1');
  const res = await fetch(
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
  const accessToken = await getAccessToken();
  const range = encodeURIComponent(sheetName + '!A2:Z');
  const res = await fetch(SHEETS_API_URL + '/' + spreadsheetId + '/values/' + range, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) {
    throw new Error('Failed to read "' + sheetName + '" values (' + res.status + '): ' + (await res.text()));
  }
  const data = await res.json();
  return data.values || [];
}

// Finds (or creates, with its two tabs + header rows) the shared "Call Feedback Log"
// spreadsheet under GOOGLE_DRIVE_FOLDER_ID - looked up by exact name the same way
// driveClient.getOrCreateCallFolder finds/creates per-call subfolders, so this is safe
// to call from multiple code paths (interactions.js and feedbackMonitor.js) without
// ever creating a duplicate.
async function getOrCreateFeedbackSheet() {
  if (cachedSpreadsheetId) return cachedSpreadsheetId;
  const accessToken = await getAccessToken();
  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const q = "'" + parentId + "' in parents and name = '" + SHEET_NAME + "' and mimeType = '" + SHEET_MIME + "' and trashed = false";
  const listRes = await fetch(DRIVE_FILES_URL + '?q=' + encodeURIComponent(q) + '&fields=files(id)', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (listRes.ok) {
    const listData = await listRes.json();
    if (listData.files && listData.files[0]) {
      cachedSpreadsheetId = listData.files[0].id;
      return cachedSpreadsheetId;
    }
  }

  // Create a blank spreadsheet with both tabs named up front via the Sheets API itself
  // (rather than Drive's generic file-create), since Sheets' create endpoint lets us
  // name every tab in the same request. Sheets' create endpoint doesn't accept a
  // `parents` field, so the new spreadsheet lands in "My Drive" root by default - a
  // second Drive API call below moves it into GOOGLE_DRIVE_FOLDER_ID alongside every
  // call's own per-call subfolder.
  const createRes = await fetch(SHEETS_API_URL, {
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
    throw new Error('Failed to create "' + SHEET_NAME + '" spreadsheet (' + createRes.status + '): ' + (await createRes.text()));
  }
  const created = await createRes.json();
  const spreadsheetId = created.spreadsheetId;

  const moveRes = await fetch(DRIVE_FILES_URL + '/' + spreadsheetId + '?addParents=' + parentId + '&fields=id,parents', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!moveRes.ok) {
    console.error('Warning: created "' + SHEET_NAME + '" but failed to move it into the destination folder (' + moveRes.status + '): ' + (await moveRes.text()));
  }

  await appendRow(spreadsheetId, 'Calls', CALLS_HEADER);
  await appendRow(spreadsheetId, 'Flags', FLAGS_HEADER);

  cachedSpreadsheetId = spreadsheetId;
  return spreadsheetId;
}

module.exports = { getOrCreateFeedbackSheet, appendRow, getSheetValues };
