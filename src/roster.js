// Extension-to-person roster. Names and extensions live in config/team-roster.json
// (or TEAM_ROSTER_JSON / TEAM_ROSTER_PATH). Phone numbers for the main line and the
// forwarded former-rep cell are NOT stored here — the repo is public. Set them in
// SYSTEM_PHONE_NUMBERS so those lines are treated as system audio, not a person.
//
// Personal cells for designers, installers, and other staff who are not an extension
// live in TEAM_MEMBER_PHONES (a JSON map of number -> {name, role}). Those numbers
// are loaded into this roster at startup and are never written to the config file.
// A phone-only person is not added to first-name lists used for channel correction:
// "this is Will" from a designer calling in must not be treated as the answering line.
//
// GoTo userKey values are learned at runtime from GET /users/v1/users (cached on the
// matching extension) and are never written back to the config file.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'team-roster.json');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

// Extensions on this account are five digits with leading zeros (00001–00007).
// A 10-digit DID is not an extension. "6" and "00006" are the same extension.
function normalizeExtension(value) {
  const digits = digitsOnly(value);
  if (!digits || digits.length > 6) return null;
  return digits.padStart(5, '0');
}

function last10(value) {
  const digits = digitsOnly(value);
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// "Bullock, James" and extra spaces still match the roster's "James Bullock".
function normalizePartyName(value) {
  let text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const comma = text.match(/^([A-Za-z][A-Za-z']+),\s*([A-Za-z][A-Za-z']+(?:\s+[A-Za-z][A-Za-z']+)*)$/);
  if (comma) text = `${comma[2]} ${comma[1]}`;
  return text.toLowerCase();
}

function collectUserPhones(user) {
  const values = [];
  const push = (value) => {
    if (value == null) return;
    if (typeof value === 'object') {
      push(value.number);
      push(value.phoneNumber);
      push(value.directNumber);
      push(value.callerId);
      return;
    }
    values.push(value);
  };
  if (!user || typeof user !== 'object') return values;
  push(user.mobile);
  push(user.mobilePhone);
  push(user.directNumber);
  for (const key of ['lines', 'extensions', 'phoneNumbers', 'phones']) {
    for (const item of user[key] || []) push(item);
  }
  return values;
}

class Roster {
  constructor(config = {}, systemNumbers = []) {
    this.people = [];
    this.byExtension = new Map();
    this.byUserKey = new Map();
    this.byPhone = new Map();
    this.firstNames = [];
    this.systemNumbers = new Set();
    for (const raw of systemNumbers) {
      const ten = last10(raw);
      if (ten) this.systemNumbers.add(ten);
    }
    for (const person of config.people || []) this.addPerson(person);
  }

  addPerson(person) {
    const extension = normalizeExtension(person.extension);
    const role = String(person.role || '').trim();
    const entry = {
      name: person.name,
      extension,
      role: role || null,
      heymarketUserId: person.heymarketUserId || null,
      recordedGreeting: Boolean(person.recordedGreeting),
      userKey: person.userKey || null,
      phones: new Set(),
    };
    this.people.push(entry);
    if (extension) this.byExtension.set(extension, entry);
    if (entry.userKey) this.byUserKey.set(String(entry.userKey), entry);
    for (const raw of person.phones || []) this.rememberPhone(entry, raw);
    // First names drive inbound channel correction ("this is Josh" is the answering
    // line). A designer who only has a cell is the outside party, so their first
    // name must not flip that channel.
    if (!extension) return;
    const first = String(person.name || '').trim().split(/\s+/)[0];
    if (first && !this.firstNames.includes(first)) this.firstNames.push(first);
    if (first === 'Joshua' && !this.firstNames.includes('Josh')) this.firstNames.push('Josh');
  }

  // A 10-digit DID or cell learned from GoTo (or a private roster file) is a team
  // line. Extensions and the published system numbers are not stored here. Nothing
  // is written back to the config file — the repo is public.
  rememberPhone(entry, number) {
    if (!entry) return false;
    const digits = digitsOnly(number);
    if (!digits || digits.length <= 6) return false;
    const ten = last10(number);
    if (!ten || this.isSystemNumber(number)) return false;
    if (!entry.phones) entry.phones = new Set();
    entry.phones.add(ten);
    this.byPhone.set(ten, entry);
    return true;
  }

  personByPhone(number) {
    const ten = last10(number);
    if (!ten) return null;
    return this.byPhone.get(ten) || null;
  }

  // Link a GoTo users-API record to a configured extension. Does not invent people
  // the config doesn't list — an unknown line stays unresolved until it's added.
  // A 403 from GET /users/v1/users leaves this empty. Call history and call-state
  // can still name the person by extension without a userKey.
  // Any 10-digit number on that same user record is remembered as their phone.
  indexApiUser(user) {
    const userKey = user && (user.userKey || user.key);
    if (!userKey || !user) return false;
    const lines = [];
    if (Array.isArray(user.lines)) lines.push(...user.lines);
    if (Array.isArray(user.extensions)) lines.push(...user.extensions);
    if (user.extensionNumber || user.extension) lines.push(user);
    let linked = false;
    const linkedEntries = [];
    for (const line of lines) {
      const raw = line && typeof line === 'object'
        ? (line.number || line.extensionNumber || line.extension)
        : line;
      const extension = normalizeExtension(raw);
      const known = extension && this.byExtension.get(extension);
      if (!known) continue;
      known.userKey = String(userKey);
      this.byUserKey.set(String(userKey), known);
      if (!linkedEntries.includes(known)) linkedEntries.push(known);
      linked = true;
    }
    if (linked) {
      for (const value of collectUserPhones(user)) {
        for (const entry of linkedEntries) this.rememberPhone(entry, value);
      }
    }
    return linked;
  }

  peopleNamed(name) {
    const target = normalizePartyName(name);
    if (!target) return [];
    const matches = [];
    for (const entry of this.people) {
      if (normalizePartyName(entry.name) === target) matches.push(entry);
    }
    return matches;
  }

  // Full name, including "Last, First" and a middle initial ("James C Bullock").
  // A first name alone does not match. Two different people matching the same
  // tokens do not match. Two extensions for one name (Amy) still match.
  matchTeamName(name) {
    const normalized = normalizePartyName(name);
    if (!normalized) return null;
    const exact = this.peopleNamed(normalized);
    const chosen = exact.length ? exact : this.peopleMatchingTokens(normalized);
    const distinct = new Set(chosen.map((entry) => String(entry.name || '').toLowerCase()));
    if (distinct.size !== 1) return null;
    return chosen[0];
  }

  peopleMatchingTokens(normalized) {
    const tokens = normalized.split(' ').filter((token) => token.length > 1 && !/^(jr|sr|ii|iii|iv)$/.test(token));
    if (tokens.length < 2) return [];
    const found = [];
    const seen = new Set();
    for (const entry of this.people) {
      const key = String(entry.name || '').toLowerCase();
      if (seen.has(key)) continue;
      const parts = normalizePartyName(entry.name).split(' ').filter(Boolean);
      if (parts.length < 2) continue;
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (tokens.includes(first) && tokens.includes(last)) {
        seen.add(key);
        found.push(entry);
      }
    }
    return found;
  }

  listPeople() {
    return this.people.slice();
  }

  // Full-name match. Two extensions for one name (Amy's desk and home office)
  // stay unresolved until an extension is present. Call history uses this so a
  // name beside a caller-id DID is not guessed onto the wrong line.
  personByName(name) {
    const matches = this.peopleNamed(name);
    if (matches.length === 1) return matches[0];
    return null;
  }

  // First configured line for a full name. Amy Bullock is 00001 in the roster
  // and 00005 is her home office, listed second. Used when the only signal is
  // the spoken name and GoTo did not say which extension.
  primaryByName(name) {
    return this.peopleNamed(name)[0] || null;
  }

  personByExtension(value) {
    const extension = normalizeExtension(value);
    if (!extension) return null;
    return this.byExtension.get(extension) || null;
  }

  personByUserKey(userKey) {
    if (!userKey) return null;
    return this.byUserKey.get(String(userKey)) || null;
  }

  isSystemNumber(value) {
    const ten = last10(value);
    if (!ten) return false;
    return this.systemNumbers.has(ten);
  }

  extensionFrom(value) {
    if (this.isSystemNumber(value)) return null;
    return normalizeExtension(value);
  }
}

function loadConfigFromDisk() {
  if (process.env.TEAM_ROSTER_JSON) {
    return JSON.parse(process.env.TEAM_ROSTER_JSON);
  }
  const file = process.env.TEAM_ROSTER_PATH || DEFAULT_PATH;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { people: [] };
}

function systemNumbersFromEnv() {
  return String(process.env.SYSTEM_PHONE_NUMBERS || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// TEAM_MEMBER_PHONES is a JSON object keyed by phone number:
// {"5555550100":{"name":"Alex Designer","role":"designer"}}
// An array of {phone,name,role} is accepted too. Blank is unset. Invalid JSON is
// ignored so a bad value cannot crash startup. Nothing is written to disk.
function parseTeamMemberPhones(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('TEAM_MEMBER_PHONES is not valid JSON. No team-member cell numbers were loaded.');
    return [];
  }
  const items = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      items.push({ phone: item.phone || item.number, name: item.name, role: item.role });
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [phone, value] of Object.entries(parsed)) {
      if (typeof value === 'string') items.push({ phone, name: value, role: null });
      else if (value && typeof value === 'object') items.push({ phone, name: value.name, role: value.role });
    }
  }
  const cleaned = [];
  for (const item of items) {
    const name = String(item.name || '').trim();
    const phone = String(item.phone || '').trim();
    const role = String(item.role || '').trim();
    if (!name || !last10(phone)) continue;
    cleaned.push({ phone, name, role: role || null });
  }
  return cleaned;
}

// Merges parsed TEAM_MEMBER_PHONES into a roster. An existing full name keeps its
// extension and gains the cell. A new name is phone-only. Returns how many numbers
// were stored.
function applyTeamMemberPhones(book, entries) {
  if (!book || typeof book.addPerson !== 'function') return 0;
  let applied = 0;
  for (const item of entries || []) {
    const ten = last10(item.phone);
    const name = String(item.name || '').trim();
    const role = String(item.role || '').trim();
    if (!ten || !name) continue;
    if (typeof book.isSystemNumber === 'function' && book.isSystemNumber(ten)) continue;
    const existing = typeof book.matchTeamName === 'function' ? book.matchTeamName(name) : null;
    if (existing) {
      if (role) existing.role = role;
      if (book.rememberPhone(existing, ten)) applied += 1;
      continue;
    }
    book.addPerson({ name, role: role || null, phones: [ten] });
    if (book.personByPhone(ten)) applied += 1;
  }
  return applied;
}

function loadActiveRoster() {
  const book = new Roster(loadConfigFromDisk(), systemNumbersFromEnv());
  applyTeamMemberPhones(book, parseTeamMemberPhones(process.env.TEAM_MEMBER_PHONES));
  return book;
}

let active = loadActiveRoster();

function getRoster() {
  return active;
}

function setRosterForTests(roster) {
  active = roster;
}

function resetRosterForTests() {
  active = loadActiveRoster();
}

function createRoster(config, systemNumbers) {
  return new Roster(config, systemNumbers || []);
}

// "Amy Bullock (00001)". A stored name with no extension uses the first
// configured line for that name. A name GoTo did not put on the roster stays
// "unknown ext".
function formatTeamMember(entry, book = active) {
  const name = (entry && entry.name) || 'unknown';
  let extension = (entry && entry.extension) || null;
  if (!extension && entry && entry.name && book && typeof book.primaryByName === 'function') {
    const person = book.primaryByName(entry.name);
    if (person && person.extension) extension = person.extension;
  }
  return `${name} (${extension || 'unknown ext'})`;
}

module.exports = {
  getRoster,
  setRosterForTests,
  resetRosterForTests,
  createRoster,
  formatTeamMember,
  normalizeExtension,
  digitsOnly,
  last10,
  parseTeamMemberPhones,
  applyTeamMemberPhones,
};
