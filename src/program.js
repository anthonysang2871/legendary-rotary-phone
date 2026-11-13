'use strict';

// The card program: holds cards and transactions, applies control changes,
// and runs every charge through the authorization engine. Emits an event for
// each change so clients can follow along in real time.

const { EventEmitter } = require('node:events');
const { decide, CATEGORIES, CHANNELS } = require('./engine');

const MAX_CENTS = 100_000_000_00; // $100M ceiling on any single money field
const STATUSES = ['active', 'frozen', 'closed'];

class ValidationError extends Error {}
class NotFoundError extends Error {}

function cents(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_CENTS) {
    throw new ValidationError(`${field} must be a whole number of cents between ${min} and ${MAX_CENTS}.`);
  }
  return value;
}
function text(value, field, max = 60) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ValidationError(`${field} must be text of 1 to ${max} characters.`);
  }
  return value.trim();
}
function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}
function country(value, field) {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) {
    throw new ValidationError(`${field} must be a two-letter country code such as US.`);
  }
  return value;
}

class CardProgram extends EventEmitter {
  /**
   * @param {object} issuer  adapter with createCard / updateCard (see issuer/simulator.js)
   * @param {() => number} now  clock, injectable for tests
   */
  constructor(issuer, now = Date.now) {
    super();
    this.issuer = issuer;
    this.now = now;
    this.cards = new Map();
    this.transactions = [];
    this.seq = 0;
  }

  async issueCard(input = {}) {
    const cardholderName = text(input.cardholderName, 'cardholderName');
    const creditLimitCents = cents(input.creditLimitCents, 'creditLimitCents', { min: 100 });
    const issued = await this.issuer.createCard({ cardholderName, creditLimitCents });
    const card = {
      id: issued.id,
      last4: issued.last4,
      expires: issued.expires,
      cardholderName,
      status: 'active',
      homeCountry: 'US',
      creditLimitCents,
      balanceCents: 0,
      points: 0,
      controls: {
        online: true,
        international: true,
        perChargeCapCents: creditLimitCents,
        dailyLimitCents: creditLimitCents,
        blockedCategories: [],
      },
      createdAt: this.now(),
    };
    this.cards.set(card.id, card);
    this.emit('event', { type: 'card.issued', card });
    return card;
  }

  getCard(id) {
    const card = this.cards.get(id);
    if (!card) throw new NotFoundError(`No card with id ${id}.`);
    return card;
  }

  listCards() { return [...this.cards.values()]; }

  async updateCard(id, patch = {}) {
    const card = this.getCard(id);
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new ValidationError('The update must be an object.');
    }
    // Validate everything before changing anything, so a bad field changes nothing.
    const next = { status: card.status, controls: { ...card.controls } };
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'status':
          oneOf(value, STATUSES, 'status');
          if (card.status === 'closed' && value !== 'closed') {
            throw new ValidationError('A closed card cannot be reopened.');
          }
          next.status = value;
          break;
        case 'online':
        case 'international':
          if (typeof value !== 'boolean') throw new ValidationError(`${key} must be true or false.`);
          next.controls[key] = value;
          break;
        case 'perChargeCapCents':
        case 'dailyLimitCents':
          next.controls[key] = cents(value, key);
          break;
        case 'blockedCategories':
          if (!Array.isArray(value)) throw new ValidationError('blockedCategories must be a list.');
          next.controls.blockedCategories = [...new Set(value.map((v) => oneOf(v, CATEGORIES, 'blockedCategories entry')))];
          break;
        default:
          throw new ValidationError(`Unknown field: ${key}.`);
      }
    }
    await this.issuer.updateCard(id, next);
    card.status = next.status;
    card.controls = next.controls;
    this.emit('event', { type: 'card.updated', card });
    return card;
  }

  spentToday(cardId, at) {
    const dayStart = Math.floor(at / 86_400_000) * 86_400_000; // UTC day
    let total = 0;
    for (const t of this.transactions) {
      if (t.cardId === cardId && t.approved && t.at >= dayStart) total += t.amountCents;
    }
    return total;
  }

  // Synchronous on purpose: the check and the balance update happen in one
  // step, so two charges arriving together cannot both pass a limit.
  authorize(cardId, input = {}) {
    const card = this.getCard(cardId);
    const merchant = input.merchant ?? {};
    const req = {
      amountCents: cents(input.amountCents, 'amountCents', { min: 1 }),
      channel: oneOf(input.channel, CHANNELS, 'channel'),
      merchant: {
        name: text(merchant.name, 'merchant.name'),
        category: oneOf(merchant.category, CATEGORIES, 'merchant.category'),
        country: country(merchant.country, 'merchant.country'),
      },
      at: this.now(),
    };
    const started = process.hrtime.bigint();
    const decision = decide(card, req, { spentTodayCents: this.spentToday(cardId, req.at) });
    if (decision.approved) {
      card.balanceCents += req.amountCents;
      card.points += decision.pointsEarned;
    }
    const transaction = {
      id: `txn_${String(++this.seq).padStart(6, '0')}`,
      cardId,
      ...req,
      ...decision,
      decisionMicros: Number((process.hrtime.bigint() - started) / 1000n),
    };
    this.transactions.push(transaction);
    this.emit('event', { type: 'authorization', transaction, card });
    return transaction;
  }

  listTransactions(limit = 50) {
    return this.transactions.slice(-limit).reverse();
  }
}

module.exports = { CardProgram, ValidationError, NotFoundError };
