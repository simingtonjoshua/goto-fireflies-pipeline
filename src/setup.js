// One-time setup script:
//   1. Confirms the GoTo credentials work and discovers the account key
//   2. Creates a Notification Channel pointing at this service's public webhook
//   3. Subscribes that channel to Call Events (STARTING/ENDING), Recording
//      notifications, Call History events, and Call Parking events
//
// Run this AFTER the service is deployed and PUBLIC_BASE_URL is reachable from the
// internet over HTTPS (GoTo will not accept a localhost URL).
//
// Safe to re-run: each subscribeX() call just creates an additional subscription on the
// same channel if run again - GoTo doesn't seem to dedupe these, so avoid running this
// more than once per real deployment unless you're prepared to also clean up old
// subscriptions via the corresponding GET/DELETE endpoints.
//
// Usage: npm run setup

require('dotenv').config();
const {
  getAccountKey,
  createWebhookChannel,
  subscribeCallEvents,
  subscribeRecordingEvents,
  subscribeCallHistoryEvents,
  subscribeCallParkingEvents,
} = require('./gotoClient');

async function main() {
  if (!process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL.includes('your-domain')) {
    throw new Error('Set PUBLIC_BASE_URL in .env to this service\'s real public HTTPS URL first.');
  }

  let accountKey = process.env.GOTO_ACCOUNT_KEY;
  if (!accountKey) {
    console.log('No GOTO_ACCOUNT_KEY set, fetching from /users/v1/me...');
    accountKey = await getAccountKey();
    console.log(`Discovered account key: ${accountKey}`);
    console.log('Add GOTO_ACCOUNT_KEY to your .env so future runs skip this lookup.');
  }

  const webhookUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/goto`;
  console.log(`Creating notification channel -> ${webhookUrl}`);
  const channelId = await createWebhookChannel(webhookUrl);
  console.log(`Channel created: ${channelId}`);

  console.log('Subscribing to call events (STARTING, ENDING)...');
  const callEventsResult = await subscribeCallEvents(channelId, accountKey);
  console.log('Call events subscription result:', JSON.stringify(callEventsResult));

  console.log('Subscribing to recording notifications...');
  const recordingResult = await subscribeRecordingEvents(channelId, accountKey);
  console.log('Recording subscription result:', JSON.stringify(recordingResult));

  console.log('Subscribing to Call History events (for park/transfer leg correlation)...');
  try {
    const callHistoryResult = await subscribeCallHistoryEvents(channelId, accountKey);
    console.log('Call History subscription result:', JSON.stringify(callHistoryResult));
  } catch (err) {
    console.error(
      'Call History subscription failed - this is new/unverified as of 2026-07-20. Check ' +
      'https://developer.goto.com/GoToConnect/#tag/Call-History-Subscription for the exact ' +
      'body shape and update src/gotoClient.js#subscribeCallHistoryEvents if it differs. ' +
      'The rest of the pipeline still works without this - it only affects park/transfer ' +
      'leg grouping, which will fall back to treating each leg as its own interaction.'
    );
    console.error(err);
  }

  console.log('Subscribing to Call Parking events (real-time park/retrieve signal)...');
  try {
    const callParkingResult = await subscribeCallParkingEvents(channelId, accountKey);
    console.log('Call Parking subscription result:', JSON.stringify(callParkingResult));
  } catch (err) {
    console.error(
      'Call Parking subscription failed - likely because it expects an organizationId ' +
      'that differs from accountKey (unverified as of 2026-07-20). Check ' +
      'https://developer.goto.com/GoToConnect/#tag/Call-Parking-Subscriptions and update ' +
      'src/gotoClient.js#subscribeCallParkingEvents with the right id if so. Not fatal - ' +
      'Call History correlation still catches parks, just without the instant signal.'
    );
    console.error(err);
  }

  console.log('\nSetup complete. Trigger a real call (including a park and a transfer) and watch');
  console.log('this service\'s logs to confirm the new event shapes match what src/interactions.js');
  console.log('expects.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
