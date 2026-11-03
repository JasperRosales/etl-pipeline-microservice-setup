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

Set the pipeline's `.env` to:

```
SHEETS_ENDPOINT=http://127.0.0.1:18080/transactions
API_TOKEN=dev-token
```
