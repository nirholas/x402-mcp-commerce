# API reference

Two surfaces: the **MCP tools** (stdio — the product) and the **HTTP inspector** beside them.
Full machine-readable spec for the HTTP side:
[`openapi.json`](https://github.com/nirholas/x402-mcp-commerce/blob/main/openapi.json).

---

# MCP tools

Transport: stdio. Command: `npx tsx src/mcp.ts` (or `node dist/mcp.js` after `npm run build`).

## Result envelope

Every commerce tool returns the same shape, so the model always sees what it bought and what it
cost:

```json
{
  "tool": "book_table",
  "upstream": "x402-tablebook",
  "resource": "http://localhost:4001/book",
  "paid": true,
  "rail": { "requested": "auto", "used": "evm" },
  "artifact": { "reservationId": "res_…", "confirmedTime": "…", "cancelToken": "…", "ics": "…" },
  "receipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
  "price": { "usd": 0.01, "atomic": "10000", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }
}
```

| Field | Meaning |
|---|---|
| `artifact` | The merchant's response body, verbatim. This is what was purchased. |
| `paid` | `false` for upstream routes that are free; `receipt` and `price` are then `null`. |
| `rail.requested` / `rail.used` | What was asked for (`auto`/`evm`/`solana`) and what was actually signed. |
| `receipt` | Decoded `X-PAYMENT-RESPONSE` from the merchant. |
| `price` | The real price from the merchant's 402 — not the registry's hint. |

## Built-in tools — free

### `list_commerce_tools` `{}`
Every registered tool with its upstream, route, price and configured rail, plus which rails this
agent holds keys for.

### `spending_report` `{}`
```json
{
  "caps": { "maxPerCallUsd": 0.05, "maxSessionUsd": 1, "maxCalls": 200, "allowedTools": "all registered tools" },
  "spent": { "usd": 0.016, "calls": 3, "remainingUsd": 0.984, "remainingCalls": 197 },
  "wallets": { "evm": "0x…", "solana": "configured (address withheld)" },
  "rails": ["evm", "solana"],
  "ledger": [ { "at": "…", "tool": "book_table", "upstream": "x402-tablebook", "rail": "evm", "network": "base-sepolia", "amountUsd": 0.01, "transaction": "0x…", "payer": "0x…" } ]
}
```

### `discover_service` `{ baseUrl }`
Fetches `{baseUrl}/.well-known/x402` — routes, prices, both networks, output schemas. Use it
before buying from a service you haven't met.

## Commerce tools

Generated from `config/tools.json`. Each takes its own arguments plus an optional
`rail: "auto" | "evm" | "solana"`.

| Tool | Upstream | Route | Price | Arguments |
|---|---|---|---|---|
| `search_flights` | x402-flight-search | `GET /search` | $0.005 | `origin*`, `destination*`, `departureDate*`, `returnDate`, `adults`, `maxPrice` |
| `price_flight` | x402-flight-search | `GET /price/{offerId}` | $0.003 | `offerId*` |
| `find_tables` | x402-tablebook | `GET /availability` | $0.001 | `date`, `party`, `days` |
| `book_table` | x402-tablebook | `POST /book` | $0.01 | `date*`, `time*`, `party*`, `name*`, `notes` |
| `search_hotels` | x402-hotel-search | `GET /search` | $0.005 | `cityCode*`, `checkIn*`, `checkOut*`, `adults` |
| `check_weather` | x402-weather-guard | `GET /forecast` | $0.001 | `lat*`, `lon*`, `date` |
| `browse_catalog` | x402-storefront | `GET /catalog` | free | — |
| `buy_item` | x402-storefront | `GET /buy/{sku}` | per item | `sku*`, `name`, `address`, `country` |
| `search_places` | x402-places | `GET /search` | $0.002 | `q`, `lat`, `lon`, `radius`, `kind` |
| `search_news` | x402-news-wire | `GET /query` | $0.003 | `q*`, `since`, `limit` |
| `check_domain` | x402-domains | `GET /check/{domain}` | $0.001 | `domain*` |
| `track_confirmation` | x402-confirmations | `POST /track` | $0.005 | `confirmation`, `rawText`, `type` |

`*` = required. Prices are the registry's hints; the upstream's 402 is authoritative and is what
the caps are checked against.

## Registry format

```json
{
  "defaults": { "rail": "auto", "timeoutMs": 20000 },
  "tools": [
    {
      "name": "book_table",
      "description": "Book a restaurant table…",
      "upstream": "x402-tablebook",
      "baseUrl": "http://localhost:4001",
      "method": "POST",
      "path": "/book",
      "price": "$0.01",
      "query": [],
      "rail": "auto",
      "input": {
        "date": { "type": "string", "required": true, "description": "YYYY-MM-DD" }
      }
    }
  ]
}
```

`{param}` segments in `path` are filled from the arguments. On a `GET`, anything listed in
`query` becomes a query-string parameter. On a `POST`, `query` entries go on the URL and
everything else becomes the JSON body.

Environment overrides: `X402_TOOLS_CONFIG` (whole file), `X402_UPSTREAM_<UPSTREAM>` (one
baseUrl), `X402_RAIL` (default rail), `X402_RAIL_<TOOL>` (one tool's rail). Names are
upper-snake-cased: `X402_UPSTREAM_X402_TABLEBOOK`, `X402_RAIL_BOOK_TABLE`.

---

# HTTP inspector

Base URL: your deployment (default `http://localhost:4039`).

## GET /attest — $0.001

The one paid route. A signed, timestamped snapshot of this agent's capabilities and remaining
budget — for a coordinator, a human approver, or an auditor who needs more than the agent's own
say-so. Returned in the response body; nothing is delivered later.

```json
{
  "payload": {
    "attestationId": "att_…",
    "issuedAt": "2026-08-07T12:00:00.000Z",
    "expiresAt": "2026-08-07T12:05:00.000Z",
    "server": { "name": "x402-mcp-commerce", "version": "0.1.0" },
    "rails": { "default": "auto", "available": ["evm"], "note": "…" },
    "caps": { "maxPerCallUsd": 0.05, "maxSessionUsd": 1, "maxCalls": 200, "allowedTools": "all registered tools" },
    "budget": { "usd": 0.016, "calls": 3, "remainingUsd": 0.984, "remainingCalls": 197 },
    "tools": [
      { "name": "book_table", "upstream": "x402-tablebook", "baseUrl": "…", "route": "POST /book",
        "price": "$0.01", "rail": "auto", "affordable": true }
    ]
  },
  "signature": "hex…",
  "algorithm": "HMAC-SHA256",
  "canonicalization": "sorted-keys-json"
}
```

`affordable` is whether this agent could pay for that tool *right now* under its own caps —
which is usually the question the reader actually has. `ATTESTATION_TTL_SECONDS` (default 300)
controls `expiresAt`.

## GET /tools — free

The registry as the MCP server sees it, after env overrides, with input schemas.

## GET /ledger — free

Caps, spend so far, wallets in use, available rails, and every payment made this session.

## POST /tools/:name — free to call

Runs one registered tool over HTTP, for agents that don't speak MCP. Body is the tool's
arguments plus an optional `rail`.

```bash
curl -s -X POST http://localhost:4039/tools/book_table \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-01","time":"19:00","party":2,"name":"Ada","rail":"evm"}'
```

Returns the same envelope as the MCP tool. It is free because the caller is not paying *this*
server — they are triggering a payment from this agent's wallet, bounded by this agent's caps.
**Expose it only to callers you trust**: bind to localhost, or put your own auth in front.

Errors: `402` for a cap, `404 UNKNOWN_TOOL`, `501 SOLANA_PAYMENT_FAILED`, `502` for upstream and
rail problems, `500 TOOL_FAILED`.

## POST /verify — free

`{ payload, signature }` → `{ valid: true|false }` for any attestation this server signed.

## GET /health — free

`{ ok: true, service: "x402-mcp-commerce", rails: ["base", "solana"] }`.

## GET /skill.md, GET /.well-known/x402 — free

The agent-facing capability sheet and the machine-readable discovery manifest.

---

## 402 shape (GET /attest)

Dual-rail: `accepts` always lists **both** USDC on Base and USDC on Solana. Pay either one.

```json
{
  "x402Version": 1,
  "error": "Payment required — pay in USDC on Base or Solana; your client picks the rail.",
  "resource": {
    "url": "http://localhost:4039/attest",
    "description": "Signed attestation of this agent's tool registry, payment rails, caps, and remaining budget",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "1000",
      "resource": "http://localhost:4039/attest",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 60, "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact", "network": "solana", "maxAmountRequired": "1000", "amount": "1000",
      "resource": "http://localhost:4039/attest",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 60,
      "extra": { "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "name": "USDC", "decimals": 6 }
    }
  ]
}
```

## Error codes

| code | HTTP | meaning |
|---|---|---|
| `PER_CALL_CAP` / `SESSION_CAP` / `CALL_CAP` / `TOOL_NOT_ALLOWED` | 402 | the agent's own spending policy blocked the call before signing |
| `RAIL_UNAVAILABLE` | 502 | the requested rail is not in the upstream's `accepts` |
| `NO_USABLE_RAIL` | 402 | the upstream's rails and this agent's keys don't overlap |
| `NO_WALLET` | 401 | `PRIVATE_KEY` is unset, so the EVM rail cannot sign |
| `SOLANA_PAYMENT_FAILED` | 501 | the Solana payment could not be built or signed |
| `UPSTREAM_UNREACHABLE` | 502 | the merchant's base URL did not answer |
| `MALFORMED_CHALLENGE` | 502 | the upstream returned 402 with no `accepts[]` |
| `PAYMENT_FAILED` | 502 | signing or settlement failed |
| `UPSTREAM_ERROR` | *upstream's* | the merchant returned an error; its status and body are passed through |
| `UNKNOWN_TOOL` | 404 | no tool by that name in the registry |
| `INVALID_REQUEST` | 400 | malformed `/verify` body |
