'use strict';

// Access tokens for the J.P. Morgan Payments mock environment.
//
// Follows the public quick-start guide: POST the client ID and secret as form
// fields to the access token URL and receive a bearer token. The Client Testing
// and Production environments use a different flow (a JWT signed with your
// certificate's private key, sent to login.jpmorgan.com) that is not built here.
//
// Settings come from environment variables so that secrets never enter the
// repository:
//   JPM_CLIENT_ID      required
//   JPM_CLIENT_SECRET  required
//   JPM_TOKEN_URL      optional, defaults to the quick-start mock token URL
//   JPM_SCOPE          optional, defaults to jpm:payments:sandbox

const DEFAULT_TOKEN_URL = 'https://id.payments.jpmorgan.com/am/oauth2/alpha/access_token';
const DEFAULT_SCOPE = 'jpm:payments:sandbox';
const REFRESH_MARGIN_MS = 60_000; // renew a minute before expiry

class TokenError extends Error {}

function assertSecureUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TokenError('JPM_TOKEN_URL is not a valid URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TokenError('JPM_TOKEN_URL must use https.');
  }
  return url.toString();
}

class TokenClient {
  constructor({ tokenUrl = DEFAULT_TOKEN_URL, clientId, clientSecret, scope = DEFAULT_SCOPE, now = Date.now }) {
    if (!clientId || !clientSecret) {
      throw new TokenError('Set JPM_CLIENT_ID and JPM_CLIENT_SECRET to use the J.P. Morgan mock environment.');
    }
    this.tokenUrl = assertSecureUrl(tokenUrl);
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this.now = now;
    this.cached = null;   // { token, expiresAt }
    this.pending = null;  // in-flight request, shared by concurrent callers
  }

  static fromEnv(env = process.env) {
    return new TokenClient({
      tokenUrl: env.JPM_TOKEN_URL || DEFAULT_TOKEN_URL,
      clientId: env.JPM_CLIENT_ID,
      clientSecret: env.JPM_CLIENT_SECRET,
      scope: env.JPM_SCOPE || DEFAULT_SCOPE,
    });
  }

  async getToken() {
    if (this.cached && this.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) return this.cached.token;
    if (!this.pending) {
      this.pending = this.fetchToken().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async fetchToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: this.scope,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    let res;
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new TokenError(`Could not reach the J.P. Morgan token server: ${err.message}`);
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON body: reported by status below */ }
    if (!res.ok || typeof data.access_token !== 'string') {
      // Report the server's error code only. Never echo the request, which holds the secret.
      const detail = [data.error, data.error_description].filter(Boolean).join(': ') || 'no error detail';
      throw new TokenError(`The J.P. Morgan token server refused the request (HTTP ${res.status}, ${detail}).`);
    }
    const lifetimeMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 300) * 1000;
    this.cached = { token: data.access_token, expiresAt: this.now() + lifetimeMs };
    return this.cached.token;
  }
}

module.exports = { TokenClient, TokenError, DEFAULT_TOKEN_URL, DEFAULT_SCOPE };

// `node src/issuer/jpmorgan-auth.js` checks the credentials without printing the token.
if (require.main === module) {
  Promise.resolve()
    .then(() => TokenClient.fromEnv().getToken())
    .then(
      (token) => console.log(`Token received (${token.length} characters). The credentials work.`),
      (err) => { console.error(err.message); process.exitCode = 1; },
    );
}
