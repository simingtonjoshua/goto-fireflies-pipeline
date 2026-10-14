const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireAdmin } = require('../src/adminAuth');

describe('admin token', () => {
  const previous = process.env.ADMIN_TOKEN;

  afterEach(() => {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  });

  function run(headers) {
    let status;
    let body;
    let nexted = false;
    const req = {
      get(name) {
        return headers[String(name).toLowerCase()] || '';
      },
    };
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json(payload) {
        body = payload;
      },
    };
    requireAdmin(req, res, () => {
      nexted = true;
    });
    return { status, body, nexted };
  }

  it('leaves /admin open when ADMIN_TOKEN is unset', () => {
    delete process.env.ADMIN_TOKEN;
    assert.equal(run({}).nexted, true);
  });

  it('accepts the shared secret header or a bearer token and rejects anything else', () => {
    process.env.ADMIN_TOKEN = 'test-admin-secret';
    assert.equal(run({ 'x-admin-token': 'test-admin-secret' }).nexted, true);
    assert.equal(run({ authorization: 'Bearer test-admin-secret' }).nexted, true);
    const denied = run({ 'x-admin-token': 'nope' });
    assert.equal(denied.nexted, false);
    assert.equal(denied.status, 401);
  });
});
