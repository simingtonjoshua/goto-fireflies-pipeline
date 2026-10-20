const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { healthPayload } = require('../src/health');

describe('/healthz payload', () => {
  it('returns ok and the running commit without doing any work', () => {
    assert.deepEqual(healthPayload({}), { ok: true, commit: null });
    assert.deepEqual(healthPayload({ RENDER_GIT_COMMIT: '' }), { ok: true, commit: null });
    assert.deepEqual(healthPayload({ RENDER_GIT_COMMIT: '   ' }), { ok: true, commit: null });
    assert.deepEqual(
      healthPayload({ RENDER_GIT_COMMIT: '  76bfab56829927e22aea3cbda67bf0d6c6972cea  ' }),
      { ok: true, commit: '76bfab56829927e22aea3cbda67bf0d6c6972cea' },
    );
  });
});
