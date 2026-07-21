// Archives call recordings to Joshua's personal Google Drive for indefinite long-term
// storage (separate from Fireflies, which only needs the recording briefly to produce a
// transcript). Uses a single pre-authorized OAuth2 refresh token rather than a service
// account, because the target is a folder on Joshua's own personal Drive, not a Shared
// Drive - service accounts have no personal storage quota of their own and can't own
// files there. The refresh token was obtained once via Google's OAuth 2.0 Playground on
// 2026-07-20, authorizing as simingtonjoshua@gmail.com with the minimal, non-sensitive
// `drive.file` scope (this app can only see/manage files it creates itself - it cannot
// browse or read the rest of Joshua's Drive).
//
// Env vars required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
// GOOGLE_DRIVE_FOLDER_ID (the destination folder, itself created by this same app/token
// so it's visible under the drive.file scope).

const fetch = require('node-fetch');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';

// Cached in-memory between calls so we don't refresh a new access token on every single
// recording upload - access tokens are valid for ~1 hour, refreshed a minute early here
// to leave margin for the upload itself.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60 * 1000) {
    return cachedToken.accessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh Google Drive access token (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

// Uploads a recording buffer into the configured Drive folder and returns its Drive
// file id + a webViewLink (opens in Drive's own player/preview in the browser). Files
// land with Drive's default sharing (private to the authorizing account, i.e. Joshua) -
// nothing here makes them public; he can share individual files further himself if
// ever needed.
async function uploadRecording(buffer, contentType, filename) {
  const accessToken = await getAccessToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const boundary = `goto_drive_upload_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = {
    name: filename,
    parents: folderId ? [folderId] : undefined,
  };

  const preamble =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const body = Buffer.concat([Buffer.from(preamble, 'utf8'), buffer, Buffer.from(closing, 'utf8')]);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to upload recording "${filename}" to Google Drive (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return { id: data.id, webViewLink: data.webViewLink };
}

module.exports = { uploadRecording };
