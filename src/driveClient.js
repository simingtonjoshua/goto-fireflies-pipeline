// Archives call recordings AND transcript/summary Google Docs to Joshua's personal
// Google Drive for indefinite long-term storage. Uses a single pre-authorized OAuth2
// refresh token rather than a service account, because the target is a folder on
// Joshua's own personal Drive, not a Shared Drive - service accounts have no personal
// storage quota of their own and can't own files there. The refresh token was obtained
// via Google's OAuth 2.0 Playground on 2026-07-20/21, authorizing as
// jsimington@budgetblinds.com with the minimal, non-sensitive `drive.file` scope (this
// app can only see/manage files it creates itself - it cannot browse or read the rest
// of Joshua's Drive). The top-level destination folder is named "Call Recordings &
// Transcriptions" (renamed 2026-07-21 from "Call Recordings" now that transcripts live
// here too); Joshua can move it under "Budget Blinds Company File Center" (or anywhere
// else) in the Drive UI at any time without breaking this app's access, since
// drive.file grants are tied to the file's resource id, not its location in the folder
// hierarchy.
//
// As of 2026-07-21, each call gets its own subfolder (see buildCallFolderName /
// getOrCreateCallFolder below) containing both the audio recording and a transcript+
// summary Google Doc, so Heymarket only needs to link to ONE folder per call instead
// of two separate files (see src/interactions.js finalizeInteraction). Both files
// inside that subfolder are also named with the folder's own name as a prefix (see
// server.js archiveToDrive and interactions.js finalizeInteraction), so either file
// still carries its date/direction/phone context if it's ever viewed on its own.
//
// Env vars required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
// GOOGLE_DRIVE_FOLDER_ID (the destination top-level folder, itself created by this same
// app/token so it's visible under the drive.file scope).

const fetch = require('node-fetch');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

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

// Maps a recording's Content-Type to a sensible file extension for the Drive filename.
function extForContentType(contentType) {
        if (contentType.includes('wav')) return 'wav';
        if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
        if (contentType.includes('ogg')) return 'ogg';
        return 'mp3';
}

// Formats an ISO timestamp as "Jul 21, 2026 9:32 PM" in Pacific time, matching the
// franchise's local timezone regardless of where this Render instance's clock is set.
// Used for the human-readable "Call started"/"Call ended" lines in the transcript Doc.
function formatPacific(isoString) {
        const d = isoString ? new Date(isoString) : new Date();
        const date = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
        return `${date} ${time}`;
}

