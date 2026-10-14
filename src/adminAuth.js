// Optional shared secret for /admin/*. When ADMIN_TOKEN is unset the routes stay
// open (so a deploy is not locked out before the env var is set) and the process
// logs a warning. When it is set, callers must send it as X-Admin-Token or as
// Authorization: Bearer.

const HEADER = 'x-admin-token';

function adminWarning() {
  return 'ADMIN_TOKEN is not set. /admin routes are open until it is configured.';
}

function warnIfAdminOpen() {
  if (!process.env.ADMIN_TOKEN) console.warn(adminWarning());
}

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next();
  const provided = String(req.get(HEADER) || '').trim();
  const authorization = String(req.get('authorization') || '');
  const bearer = /^bearer\s+/i.test(authorization)
    ? authorization.replace(/^bearer\s+/i, '').trim()
    : '';
  if ((provided && provided === token) || (bearer && bearer === token)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

module.exports = {
  requireAdmin,
  warnIfAdminOpen,
  adminWarning,
};
