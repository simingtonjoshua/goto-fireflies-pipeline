// Decides who a call was with before the summary is written.
//
// Strong signals, in order: a roster extension, a phone learned from GoTo's user
// record or a private roster file, GoTo's own party name, then a contact name
// passed in whose display name matches a roster full name. The transcript is a
// fallback only when the signal is strong: the other party uses a roster full
// name, two distinct first-person coworker signals, a real
// "this is <Name> from/with <Company>" introduction, or a specific vendor menu.
// One mention of "the customer", "our customer", "the homeowner", or "on the
// install" is not an internal call. "Calling from", "here with", a street, a
// place, "my cell", and "my husband" are not a vendor. Order words such as
// backorder, purchase order, and order desk stay on the customer prompt.
// A customer or prospect is the default.
//
// Personal numbers are not stored in git. Vendors are not a phone directory —
// they are recognized from what was said.

const BUSINESS_NAME = /budget\s*(?:blinds|brinds|lines|minds|binds|lions|blends|blind)\b/i;

const GENERIC_PARTY_NAME = /^(wireless caller|unknown|unavailable|private|anonymous|toll free call|toll free|caller|no name|restricted|cid unavailable)$/i;

const VENDOR_IVR = /\b(dedicated support line|estimated wait time|save your place in line|welcome to bright)\b/i;

const VENDOR_REACHED = /\byou have reached\b[\s\S]{0,80}\bsupport\b/i;

