// Extension-to-person roster. Names and extensions live in config/team-roster.json
// (or TEAM_ROSTER_JSON / TEAM_ROSTER_PATH). Phone numbers for the main line and the
// forwarded former-rep cell are NOT stored here — the repo is public. Set them in
// SYSTEM_PHONE_NUMBERS so those lines are treated as system audio, not a person.
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

class Roster {
  constructor(config = {}, systemNumbers = []) {
    this.byExtension = new Map();
    this.byUserKey = new Map();
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
    const entry = {
      name: person.name,
      extension,
      heymarketUserId: person.heymarketUserId || null,
      recordedGreeting: Boolean(person.recordedGreeting),
      userKey: person.userKey || null,
    };
    if (extension) this.byExtension.set(extension, entry);
    if (entry.userKey) this.byUserKey.set(String(entry.userKey), entry);
    const first = String(person.name || '').trim().split(/\s+/)[0];
    if (first && !this.firstNames.includes(first)) this.firstNames.push(first);
    if (first === 'Joshua' && !this.firstNames.includes('Josh')) this.firstNames.push('Josh');
  }

  // Link a GoTo users-API record to a configured extension. Does not invent people
  // the config doesn't list — an unknown line stays unresolved until it's added.
  // A 403 from GET /users/v1/users leaves this empty. Call history and call-state
  // can still name the person by extension without a userKey.
  indexApiUser(user) {
    const userKey = user && (user.userKey || user.key);
    if (!userKey || !user) return false;
    const lines = [];
    if (Array.isArray(user.lines)) lines.push(...user.lines);
    if (Array.isArray(user.extensions)) lines.push(...user.extensions);
    if (user.extensionNumber || user.extension) lines.push(user);
    let linked = false;
    for (const line of lines) {
      const raw = line && typeof line === 'object'
        ? (line.number || line.extensionNumber || line.extension)
        : line;
      const extension = normalizeExtension(raw);
      const known = extension && this.byExtension.get(extension);
      if (!known) continue;
      known.userKey = String(userKey);
      this.byUserKey.set(String(userKey), known);
      linked = true;
    }
    return linked;
  }

  // Full-name match. Two extensions for one name (Amy's desk and home office)
  // stay unresolved until an extension is present.
  personByName(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    const matches = [];
    for (const entry of this.byExtension.values()) {
      if (String(entry.name || '').trim().toLowerCase() === target) matches.push(entry);
    }
    if (matches.length === 1) return matches[0];
    return null;
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

let active = new Roster(loadConfigFromDisk(), systemNumbersFromEnv());

function getRoster() {
  return active;
}

function setRosterForTests(roster) {
  active = roster;
}

function resetRosterForTests() {
  active = new Roster(loadConfigFromDisk(), systemNumbersFromEnv());
}

function createRoster(config, systemNumbers) {
  return new Roster(config, systemNumbers || []);
}

module.exports = {
  getRoster,
  setRosterForTests,
  resetRosterForTests,
  createRoster,
  normalizeExtension,
  digitsOnly,
  last10,
};
