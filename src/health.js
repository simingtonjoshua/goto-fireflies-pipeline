// Render sets RENDER_GIT_COMMIT on each deploy. /healthz reports it so an audit
// can see which build is serving. Missing or blank stays a 200 with commit null.
function healthPayload(env = process.env) {
  const commit = String((env && env.RENDER_GIT_COMMIT) || '').trim();
  return { ok: true, commit: commit || null };
}

module.exports = { healthPayload };
