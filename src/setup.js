// One-time setup script:
//   1. Confirms the GoTo credentials work and discovers the account key
//   2. Creates a Notification Channel pointing at this service's public webhook
//   3. Subscribes that channel to Call Events (STARTING/ENDING) and Recording notifications
//
// Run this AFTER the service is deployed and PUBLIC_BASE_URL is reachable from the
// internet over HTTPS (GoTo will not accept a localhost URL).
//
// Usage: npm run setup

require('dotenv').config();
const {
  getAccountKey,
  createWebhookChannel,
  subscribeCallEvents,
  subscribeRecordingEvents,
} = require('./gotoClient');

async function main() {
  if (!process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL.includes('your-domain')) {
    throw new Error('Set PUBLIC_BASE_URL in .env to this service\'s real public HTTPS URL first.');
  }

  let accountKey = process.env.GOTO_ACCOUNT_KEY;
  if (!accountKey) {
    console.log('No GOTO_ACCOUNT_KEY set, fetching from /admin/rest/v1/me...');
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
  try {
    const recordingResult = await subscribeRecordingEvents(channelId, accountKey);
    console.log('Recording subscription result:', JSON.stringify(recordingResult));
  } catch (err) {
    console.error(
      'Recording subscription failed. This endpoint was inferred from the Call Events pattern - ' +
      'check https://developer.goto.com/GoToConnect for the exact Recording subscription path/body ' +
      'and update src/gotoClient.js#subscribeRecordingEvents if it differs.'
    );
    throw err;
  }

  console.log('\nSetup complete. Trigger a real call and watch this service\'s logs to confirm the');
  console.log('recording notification payload shape, then adjust extractRecordingId() in src/server.js');
  console.log('if needed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
