// Fireflies' uploadAudio mutation requires a publicly downloadable HTTPS URL -
// it will not accept raw bytes. This module stages a downloaded recording
// somewhere with a public URL, using one of two backends:
//
//   local -> serve the file from this same server at a random, one-time URL
//            (default; no extra signup, but requires PUBLIC_BASE_URL to be
//            genuinely internet-reachable over HTTPS)
//   s3    -> upload to an S3 bucket and hand back a presigned GET URL

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// token -> { filePath, contentType, expiresAt }
const localFiles = new Map();

function extForContentType(contentType) {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  if (contentType.includes('ogg')) return 'ogg';
  return 'mp3';
}

async function stageLocal(buffer, contentType) {
  const token = crypto.randomBytes(24).toString('hex');
  const ext = extForContentType(contentType);
  const filePath = path.join(TMP_DIR, `${token}.${ext}`);
  fs.writeFileSync(filePath, buffer);

  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour is plenty for Fireflies to fetch it
  localFiles.set(token, { filePath, contentType, expiresAt });

  // best-effort cleanup
  setTimeout(() => {
    localFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, 60 * 60 * 1000).unref();

  const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}/recordings/${token}.${ext}`;
}

function getLocalFile(token) {
  const entry = localFiles.get(token);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry;
}

async function stageS3(buffer, contentType) {
  // Lazy-require so the S3 SDK is only needed when this backend is selected.
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const client = new S3Client({ region: process.env.AWS_REGION });
  const key = `recordings/${crypto.randomBytes(24).toString('hex')}.${extForContentType(contentType)}`;

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    { expiresIn: 3600 }
  );
  return url;
}

async function stageRecording(buffer, contentType) {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend === 's3') return stageS3(buffer, contentType);
  return stageLocal(buffer, contentType);
}

module.exports = { stageRecording, getLocalFile, extForContentType };
