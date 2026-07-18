// Fireflies.ai GraphQL client: uploadAudio + updateMeetingChannel.
// Docs:
//   https://docs.fireflies.ai/graphql-api/mutation/upload-audio
//   https://docs.fireflies.ai/graphql-api/webhooks (per-upload webhook + client_reference_id)
//   https://docs.fireflies.ai/graphql-api/mutation/update-meeting-channel

const fetch = require('node-fetch');

const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

async function firefliesRequest(query, variables) {
  const res = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`Fireflies request failed: ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

// options: { url, title, clientReferenceId, webhook, attendees }
//   - clientReferenceId: set to the GoTo recordingId so the Fireflies webhook
//     (see /webhooks/fireflies in server.js) can be correlated back to the call.
//   - webhook: our own public URL that Fireflies POSTs to once transcription finishes.
async function uploadAudio({ url, title, clientReferenceId, webhook, attendees }) {
  const query = `
    mutation UploadAudio($input: AudioUploadInput!) {
      uploadAudio(input: $input) {
        success
        title
        message
      }
    }
  `;

  const input = {
    url,
    title: title || `GoTo Connect call - ${new Date().toISOString()}`,
  };
  if (clientReferenceId) input.client_reference_id = clientReferenceId;
  if (webhook) input.webhook = webhook;
  if (attendees) input.attendees = attendees;

  const data = await firefliesRequest(query, { input });
  return data.uploadAudio;
}

// Assigns a transcript (already-processed meeting) to a Fireflies channel.
// A meeting can only belong to one channel at a time - this replaces any prior one.
async function updateMeetingChannel(transcriptId, channelId) {
  const query = `
    mutation UpdateMeetingChannel($input: UpdateMeetingChannelInput!) {
      updateMeetingChannel(input: $input) {
        id
        title
        channels {
          id
        }
      }
    }
  `;

  const data = await firefliesRequest(query, {
    input: { transcript_ids: [transcriptId], channel_id: channelId },
  });
  return data.updateMeetingChannel;
}

module.exports = { uploadAudio, updateMeetingChannel };
