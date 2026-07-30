// Polls Heymarket CONTACT NOTES for team feedback on posted call summaries (added
// 2026-07-30, per Joshua). Two deliberate design choices, both driven by real
// constraints on this Heymarket account:
//
// 1) Contact Notes, not a reply in the conversation thread. Team members write
//    "@transcript" (plus the actual feedback) directly in a customer's Contact Notes
//    in the Heymarket app, rather than replying in the conversation itself - this keeps
//    the customer-facing conversation thread clean instead of cluttering it with
//    internal review comments.
// 2) Polling, not a webhook. Heymarket only supports ONE webhook URL per team, and this
//    account's is already committed to something else - so this can't add a second
//    subscription. Heymarket also has no webhook event for contact-note changes at all
//    (confirmed against their event type list: message_sent, message_recieved,
//    chat_reassigned, chat_closed, chat_opened, chat_pending, chat_transferred,
//    target_opt_out/opt_in, incoming_call - no note event). Instead, pollFeedback()
//    below is called on an interval from server.js and just re-checks contact notes for
//    every phone number with a recent call.
//
// "#Urgent" alongside "@transcript" (both required together - see URGENT_TOKEN below)
// escalates a flag out of the normal weekly batch review: it's logged the same way, but
// also gets an immediate acknowledgment posted back to the conversation so the team
// knows it registered, and is what the "urgent" scheduled review task (set up
// separately, see README) checks for between weekly runs.
//
// Because Contact Notes live on the CONTACT, not on one specific conversation or
// message, a flag note has no structural link to a single call - a repeat customer's
// notes are all in the same list regardless of which call prompted them. Per Joshua
// (2026-07-30): default to the contact's MOST RECENT call. When a contact has multiple
// recent calls, still default to the most recent one, but also log the next couple of
// calls' dates alongside it (see RECENT_CALLS_FOR_CONTEXT) so a reviewer isn't stuck
// guessing whether a flag is really about the latest call or is more of a general
// comment spanning several - the flag row always shows enough for a human to tell at a
// glance rather than the code trying to guess.

const heymarketClient = require('./heymarketClient');
const sheetsClient = require('./sheetsClient');
const driveClient = require('./driveClient');

// Case-insensitive, matches "@transcript" anywhere in the note text.
const FLAG_TOKEN = /@transcript/i;
// Must appear ALONGSIDE @transcript in the same note (not on its own) to count as
// urgent - see header comment.
const URGENT_TOKEN = /#urgent/i;

// How many of a contact's most recent calls (most recent first) to log for reviewer
// context alongside the one we default to matching the flag against.
const RECENT_CALLS_FOR_CONTEXT = 3;

async function postUrgentAcknowledgment(phone) {
  try {
    await heymarketClient.postPrivateNote(
      phone,
      'Got it — flagged as urgent, we’re looking into this now.',
      null
    );
  } catch (err) {
    console.error('Error posting urgent-flag acknowledgment for ' + phone + ':', err);
  }
}

// Groups the "Calls" tab's rows by phone number (column index 3), most recent call
// first. Rows are appended in finalize order, so reversing the raw sheet order gives
// newest-first per phone without needing to parse the date column at all.
function groupCallsByPhone(callRows) {
  const byPhone = new Map();
  for (const row of [...callRows].reverse()) {
    const phone = row[3];
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(row);
  }
  return byPhone;
}

// Checks every phone number with at least one logged call for new "@transcript" notes,
// logs each new one to the "Flags" tab, and posts an immediate acknowledgment for any
// marked "#Urgent". Safe to call repeatedly/concurrently-ish from a setInterval in
// server.js - dedup is by Heymarket's own stable note id (see alreadyLoggedNoteIds
// below), so a note already written to the Flags tab is never logged twice even if a
// poll cycle overlaps or the process restarts mid-run.
async function pollFeedback() {
  const spreadsheetId = await sheetsClient.getOrCreateFeedbackSheet();

  const [callRows, flagRows] = await Promise.all([
    sheetsClient.getSheetValues(spreadsheetId, 'Calls'),
    sheetsClient.getSheetValues(spreadsheetId, 'Flags'),
  ]);

  const alreadyLoggedNoteIds = new Set(flagRows.map((row) => row[1]).filter(Boolean));
  const callsByPhone = groupCallsByPhone(callRows);

  let flaggedCount = 0;
  let urgentCount = 0;

  for (const phone of callsByPhone.keys()) {
    try {
      const contact = await heymarketClient.getContactByPhone(phone);
      if (!contact || !contact.note || !contact.note.length) continue;

      for (const note of contact.note) {
        if (!note || !note.id) continue;
        if (alreadyLoggedNoteIds.has(note.id)) continue;
        if (!FLAG_TOKEN.test(note.text || '')) continue;

        const urgent = URGENT_TOKEN.test(note.text || '');
        const recentCalls = callsByPhone.get(phone).slice(0, RECENT_CALLS_FOR_CONTEXT);
        const matchedCall = recentCalls[0]; // most recent call, per Joshua's default rule
        const otherCalls = recentCalls
          .slice(1)
          .map((row) => row[1])
          .filter(Boolean)
          .join('; ');

        await sheetsClient.appendRow(spreadsheetId, 'Flags', [
          driveClient.formatPacific(new Date().toISOString()),
          note.id,
          phone,
          contact.display_name || ((contact.first || '') + ' ' + (contact.last || '')).trim(),
          note.name || (note.user_id != null ? String(note.user_id) : 'unknown'),
          note.date || '',
          urgent ? 'Yes' : 'No',
          note.text || '',
          matchedCall ? matchedCall[1] : '',
          matchedCall ? matchedCall[5] : '',
          otherCalls ? ('Also called: ' + otherCalls) : '',
          'New',
        ]);

        flaggedCount += 1;
        if (urgent) {
          urgentCount += 1;
          await postUrgentAcknowledgment(phone);
          console.log('URGENT feedback flag logged for ' + phone + ': ' + note.text);
        } else {
          console.log('Feedback flag logged for ' + phone + ': ' + note.text);
        }
      }
    } catch (err) {
      console.error('Error checking Heymarket contact notes for ' + phone + ':', err);
    }
  }

  if (flaggedCount) {
    console.log('pollFeedback: logged ' + flaggedCount + ' new flag(s), ' + urgentCount + ' urgent.');
  }
  return { flaggedCount, urgentCount };
}

module.exports = { pollFeedback };
