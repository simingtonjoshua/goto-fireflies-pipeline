const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const cardRedact = require('../src/cardRedact');
const interactions = require('../src/interactions');
const openaiClient = require('../src/openaiClient');

// Standard test PANs only. These are not live card numbers.
const PAN = '4111111111111111';
const PAN_FAIL = '4111111111111112';
const AMEX = '378282246310005';
const PHONE = '5550101001';

function utterance(text) {
  return { results: [{ transcript: text, channel: 0, startTimeMs: 0 }] };
}

function textOf(result) {
  return result.transcript.results.map((row) => row.transcript).join('\n');
}

describe('card redaction', () => {
  it('checks Luhn and masks a contiguous test PAN', () => {
    assert.equal(cardRedact.luhnOk(PAN), true);
    assert.equal(cardRedact.luhnOk(PAN_FAIL), false);
    assert.equal(cardRedact.luhnOk(AMEX), true);

    const result = cardRedact.redactTranscript(utterance(`please use ${PAN}`));
    assert.equal(result.masked, true);
    assert.equal(result.review, false);
    assert.equal(result.flagged, true);
    assert.match(textOf(result), /\[REDACTED-CARD\]/);
    assert.equal(textOf(result).includes(PAN), false);
  });

  it('masks spaced, dashed, and spoken test PANs', () => {
    const spaced = cardRedact.redactTranscript(utterance('4111 1111 1111 1111'));
    assert.match(textOf(spaced), /\[REDACTED-CARD\]/);
    assert.equal(textOf(spaced).includes('4111'), false);

    const dashed = cardRedact.redactTranscript(utterance('4111-1111-1111-1111'));
    assert.match(textOf(dashed), /\[REDACTED-CARD\]/);
    assert.equal(textOf(dashed).includes('4111'), false);

    const spoken = cardRedact.redactTranscript(utterance(
      'four one one one one one one one one one one one one one one one',
    ));
    assert.match(textOf(spoken), /\[REDACTED-CARD\]/);
    assert.equal(textOf(spoken).includes('four'), false);
    assert.equal(textOf(spoken).includes('one'), false);

    const amex = cardRedact.redactTranscript(utterance(AMEX));
    assert.match(textOf(amex), /\[REDACTED-CARD\]/);
    assert.equal(textOf(amex).includes(AMEX), false);
  });

  it('joins a spoken test PAN split across transcript rows', () => {
    const result = cardRedact.redactTranscript({
      results: [
        { transcript: 'four one one one one one one one', channel: 0 },
        { transcript: 'one one one one one one one one', channel: 1 },
      ],
    });
    const joined = textOf(result);
    assert.match(joined, /\[REDACTED-CARD\]/);
    assert.equal(joined.includes('four'), false);
    assert.equal(joined.includes('one'), false);
    assert.equal(result.masked, true);
    assert.equal(result.review, false);
  });

  it('leaves phone numbers and non-Luhn digit runs alone', () => {
    const phone = cardRedact.redactTranscript(utterance(`call me at ${PHONE}`));
    assert.equal(textOf(phone), `call me at ${PHONE}`);
    assert.equal(phone.flagged, false);

    const order = cardRedact.redactTranscript(utterance(`order ${PAN_FAIL}`));
    assert.equal(textOf(order), `order ${PAN_FAIL}`);
    assert.equal(order.masked, false);
    assert.equal(order.review, false);
  });

  it('masks an expiration and a security code near card wording', () => {
    const exp = cardRedact.redactTranscript(utterance('the expiration date is 12/26'));
    assert.match(textOf(exp), /\[REDACTED-EXP\]/);
    assert.equal(textOf(exp).includes('12/26'), false);
    assert.equal(exp.review, false);

    const cardExp = cardRedact.redactTranscript(utterance('the card expires 12/26'));
    assert.match(textOf(cardExp), /\[REDACTED-EXP\]/);
    assert.equal(textOf(cardExp).includes('12/26'), false);

    const cvv = cardRedact.redactTranscript(utterance('security code is 123'));
    assert.match(textOf(cvv), /\[REDACTED-CVV\]/);
    assert.equal(textOf(cvv).includes('123'), false);
    assert.equal(cvv.review, false);

    const cid = cardRedact.redactTranscript(utterance('the cvv is 1234'));
    assert.match(textOf(cid), /\[REDACTED-CVV\]/);
    assert.equal(textOf(cid).includes('1234'), false);

    const plainDate = cardRedact.redactTranscript(utterance('see you on 12/26'));
    assert.equal(textOf(plainDate), 'see you on 12/26');
    assert.equal(plainDate.flagged, false);
  });

  it('never holds or flags payment talk without card digits (false positives)', () => {
    const cases = [
      '15 windows',
      'credit for 15 windows',
      'Can I pay by credit card?',
      'the cvv is 2026',
      'I will put the deposit on my card, the total is $4,250.00',
      'my card number? I will call back with it',
      'call me at 916-555-0123 or (707) 718-1909',
      'call me at 1 916 555 0123',
      'order number 202610120045 for the shutters',
      'PO 4400123, invoice 88231',
      'we live at 12345 Fair Oaks Blvd, Sacramento CA 95628',
      'payment is due 10/15 and the credit card fee is 3 percent',
      'the price is 1,299 and the card on file was charged 350 dollars',
      'debit or credit, either works, we take payment at install',
    ];
    for (const text of cases) {
      const result = cardRedact.redactTranscript(utterance(text));
      assert.equal(textOf(result), text, text);
      assert.equal(result.review, false, text);
      assert.equal(result.masked, false, text);
      assert.equal(result.flagged, false, text);
    }
  });

  it('stays masked on a second pass when card wording remains beside the token', () => {
    const once = cardRedact.redactTranscript(utterance(`my card is ${PAN}`));
    const twice = cardRedact.redactTranscript(once.transcript);
    assert.equal(twice.review, false);
    assert.equal(twice.masked, true);
    assert.equal(twice.flagged, true);
    assert.match(textOf(twice), /\[REDACTED-CARD\]/);
    assert.equal(JSON.stringify(twice).includes(PAN), false);
  });
});