// Formats an ISO timestamp as "2026-07-21" (YYYY-MM-DD, Pacific time) - used for the
// per-call folder/file naming convention instead of formatPacific's "Jul 21, 2026" style
// (per Joshua, 2026-07-21: YYYY-MM-DD sorts correctly and scans faster in a file list).
function formatDateForFilename(isoString) {
        const d = isoString ? new Date(isoString) : new Date();
        // en-CA's locale date format is YYYY-MM-DD - a reliable built-in way to get this
  // without hand-rolling zero-padding.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// Formats a raw phone number (however GoTo/Heymarket happened to send it - with or
// without a leading "+1") as "(916) 390-8378" for filenames/folder names that are
// meant to be read by a person, not parsed by a machine.
function formatPhoneForDisplay(number) {
        const digits = (number || '').replace(/\D/g, '');
        const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (ten.length !== 10) return number || 'unknown number';
        return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// Builds the per-call subfolder name shared by both server.js (uploads the audio the
// moment RECORDING_UPLOADED fires) and interactions.js (creates the transcript+summary
// Doc once the interaction is finalized). Both call sites compute this from the same
// call metadata (callCreated, direction, externalNumber), so getOrCreateCallFolder()
// converges on the SAME subfolder regardless of which of the two runs first - the two
// uploads are independent async operations that can finish in either order (see the
// comment on recordRecordingLink in interactions.js).
function buildCallFolderName({ callCreated, direction, externalNumber }) {
        const date = formatDateForFilename(callCreated);
        const time = (callCreated ? new Date(callCreated) : new Date()).toLocaleTimeString('en-US', {
                  timeZone: 'America/Los_Angeles',
                  hour: 'numeric',
                  minute: '2-digit',
        });
        const dir = direction === 'OUTBOUND' ? 'Outbound' : direction === 'INBOUND' ? 'Inbound' : 'Call';
        const phone = formatPhoneForDisplay(externalNumber);
        return `${date} ${time} - ${dir} - ${phone}`;
}

// Finds a subfolder by exact name directly under `parentId`, creating it if it doesn't
// already exist yet. Idempotent by design (see buildCallFolderName above) so it's safe
// to call from both the recording-upload path and the transcript-doc path for the same
// call without creating two folders.
async function getOrCreateCallFolder(parentId, folderName) {
        const accessToken = await getAccessToken();
        const escapedName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const q = `'${parentId}' in parents and name = '${escapedName}' and mimeType = '${FOLDER_MIME}' and trashed = false`;

  const listRes = await fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)`, {
            headers: { Authorization: `Bearer ${accessToken}` },
  });
        if (listRes.ok) {
                  const listData = await listRes.json();
                  if (listData.files && listData.files[0]) return listData.files[0];
        }

  const createRes = await fetch(`${DRIVE_FILES_URL}?fields=id,webViewLink`, {
            method: 'POST',
            headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
        if (!createRes.ok) {
                  throw new Error(`Failed to create call folder "${folderName}" (${createRes.status}): ${await createRes.text()}`);
        }
        return createRes.json();
}

// Renames the top-level destination folder. One-off helper for the 2026-07-21 rename
// from "Call Recordings" to "Call Recordings & Transcriptions" - exposed via the
// /admin/rename-drive-folder route in server.js since Render's free tier has no Shell
// access to run a one-off script directly.
async function renameFolder(folderId, newName) {
        const accessToken = await getAccessToken();
        const res = await fetch(`${DRIVE_FILES_URL}/${folderId}?fields=id,name,webViewLink`, {
                  method: 'PATCH',
                  headers: {
                              Authorization: `Bearer ${accessToken}`,
                              'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) {
                  throw new Error(`Failed to rename folder ${folderId} to "${newName}" (${res.status}): ${await res.text()}`);
        }
        return res.json();
}

// Uploads a recording buffer into the given Drive folder (the per-call subfolder as of
// 2026-07-21 - see buildCallFolderName/getOrCreateCallFolder) and returns its Drive file
// id + a webViewLink. Files land with Drive's default sharing (private to the
// authorizing account, i.e. Joshua) - nothing here makes them public.
async function uploadRecording(buffer, contentType, filename, folderId) {
        const accessToken = await getAccessToken();
        const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  const boundary = `goto_drive_upload_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const metadata = {
                  name: filename,
                  parents: targetFolderId ? [targetFolderId] : undefined,
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

// Creates a Google Doc from HTML content inside the given folder, using Drive's
// on-the-fly import conversion (uploading a text/html source with a target mimeType of
// application/vnd.google-apps.document makes Drive convert it into a real, editable
// Google Doc rather than just storing raw HTML). This is how interactions.js's
// finalizeInteraction turns the assembled transcript + summary + metadata into a
// document that lives alongside the audio recording in the same per-call subfolder.
async function createTranscriptDoc(folderId, title, htmlContent) {
        const accessToken = await getAccessToken();

  const boundary = `goto_drive_doc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const metadata = {
                  name: title,
                  mimeType: DOC_MIME,
                  parents: folderId ? [folderId] : undefined,
        };

  const preamble =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
        const closing = `\r\n--${boundary}--`;

  const body = Buffer.concat([
            Buffer.from(preamble, 'utf8'),
            Buffer.from(htmlContent, 'utf8'),
            Buffer.from(closing, 'utf8'),
          ]);

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
            throw new Error(`Failed to create transcript Doc "${title}" (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
        return { id: data.id, webViewLink: data.webViewLink };
}

module.exports = {
        uploadRecording,
        extForContentType,
        buildCallFolderName,
        getOrCreateCallFolder,
        createTranscriptDoc,
        renameFolder,
        formatPacific,
        formatDateForFilename,
        formatPhoneForDisplay,
};
