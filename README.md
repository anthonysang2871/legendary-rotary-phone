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
- **The J.P. Morgan connection is not built.** `src/issuer/jpmorgan.js` marks
  where it goes and refuses to start. It needs J.P. Morgan's card API
  documentation and sandbox access.
- **Data is in memory.** Restarting the server clears all cards and
  transactions.
- **There is no login.** The server listens on `127.0.0.1` only. Do not expose
  it to a network as is.
