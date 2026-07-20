// Thin wrapper around the GoTo Connect APIs we need:
//   - Users API (/users/v1/me) to discover the account key
//   - Notification Channel API (create a webhook channel)
//   - Call Events API (subscribe to call state changes)
//   - Recording API (subscribe to recording-ready notifications, fetch recording bytes)
//   - Transcriptions API (fetch transcript content once the Advanced Reporting &
//     Analytics add-on has processed a recording)
//   - Call History Subscriptions (learn which legs belong to the same real interaction)
//   - Call Parking Subscriptions (real-time park/retrieve signal)
//
// Docs:
//   https://developer.goto.com/guides/GoToConnect/09_HOW_fetchAccountUsers/
//   https://developer.goto.com/guides/GoToConnect/14_HOW_useNotificationChannelApi/
//   https://developer.goto.com/guides/GoToConnect/15_HOW_useCallEventsApi/
//   https://community.goto.com/discussion/323514 (recording content endpoint)
//   https://developer.goto.com/GoToConnect/#tag/Recording (Recording Subscriptions schema)
//   https://developer.goto.com/GoToConnect/#tag/Transcriptions
//   https://developer.goto.com/GoToConnect/#tag/Call-History-Subscription
//   https://developer.goto.com/GoToConnect/#tag/Call-Parking-Subscriptions
//
// Verified live against the real API on 2026-07-18: /recording/v1/subscriptions takes
// a flat { accountKey, channelId, eventTypes } body (eventTypes: RECORDING_UPLOADED,
// RECORDING_TRANSCRIPT_UPLOADED) - not the { accountKeys: [...] } shape used by Call
// Events. Also, /admin/rest/v1/me requires an admin-scoped token and returns 401 for
// this PAT-derived token, so account key discovery uses /users/v1/me instead.
//
// The Advanced Reporting & Analytics add-on was enabled on this GoTo account on
// 2026-07-20, which is what makes RECORDING_TRANSCRIPT_UPLOADED notifications and the
// Transcriptions endpoint actually return data instead of empty/disabled responses.

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

// Looks up the channelId for a previously-created notification channel by its nickname.
// Used by the one-off /admin/register-new-subscriptions route (see server.js, added
// 2026-07-20) so we can attach the new Call History / Call Parking subscriptions to the
// SAME channel setup.js already created, without re-running the whole setup script -
// which would duplicate the call-events and recording subscriptions it also creates (see
// the "safe to re-run" caveat in setup.js). Render's free tier has no Shell access, so
// this HTTP-triggerable route is how the new subscriptions get registered post-deploy.
async function getChannelId(nickname) {
  const res = await gotoFetch(`${API_BASE}/notification-channel/v1/channels/${encodeURIComponent(nickname)}`);
  if (!res.ok) {
    throw new Error(`Failed to look up notification channel "${nickname}" (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.channelId;
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

// Call History Subscription - pushes a UcNEvent to our webhook whenever a call leg
// completes, carrying { originatorId, legId, caller, callee, direction, startTime,
// answerTime, duration, hangupCause, userKey, accountKey, ownerPhoneNumber }.
// `originatorId` groups every leg of the same real interaction (parks, transfers,
// holds) together - see src/interactions.js for how we use it.
//
// UNVERIFIED as of 2026-07-20: whether omitting `userKeys` subscribes to the whole
// account's history or just the calling principal's own - the docs describe the latter
// ("If no user key is specified, the currently logged-in user is used") but that may
// resolve differently for a service-integration token than for a human's own session.
// If interactions.js logs show Call History events only ever referencing one user's
// calls, this needs `userKeys` (or per-extension `extensions`) added explicitly.
async function subscribeCallHistoryEvents(channelId, accountKey) {
  const res = await gotoFetch(`${API_BASE}/call-history/v1/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({ accountKey, channelId }),
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to subscribe to call history events (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Call Parking Subscriptions - a real-time, explicit "this call was parked" / "this
// call was retrieved" signal, instead of inferring it from timing. Takes
// `organizationId` rather than `accountKey` - UNVERIFIED whether these are the same
// value for this account. Trying accountKey first; if this 400s, the error response
// should say so and we'll need to find the real organizationId (possibly via the Users
// or Accounts admin endpoints).
async function subscribeCallParkingEvents(channelId, organizationId) {
  const res = await gotoFetch(`${API_BASE}/call-parking/v1/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      organizationId,
      channelId,
      scopes: ['ORGANIZATION'],
    }),
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to subscribe to call parking events (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Fetches the channel-separated transcript content for a recording, once
// RECORDING_TRANSCRIPT_UPLOADED has fired for it. Per the documented schema, each result
// item has { type, transcript, final, startTimeMs, endTimeMs, channel, languageCode } -
// channel 0 is "what the participant said", channel 1 is "what the participant heard"
// (docs' wording; if the recording was mono, everything is channel 0). Which physical
// channel maps to the CSR vs. the customer is UNVERIFIED as of this writing - the first
// live transcript we pull should confirm this so buildConversationText() (wherever the
// summarization step ends up) can label speakers correctly.
//
// The endpoint is documented as returning a 302 redirect to the actual content.
// UNVERIFIED whether the redirect target needs the same Bearer token resent or not -
// this tries with auth first and falls back to no-auth, logging which branch worked.
async function fetchTranscript(recordingId) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/recording/v1/transcriptions/${recordingId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      throw new Error(`Transcript redirect for ${recordingId} had no Location header`);
    }

    const withAuth = await fetch(location, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (withAuth.ok) {
      console.log(`Fetched transcript content for ${recordingId} (redirect target accepted Bearer token).`);
      return withAuth.json();
    }

    const withoutAuth = await fetch(location, { headers: { Accept: 'application/json' } });
    if (withoutAuth.ok) {
      console.log(`Fetched transcript content for ${recordingId} (redirect target rejected Bearer token, worked without it).`);
      return withoutAuth.json();
    }

    throw new Error(
      `Failed to fetch transcript content for ${recordingId} (with auth: ${withAuth.status}, without auth: ${withoutAuth.status}): ${await withoutAuth.text()}`
    );
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch transcript for ${recordingId} (${res.status}): ${await res.text()}`);
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
  getChannelId,
  subscribeCallEvents,
  subscribeRecordingEvents,
  subscribeCallHistoryEvents,
  subscribeCallParkingEvents,
  fetchTranscript,
  fetchRecordingContent,
};