// "This is <Person> from/with <Company>" only. "I'm calling from…", "here with…",
// and "at <street>" are customer speech and are not matched here.
const COMPANY_INTRO = /\bthis is\s+([a-z][a-z']+(?:\s+[a-z][a-z']+){0,2})\s+(?:from|with)\s+([a-z0-9][a-z0-9&.'’ -]{1,60})/gi;

const NOT_A_PERSON = new Set([
  'calling', 'here', 'just', 'now', 'still', 'also', 'someone', 'somebody', 'there', 'this',
]);

const PERSONAL_COMPANY = /^(my|our|his|her|their|the|a|an)\b|\b(cell|cellphone|mobile|phone|husband|wife|spouse|mom|dad|mother|father|boyfriend|girlfriend|friend|neighbor|neighbour)\b/i;

const STREET_ADDRESS = /^\d|\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|circle|cir|place|pl|terrace|ter|parkway|pkwy|highway|hwy)\b/i;

const PLACE_LAST_WORD = /^(grove|heights|hills|creek|valley|beach|springs|village|ridge|acres|meadows|falls|lake|lakes|landing|harbor|harbour|island|islands|ranch|estates|manor|woods|junction|crossing|prairie|mesa|canyon|bluff|bluffs|shore|shores|county|parish|gardens|garden|park)$/i;

const PLACE_NAMES = new Set([
  'sacramento', 'roseville', 'folsom', 'davis', 'auburn', 'rocklin', 'lincoln', 'woodland',
  'galt', 'lodi', 'stockton', 'modesto', 'tracy', 'manteca', 'carmichael', 'orangevale',
  'antelope', 'natomas', 'reno', 'sparks', 'tahoe', 'california', 'elk grove',
  'rancho cordova', 'citrus heights', 'fair oaks', 'granite bay', 'el dorado hills',
  'west sacramento', 'north highlands', 'rio linda', 'elverta', 'cameron park',
  'placerville', 'loomis',
]);

// First-person coworker logistics. "The customer", "our customer", "the homeowner",
// and "on the install" are not in this list: an outside caller says those about
// their own job. Two different signals are required. One is still a customer call.
const STRONG_STAFF_SIGNALS = [
  /\b(?:i'm|i am|we're|we are)\s+(?:heading|going|on my way)\s+to\s+(?:the\s+)?(?:job|install|measure)\b/i,
  /\b(?:i'll|i will|we'll|we will)\s+(?:meet you|see you|be there)\s+(?:at|for)\s+the\s+(?:job|install|measure)\b/i,
  /\b(?:bring|bringing|grab|grabbing)\s+the\s+(?:paperwork|invoice|samples)\b/i,
];

const CALL_TYPE_LABELS = {
  customer: 'Customer',
  internal: 'Internal team',
  vendor: 'Vendor',
  other: 'Other',
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelFor(type) {
  return CALL_TYPE_LABELS[type] || CALL_TYPE_LABELS.other;
}

function result(type, source, partyName) {
  return {
    type,
    label: labelFor(type),
    source: source || null,
    partyName: partyName || null,
  };
}

function pathText(csrPath) {
  return (csrPath || []).join(' ').toLowerCase();
}

function isCredited(name, csrPath) {
  const cleaned = String(name || '').trim().toLowerCase();
  if (!cleaned) return false;
  return pathText(csrPath).includes(cleaned);
}

function usablePartyName(name) {
  const text = String(name || '').trim();
  if (!text || GENERIC_PARTY_NAME.test(text)) return null;
  if (/^[\d\s()+.-]+$/.test(text)) return null;
  return text;
}

function contactName(contact) {
  if (!contact || typeof contact !== 'object') return null;
  const combined = [contact.first, contact.last].filter(Boolean).join(' ');
  for (const candidate of [contact.display_name, contact.name, combined]) {
    const usable = usablePartyName(candidate);
    if (usable) return usable;
  }
  return null;
}

function rosterMatch(name, book) {
  if (!book || typeof book.matchTeamName !== 'function') return null;
  const usable = usablePartyName(name);
  if (!usable) return null;
  return book.matchTeamName(usable);
}

function externalRows(rows) {
  return (rows || []).filter((row) => row && (row.label === 'Customer' || String(row.label || '').startsWith('Channel ')));
}

function teamRows(rows) {
  return (rows || []).filter((row) => {
    if (!row || !row.label || row.label === 'Recording') return false;
    if (row.label === 'Customer' || String(row.label).startsWith('Channel ')) return false;
    return true;
  });
}

function joined(rows) {
  return (rows || []).map((row) => row.text || '').join('\n');
}

function plausiblePerson(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.every((word) => (
    /^[a-z][a-z']+$/i.test(word) && !NOT_A_PERSON.has(word.toLowerCase())
  ));
}

function isPlace(text) {
  const normalized = String(text || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const last = normalized.split(' ').pop();
  if (PLACE_LAST_WORD.test(last)) return true;
  if (PLACE_NAMES.has(normalized)) return true;
  const stripped = normalized.replace(/^(north|south|east|west|greater|downtown)\s+/, '');
  return stripped !== normalized && PLACE_NAMES.has(stripped);
}

function plausibleCompany(company) {
  const text = String(company || '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (BUSINESS_NAME.test(text)) return false;
  if (PERSONAL_COMPANY.test(text)) return false;
  if (STREET_ADDRESS.test(text)) return false;
  if (isPlace(text)) return false;
  return true;
}

function companyFrom(text) {
  const re = new RegExp(COMPANY_INTRO.source, 'gi');
  let match = re.exec(text);
  while (match) {
    const person = String(match[1] || '').trim();
    let company = String(match[2] || '').split(/[.,!?;]/)[0];
    company = company.split(/\b(?:and|to|about|regarding|calling|for)\b/i)[0];
    company = company.trim().split(/\s+/).slice(0, 4).join(' ');
    if (plausiblePerson(person) && plausibleCompany(company)) return company;
    match = re.exec(text);
  }
  return null;
}

function transcriptTeam(externalText, teamText, book) {
  const people = book && typeof book.listPeople === 'function' ? book.listPeople() : [];
  const seen = new Set();
  for (const person of people) {
    const name = String(person.name || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const selfId = new RegExp(`\\b(?:this is|i'm|i am|my name is)\\s+${escapeRegExp(name)}\\b`, 'i');
    if (selfId.test(externalText)) return person;
    const addressed = new RegExp(`\\b(?:hey|hi|hello),?\\s+${escapeRegExp(name)}\\b`, 'i');
    if (addressed.test(teamText)) return person;
  }
  return null;
}

function staffTalk(text) {
  const cleaned = String(text || '').replace(/\b(?:i am|i'm)\s+the\s+customer\b/gi, '');
  const hits = STRONG_STAFF_SIGNALS.filter((pattern) => pattern.test(cleaned)).length;
  return hits >= 2;
}

function vendorIvr(rows) {
  const text = joined(rows);
  // A "thank you for calling …" greeting is not a vendor menu. A garbled
  // "Thank you for calling Budget Brinds of Sacramento" is still our customer line.
  return VENDOR_IVR.test(text) || VENDOR_REACHED.test(text);
}

function otherPartyOf(legRecords, explicit) {
  if (explicit && (explicit.name || explicit.extension)) return explicit;
  for (const leg of legRecords || []) {
    if (leg && leg.otherParty && (leg.otherParty.name || leg.otherParty.extension)) return leg.otherParty;
  }
  return null;
}

function classifyCall({
  rows,
  legRecords,
  externalNumber,
  externalName,
  contactName: namedContact,
  otherParty,
  csrPath,
  roster,
} = {}) {
  const book = roster;
  const path = csrPath || [];
  const knownOther = otherPartyOf(legRecords, otherParty);

  if (knownOther && !isCredited(knownOther.name, path)) {
    return result('internal', knownOther.matchedBy || 'goto', knownOther.name || null);
  }

  if (book && typeof book.personByPhone === 'function') {
    const byPhone = book.personByPhone(externalNumber);
    if (byPhone && !isCredited(byPhone.name, path)) {
      return result('internal', 'phone', byPhone.name || null);
    }
  }

  if (book && typeof book.personByExtension === 'function') {
    const byExtension = book.personByExtension(externalNumber);
    if (byExtension && !isCredited(byExtension.name, path)) {
      return result('internal', 'extension', byExtension.name || null);
    }
  }

  for (const candidate of [namedContact, externalName]) {
    const person = rosterMatch(candidate, book);
    if (person && !isCredited(person.name, path)) {
      return result('internal', candidate === namedContact ? 'contact-name' : 'caller-id-name', person.name);
    }
  }

  const externalText = joined(externalRows(rows));
  const teamText = joined(teamRows(rows));
  const allRows = rows || [];

  if (vendorIvr(allRows)) return result('vendor', 'transcript-ivr', null);
  const company = companyFrom(externalText);
  if (company) return result('vendor', 'transcript-company', company);

  const named = transcriptTeam(externalText, teamText, book);
  if (named && !isCredited(named.name, path)) {
    return result('internal', 'transcript-name', named.name);
  }
  if (staffTalk(externalText)) return result('internal', 'transcript-staff', null);

  return result('customer', 'default', null);
}

function parseCallTypeLine(summary) {
  const match = String(summary || '').match(/^\s*call type\s*:\s*([^\n]+)/i);
  if (!match) return null;
  const value = match[1].trim().toLowerCase();
  if (value.startsWith('customer')) return 'customer';
  if (value.startsWith('internal')) return 'internal';
  if (value.startsWith('vendor') || value.startsWith('supplier')) return 'vendor';
  if (value.startsWith('other') || value.startsWith('unknown')) return 'other';
  return null;
}

function stripCallTypeLine(summary) {
  return String(summary || '').replace(/^\s*call type\s*:\s*[^\n]*\n*/i, '').trim();
}

// Ambiguous calls stay Customer. Other and unknown from the model are Customer.
// A decided internal or vendor classification is kept. Vendor or internal is
// taken from the model only when this call was not already classified.
function callTypeForNote(classifiedType, summary) {
  if (classifiedType === 'customer' || classifiedType === 'internal' || classifiedType === 'vendor') {
    return classifiedType;
  }
  const parsed = parseCallTypeLine(summary);
  if (parsed === 'internal' || parsed === 'vendor') return parsed;
  return 'customer';
}

function formatCallNote({ summary, callTypeLabel, folderLink }) {
  const lines = [`Call type: ${callTypeLabel || CALL_TYPE_LABELS.other}`, '', String(summary || '').trim()];
  if (folderLink) lines.push('', `Call recording & transcript: ${folderLink}`);
  return lines.join('\n');
}

module.exports = {
  classifyCall,
  contactName,
  parseCallTypeLine,
  stripCallTypeLine,
  callTypeForNote,
  formatCallNote,
  labelFor,
  CALL_TYPE_LABELS,
};