describe('card redaction before summary and docs', () => {
  it('puts the same masked text in the summary prompt and the doc', () => {
    const legRecords = [{
      transcript: utterance(`my card is ${PAN} and it expires 12/26`),
      callCreated: '2026-01-01T00:00:00.000Z',
    }];
    const built = openaiClient.buildSummaryMessages({
      legRecords,
      csrPath: [],
      direction: 'INBOUND',
      externalNumber: PHONE,
      answered: true,
    });
    assert.match(built.conversationText, /\[REDACTED-CARD\]/);
    assert.match(built.conversationText, /\[REDACTED-EXP\]/);
    assert.equal(built.user.includes(PAN), false);
    assert.equal(built.conversationText.includes(PAN), false);
    assert.equal(built.user.includes('12/26'), false);

    const doc = openaiClient.formatTranscriptForDoc(legRecords);
    assert.match(doc, /\[REDACTED-CARD\]/);
    assert.equal(doc.includes(PAN), false);
    assert.equal(doc.includes('12/26'), false);
  });

  it('always includes the transcript when payment is discussed without a card number', async () => {
    const legRecords = [{ transcript: utterance('Can I pay by credit card? zebra') }];
    const doc = openaiClient.formatTranscriptForDoc(legRecords);
    assert.match(doc, /zebra/);
    assert.equal(/withheld/i.test(doc), false);
    const built = openaiClient.buildSummaryMessages({
      legRecords, csrPath: [], direction: 'INBOUND', externalNumber: PHONE, answered: false,
    });
    assert.match(built.conversationText, /zebra/);
    assert.equal(typeof cardRedact.reviewHoldMessage, 'undefined');
    assert.equal(typeof cardRedact.withheldTranscript, 'undefined');
  });

  it('still includes an ordinary transcript', () => {
    const doc = openaiClient.formatTranscriptForDoc([{ transcript: utterance('Hello there') }]);
    assert.match(doc, /Hello there/);
    const built = openaiClient.buildSummaryMessages({
      legRecords: [{ transcript: utterance('Hello there'), callCreated: '2026-01-01T00:00:00.000Z' }],
      csrPath: ['Emily Kingdon (00006)'],
      direction: 'INBOUND',
      externalNumber: PHONE,
      answered: true,
    });
    assert.match(built.conversationText, /Hello there/);
  });
});

