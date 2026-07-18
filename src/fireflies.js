// Minimal Fireflies.ai GraphQL client for the uploadAudio mutation.
// Docs: https://docs.fireflies.ai/graphql-api/mutation/upload-audio

const fetch = require('node-fetch');

const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

async function uploadAudio(publicUrl, title) {
  const query = `
    mutation UploadAudio($input: AudioUploadInput!) {
      uploadAudio(input: $input) {
        success
        title
        message
      }
    }
  `;

  const res = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          url: publicUrl,
          title: title || `GoTo Connect call - ${new Date().toISOString()}`,
        },
      },
    }),
  });

  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`Fireflies uploadAudio failed: ${JSON.stringify(body.errors || body)}`);
  }
  return body.data.uploadAudio;
}

module.exports = { uploadAudio };
