// Optional Pipedrive lookup by phone. Used so an outbound follow-up that books
// a consultation can cite the deal (id and title) on the call header.
//
// PIPEDRIVE_API_TOKEN is optional. When it is unset, or the lookup fails, this
// returns no deals and the caller leaves the Pipedrive line blank. Nothing here
// is allowed to block the transcript Doc or the Heymarket note.

const fetch = require('node-fetch');

const API_BASE = 'https://api.pipedrive.com/v1';

let request = fetch;

function setFetchForTests(fn) {
  request = typeof fn === 'function' ? fn : fetch;
}

function resetForTests() {
  request = fetch;
}

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length >= 10 ? national.slice(-10) : '';
}

function samePhone(left, right) {
  const a = last10(left);
  const b = last10(right);
  return Boolean(a) && a === b;
}

function personPhones(item) {
  const phones = [];
  if (!item || typeof item !== 'object') return phones;
  if (Array.isArray(item.phones)) phones.push(...item.phones);
  if (Array.isArray(item.phone)) phones.push(...item.phone);
  return phones.map((value) => {
    if (value && typeof value === 'object') return String(value.value || '');
    return String(value || '');
  }).filter(Boolean);
}

function token() {
  return String(process.env.PIPEDRIVE_API_TOKEN || '').trim();
}

async function pipedriveGet(path) {
  const res = await request(`${API_BASE}${path}`, {
    headers: {
      'x-api-token': token(),
      Accept: 'application/json',
    },
    timeout: 8000,
  });
  if (!res.ok) {
    const body = typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`Pipedrive ${path.split('?')[0]} failed (${res.status}): ${String(body).slice(0, 300)}`);
  }
  return res.json();
}

function rank(deal) {
  const open = String(deal && deal.status || '').toLowerCase() === 'open' ? 0 : 1;
  const updated = Date.parse((deal && (deal.update_time || deal.add_time)) || '') || 0;
  return { open, updated };
}

function sortDeals(deals) {
  return [...deals].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left.open !== right.open) return left.open - right.open;
    return right.updated - left.updated;
  });
}

async function findDealsByPhone(phone) {
  if (!token()) return [];
  const digits = last10(phone);
  if (!digits) return [];
  try {
    const search = await pipedriveGet(
      `/persons/search?term=${encodeURIComponent(digits)}&fields=phone&limit=10`,
    );
    const items = (search && search.data && search.data.items) || [];
    const people = [];
    for (const row of items) {
      const item = row && (row.item || row);
      if (!item || item.id == null) continue;
      if (!personPhones(item).some((value) => samePhone(value, digits))) continue;
      people.push(item);
      if (people.length === 3) break;
    }
    const deals = [];
    for (const person of people) {
      const body = await pipedriveGet(`/persons/${encodeURIComponent(person.id)}/deals?status=all_not_deleted&limit=50`);
      const rows = Array.isArray(body && body.data) ? body.data : [];
      for (const deal of rows) {
        if (!deal || deal.id == null) continue;
        deals.push({
          id: deal.id,
          title: deal.title || '',
          status: deal.status || '',
          update_time: deal.update_time || deal.add_time || '',
        });
      }
    }
    return sortDeals(deals);
  } catch (err) {
    console.error(`Pipedrive lookup failed (deal reference left blank): ${err.message}`);
    return [];
  }
}

module.exports = {
  findDealsByPhone,
  setFetchForTests,
  resetForTests,
  last10,
};
