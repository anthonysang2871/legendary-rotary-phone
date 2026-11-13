'use strict';

// Client for the J.P. Morgan Prepaid Card APIs (Global 1.0.2, Funding, Card
// Link 1.0.1), written from the OpenAPI specifications on the Payments
// Developer Portal.
//
// Connection: mutual TLS. Every request presents your client certificate.
// Signing: operations marked "Digital Signature Required" send the JSON body
// as a compact JWS signed with RS256, as described in J.P. Morgan's "mTLS with
// Digital Signature" guide.
//
// Settings (environment variables; file paths, never the key material itself):
//   JPM_PREPAID_CLIENT_ID     required  X-Client-Id from your implementation manager
//   JPM_MTLS_CERT_FILE        required  client certificate (PEM)
//   JPM_MTLS_KEY_FILE         required  private key for that certificate (PEM)
//   JPM_SIGNING_KEY_FILE      required  private key of the Digital Signature certificate (PEM)
//   JPM_PREPAID_BASE_URL      optional  defaults to the Client Testing gateway
//   JPM_SIGNED_CONTENT_TYPE   optional  defaults to application/jose
//
// This module never logs request or response bodies: they carry cardholder
// identity data.

const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CLIENT_TESTING_URL = 'https://apigatewayqaf.jpmorgan.com/tsapi/v1/gpp';
const PRODUCTION_URL = 'https://apigateway.jpmorgan.com/tsapi/v1/gpp';

