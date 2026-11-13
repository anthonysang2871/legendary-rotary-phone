'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TokenClient, TokenError } = require('../src/issuer/jpmorgan-auth');

// A stand-in token server that records what it was sent.
async function tokenServer(t, respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)) });
      const { status = 200, json } = respond(seen.length);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}/token`, seen };
}

test('sends the documented form fields and caches the token until near expiry', async (t) => {
  let now = 1_000_000;
  const { url, seen } = await tokenServer(t, (n) => ({ json: { access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 3599 } }));
  const client = new TokenClient({ tokenUrl: url, clientId: 'my-id', clientSecret: 's3cret', now: () => now });

  const [a, b] = await Promise.all([client.getToken(), client.getToken()]);
  assert.equal(a, 'tok-1');
  assert.equal(b, 'tok-1');
  assert.equal(seen.length, 1); // concurrent callers share one request
  assert.deepEqual(seen[0].form, {
    grant_type: 'client_credentials', scope: 'jpm:payments:sandbox', client_id: 'my-id', client_secret: 's3cret',
  });
  assert.equal(seen[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(seen[0].headers.authorization, undefined);

  now += 3_500_000; // still inside the lifetime minus the one-minute margin
  assert.equal(await client.getToken(), 'tok-1');
  now += 60_000;    // inside the margin: renew
  assert.equal(await client.getToken(), 'tok-2');
  assert.equal(seen.length, 2);
});

test('a refusal reports the server error code and never the secret', async (t) => {
  const { url } = await tokenServer(t, () => ({ status: 401, json: { error: 'invalid_client', error_description: 'Client authentication failed' } }));
  const client = new TokenClient({ tokenUrl: url, clientId: 'my-id', clientSecret: 's3cret' });
  await assert.rejects(client.getToken(), (err) => {
    assert.ok(err instanceof TokenError);
    assert.match(err.message, /HTTP 401, invalid_client: Client authentication failed/);
    assert.doesNotMatch(err.message, /s3cret/);
    return true;
  });
});

test('missing settings and insecure URLs are refused up front', () => {
  assert.throws(() => TokenClient.fromEnv({}), /JPM_CLIENT_ID and JPM_CLIENT_SECRET/);
  const creds = { JPM_CLIENT_ID: 'a', JPM_CLIENT_SECRET: 'b' };
  assert.throws(() => TokenClient.fromEnv({ ...creds, JPM_TOKEN_URL: 'http://example.com/token' }), /must use https/);
  assert.throws(() => TokenClient.fromEnv({ ...creds, JPM_TOKEN_URL: 'not a url' }), /not a valid URL/);
  assert.equal(TokenClient.fromEnv(creds).tokenUrl, 'https://id.payments.jpmorgan.com/am/oauth2/alpha/access_token');
});
