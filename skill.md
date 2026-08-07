# x402-mcp-commerce — agent skill

An MCP server that turns the x402 suite into tools a model can call. Each tool maps to one
upstream x402 route: calling it pays that merchant in USDC over HTTP 402 and returns the
merchant's artifact together with the payment receipt. The agent's wallet, spending caps, and
**payment rail** all live in this server's config, so the model gets commerce without ever
touching a key.

This service is primarily a **buyer**. The one thing it sells is `GET /attest` — a signed
snapshot of what it can spend and where.

**MCP transport**: stdio — `npx tsx src/mcp.ts`
**Inspector base URL**: `{BASE_URL}` (self-hosted — e.g. `http://localhost:4039`)

## MCP tools

Twelve commerce tools are generated from `config/tools.json`, plus three built-ins. Point the
registry's `baseUrl`s at your own deployments, or at
[x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) (ship
`config/tools.sandbox.json`) to rehearse everything for fractions of a cent.

### Built-in — free, no payment
| Tool | Returns |
|---|---|
| `list_commerce_tools` | Every tool with its upstream, route, price and configured rail, plus which rails this agent holds keys for. |
| `spending_report` | Caps, spend so far, remaining budget, and the full payment ledger. |
| `discover_service` `{baseUrl}` | Any x402 service's `/.well-known/x402` manifest — routes, prices, rails, output schemas. |

### Commerce — paid, upstream prices
| Tool | Upstream | Price | Returns |
|---|---|---|---|
| `search_flights` | x402-flight-search | $0.005 | Priced offers for a route and date. |
| `price_flight` | x402-flight-search | $0.003 | Live price and availability for one offer. |
| `find_tables` | x402-tablebook | $0.001 | Open reservation slots. |
| `book_table` | x402-tablebook | $0.01 | Confirmed reservation + cancel token + refund terms + ICS invite. |
| `search_hotels` | x402-hotel-search | $0.005 | Room offers for a city and date range. |
| `check_weather` | x402-weather-guard | $0.001 | Forecast with the plan-relevant summary. |
| `browse_catalog` | x402-storefront | free | Items with prices and buy routes. |
| `buy_item` | x402-storefront | per item | Digital: signed download URL + license. Physical: signed order confirmation + fulfillment record. |
| `search_places` | x402-places | $0.002 | Places near a point or in an area. |
| `search_news` | x402-news-wire | $0.003 | Coverage of a topic in a time window. |
| `check_domain` | x402-domains | $0.001 | Registration status, holder, expiry. |
| `track_confirmation` | x402-confirmations | $0.005 | Any merchant confirmation normalized to a portable record + ICS. |

### Tool result shape

Every commerce tool returns the same envelope, so the model always sees what it bought and what
it cost:

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

`artifact` is the merchant's response verbatim. Free upstream routes come back with
`paid: false` and no receipt.

## Choosing a payment rail

Every suite merchant offers **USDC on Base** and **USDC on Solana** in the same 402. This server
decides which one to sign, and the decision is layered — later wins:

1. `defaults.rail` in `config/tools.json`
2. `X402_RAIL` (server-wide: `auto` | `evm` | `solana`)
3. the tool's own `rail` field in the registry
4. `X402_RAIL_<TOOL_NAME>` (e.g. `X402_RAIL_BOOK_TABLE=evm`)
5. a `rail` argument on the individual tool call — every commerce tool accepts one

`auto` picks a rail this process actually holds a key for, EVM first. So a model can be told
"pay for this one on Solana" without touching the server config, and an operator can run mostly
on Solana while pinning one particular merchant to Base.

If a chosen rail isn't offered by the upstream, the call fails with `RAIL_UNAVAILABLE` rather
than silently paying on the other one.

## Spending caps

Checked **before** any payment is signed, against the real price in the upstream's 402:

| Env | Default | Meaning |
|---|---|---|
| `MAX_PER_CALL_USD` | `0.05` | Most this agent will pay for any single tool call. |
| `MAX_SESSION_USD` | `1` | Total this process may spend before it refuses. |
| `MAX_CALLS` | `200` | Total paid calls this process may make. |
| `ALLOWED_TOOLS` | *(all)* | Comma-separated allowlist. |

A blocked call returns `PER_CALL_CAP`, `SESSION_CAP`, `CALL_CAP` or `TOOL_NOT_ALLOWED` with the
current spending state — enough for the model to explain itself, or to escalate to a human via
[x402-approval-page](https://github.com/nirholas/x402-approval-page).

## HTTP endpoints (the inspector)

### GET /attest — $0.001 (paid via x402)
A signed snapshot of this agent's capabilities and remaining budget. Useful when a coordinator,
a human approver, or an auditor needs to know what the agent can spend and where, without taking
the agent's word for it.

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
    "tools": [ { "name": "book_table", "upstream": "x402-tablebook", "price": "$0.01", "rail": "auto", "affordable": true } ]
  },
  "signature": "hex…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

### Free routes
- `GET /tools` — the registry after env overrides, with input schemas.
- `GET /ledger` — caps, spend, and every payment made this session.
- `POST /tools/:name` `{...args, rail?}` — run one tool over HTTP, for agents that don't speak
  MCP. Free to call because it spends *this agent's* wallet under *this agent's* caps — expose
  it only to callers you trust.
- `POST /verify` `{payload, signature}` — check any attestation this server signed.
- `GET /health`, `GET /skill.md`, `GET /.well-known/x402`.

## Payment

x402 protocol (HTTP 402). **Pay in USDC on Base or Solana — your client picks the rail.**

`GET /attest` answers an unpaid request with one `402` whose `accepts` array lists both rails:

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (default) or `base` | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `https://x402.org/facilitator` |
| Solana | `solana` (default) or `solana-devnet` | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `https://facilitator.payai.network` |

Flow: call the route → receive `402` with `accepts` → pick the entry your wallet supports → sign
the USDC payment (EIP-3009 authorization on EVM, SPL `transferChecked` on Solana) → retry with
the base64 `X-PAYMENT` header. The artifact comes back in the `200` body and the settlement
receipt in `X-PAYMENT-RESPONSE`.

## Error codes

| code | meaning |
|---|---|
| `PER_CALL_CAP` / `SESSION_CAP` / `CALL_CAP` / `TOOL_NOT_ALLOWED` | the agent's own spending policy blocked the call before signing |
| `RAIL_UNAVAILABLE` | the requested rail is not in the upstream's `accepts` |
| `NO_USABLE_RAIL` | the upstream's rails and this agent's keys don't overlap |
| `NO_WALLET` | `PRIVATE_KEY` is unset, so the EVM rail cannot sign |
| `SOLANA_PAYMENT_FAILED` | the Solana payment could not be built or signed (usually `SOLANA_PRIVATE_KEY` unset) |
| `UPSTREAM_UNREACHABLE` | the merchant's base URL did not answer |
| `MALFORMED_CHALLENGE` | the upstream returned 402 with no `accepts[]` |
| `PAYMENT_FAILED` | signing or settlement failed at the facilitator |
| `UPSTREAM_ERROR` | the merchant returned an error, with its status and body |
| `UNKNOWN_TOOL` | no tool by that name in the registry |

Machine-readable manifest: [`/.well-known/x402`]({BASE_URL}/.well-known/x402)

Contact: **nichxbt@gmail.com**
