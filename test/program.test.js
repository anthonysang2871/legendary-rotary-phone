'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, isExpired } = require('../src/engine');
const { CardProgram, ValidationError, NotFoundError } = require('../src/program');
const { SimulatorIssuer } = require('../src/issuer/simulator');
const { createServer, loadIssuer } = require('../src/server');

const NOW = Date.UTC(2026, 10, 13, 12);
const charge = (over = {}) => ({
  amountCents: 5000, channel: 'in_store',
  merchant: { name: 'Harbor Grill', category: 'dining', country: 'US' },
  ...over,
});

async function setup(limit = 100_000) {
  let now = NOW;
  const clock = () => now;
  const program = new CardProgram(new SimulatorIssuer(clock), clock);
  const card = await program.issueCard({ cardholderName: 'Test Holder', creditLimitCents: limit });
  return { program, card, advance: (ms) => { now += ms; } };
}

test('approves a normal charge, updates balance and earns category points', async () => {
  const { program, card } = await setup();
  const t = program.authorize(card.id, charge({ amountCents: 12_050 }));
  assert.equal(t.approved, true);
  assert.equal(t.pointsEarned, 120 * 4); // whole dollars × dining rate
  assert.equal(card.balanceCents, 12_050);
  assert.equal(card.points, 480);
});

test('each control declines with its own reason and leaves the balance alone', async () => {
  const { program, card } = await setup();
  const cases = [
    [{ status: 'frozen' }, charge(), 'card_frozen'],
    [{ status: 'active', online: false }, charge({ channel: 'online' }), 'online_blocked'],
    [{ international: false }, charge({ merchant: { name: 'Cafe', category: 'dining', country: 'FR' } }), 'international_blocked'],
    [{ blockedCategories: ['travel'] }, charge({ merchant: { name: 'Air', category: 'travel', country: 'US' } }), 'category_blocked'],
    [{ perChargeCapCents: 4000 }, charge(), 'over_charge_cap'],
  ];
  for (const [patch, req, code] of cases) {
    await program.updateCard(card.id, patch);
    assert.equal(program.authorize(card.id, req).code, code);
  }
  assert.equal(card.balanceCents, 0);
  assert.equal(card.points, 0);
});

test('credit limit and daily limit count earlier approved charges', async () => {
  const { program, card, advance } = await setup(10_000);
  assert.equal(program.authorize(card.id, charge({ amountCents: 6000 })).approved, true);
  assert.equal(program.authorize(card.id, charge({ amountCents: 4001 })).code, 'over_daily_limit');

  await program.updateCard(card.id, { dailyLimitCents: 3000 });
  advance(86_400_000); // next day: daily spend resets, balance does not
  assert.equal(program.authorize(card.id, charge({ amountCents: 3000 })).approved, true);
  assert.equal(program.authorize(card.id, charge({ amountCents: 1 })).code, 'over_daily_limit');
  advance(86_400_000);
  assert.equal(program.authorize(card.id, charge({ amountCents: 1001 })).code, 'insufficient_credit');
  assert.equal(program.authorize(card.id, charge({ amountCents: 1000 })).approved, true);
  assert.equal(card.balanceCents, 10_000);
});

test('expiry is the end of the printed month', () => {
  assert.equal(isExpired('2026-11', Date.UTC(2026, 10, 30, 23, 59)), false);
  assert.equal(isExpired('2026-11', Date.UTC(2026, 11, 1)), true);
  const card = { status: 'active', expires: '2026-10', homeCountry: 'US', balanceCents: 0, creditLimitCents: 1e6,
    controls: { online: true, international: true, perChargeCapCents: 1e6, dailyLimitCents: 1e6, blockedCategories: [] } };
  assert.equal(decide(card, { ...charge(), at: NOW }, { spentTodayCents: 0 }).code, 'card_expired');
});

test('bad input is rejected and changes nothing', async () => {
  const { program, card } = await setup();
  assert.throws(() => program.authorize(card.id, charge({ amountCents: 10.5 })), ValidationError);
  assert.throws(() => program.authorize(card.id, charge({ amountCents: -1 })), ValidationError);
  assert.throws(() => program.authorize(card.id, charge({ channel: 'phone' })), ValidationError);
  assert.throws(() => program.authorize('card_missing', charge()), NotFoundError);
  await assert.rejects(program.updateCard(card.id, { online: false, bogus: 1 }), ValidationError);
  assert.equal(card.controls.online, true); // the valid half of a bad update is not applied
  await assert.rejects(program.issueCard({ cardholderName: '', creditLimitCents: 1000 }), ValidationError);
  assert.equal(program.transactions.length, 0);
});

test('a closed card stays closed', async () => {
  const { program, card } = await setup();
  await program.updateCard(card.id, { status: 'closed' });
  await assert.rejects(program.updateCard(card.id, { status: 'active' }), ValidationError);
  assert.equal(program.authorize(card.id, charge()).code, 'card_closed');
});

test('the J.P. Morgan adapter refuses to run until it is implemented', () => {
  assert.throws(() => loadIssuer('jpmorgan'), /not implemented/);
  assert.throws(() => loadIssuer('nope'), /Unknown ISSUER/);
});

test('HTTP API: issue, control, authorize, and stream the decision live', async (t) => {
  const program = new CardProgram(new SimulatorIssuer());
  const server = createServer(program);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, type = 'application/json') => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': type } : {}, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const stream = await fetch(base + '/api/events');
  const reader = stream.body.getReader();
  const nextEvent = async () => {
    for (;;) {
      const { value } = await reader.read();
      const line = new TextDecoder().decode(value).split('\n').find((l) => l.startsWith('data: '));
      if (line) return JSON.parse(line.slice(6));
    }
  };

  const issued = await call('POST', '/api/cards', { cardholderName: 'Web Holder', creditLimitCents: 50_000 });
  assert.equal(issued.status, 201);
  assert.equal((await nextEvent()).type, 'card.issued');
  const id = issued.body.id;
  assert.match(issued.body.last4, /^\d{4}$/);
  assert.equal('pan' in issued.body || 'cvv' in issued.body, false);

  assert.equal((await call('PATCH', `/api/cards/${id}`, { status: 'frozen' })).body.status, 'frozen');
  await nextEvent();
  const declined = await call('POST', `/api/cards/${id}/authorizations`, charge());
  assert.equal(declined.status, 201);
  assert.equal(declined.body.code, 'card_frozen');
  const live = await nextEvent();
  assert.equal(live.type, 'authorization');
  assert.equal(live.transaction.id, declined.body.id);

  assert.equal((await call('POST', `/api/cards/${id}/authorizations`, charge({ amountCents: 'lots' }))).status, 400);
  assert.equal((await call('POST', '/api/cards', { cardholderName: 'x', creditLimitCents: 1000 }, 'text/plain')).status, 415);
  assert.equal((await call('PATCH', '/api/cards/card_missing', { online: false })).status, 404);
  assert.equal((await call('POST', '/api/cards', { cardholderName: 'x'.repeat(20_000), creditLimitCents: 1000 })).status, 413);
  assert.equal((await call('GET', '/api/transactions')).body.transactions.length, 1);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  await reader.cancel();
});