class PrepaidCardError extends Error {
  constructor(message, { status, errors = [], requestId } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;       // [{ errorCode, errorMsg }]
    this.requestId = requestId;
  }
}
class PrepaidValidationError extends Error {}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Compact JWS (RS256) over the JSON payload, per J.P. Morgan's signing guide. */
function signJws(payload, privateKeyPem) {
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function requireFields(object, fields, what) {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    throw new PrepaidValidationError(`${what} must be an object.`);
  }
  const missing = fields.filter((f) => object[f] === undefined || object[f] === null || object[f] === '');
  if (missing.length) throw new PrepaidValidationError(`${what} is missing required field(s): ${missing.join(', ')}.`);
}
function accountNumber(value, field = 'accountNumber') {
  const text = String(value ?? '');
  if (!/^\d{1,12}$/.test(text)) throw new PrepaidValidationError(`${field} must be 1 to 12 digits.`);
  return text;
}
function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new PrepaidValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}
function isoDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PrepaidValidationError(`${field} must be a date in YYYY-MM-DD form.`);
  }
  return value;
}
/** Whole cents to the API's decimal string, e.g. 236 -> "2.36". No floating point. */
function centsToAmount(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new PrepaidValidationError('amountCents must be a positive whole number of cents.');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

class PrepaidCardClient {
  constructor({ baseUrl = CLIENT_TESTING_URL, clientId, cert, key, signingKey, ca, signedContentType = 'application/jose', timeoutMs = 30_000 }) {
    if (!clientId) throw new PrepaidValidationError('Set JPM_PREPAID_CLIENT_ID (the X-Client-Id from J.P. Morgan).');
    if (!cert || !key) throw new PrepaidValidationError('Set JPM_MTLS_CERT_FILE and JPM_MTLS_KEY_FILE for the mutual TLS connection.');
    if (!signingKey) throw new PrepaidValidationError('Set JPM_SIGNING_KEY_FILE for digitally signed requests.');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') throw new PrepaidValidationError('JPM_PREPAID_BASE_URL must use https.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = clientId;
    this.signingKey = signingKey;
    this.signedContentType = signedContentType;
    this.timeoutMs = timeoutMs;
    this.agent = new https.Agent({ cert, key, ca, keepAlive: true });
  }

  static fromEnv(env = process.env) {
    const read = (name) => (env[name] ? fs.readFileSync(env[name]) : undefined);
    return new PrepaidCardClient({
      baseUrl: env.JPM_PREPAID_BASE_URL || CLIENT_TESTING_URL,
      clientId: env.JPM_PREPAID_CLIENT_ID,
      cert: read('JPM_MTLS_CERT_FILE'),
      key: read('JPM_MTLS_KEY_FILE'),
      signingKey: read('JPM_SIGNING_KEY_FILE'),
      ca: read('JPM_CA_FILE'),
      signedContentType: env.JPM_SIGNED_CONTENT_TYPE || 'application/jose',
    });
  }

  close() { this.agent.destroy(); }

  // ---- accounts ----

  /** POST /accounts (signed). Enrols a cardholder; returns { accountNumber }. */
  createAccount(account) {
    requireFields(account, ['cardHolderID', 'firstName', 'lastName', 'birthDate', 'passPhrase', 'reminderPassPhrase',
      'email', 'residentialAddress', 'mobilePhone', 'initial', 'governmentIDNumber', 'identifierType'], 'account');
    isoDate(account.birthDate, 'birthDate');
    oneOf(account.identifierType, ['T', 'L', 'P', 'R', 'U', 'V'], 'identifierType');
    return this.send('POST', '/accounts', account, { signed: true });
  }

  /** POST /accounts/update (signed). */
  updateAccount(update) {
    requireFields(update, ['accountNumber'], 'update');
    return this.send('POST', '/accounts/update', { ...update, accountNumber: accountNumber(update.accountNumber) }, { signed: true });
  }

  /** POST /accounts/details. identifierType: A account number, G government ID, C cardholder ID. */
  getAccount({ identifier, identifierType } = {}) {
    requireFields({ identifier, identifierType }, ['identifier', 'identifierType'], 'lookup');
    oneOf(identifierType, ['A', 'G', 'C'], 'identifierType');
    return this.send('POST', '/accounts/details', { identifier, identifierType });
  }

  // ---- money ----

  /**
   * POST /fundings (signed). Credits (loads) or debits a card account.
   * traceId is your unique id for the transfer; reuse it when retrying so a
   * repeated request can be recognised.
   */
  fundAccount({ accountNumber: account, amountCents, direction, traceId, memo, locationCode } = {}) {
    oneOf(direction, ['credit', 'debit'], 'direction');
    if (typeof traceId !== 'string' || !/^[A-Za-z0-9]{1,22}$/.test(traceId)) {
      throw new PrepaidValidationError('traceId must be 1 to 22 letters or digits.');
    }
    if (memo !== undefined && (typeof memo !== 'string' || memo.length > 50)) {
      throw new PrepaidValidationError('memo must be text of at most 50 characters.');
    }
    const body = {
      accountNumber: accountNumber(account),
      creditDebitFlag: direction === 'credit' ? 'C' : 'D',
      funds: { amount: centsToAmount(amountCents), currencyCode: 'USD' },
      traceId,
    };
    if (memo !== undefined) body.addendumInfo = memo;
    if (locationCode !== undefined) body.locationCode = String(locationCode);
    return this.send('POST', '/fundings', body, { signed: true });
  }

  /** POST /transactions/list. flag: A all, C credits, D debits. */
  listTransactions({ accountNumber: account, fromDate, toDate, flag = 'A', start, limit } = {}) {
    const query = { accountNumber: Number(accountNumber(account)), transactionFlag: oneOf(flag, ['A', 'C', 'D'], 'flag') };
    if (fromDate !== undefined) query.fromDate = isoDate(fromDate, 'fromDate');
    if (toDate !== undefined) query.toDate = isoDate(toDate, 'toDate');
    const body = { query };
    if (start !== undefined) body.start = start;
    if (limit !== undefined) body.limit = limit;
    return this.send('POST', '/transactions/list', body);
  }

  // ---- cards ----

  /** POST /cards (signed). Orders a new or replacement card for an account. */
  createCard(card) {
    requireFields(card, ['addReplaceFlag', 'cardTypeFlag', 'shippingAddrType', 'firstName', 'lastName', 'shippingAddress'], 'card');
    if (card.accountNumber === undefined && card.cardHolderID === undefined) {
      throw new PrepaidValidationError('card needs accountNumber or cardHolderID.');
    }
    oneOf(card.addReplaceFlag, ['A', 'R'], 'addReplaceFlag');
    oneOf(card.cardTypeFlag, ['P', 'S'], 'cardTypeFlag');
    oneOf(card.shippingAddrType, ['M', 'R', 'O'], 'shippingAddrType');
    return this.send('POST', '/cards', card, { signed: true });
  }

  /** POST /card/linkCard (signed). Links an instant-issue card to an account. */
  linkCard(link) {
    requireFields(link, ['cardSerialNumber', 'accountNumber', 'locationCode'], 'link');
    const serial = String(link.cardSerialNumber);
    if (!/^\d{1,15}$/.test(serial)) throw new PrepaidValidationError('cardSerialNumber must be up to 15 digits.');
    return this.send('POST', '/card/linkCard', {
      ...link,
      cardSerialNumber: Number(serial),
      accountNumber: Number(accountNumber(link.accountNumber)),
      locationCode: String(link.locationCode),
    }, { signed: true });
  }

  /** POST /webview-links. Returns a link to the cardholder's hosted card page. */
  getWebviewLink(account) {
    return this.send('POST', '/webview-links', { accountNumber: accountNumber(account) });
  }

  // ---- transport ----

  send(method, path, payload, { signed = false } = {}) {
    const body = signed ? signJws(payload, this.signingKey) : JSON.stringify(payload);
    const url = new URL(this.baseUrl + path);
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        agent: this.agent,
        headers: {
          'Content-Type': signed ? this.signedContentType : 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          'X-Client-Id': this.clientId,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); return; }
          const errors = Array.isArray(data?.errors) ? data.errors.map((e) => ({ errorCode: e.errorCode, errorMsg: e.errorMsg })) : [];
          const detail = errors.map((e) => `${e.errorCode}: ${e.errorMsg}`).join('; ') || 'no error detail';
          reject(new PrepaidCardError(`J.P. Morgan refused ${method} ${path} (HTTP ${res.statusCode}, ${detail}).`,
            { status: res.statusCode, errors, requestId: data?.requestid }));
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('error', (err) => reject(new PrepaidCardError(`Could not reach J.P. Morgan for ${method} ${path}: ${err.message}`)));
      req.end(body);
    });
  }
}

module.exports = { PrepaidCardClient, PrepaidCardError, PrepaidValidationError, signJws, centsToAmount, CLIENT_TESTING_URL, PRODUCTION_URL };
