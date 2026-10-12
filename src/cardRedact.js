// Masks payment-card data in transcript text before it is sent to OpenAI or written
// to Drive, HeyMarket, or Sheets. The same masked text is what every later step sees.
// A long digit run is masked only when it is 13–19 digits and passes the Luhn check,
// so phone numbers and ordinary order numbers stay visible.
//
// When card-context words are present but nothing was masked, callers withhold the
// transcript body and skip the audio archive. Raw matching text is not logged here.

const DIGIT_WORD = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const TOKEN_RE = /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d+)\b/gi;
const CONTEXT_RE = /\b(cards?|credit|debit|expiration|cvv|cvc|security code|card number)\b/i;
const CONTEXT_RE_G = /\b(cards?|credit|debit|expiration|cvv|cvc|security code|card number)\b/gi;
const EXP_RE = /\b(?:0?[1-9]|1[0-2])\s*[/\-]\s*(?:\d{4}|\d{2})\b/g;
const CVV_ANCHOR_RE = /\b(?:cvv|cvc|cid|security code|card number)\b/gi;
const CVV_RE = /\b\d{3,4}\b/g;
const ALREADY_RE = /\[REDACTED-(?:CARD|EXP|CVV)\]/;

function luhnOk(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function digitValue(raw) {
  if (/^\d+$/.test(raw)) return raw;
  return DIGIT_WORD[raw.toLowerCase()] || '';
}

function findCardSpans(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(text);
  while (match) {
    const digits = digitValue(match[0]);
    if (digits) tokens.push({ start: match.index, end: match.index + match[0].length, digits });
    match = TOKEN_RE.exec(text);
  }
  const spans = [];
  let group = [];
  function flush() {
    if (!group.length) return;
    const digits = group.map((token) => token.digits).join('');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
      spans.push({ start: group[0].start, end: group[group.length - 1].end, token: '[REDACTED-CARD]' });
    }
    group = [];
  }
  for (const token of tokens) {
    if (!group.length) {
      group.push(token);
      continue;
    }
    const gap = text.slice(group[group.length - 1].end, token.start);
    if (/^[\s,.\-]*$/.test(gap)) group.push(token);
    else {
      flush();
      group.push(token);
    }
  }
  flush();
  return spans;
}

function contextIndexes(text) {
  const indexes = [];
  CONTEXT_RE_G.lastIndex = 0;
  let match = CONTEXT_RE_G.exec(text);
  while (match) {
    indexes.push(match.index);
    match = CONTEXT_RE_G.exec(text);
  }
  return indexes;
}

function nearAny(index, indexes, window) {
  return indexes.some((contextIndex) => Math.abs(contextIndex - index) <= window);
}

function overlaps(span, spans) {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

function findExtraSpans(text, blocked) {
  const spans = [];
  const contexts = contextIndexes(text);
  EXP_RE.lastIndex = 0;
  let match = EXP_RE.exec(text);
  while (match) {
    const span = { start: match.index, end: match.index + match[0].length, token: '[REDACTED-EXP]' };
    if (nearAny(match.index, contexts, 80) && !overlaps(span, blocked) && !overlaps(span, spans)) spans.push(span);
    match = EXP_RE.exec(text);
  }
  const anchors = [];
  CVV_ANCHOR_RE.lastIndex = 0;
  match = CVV_ANCHOR_RE.exec(text);
  while (match) {
    anchors.push(match.index);
    match = CVV_ANCHOR_RE.exec(text);
  }
  CVV_RE.lastIndex = 0;
  match = CVV_RE.exec(text);
  while (match) {
    const span = { start: match.index, end: match.index + match[0].length, token: '[REDACTED-CVV]' };
    const year = match[0].length === 4 && /^(19|20)/.test(match[0]);
    if (!year && nearAny(match.index, anchors, 40) && !overlaps(span, blocked) && !overlaps(span, spans)) {
      spans.push(span);
    }
    match = CVV_RE.exec(text);
  }
  return spans;
}

function joinTexts(texts) {
  let joined = '';
  const map = [];
  texts.forEach((text, ui) => {
    if (ui > 0) {
      joined += '\n';
      map.push(null);
    }
    for (let ci = 0; ci < text.length; ci += 1) {
      joined += text[ci];
      map.push({ ui, ci });
    }
  });
  return { joined, map };
}

function applySpans(texts, spans) {
  if (!spans.length) return texts.slice();
  const chars = texts.map((text) => text.split(''));
  const { map } = joinTexts(texts);
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  for (const span of ordered) {
    let inserted = false;
    for (let i = span.start; i < span.end && i < map.length; i += 1) {
      const pos = map[i];
      if (!pos) continue;
      if (!inserted) {
        chars[pos.ui][pos.ci] = span.token;
        inserted = true;
      } else {
        chars[pos.ui][pos.ci] = '';
      }
    }
  }
  return chars.map((row) => row.join('').replace(/[ \t]{2,}/g, ' ').trim());
}

function utteranceTexts(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.results || raw.items || raw.transcriptions || [];
  if (!Array.isArray(items)) return [];
  return items.map((item) => String((item && (item.transcript || item.text)) || ''));
}

function writeBack(raw, texts) {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      if (!item || typeof item !== 'object') return item;
      const next = { ...item };
      if (Object.prototype.hasOwnProperty.call(item, 'transcript')) next.transcript = texts[index] ?? '';
      else next.text = texts[index] ?? '';
      return next;
    });
  }
  if (raw && typeof raw === 'object') {
    const key = raw.results ? 'results' : raw.items ? 'items' : raw.transcriptions ? 'transcriptions' : null;
    if (!key) return raw;
    return {
      ...raw,
      [key]: raw[key].map((item, index) => {
        const next = { ...item };
        if (Object.prototype.hasOwnProperty.call(item, 'transcript')) next.transcript = texts[index] ?? '';
        else next.text = texts[index] ?? '';
        return next;
      }),
    };
  }
  return raw;
}

function redactTranscript(raw) {
  const texts = utteranceTexts(raw);
  const { joined } = joinTexts(texts);
  const hasContext = CONTEXT_RE.test(joined);
  const already = ALREADY_RE.test(joined);
  const cardSpans = findCardSpans(joined);
  const extraSpans = findExtraSpans(joined, cardSpans);
  const spans = cardSpans.concat(extraSpans);
  const masked = spans.length > 0 || already;
  const review = hasContext && !masked;
  const flagged = masked || review;
  const nextTexts = spans.length ? applySpans(texts, spans) : texts;
  return {
    transcript: spans.length ? writeBack(raw, nextTexts) : raw,
    masked: spans.length > 0 || already,
    review,
    flagged,
  };
}

function reviewHoldMessage() {
  return 'Payment-card wording was detected on this call and could not be masked automatically. The transcript was withheld for review.';
}

function withheldTranscript() {
  return { results: [{ transcript: 'Transcript withheld for payment-data review.', channel: 0, startTimeMs: 0 }] };
}

module.exports = {
  redactTranscript,
  reviewHoldMessage,
  withheldTranscript,
  luhnOk,
};
