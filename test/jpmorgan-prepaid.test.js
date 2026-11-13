'use strict';

// Runs the Prepaid Card client against a local stand-in server that, like the
// real gateway, requires a client certificate. Certificates are generated with
// openssl for the test run only.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrepaidCardClient, PrepaidCardError, PrepaidValidationError, signJws, centsToAmount } = require('../src/issuer/jpmorgan-prepaid');

let pki = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-pki-'));
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Test CA');
  fs.writeFileSync(path.join(dir, 'san.cnf'), 'subjectAltName=IP:127.0.0.1');
  for (const [name, cn, ext] of [['server', '127.0.0.1', ['-extfile', 'san.cnf']], ['client', 'tessera-test-client', []]]) {
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', ...ext);
  }
  ssl('genrsa', '-out', 'signing.key', '2048');
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'stranger.key', '-out', 'stranger.crt', '-days', '1', '-subj', '/CN=stranger');
  const read = (f) => fs.readFileSync(path.join(dir, f));
  pki = { dir, ca: read('ca.crt'), serverCert: read('server.crt'), serverKey: read('server.key'),
    clientCert: read('client.crt'), clientKey: read('client.key'), signingKey: read('signing.key'),
    strangerCert: read('stranger.crt'), strangerKey: read('stranger.key') };
} catch { /* openssl unavailable: the mTLS tests are skipped */ }

async function gateway(t, respond) {
  const seen = [];
  const server = https.createServer({ cert: pki.serverCert, key: pki.serverKey, ca: pki.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body, clientCn: req.socket.getPeerCertificate().subject.CN });
      const { status = 200, json = {} } = respond(req.url);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `https://127.0.0.1:${server.address().port}/tsapi/v1/gpp`;
  const client = new PrepaidCardClient({ baseUrl, clientId: 'CLIENT123', cert: pki.clientCert, key: pki.clientKey, signingKey: pki.signingKey, ca: pki.ca });
  t.after(() => { client.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { client, seen, baseUrl };
}

function verifyJws(jws) {
  const [header, payload, signature] = jws.split('.');
  const publicKey = crypto.createPublicKey(pki.signingKey);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  return { ok, header: JSON.parse(Buffer.from(header, 'base64url')), payload: JSON.parse(Buffer.from(payload, 'base64url')) };
}

test('amounts convert from cents without rounding error', () => {
  assert.equal(centsToAmount(236), '2.36');
  assert.equal(centsToAmount(5), '0.05');
  assert.equal(centsToAmount(1_000_000_01), '1000000.01');
  assert.throws(() => centsToAmount(2.5), PrepaidValidationError);
  assert.throws(() => centsToAmount(0), PrepaidValidationError);
});

test('funding is sent over mutual TLS as a signed JWS matching the specification', { skip: !pki }, async (t) => {
  const { client, seen } = await gateway(t, () => ({ status: 201, json: { fundingId: '123456789' } }));
  const result = await client.fundAccount({ accountNumber: '501002640305', amountCents: 236, direction: 'credit', traceId: '11027237t', memo: 'credit', locationCode: '12345' });
  assert.equal(result.fundingId, '123456789');

  const [req] = seen;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/tsapi/v1/gpp/fundings');
  assert.equal(req.clientCn, 'tessera-test-client'); // the client certificate was presented
  assert.equal(req.headers['x-client-id'], 'CLIENT123');
  assert.equal(req.headers['content-type'], 'application/jose');
  const jws = verifyJws(req.body);
  assert.equal(jws.ok, true);
  assert.deepEqual(jws.header, { alg: 'RS256' });
  assert.deepEqual(jws.payload, { // the specification's own example
    accountNumber: '501002640305', creditDebitFlag: 'C', funds: { amount: '2.36', currencyCode: 'USD' },
    traceId: '11027237t', addendumInfo: 'credit', locationCode: '12345',
  });
});

test('read operations are plain JSON; card operations are signed', { skip: !pki }, async (t) => {
  const { client, seen } = await gateway(t, (url) => (url.endsWith('/linkCard') ? { json: { lastFourOfNewCard: '7331' } } : { json: { transactions: [] } }));
  await client.listTransactions({ accountNumber: '123456789000', fromDate: '2020-06-01', toDate: '2020-07-01', start: 2, limit: 30 });
  await client.getAccount({ identifier: '123456789000', identifierType: 'A' });
  const linked = await client.linkCard({ cardSerialNumber: '100000226200', accountNumber: '501000302693', locationCode: '0000' });

  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].body), { start: 2, limit: 30, query: { accountNumber: 123456789000, fromDate: '2020-06-01', toDate: '2020-07-01', transactionFlag: 'A' } });
  assert.equal(seen[1].path, '/tsapi/v1/gpp/accounts/details');
  assert.equal(seen[2].path, '/tsapi/v1/gpp/card/linkCard');
  assert.deepEqual(verifyJws(seen[2].body).payload, { cardSerialNumber: 100000226200, accountNumber: 501000302693, locationCode: '0000' });
  assert.equal(linked.lastFourOfNewCard, '7331');
});

test('gateway errors surface the error codes', { skip: !pki }, async (t) => {
  const { client } = await gateway(t, () => ({ status: 400, json: { requestid: 'req-1', errors: [{ errorCode: 'GPP-FE001', errorMsg: 'traceId is invalid' }] } }));
  await assert.rejects(client.getWebviewLink('123456789000'), (err) => {
    assert.ok(err instanceof PrepaidCardError);
    assert.equal(err.status, 400);
    assert.equal(err.requestId, 'req-1');
    assert.match(err.message, /HTTP 400, GPP-FE001: traceId is invalid/);
    return true;
  });
});

test('a connection without the client certificate is refused', { skip: !pki }, async (t) => {
  const { baseUrl } = await gateway(t, () => ({}));
  // A certificate the gateway's authority did not issue.
  const stranger = new PrepaidCardClient({ baseUrl, clientId: 'X', cert: pki.strangerCert, key: pki.strangerKey, signingKey: pki.signingKey, ca: pki.ca });
  t.after(() => stranger.close());
  await assert.rejects(stranger.getWebviewLink('1'), /Could not reach J\.P\. Morgan/);
});

test('invalid input is rejected before anything is sent', () => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const client = new PrepaidCardClient({ clientId: 'X', cert: 'unused', key: 'unused', signingKey: key });
  const fund = (over) => () => client.fundAccount({ accountNumber: '1', amountCents: 100, direction: 'credit', traceId: 'abc', ...over });
  assert.throws(fund({ amountCents: 1.5 }), /whole number of cents/);
  assert.throws(fund({ direction: 'refund' }), /direction/);
  assert.throws(fund({ traceId: 'x'.repeat(23) }), /traceId/);
  assert.throws(fund({ accountNumber: '1234567890123' }), /1 to 12 digits/);
  assert.throws(() => client.createAccount({ firstName: 'A' }), /missing required field/);
  assert.throws(() => client.createCard({ addReplaceFlag: 'A', cardTypeFlag: 'P', shippingAddrType: 'M', firstName: 'A', lastName: 'B', shippingAddress: {} }), /accountNumber or cardHolderID/);
  assert.throws(() => client.getAccount({ identifier: '1', identifierType: 'Z' }), /identifierType/);
  assert.throws(() => new PrepaidCardClient({ clientId: 'X', cert: 'c', key: 'k', signingKey: key, baseUrl: 'http://example.com' }), /https/);
  assert.throws(() => PrepaidCardClient.fromEnv({}), /JPM_PREPAID_CLIENT_ID/);
  assert.equal(signJws({ a: 1 }, key).split('.').length, 3);
  client.close();
});
