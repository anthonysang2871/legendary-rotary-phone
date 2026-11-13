'use strict';

// Real-time authorization engine. Pure functions: given a card, a charge
// request and today's spend, return an approve/decline decision. All money is
// in integer cents.

const EARN_RATES = Object.freeze({ travel: 5, dining: 4, grocery: 3, other: 2 });
const CATEGORIES = Object.freeze(Object.keys(EARN_RATES));
const CHANNELS = Object.freeze(['in_store', 'online']);

const decline = (code, reason) => ({ approved: false, code, reason, pointsEarned: 0 });

function isExpired(expires, at) {
  // expires is "YYYY-MM"; the card is valid through the last day of that month (UTC).
  const [y, m] = expires.split('-').map(Number);
  return at >= Date.UTC(y, m, 1);
}

/**
 * @param {object} card   card record (see program.js)
 * @param {object} req    { amountCents, channel, merchant: { category, country }, at }
 * @param {object} ctx    { spentTodayCents }
 */
function decide(card, req, ctx) {
  if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) {
    return decline('invalid_amount', 'The amount must be a positive whole number of cents.');
  }
  if (card.status === 'closed') return decline('card_closed', 'The card is closed.');
  if (card.status === 'frozen') return decline('card_frozen', 'The card is frozen.');
  if (isExpired(card.expires, req.at)) return decline('card_expired', 'The card has expired.');

  const c = card.controls;
  if (req.channel === 'online' && !c.online) {
    return decline('online_blocked', 'Online purchases are switched off.');
  }
  if (req.merchant.country !== card.homeCountry && !c.international) {
    return decline('international_blocked', 'International charges are switched off.');
  }
  if (c.blockedCategories.includes(req.merchant.category)) {
    return decline('category_blocked', `Charges in the ${req.merchant.category} category are blocked.`);
  }
  if (req.amountCents > c.perChargeCapCents) {
    return decline('over_charge_cap', 'The amount is over the per-charge cap.');
  }
  if (ctx.spentTodayCents + req.amountCents > c.dailyLimitCents) {
    return decline('over_daily_limit', 'The charge would take today\'s spend over the daily limit.');
  }
  if (card.balanceCents + req.amountCents > card.creditLimitCents) {
    return decline('insufficient_credit', 'The charge would take the balance over the credit limit.');
  }

  const rate = EARN_RATES[req.merchant.category] ?? EARN_RATES.other;
  // One point per whole dollar, multiplied by the category rate.
  const pointsEarned = Math.floor(req.amountCents / 100) * rate;
  return { approved: true, code: 'approved', reason: 'Approved.', pointsEarned };
}

module.exports = { decide, isExpired, EARN_RATES, CATEGORIES, CHANNELS };
