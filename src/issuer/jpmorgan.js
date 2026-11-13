'use strict';

// J.P. Morgan as a drop-in issuer for the real-time card program: NOT IMPLEMENTED,
// and it cannot be made a drop-in, because the two do different jobs.
//
// The card program (program.js) decides every charge itself and enforces
// freeze, online, international and limit controls. The J.P. Morgan Prepaid
// Card API offers none of that: J.P. Morgan and the card network decide each
// charge, and the API covers enrolling cardholders, ordering and linking
// cards, loading funds and listing transactions.
//
// Those operations are implemented in jpmorgan-prepaid.js, and mock-environment
// sign-in in jpmorgan-auth.js. Use them directly.
//
// Selecting this adapter fails loudly rather than pretending to issue cards.

class JPMorganIssuer {
  constructor() {
    throw new Error(
      'The J.P. Morgan adapter is not implemented as an issuer for the simulator program. ' +
      'Use src/issuer/jpmorgan-prepaid.js for the Prepaid Card API, or run with ISSUER=simulator (the default).'
    );
  }
}

module.exports = { JPMorganIssuer };
