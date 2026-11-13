# Tessera

Two things live here.

## 1. The concept site

`index.html` is the Tessera One card concept page, published at
https://anthonysang2871.github.io/legendary-rotary-phone/.

## 2. The real-time card program

A working card program that runs on your machine: it issues cards instantly,
decides every charge in real time against the card's controls, and streams each
decision to a live dashboard.

```
npm start        # then open http://127.0.0.1:3000
npm test
```

It needs Node 20 or newer and has no dependencies.

### What it does

- **Issue a card** with a cardholder name and credit limit.
- **Authorize charges.** Each charge is approved or declined on the spot, with
  the reason, against: card status, expiry, online and international switches,
  blocked categories, per-charge cap, daily limit and available credit.
- **Change controls live.** Freeze, unfreeze, close, or adjust any control; the
  next charge sees the change.
- **Earn points** on approved charges: 5× travel, 4× dining, 3× groceries, 2×
  everything else, per whole dollar.
- **Live feed.** `GET /api/events` is a server-sent event stream of every card
  change and decision.

### API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cards` | Issue a card: `{ cardholderName, creditLimitCents }` |
| `GET` | `/api/cards` | List cards |
| `PATCH` | `/api/cards/:id` | Change `status`, `online`, `international`, `perChargeCapCents`, `dailyLimitCents`, `blockedCategories` |
| `POST` | `/api/cards/:id/authorizations` | Decide a charge: `{ amountCents, channel, merchant: { name, category, country } }` |
| `GET` | `/api/transactions` | Latest decisions |
| `GET` | `/api/events` | Live event stream |

All money is in whole cents.

### Limits you should know

- **It runs on a simulator.** Cards are test records with an id, last four
  digits and expiry. There is no full card number, no real account, and nothing
  can be spent.
- **J.P. Morgan is separate from the simulator.** The Prepaid Card API does
  not let you decide charges or set the controls above, so it is a separate
  client (see below), not an issuer for this program.
- **Data is in memory.** Restarting the server clears all cards and
  transactions.
- **There is no login.** The server listens on `127.0.0.1` only. Do not expose
  it to a network as is.

### J.P. Morgan mock sign-in

`src/issuer/jpmorgan-auth.js` fetches an access token from the J.P. Morgan
Payments mock environment, following the public quick-start guide. Set these
environment variables, then run the check:

| Variable | Required | Value |
|---|---|---|
| `JPM_CLIENT_ID` | yes | Client ID from the portal's Security page, Mock tab |
| `JPM_CLIENT_SECRET` | yes | Client secret from the same page |
| `JPM_TOKEN_URL` | no | Access token URL, if it differs from the quick-start default |
| `JPM_SCOPE` | no | Defaults to `jpm:payments:sandbox` |

```
node src/issuer/jpmorgan-auth.js
```

It prints whether a token was received and never prints the token or secret.
Keep the values out of the repository: `.env` files, keys and certificates are
git-ignored.

Client Testing and Production use a different sign-in (a JWT signed with your
certificate's private key). That flow is not built.

### J.P. Morgan Prepaid Card client

`src/issuer/jpmorgan-prepaid.js` implements the J.P. Morgan Prepaid Card APIs
(Global, Funding and Card Link) from their OpenAPI specifications.

| Method | Endpoint | Signed |
|---|---|---|
| `createAccount(account)` | `POST /accounts` | yes |
| `updateAccount(update)` | `POST /accounts/update` | yes |
| `getAccount({ identifier, identifierType })` | `POST /accounts/details` | no |
| `fundAccount({ accountNumber, amountCents, direction, traceId })` | `POST /fundings` | yes |
| `listTransactions({ accountNumber, fromDate, toDate })` | `POST /transactions/list` | no |
| `createCard(card)` | `POST /cards` | yes |
| `linkCard(link)` | `POST /card/linkCard` | yes |
| `getWebviewLink(accountNumber)` | `POST /webview-links` | no |

Every request uses mutual TLS. Signed requests send the body as an RS256 JWS,
following J.P. Morgan's "mTLS with Digital Signature" guide.

```js
const { PrepaidCardClient } = require('./src/issuer/jpmorgan-prepaid');
const client = PrepaidCardClient.fromEnv();
await client.fundAccount({ accountNumber: '501002640305', amountCents: 2500, direction: 'credit', traceId: 'load0001' });
```

| Variable | Required | Value |
|---|---|---|
| `JPM_PREPAID_CLIENT_ID` | yes | `X-Client-Id` from your J.P. Morgan implementation manager |
| `JPM_MTLS_CERT_FILE` | yes | Path to your client certificate (PEM) |
| `JPM_MTLS_KEY_FILE` | yes | Path to that certificate's private key (PEM) |
| `JPM_SIGNING_KEY_FILE` | yes | Path to the Digital Signature certificate's private key (PEM) |
| `JPM_PREPAID_BASE_URL` | no | Defaults to Client Testing, `https://apigatewayqaf.jpmorgan.com/tsapi/v1/gpp` |
| `JPM_SIGNED_CONTENT_TYPE` | no | Defaults to `application/jose` |

What to know before using it:

- **Not yet run against J.P. Morgan.** The Prepaid Card API has no mock
  environment. The tests run against a local stand-in server that requires a
  client certificate and checks the signature. Confirm in Client Testing that
  the gateway accepts `application/jose` for signed requests; the guide says
  older APIs use `text/xml`.
- **It needs J.P. Morgan onboarding.** Your certificates must be registered for
  Client Testing and the product enabled for your organization.
- **It handles identity data.** Creating an account sends a cardholder's name,
  birth date, address and government ID. The client never logs request or
  response bodies; keep it that way in anything you build on it.
- **Money is in whole cents** and converted to the API's decimal strings.
