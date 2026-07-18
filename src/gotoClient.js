// Thin wrapper around the GoTo Connect APIs we need:
//   - Users API (/users/v1/me) to discover the account key
//   - Notification Channel API (create a webhook channel)
//   - Call Events API (subscribe to call state changes)
//   - Recording API (subscribe to recording-ready notifications, fetch recording bytes)
//
// Docs:
//   https://developer.goto.com/guides/GoToConnect/09_HOW_fetchAccountUsers/
//   https://developer.goto.com/guides/GoToConnect/14_HOW_useNotificationChannelApi/
//   https://developer.goto.com/guides/GoToConnect/15_HOW_useCallEventsApi/
//   https://community.goto.com/discussion/323514 (recording content endpoint)
//   https://developer.goto.com/GoToConnect/#tag/Recording (Recording Subscriptions schema)
//
// Verified live against the real API on 2026-07-18: /recording/v1/subscriptions takes
// a flat { accountKey, channelId, eventTypes } body (eventTypes: RECORDING_UPLOADED,
// RECORDING_TRANSCRIPT_UPLOADED) - not the { accountKeys: [...] } shape used by Call
// Events. Also, /admin/rest/v1/me requires an admin-scoped token and returns 401 for
// this PAT-derived token, so account key discovery uses /users/v1/me instead.

const fetch = require('node-fetch');
const { getAccessToken } = require('./auth');

const API_BASE = 'https://api.goto.com';
const ADMIN_BASE = 'https://api.getgo.com';

async function gotoFetch(url, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  return res;
}

async function getAccountKey() {
  // /admin/rest/v1/me requires an admin-scoped token and returned 401 not.authenticated
  // for the PAT-derived token this service uses. /users/v1/me works with the scopes
  // this OAuth client already has and returns one entry per account the user belongs to.
  const res = await gotoFetch(`${ADMIN_BASE}/users/v1/me`);
  if (!res.ok) {
    throw new Error(`Failed to fetch /users/v1/me (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) throw new Error('No accounts returned for this user/token');
  // Prefer the account that actually has phone numbers provisioned (the real phone
  // system account), falling back to the first entry if none do.
  const withPhones = items.find((i) => (i.outboundPhoneNumbers || []).length > 0);
  return (withPhones || items[0]).accountKey;
}

async function createWebhookChannel(webhookUrl, nickname = 'fireflies-pipeline') {
  const res = await gotoFetch(
    `${API_BASE}/notification-channel/v1/channels/${encodeURIComponent(nickname)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        channelType: 'Webhook',
        webhookChannelData: { webhook: { url: webhookUrl } },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to create notification channel (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.channelId;
}

async function subscribeCallEvents(channelId, accountKey, events = ['STARTING', 'ENDING']) {
  const res = await gotoFetch(`${API_BASE}/call-events/v1/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      channelId,
      accountKeys: [{ id: accountKey, events }],
    }),
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to subscribe to call events (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function subscribeRecordingEvents(channelId, accountKey) {
  const res = await gotoFetch(`${API_BASE}/recording/v1/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      accountKey,
      channelId,
      eventTypes: ['RECORDING_UPLOADED', 'RECORDING_TRANSCRIPT_UPLOADED'],
    }),
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to subscribe to recording events (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Downloads the raw recording audio bytes for a given recordingId.
//
// This is a two-step flow, confirmed live on 2026-07-18:
//   1. GET /recording/v1/recordings/{id}/content -> a short-lived content token
//      (JSON body: { token: { token, expires }, status }). This step requires the
//      normal OAuth Bearer token and only succeeds once the recording's status is
//      UPLOADED.
//   2. GET /recording/v1/recordings/{id}/content/{contentToken} -> the actual audio
//      bytes. The content token goes in the URL path, but the request must ALSO carry
//      the same Bearer access token - a plain unauthenticated request (e.g. a browser
//      just navigating to the URL) gets AUTHN_INVALID_TOKEN even with a fresh,
//      unexpired content token.
async function fetchRecordingContent(recordingId) {
  const tokenRes = await gotoFetch(`${API_BASE}/recording/v1/recordings/${recordingId}/content`);
  if (!tokenRes.ok) {
    throw new Error(
      `Failed to fetch content token for recording ${recordingId} (${tokenRes.status}): ${await tokenRes.text()}`
    );
  }
  const tokenBody = await tokenRes.json();
  const contentToken = tokenBody?.token?.token;
  if (!contentToken) {
    throw new Error(
      `No content token returned for recording ${recordingId} (status: ${tokenBody?.status}): ${JSON.stringify(tokenBody)}`
    );
  }

  const res = await gotoFetch(`${API_BASE}/recording/v1/recordings/${recordingId}/content/${contentToken}`);
  if (!res.ok) {
    throw new Error(`Failed to download recording ${recordingId} (${res.status}): ${await res.text()}`);
  }
  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const buffer = await res.buffer();
  return { buffer, contentType };
}

module.exports = {
  getAccountKey,
  createWebhookChannel,
  subscribeCallEvents,
  subscribeRecordingEvents,
  fetchRecordingContent,
};
