# M-Pesa Donation Backend (via PayHero)

STK push donation flow using [PayHero](https://payhero.co.ke) as the payment
aggregator, instead of talking to Safaricom's Daraja API directly. PayHero
sits in front of Daraja — you register your Till/Paybill with them, and they
handle the OAuth/shortcode/passkey plumbing on their end.

## 1. Install

```bash
npm install
```

## 2. Get your PayHero credentials

1. Create/log into your account at [app.payhero.co.ke](https://app.payhero.co.ke).
2. Go to **Payment Channels -> My Payment Channels** and register your Till
   number (1111111). PayHero will assign it a **channel_id** — this is
   different from the till number itself, and it's what the API actually uses.
3. Go to the **API Keys** menu and generate/copy your API username and
   password.

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `PAYHERO_API_USERNAME` / `PAYHERO_API_PASSWORD` | PayHero portal -> API Keys |
| `PAYHERO_CHANNEL_ID` | PayHero portal -> Payment Channels -> the ID next to your registered Till |
| `PAYHERO_CALLBACK_URL` | A public HTTPS URL reaching this server's `/payhero/callback` route (see below) |

**Getting a callback URL that works:**
- **Local dev:** run `ngrok http 3000`, then set `PAYHERO_CALLBACK_URL` to `https://<your-ngrok-id>.ngrok-free.app/payhero/callback`.
- **Production:** point it at your real domain, e.g. `https://rn.dev/payhero/callback`.

## 4. Run

```bash
npm start
```

Visit `http://localhost:3000`.

## How it works

1. Browser submits amount + phone to `POST /stkpush`.
2. Server calls PayHero's `POST /api/v2/payments` with Basic auth
   (`base64(username:password)`), your `channel_id`, and a generated
   `external_reference`. PayHero relays the STK push to the customer's phone.
3. Once the customer enters (or cancels) their PIN, PayHero calls **your
   server** at `POST /payhero/callback` — not the browser — with the result.
4. Meanwhile the browser polls `GET /status/:reference` every 1.5s until it
   sees `success` or `failed`, then shows the receipt.

## A known gap — please read before your first real test

PayHero's developer docs are JavaScript-rendered, so I could confirm the
exact **request** format (`POST /api/v2/payments`, Basic auth, the
`amount`/`phone_number`/`channel_id`/`provider`/`external_reference`/
`callback_url` fields, and the `{success, status, reference,
CheckoutRequestID}` response) but **not** the exact field names in the
**callback** payload they send back.

`/payhero/callback` in `server.js` logs the full raw payload to your
terminal and tries to match several plausible shapes (`success`/`Success`,
`status`/`Status`, `ResultCode`, etc.). Do one real test donation, then:

1. Check your terminal for a line starting `PayHero callback payload:`
2. Send me that JSON (redact your phone number if you want) and I'll adjust
   the parsing in `/payhero/callback` to match exactly.

Until that's confirmed, the receipt screen might not populate the M-Pesa
receipt number correctly even though the payment itself succeeds.

## Notes

- Transactions are stored in memory (`Map`) — fine for a low-traffic page,
  but a server restart clears history. Swap in Airtable/Sheets if you want
  persistence, called from inside `/payhero/callback`.
- Never commit `.env` — it's already in `.gitignore`.
