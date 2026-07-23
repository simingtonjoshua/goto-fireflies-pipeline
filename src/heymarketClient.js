// Posts finalized call summaries (see src/interactions.js + src/openaiClient.js) into
// Heymarket as a private internal note on the customer's conversation, using
// POST /v1/message/send with private: true - see
// https://developers.heymarket.com/guides/send-message.
//
// Authenticates with a short-lived JWT signed from a Heymarket API Secret ID + Secret
// Key (https://developers.heymarket.com/authentication), rather than the simpler
// long-lived team API key, because that's what was generated in Heymarket's
// Settings > Integrations > API on 2026-07-21. The JWT is HS256, signed with the
// Secret ID and Secret Key concatenated with "||" as the HMAC key, and is only valid
// for 5 minutes - regenerated fresh on every call rather than cached (unlike
// src/driveClient.js's Google token, which is worth caching since it lasts an hour).
//
// Env vars required: HEYMARKET_API_SECRET_ID, HEYMARKET_API_SECRET_KEY,
// HEYMARKET_INBOX_ID, HEYMARKET_CREATOR_ID (inbox_id/creator_id come from Heymarket's
// GET /v1/inboxes for the account this integration should post as).
//
// Author display name changed from "Call Summary Bot" to "Call Summary" (per Joshua,
// 2026-07-23), then split into "Inbound Call Summary" / "Outbound Call Summary" (per
// Joshua, same day) so the note itself shows call direction at a glance in Heymarket's
// UI without having to open it - see authorForDirection() and the new `direction`
// parameter on postPrivateNote() below.

const crypto = require('crypto');
const fetch = require('node-fetch');

const MESSAGE_SEND_URL = 'https://api.heymarket.com/v1/message/send';

function base64url(input) {
        return Buffer.from(input)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
}

function generateJwt() {
        const header = { alg: 'HS256', typ: 'JWT' };
        const payload = { iss: process.env.HEYMARKET_API_SECRET_ID, iat: Math.floor(Date.now() / 1000) };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
        const combinedSecret = `${process.env.HEYMARKET_API_SECRET_ID}||${process.env.HEYMARKET_API_SECRET_KEY}`;
        const signature = base64url(crypto.createHmac('sha256', combinedSecret).update(signingInput).digest());

  return `${signingInput}.${signature}`;
}

// Heymarket phone numbers are E.164 digits without the leading "+" (e.g.
// "16505551003"). GoTo's externalNumber sometimes includes a leading "+" and
// occasionally arrives without a country code for US numbers - both are normalized
// here.
function normalizePhoneNumber(phoneNumber) {
        const digits = (phoneNumber || '').replace(/[^\d]/g, '');
        if (digits.length === 10) return `1${digits}`;
        return digits;
}

// Author display name shown on the Heymarket note itself. OUTBOUND/INBOUND map to
// their own labels so the note's direction is visible without opening it; anything
// else (direction unknown/missing) falls back to the plain "Call Summary" rather than
// guessing.
function authorForDirection(direction) {
        if (direction === 'OUTBOUND') return 'Outbound Call Summary';
        if (direction === 'INBOUND') return 'Inbound Call Summary';
        return 'Call Summary';
}

// Posts `text` as a private comment (visible only to Heymarket team members, not the
// customer) on the conversation for `phoneNumber`. Per Heymarket's own "private
// message" example, a private send can target `phone_number` directly - no separate
// chat_id/conversation lookup needed.
async function postPrivateNote(phoneNumber, text, direction) {
        const digits = normalizePhoneNumber(phoneNumber);
        if (!digits) {
                  throw new Error(`Cannot post Heymarket note - no usable phone number (got "${phoneNumber}")`);
        }

  const res = await fetch(MESSAGE_SEND_URL, {
            method: 'POST',
            headers: {
                        Authorization: `Bearer ${generateJwt()}`,
                        'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                        inbox_id: Number(process.env.HEYMARKET_INBOX_ID),
                        creator_id: Number(process.env.HEYMARKET_CREATOR_ID),
                        phone_number: digits,
                        text,
                        private: true,
                        author: authorForDirection(direction),
            }),
  });

  if (!res.ok) {
            throw new Error(`Failed to post Heymarket private note (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

module.exports = { postPrivateNote };