describe('card flags on a call', () => {
  beforeEach(() => interactions.resetForTests());
  after(() => interactions.resetForTests());

  it('stores masked text only and skips audio for a masked call', async () => {
    const uploaded = [];
    interactions.setAudioUploader(async (pending) => uploaded.push(pending.recordingId));
    interactions.holdRecordingAudio('conv-pan', {
      recordingId: 'rec-pan',
      buffer: Buffer.from('synthetic-audio'),
      contentType: 'audio/mpeg',
      meta: { conversationSpaceId: 'conv-pan' },
    });
    assert.equal(interactions.audioArchiveDecision('conv-pan'), 'hold');

    interactions.recordTranscript('conv-pan', 'rec-pan', utterance(`the number is ${PAN}`));
    await new Promise((resolve) => setImmediate(resolve));

    const stored = JSON.stringify(interactions.peekLeg('conv-pan'));
    assert.equal(stored.includes(PAN), false);
    assert.match(stored, /\[REDACTED-CARD\]/);
    assert.equal(interactions.isCardFlagged('conv-pan'), true);
    assert.equal(interactions.audioArchiveDecision('conv-pan'), 'skip');
    assert.deepEqual(uploaded, []);
    assert.equal(Object.hasOwn(interactions.peekLeg('conv-pan'), 'pendingAudio'), false);
  });

  it('keeps and archives a call with payment talk but no card number', async () => {
    const uploaded = [];
    interactions.setAudioUploader(async (pending) => uploaded.push(pending.recordingId));
    interactions.holdRecordingAudio('conv-talk', {
      recordingId: 'rec-talk',
      buffer: Buffer.from('synthetic-audio'),
      contentType: 'audio/mpeg',
      meta: { conversationSpaceId: 'conv-talk' },
    });
    interactions.recordTranscript('conv-talk', 'rec-talk', utterance('Can I pay by credit card? zebra'));
    await new Promise((resolve) => setImmediate(resolve));
    const stored = JSON.stringify(interactions.peekLeg('conv-talk'));
    assert.match(stored, /zebra/);
    assert.equal(/withheld/i.test(stored), false);
    assert.equal(interactions.isCardFlagged('conv-talk'), false);
    assert.deepEqual(uploaded, ['rec-talk']);
  });

  it('archives a clean call and uploads audio that was held for the check', async () => {
    const uploaded = [];
    interactions.setAudioUploader(async (pending) => uploaded.push(pending.recordingId));
    assert.equal(interactions.audioArchiveDecision(null), 'archive');
    assert.equal(interactions.audioArchiveDecision(''), 'archive');

    interactions.holdRecordingAudio('conv-clean', {
      recordingId: 'rec-clean',
      buffer: Buffer.from('synthetic-audio'),
      contentType: 'audio/mpeg',
      meta: { conversationSpaceId: 'conv-clean' },
    });
    interactions.recordTranscript('conv-clean', 'rec-clean', utterance('hello there'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(interactions.isCardFlagged('conv-clean'), false);
    assert.equal(interactions.audioArchiveDecision('conv-clean'), 'archive');
    assert.match(JSON.stringify(interactions.peekLeg('conv-clean')), /hello there/);
    assert.deepEqual(uploaded, ['rec-clean']);
  });

  it('does not call the uploader when held audio is released for a flagged call', async () => {
    const uploaded = [];
    interactions.setAudioUploader(async (pending) => uploaded.push(pending.recordingId));
    interactions.holdRecordingAudio('conv-held', {
      recordingId: 'rec-held',
      buffer: Buffer.from('synthetic-audio'),
      contentType: 'audio/mpeg',
      meta: { conversationSpaceId: 'conv-held' },
    });
    await interactions.releaseHeldAudio(['conv-held'], true);
    assert.deepEqual(uploaded, []);
    assert.equal(interactions.audioArchiveDecision('conv-held'), 'hold');
  });
});
