# salsa-pos-api

Source POS API for the S.A.L.S.A. ETL pipeline. The extractor
(`services/extractor`) calls it as `SHEETS_ENDPOINT`.

Deployed on Render as the `salsa-pos-api` web service (root directory `salsa-pos-api`).

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Liveness check and the current row count |
| GET | `/transactions?token=…&since=…` | token | `{ count, transactions: [...] }`. `since` is optional and exclusive (`timestamp > since`) |
| GET | `/transactions/:id?token=…` | token | One sale |
| POST | `/transactions?token=…` | token | Adds a sale `{ amount, currency?, timestamp?, items?, store_id?, cashier_id?, payment_method? }`. Stored in memory only; it is lost on restart |

`POST /transactions` checks the body in `src/validate.js` and returns `400` if:

- `amount` is not a positive number with at most 2 decimals, or is over 1,000,000
- `currency` is not a 3-letter code (default `PHP`)
- `timestamp` cannot be parsed or is in the future
- `payment_method` is not `cash`, `card`, `gcash` or `maya`
- `store_id` or `cashier_id` is empty or over 64 characters
- an entry in `items` has no `name`, a `qty` that is not a positive whole number, or a `unit_price` that is not above 0

These rules match what the ETL transformer accepts. A sale that passes them
does not end up as a rejected row in the pipeline.

You can send the token as the `token` query parameter (that is what the
extractor does) or as `Authorization: Bearer <token>`. A missing or wrong token
gets a `401`.

Each row has `id`, `amount` (a decimal string), `currency` (`PHP`) and
`timestamp` (ISO 8601 UTC). The extractor maps those four fields. The rest of
the row (`store_id`, `cashier_id`, `payment_method`, `discount`, `items`, `row`)
stays in `payload`.

## Seed data

`data/seed.json` has 120 sales from October 2026 across 3 stores. The
`npm run seed` script builds it with a fixed random seed, so you get the same
rows every time. The pipeline's dedupe hash therefore stays stable across
extractions.

## Run locally

```bash
npm install
API_TOKEN=dev-token PORT=18080 npm start
curl "http://localhost:18080/transactions?token=dev-token&since=2026-10-25T00:00:00Z"
```

To record sales from a phone, use the separate [salsa-pos-ui](https://github.com/JasperRosales/salsa-pos-ui) repo.
It proxies to this API and keeps the token in its own `.env`.

Run the tests with `npm test`.

Set the pipeline's `.env` to:

```
SHEETS_ENDPOINT=http://127.0.0.1:18080/transactions
API_TOKEN=dev-token
```
