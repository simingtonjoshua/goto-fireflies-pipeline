require('dotenv').config();
const express = require('express');
const fs = require('fs');

const { fetchRecordingContent } = require('./gotoClient');
const { stageRecording, getLocalFile } = require('./storage');
const { uploadAudio } = require('./fireflies');

const app = express();
app.use(express.json({ limit: '5mb' }));

// GoTo pings the webhook with an empty request (User-Agent: "GoTo Notifications")
// when the notification channel is first created, just to verify reachability.
app.get('/webhooks/goto', (req, res) => res.sendStatus(200));

app.post('/webhooks/goto', async (req, res) => {
  // Always ack fast; GoTo will retry if it doesn't get a timely response.
  res.sendStatus(200);

  const payload = req.body;
  console.log('GoTo notification received:', JSON.stringify(payload));

  try {
    const recordingId = extractRecordingId(payload);
    if (recordingId) {
      await handleRecording(recordingId);
      return;
    }

    // Otherwise this is a call-state event (STARTING/ACTIVE/ENDING) - just log it.
    // Useful for correlating with a recording notification that arrives shortly after.
    const callState = payload?.content?.state?.type;
    if (callState) {
      console.log(`Call event: ${callState} (conversationSpaceId=${payload?.content?.metadata?.conversationSpaceId})`);
    }
  } catch (err) {
    console.error('Error handling GoTo notification:', err);
  }
});

// Confirmed against a live payload on 2026-07-18: GoTo's recording-ready notification
// looks like { source: "recording-service", type: "RECORDING_UPLOADED", content: { recording_id } }.
// Call-state events look like { source: "call-events", type: "call-state", content: { state: {...} } }
// and never carry a recording id at this top level (recordings are only referenced inside
// content.state.participants[].recordings[].id, which is informational, not a ready signal).
function extractRecordingId(payload) {
  if (payload?.type === 'RECORDING_UPLOADED' && payload?.content?.recording_id) {
    return payload.content.recording_id;
  }
  // Keep the older guesses as a fallback in case the shape varies by event source.
  return (
    payload?.recordingId ||
    payload?.recording?.id ||
    payload?.data?.recordingId ||
    payload?.body?.recordingId ||
    payload?.content?.recording_id ||
    null
  );
}

async function handleRecording(recordingId) {
  console.log(`Fetching recording ${recordingId} from GoTo...`);
  const { buffer, contentType } = await fetchRecordingContent(recordingId);

  console.log(`Staging recording ${recordingId} (${buffer.length} bytes, ${contentType})...`);
  const publicUrl = await stageRecording(buffer, contentType);

  console.log(`Sending ${recordingId} to Fireflies: ${publicUrl}`);
  const result = await uploadAudio(publicUrl, `GoTo Connect call ${recordingId}`);
  console.log('Fireflies response:', result);
}

// Serves locally staged recordings (only used when STORAGE_BACKEND=local).
app.get('/recordings/:file', (req, res) => {
  const token = req.params.file.split('.')[0];
  const entry = getLocalFile(token);
  if (!entry) return res.sendStatus(404);
  res.setHeader('Content-Type', entry.contentType);
  fs.createReadStream(entry.filePath).pipe(res);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`goto-fireflies-pipeline listening on :${port}`));
