'use strict';

// J.P. Morgan issuer adapter: NOT IMPLEMENTED.
//
// This file marks where the J.P. Morgan commercial card API connects. It is
// deliberately empty of guesses: the card endpoints, request fields and
// authentication for that API come from the documentation J.P. Morgan gives
// its clients, which this project has not been given yet.
//
// To finish it, the adapter needs the same two methods as simulator.js:
//   createCard({ cardholderName, creditLimitCents }) -> { id, last4, expires }
//   updateCard(id, { status, controls })
//
// Selecting this adapter fails loudly rather than pretending to issue cards.

class JPMorganIssuer {
  constructor() {
    throw new Error(
      'The J.P. Morgan adapter is not implemented. It needs the card API documentation ' +
      'and sandbox access. Run with ISSUER=simulator (the default) until then.'
    );
  }
}

module.exports = { JPMorganIssuer };
