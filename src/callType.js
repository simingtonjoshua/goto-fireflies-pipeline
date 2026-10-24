// Decides who a call was with before the summary is written.
//
// Strong signals, in order: a roster extension, a phone learned from GoTo's user
// record or a private roster file, GoTo's own party name, then a Heymarket contact
// whose display name matches a roster full name. The transcript is the fallback:
// the other party introducing themselves as a roster member, talking about "the
// customer" as someone else, or a vendor company introduction / vendor phone menu.
// A customer or prospect is the default, and that path keeps the existing prompt.
//
// Personal numbers are not stored in git. Vendors are not a phone directory —
// they are recognized from what was said.

const BUSINESS_NAME = /budget\s*(?:blinds|lines|minds|binds|lions|blends|blind)\b/i;

const GENERIC_PARTY_NAME = /^(wireless caller|unknown|unavailable|private|anonymous|toll free call|toll free|caller|no name|restricted|cid unavailable)$/i;

const VENDOR_IVR = /\b(dedicated support line|estimated wait time|save your place in line|welcome to bright)\b/i;

const VENDOR_REACHED = /\byou have reached\b[\s\S]{0,80}\bsupport\b/i;

const VENDOR_HINT = /\b(back\s?orders?|purchase orders?|po\s*(?:number|#)|accounts payable|accounts receivable|order desk)\b/i;

const STAFF_TALK = /\b(?:the|our|that|this)\s+(?:customer|client|homeowner)\b|\b(?:heading|going|on my way)\s+to\s+the\s+(?:job|install|measure)\b|\b(?:on|at)\s+the\s+(?:install|measure)\b/i;

const COMPANY_INTRO = /\b(?:this is|i'm|i am|my name is)\s+[a-z][a-z']+(?:\s+[a-z][a-z']+){0,2}\s+(?:from|with|at)\s+([a-z0-9][a-z0-9&.' -]{1,60})/gi;

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

function companyFrom(text) {
  const found = [];
  const re = new RegExp(COMPANY_INTRO.source, 'gi');
  let match = re.exec(text);
  while (match) {
    let company = String(match[1] || '').split(/[.,!?;]/)[0];
    company = company.split(/\b(?:and|to|about|regarding|calling|for)\b/i)[0];
    company = company.trim().split(/\s+/).slice(0, 4).join(' ');
    if (company && !BUSINESS_NAME.test(company)) found.push(company);
    match = re.exec(text);
  }
  return found[0] || null;
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
  return STAFF_TALK.test(cleaned);
}

function vendorIvr(rows) {
  const text = joined(rows);
  if (VENDOR_IVR.test(text) || VENDOR_REACHED.test(text)) return true;
  // "Thank you for calling Hunter Douglas" is a vendor menu. Our own greeting
  // says Budget Blinds and stays a customer call.
  return /\bthank you for calling\b/i.test(text) && !BUSINESS_NAME.test(text);
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

  if (VENDOR_HINT.test(externalText) || VENDOR_HINT.test(teamText)) {
    return result('unknown', 'transcript-hint', null);
  }

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
  formatCallNote,
  labelFor,
  CALL_TYPE_LABELS,
};
