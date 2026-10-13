// Masks payment-card data in transcript text before it is sent to OpenAI or written
// to Drive, HeyMarket, or Sheets. The same masked text is what every later step sees.
// A long digit run is masked only when it is 13–19 digits and passes the Luhn check,
// so phone numbers and ordinary order numbers stay visible.
//
// LOCKED RULE (Joshua, 2026-10-12): the transcript and summary are ALWAYS posted.
// Payment wording alone ("card", "credit", "payment") never withholds or holds anything.
// Only real card numbers, expiration dates and security codes in a card context are masked.
// Speech-to-text expirations ("128", "1 28", "January 2028", "one twenty eight") and
// security codes after "security" / "on the back" / "verification code" are included.
// Prices, phone numbers, zip codes, and appointment times stay visible.

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
// Slash dates stay tied to an explicit expiration cue or a real card number.
// "credit card" alone must not hide a due date like 10/15.
const EXP_WORD_RE = /\b(?:expiration(?:\s+date)?|expires|expiry|exp\s+date|exp|cvv|cvc|security\s+code)\b/gi;
const EXP_SEPARATOR_RE = /\b(?:0?[1-9]|1[0-2])\s*[/\-]\s*(?:\d{4}|\d{2})\b/g;
// 0128 / 1228, then 128. Validated again so 4111-style groups are not assumed.
const EXP_COMPACT_RE = /\b(?:0[1-9]|1[0-2])\d{2}\b|\b[1-9]\d{2}\b/g;
const EXP_SPACED_RE = /\b(?:0[1-9]|1[0-2]|[1-9])\s+\d{2}\b/g;
const MONTH_ALT = 'january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|may';
const EXP_MONTH_RE = new RegExp(`\\b(?:${MONTH_ALT})\\.?\\s+(?:20\\d{2}|\\d{2})\\b`, 'gi');
// Card wording, including "the security is" and "on the back", for spoken forms.
const CARDISH_RE = /\b(?:cards?|(?<!social\s)security(?!\s+deposit)|cvv|cvc|cid|on the back|back of (?:the )?card)\b/gi;
const CVV_ANCHOR_RE = /\b(?:verification\s+code|(?:three|3)[\s-]*digits?\s+on\s+the\s+back|(?:three|3)[\s-]*digit\s+code|(?:code|digits)\s+on\s+the\s+back|(?<!social\s)security(?!\s+deposit)(?:\s+(?:code|number))?|cvv|cvc|cid)\b/gi;
const SPOKEN_ONES = 'zero|oh|one|two|three|four|five|six|seven|eight|nine';
const SPOKEN_WORD = `${SPOKEN_ONES}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety`;
const SPOKEN_WORD_RE = new RegExp(`\\b(?:${SPOKEN_WORD})\\b`, 'gi');
const SPOKEN_CVV_RE = new RegExp(`\\b(?:${SPOKEN_ONES})(?:[\\s-]+(?:${SPOKEN_ONES})){2,3}\\b`, 'i');
const ALREADY_RE = /\[REDACTED-(?:CARD|EXP|CVV)\]/;
const ONES = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const TEENS = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
};
const TENS = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };

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
    const digitsOf = (tokens) => tokens.map((token) => token.digits).join('');
    const digits = digitsOf(group);
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
      spans.push({ start: group[0].start, end: group[group.length - 1].end, token: '[REDACTED-CARD]' });
      group = [];
      return;
    }
    // A card number and a following expiration ("4111…1111" then "0128") are only
    // separated by a space or a row break, so they land in one digit run.
    if (group.length > 1) {
      for (let n = group.length - 1; n >= 1; n -= 1) {
        const prefix = digitsOf(group.slice(0, n));
        const rest = digitsOf(group.slice(n));
        if (prefix.length >= 13 && prefix.length <= 19 && rest.length >= 3 && rest.length <= 4 && luhnOk(prefix)) {
          spans.push({ start: group[0].start, end: group[n - 1].end, token: '[REDACTED-CARD]' });
          group = group.slice(n);
          flush();
          return;
        }
      }
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

function insideRedactionToken(text, index) {
  const open = text.lastIndexOf('[', index);
  if (open < 0 || index - open > 24) return false;
  const close = text.indexOf(']', open);
  if (close < index) return false;
  return ALREADY_RE.test(text.slice(open, close + 1));
}

function matchIndexes(text, regex) {
  const indexes = [];
  regex.lastIndex = 0;
  let match = regex.exec(text);
  while (match) {
    if (!insideRedactionToken(text, match.index)) indexes.push(match.index);
    match = regex.exec(text);
  }
  return indexes;
}

function utteranceBounds(texts) {
  const bounds = [];
  let offset = 0;
  texts.forEach((text, index) => {
    bounds.push({ start: offset, end: offset + text.length, index });
    offset += text.length + 1;
  });
  return bounds;
}

function utteranceIndexAt(bounds, index) {
  for (const bound of bounds) {
    if (index >= bound.start && index < bound.end) return bound.index;
  }
  return -1;
}

function sliceHas(text, bounds, index, regex) {
  const bound = bounds[index];
  if (!bound) return false;
  regex.lastIndex = 0;
  return regex.test(text.slice(bound.start, bound.end));
}

function nearAny(index, indexes, window) {
  return indexes.some((contextIndex) => Math.abs(contextIndex - index) <= window);
}

function overlaps(span, spans) {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

function digitRunLength(text, start, end) {
  let s = start;
  let e = end;
  // Newlines are row breaks. A card number and the next row's expiration are not one phone number.
  while (s > 0 && /[\d ().+\t-]/.test(text[s - 1])) s -= 1;
  while (e < text.length && /[\d ().+\t-]/.test(text[e])) e += 1;
  return text.slice(s, e).replace(/\D/g, '').length;
}

// Prices, phones, and clock times stay visible. A 3-digit total next to the word
// "card" is not an expiration; a 10-digit number is not a security code.
function isProtectedNumber(text, start, end) {
  const before = text.slice(Math.max(0, start - 8), start);
  const after = text.slice(end, Math.min(text.length, end + 16));
  if (/\$\s*$/.test(before)) return true;
  if (/\d,$/.test(before) || /^,\d/.test(after)) return true;
  if (/^\s*(?:dollars?|bucks|cents|percent)\b/i.test(after)) return true;
  if ((text[start - 1] || '') === ':' || (text[end] || '') === ':') return true;
  if (digitRunLength(text, start, end) >= 10) return true;
  return false;
}

function validExpirationDigits(digits) {
  if (digits.length === 3) return digits[0] >= '1' && digits[0] <= '9';
  if (digits.length === 4) {
    const month = Number(digits.slice(0, 2));
    return month >= 1 && month <= 12 && !/^(?:19|20)/.test(digits);
  }
  return false;
}

function tryAdd(spans, blocked, span) {
  if (!span) return;
  if (overlaps(span, blocked) || overlaps(span, spans)) return;
  spans.push(span);
}

function decodeSpoken(words) {
  let digits = '';
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (TENS[word]) {
      const next = words[i + 1];
      if (next && ONES[next]) {
        digits += TENS[word] + ONES[next];
        i += 1;
      } else {
        digits += `${TENS[word]}0`;
      }
    } else if (TEENS[word]) {
      digits += TEENS[word];
    } else if (ONES[word]) {
      digits += ONES[word];
    } else {
      return '';
    }
  }
  return digits;
}

function spokenGroups(text) {
  const tokens = [];
  SPOKEN_WORD_RE.lastIndex = 0;
  let match = SPOKEN_WORD_RE.exec(text);
  while (match) {
    tokens.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
    match = SPOKEN_WORD_RE.exec(text);
  }
  const groups = [];
  let group = [];
  for (const token of tokens) {
    if (!group.length) {
      group.push(token);
      continue;
    }
    const gap = text.slice(group[group.length - 1].end, token.start);
    if (/^[\s-]+$/.test(gap)) group.push(token);
    else {
      groups.push(group);
      group = [token];
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

function findCvvSpans(text, blocked) {
  const spans = [];
  CVV_ANCHOR_RE.lastIndex = 0;
  let anchor = CVV_ANCHOR_RE.exec(text);
  while (anchor) {
    if (!insideRedactionToken(text, anchor.index)) {
      const from = anchor.index + anchor[0].length;
      const window = text.slice(from, from + 40);
      const numeric = /\b\d{3,4}\b/g;
      let picked = null;
      let digit = numeric.exec(window);
      while (digit) {
        const start = from + digit.index;
        const end = start + digit[0].length;
        const year = digit[0].length === 4 && /^(?:19|20)/.test(digit[0]);
        if (!year && !isProtectedNumber(text, start, end)) {
          picked = { start, end, token: '[REDACTED-CVV]' };
          break;
        }
        digit = numeric.exec(window);
      }
      if (!picked) {
        const spoken = SPOKEN_CVV_RE.exec(window);
        if (spoken && !/^\s*(?:dollars?|bucks|percent)\b/i.test(window.slice(spoken.index + spoken[0].length))) {
          picked = { start: from + spoken.index, end: from + spoken.index + spoken[0].length, token: '[REDACTED-CVV]' };
        }
      }
      tryAdd(spans, blocked, picked);
    }
    anchor = CVV_ANCHOR_RE.exec(text);
  }
  return spans;
}

function findExtraSpans(text, blocked, bounds) {
  const spans = findCvvSpans(text, blocked);
  const expWords = matchIndexes(text, EXP_WORD_RE);
  const cardish = matchIndexes(text, CARDISH_RE);
  const cardEnds = blocked.map((span) => span.end);
  const cardUtterances = new Set();
  for (const span of blocked) {
    const index = utteranceIndexAt(bounds, span.start);
    if (index >= 0) cardUtterances.add(index);
  }

  function around(index, setName) {
    const ui = utteranceIndexAt(bounds, index);
    if (ui < 0) return false;
    const regex = setName === 'exp' ? EXP_WORD_RE : CARDISH_RE;
    return sliceHas(text, bounds, ui, regex)
      || sliceHas(text, bounds, ui - 1, regex)
      || sliceHas(text, bounds, ui + 1, regex);
  }

  function cardNearby(index) {
    if (nearAny(index, cardEnds, 120)) return true;
    const ui = utteranceIndexAt(bounds, index);
    return ui >= 0 && (cardUtterances.has(ui) || cardUtterances.has(ui - 1) || cardUtterances.has(ui + 1));
  }

  // Slash and dash dates. The word "card" is not enough: "due 10/15" beside
  // "credit card" is a calendar date.
  function separatorContext(index) {
    if (nearAny(index, expWords, 80) || cardNearby(index)) return true;
    const ui = utteranceIndexAt(bounds, index);
    return ui >= 0 && sliceHas(text, bounds, ui, EXP_WORD_RE);
  }

  // Spoken, spaced, and compact forms. "card" / "security" / "on the back"
  // count here, including the previous or next transcript row.
  function looseContext(index) {
    if (separatorContext(index) || nearAny(index, cardish, 80) || around(index, 'card')) return true;
    const ui = utteranceIndexAt(bounds, index);
    if (ui < 0) return false;
    return sliceHas(text, bounds, ui, EXP_WORD_RE)
      || sliceHas(text, bounds, ui - 1, EXP_WORD_RE)
      || sliceHas(text, bounds, ui + 1, EXP_WORD_RE);
  }

  function considerDigits(match, contextOk, validate) {
    if (!contextOk(match.index)) return;
    const end = match.index + match[0].length;
    // 12/26/2026 is a calendar date. 12/2026 and 12/26 are expirations.
    if (!validate && /\/\d/.test(text.slice(end, end + 6))) return;
    if (validate && !validExpirationDigits(match[0].replace(/\D/g, ''))) return;
    if (isProtectedNumber(text, match.index, end)) return;
    tryAdd(spans, blocked, { start: match.index, end, token: '[REDACTED-EXP]' });
  }

  EXP_SEPARATOR_RE.lastIndex = 0;
  let match = EXP_SEPARATOR_RE.exec(text);
  while (match) {
    considerDigits(match, separatorContext, false);
    match = EXP_SEPARATOR_RE.exec(text);
  }
  for (const regex of [EXP_COMPACT_RE, EXP_SPACED_RE]) {
    regex.lastIndex = 0;
    match = regex.exec(text);
    while (match) {
      considerDigits(match, looseContext, true);
      match = regex.exec(text);
    }
  }

  EXP_MONTH_RE.lastIndex = 0;
  match = EXP_MONTH_RE.exec(text);
  while (match) {
    if (looseContext(match.index)) {
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 16);
      if (!/^\s*(?:dollars?|bucks|percent)\b/i.test(after)) {
        tryAdd(spans, blocked, {
          start: match.index,
          end: match.index + match[0].length,
          token: '[REDACTED-EXP]',
        });
      }
    }
    match = EXP_MONTH_RE.exec(text);
  }

  for (const group of spokenGroups(text)) {
    const decodedAll = decodeSpoken(group.map((token) => token.word));
    // A longer run is a card number or a phone number spelled out, not an expiration.
    if (group.length > 4 || decodedAll.length > 4) continue;
    let best = null;
    for (let length = Math.min(4, group.length); length >= 2; length -= 1) {
      for (let i = 0; i + length <= group.length; i += 1) {
        const slice = group.slice(i, i + length);
        const digits = decodeSpoken(slice.map((token) => token.word));
        if (!validExpirationDigits(digits)) continue;
        const start = slice[0].start;
        const end = slice[slice.length - 1].end;
        if (!looseContext(start) || isProtectedNumber(text, start, end)) continue;
        const after = text.slice(end, end + 16);
        if (/^\s*(?:dollars?|bucks|percent)\b/i.test(after)) continue;
        if (!best || (end - start) > (best.end - best.start)) best = { start, end, token: '[REDACTED-EXP]' };
      }
    }
    tryAdd(spans, blocked, best);
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
  const already = ALREADY_RE.test(joined);
  const cardSpans = findCardSpans(joined);
  const extraSpans = findExtraSpans(joined, cardSpans, utteranceBounds(texts));
  const spans = cardSpans.concat(extraSpans);
  const masked = spans.length > 0 || already;
  const review = false; // never hold or withhold on wording
  const flagged = masked;
  const nextTexts = spans.length ? applySpans(texts, spans) : texts;
  return {
    transcript: spans.length ? writeBack(raw, nextTexts) : raw,
    masked: spans.length > 0 || already,
    review,
    flagged,
  };
}

module.exports = {
  redactTranscript,
  luhnOk,
};
