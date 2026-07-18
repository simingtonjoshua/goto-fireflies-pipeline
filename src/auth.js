// Exchanges the long-lived GoTo Personal Access Token (PAT) for short-lived
// OAuth access tokens, caching in memory and refreshing before expiry.
// Docs: https://developer.goto.com/guides/Authentication/03.1_HOW_accessTokenPAT/

const fetch = require('node-fetch');

const TOKEN_URL = 'https://authentication.logmeininc.com/oauth/token';

let cached = { accessToken: null, expiresAt: 0 };

function basicAuthHeader() {
  const { GOTO_CLIENT_ID, GOTO_CLIENT_SECRET } = process.env;
  if (!GOTO_CLIENT_ID || !GOTO_CLIENT_SECRET) {
    throw new Error('GOTO_CLIENT_ID / GOTO_CLIENT_SECRET are not set');
  }
  return 'Basic ' + Buffer.from(`${GOTO_CLIENT_ID}:${GOTO_CLIENT_SECRET}`).toString('base64');
}

async function fetchNewToken() {
  const { GOTO_PAT } = process.env;
  if (!GOTO_PAT) throw new Error('GOTO_PAT is not set');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'personal_access_token',
      pat: GOTO_PAT,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GoTo token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return body; // { access_token, token_type, expires_in, scope, principal }
}

// Returns a valid access token, refreshing ~60s before it actually expires.
async function getAccessToken() {
  const now = Date.now();
  if (cached.accessToken && now < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }
  const body = await fetchNewToken();
  cached = {
    accessToken: body.access_token,
    expiresAt: now + (body.expires_in || 3600) * 1000,
  };
  return cached.accessToken;
}

module.exports = { getAccessToken };
