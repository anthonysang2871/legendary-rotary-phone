'use strict';

// Simulated issuer. Stands in for a real issuing bank so the program can run
// end to end with no outside account. It creates card records only: there is
// no full card number, no CVV and nothing that can be spent.

const { randomBytes, randomInt } = require('node:crypto');

class SimulatorIssuer {
  constructor(now = Date.now) {
    this.name = 'simulator';
    this.now = now;
  }

  async createCard() {
    const d = new Date(this.now());
    const expiryYear = d.getUTCFullYear() + 5;
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return {
      id: `card_${randomBytes(6).toString('hex')}`,
      last4: String(randomInt(0, 10_000)).padStart(4, '0'),
      expires: `${expiryYear}-${month}`,
    };
  }

  // A real issuer would be told about status and control changes here.
  async updateCard() {}
}

module.exports = { SimulatorIssuer };
