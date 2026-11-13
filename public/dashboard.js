'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toCents = (dollars) => Math.round(Number(dollars) * 100);
  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  };

  const cards = new Map();
  let selectedId = null;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The request failed.');
    return data;
  }
  function showError(node, err) { node.textContent = err ? err.message : ''; node.hidden = !err; }

  // ---- cards ----
  function select(id) {
    selectedId = id;
    renderCards();
  }

  function renderCard(card) {
    const patch = (body) => api('PATCH', `/api/cards/${card.id}`, body).catch((err) => showError($('issueError'), err));
    const closed = card.status === 'closed';

    const toggle = (key, label) => {
      const input = el('input', { type: 'checkbox', checked: card.controls[key], disabled: closed, id: `${key}-${card.id}` });
      input.addEventListener('change', () => patch({ [key]: input.checked }));
      return el('label', { htmlFor: input.id }, [input, label]);
    };

    const capInput = el('input', { type: 'number', min: '0', step: '1', value: String(card.controls.perChargeCapCents / 100), disabled: closed, id: `cap-${card.id}` });
    const capBtn = el('button', { type: 'button', className: 'btn small', textContent: 'Set cap', disabled: closed });
    capBtn.addEventListener('click', () => patch({ perChargeCapCents: toCents(capInput.value) }));

    const freezeBtn = el('button', { type: 'button', className: 'btn small', textContent: card.status === 'frozen' ? 'Unfreeze' : 'Freeze', disabled: closed });
    freezeBtn.addEventListener('click', () => patch({ status: card.status === 'frozen' ? 'active' : 'frozen' }));
    const useBtn = el('button', { type: 'button', className: 'btn small', textContent: card.id === selectedId ? 'Selected for charges' : 'Use for charges' });
    useBtn.addEventListener('click', () => select(card.id));

    return el('div', { className: 'card' + (card.id === selectedId ? ' selected' : '') }, [
      el('div', { className: 'card-head' }, [
        el('span', {}, [el('strong', { textContent: `•••• ${card.last4}` }), ` ${card.cardholderName}`]),
        el('span', { className: `pill ${card.status}`, textContent: card.status }),
      ]),
      el('div', { className: 'stats' }, [
        el('span', {}, ['Balance', el('b', { textContent: usd(card.balanceCents) })]),
        el('span', {}, ['Available', el('b', { textContent: usd(card.creditLimitCents - card.balanceCents) })]),
        el('span', {}, ['Points', el('b', { textContent: card.points.toLocaleString('en-US') })]),
      ]),
      el('div', { className: 'toggles' }, [toggle('online', 'Online'), toggle('international', 'International')]),
      el('div', { className: 'cap' }, [
        el('div', {}, [el('label', { htmlFor: capInput.id, textContent: 'Per-charge cap (USD)' }), capInput]),
        capBtn,
      ]),
      el('div', { className: 'actions' }, [freezeBtn, useBtn]),
    ]);
  }

  function renderCards() {
    $('noCards').hidden = cards.size > 0;
    $('cards').replaceChildren(...[...cards.values()].reverse().map(renderCard));
    const selected = cards.get(selectedId);
    $('chargeBtn').disabled = !selected;
    $('chargeTarget').textContent = selected
      ? `Charging •••• ${selected.last4} (${selected.cardholderName}).`
      : 'Select a card first.';
  }

  function upsertCard(card) {
    cards.set(card.id, card);
    if (!selectedId) selectedId = card.id;
    renderCards();
  }

  // ---- feed ----
  function addTransaction(t, { prepend = true } = {}) {
    $('noTx').hidden = true;
    $('feed').hidden = false;
    const card = cards.get(t.cardId);
    const reason = t.approved ? [] : [el('small', { textContent: t.reason })];
    const row = el('tr', {}, [
      el('td', { textContent: new Date(t.at).toLocaleTimeString() }),
      el('td', { textContent: card ? `•••• ${card.last4}` : t.cardId }),
      el('td', {}, [`${t.merchant.name}`, el('small', { textContent: `${t.merchant.category} · ${t.channel === 'online' ? 'online' : 'in store'} · ${t.merchant.country}` })]),
      el('td', { className: 'r', textContent: usd(t.amountCents) }),
      el('td', {}, [el('span', { className: `pill ${t.approved ? 'approved' : 'declined'}`, textContent: t.approved ? 'approved' : 'declined' }), ...reason]),
      el('td', { className: 'r', textContent: t.pointsEarned ? `+${t.pointsEarned.toLocaleString('en-US')}` : '–' }),
      el('td', { className: 'r', textContent: `${t.decisionMicros} µs` }),
    ]);
    if (prepend) $('feedBody').prepend(row); else $('feedBody').append(row);
  }

  // ---- forms ----
  $('issueForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('issueError'), null);
    try {
      const card = await api('POST', '/api/cards', { cardholderName: $('holder').value, creditLimitCents: toCents($('limit').value) });
      select(card.id);
    } catch (err) { showError($('issueError'), err); }
  });

  $('chargeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('chargeError'), null);
    if (!selectedId) return;
    try {
      await api('POST', `/api/cards/${selectedId}/authorizations`, {
        amountCents: toCents($('amount').value),
        channel: $('channel').value,
        merchant: { name: $('merchant').value, category: $('category').value, country: $('country').value },
      });
    } catch (err) { showError($('chargeError'), err); }
  });

  // ---- live stream ----
  function connect() {
    const stream = new EventSource('/api/events');
    stream.onopen = () => { $('liveTag').textContent = 'Live'; $('liveTag').classList.add('live'); };
    stream.onerror = () => { $('liveTag').textContent = 'Reconnecting…'; $('liveTag').classList.remove('live'); };
    stream.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      if (event.card) upsertCard(event.card);
      if (event.type === 'authorization') addTransaction(event.transaction);
    };
  }

  async function start() {
    const [{ issuer, cards: list }, { transactions }] = await Promise.all([
      api('GET', '/api/cards'), api('GET', '/api/transactions'),
    ]);
    $('issuerTag').textContent = `Issuer: ${issuer}`;
    list.forEach(upsertCard);
    transactions.forEach((t) => addTransaction(t, { prepend: false }));
    renderCards();
    connect();
  }
  start().catch((err) => showError($('issueError'), err));
})();
