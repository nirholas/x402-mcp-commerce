# x402-mcp-commerce

> MCP server that gives Claude/GPT agents commerce tools — each tool call pays an upstream x402 endpoint and returns its artifact.

![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![x402](https://img.shields.io/badge/payments-x402-0052ff) ![USDC](https://img.shields.io/badge/asset-USDC-2775CA) ![Rails](https://img.shields.io/badge/rails-Base%20%2B%20Solana-9945FF) ![MCP](https://img.shields.io/badge/protocol-MCP-7c3aed)

**Pay in USDC on Base or Solana — the agent picks the rail, per call.**

Give a model a wallet, a spending cap, and a dozen merchants. `book_table`, `search_flights`,
`buy_item`, `check_weather` — each tool call pays an upstream x402 route in USDC and hands back
the merchant's artifact with the payment receipt attached. The model never sees a key, never
signs anything, and cannot spend past a cap it doesn't control.

## Why x402 for this

Tool-using agents hit a wall the moment a tool costs money: API keys have to be provisioned per
merchant, per agent, in advance, by a human. x402 inverts that — the merchant advertises a price
in a `402`, the agent signs a USDC payment for exactly that amount, and the goods come back in
the same response. A new merchant becomes a new tool by adding four lines to a JSON file. No
signup, no key distribution, no billing relationship, and a per-call cost the agent can reason
about because it is printed in the result.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-mcp-commerce
cd x402-mcp-commerce && npm install

# rehearse the whole toolbox against the sandbox — costs a fraction of a cent
git clone https://github.com/nirholas/x402-agent-sandbox
(cd ../x402-agent-sandbox && npm install && npm run dev &)     # :4038
X402_TOOLS_CONFIG=./config/tools.sandbox.json npx tsx examples/agent-client.ts

# the real thing
npm run mcp        # MCP server over stdio — what Claude Desktop launches
npm run dev        # the HTTP inspector on :4039
```

Add it to Claude Desktop with
[`examples/claude_desktop_config.json`](examples/claude_desktop_config.json), restart, and ask
for a table next Friday.

## Tools

Twelve commerce tools, generated from [`config/tools.json`](config/tools.json), plus three
built-ins. Every commerce tool takes an optional `rail` argument.

| Tool | Upstream | Price | What you get back |
|---|---|---|---|
| `search_flights` | x402-flight-search | $0.005 | Priced offers for a route and date. |
| `price_flight` | x402-flight-search | $0.003 | Live price + availability for one offer. |
| `find_tables` | x402-tablebook | $0.001 | Open reservation slots. |
| `book_table` | x402-tablebook | $0.01 | Confirmed reservation + cancel token + refund terms + ICS invite. |
| `search_hotels` | x402-hotel-search | $0.005 | Room offers for a city and date range. |
| `check_weather` | x402-weather-guard | $0.001 | Forecast with a plan-relevant summary. |
| `browse_catalog` | x402-storefront | free | Items, prices, buy routes. |
| `buy_item` | x402-storefront | per item | Digital: signed download URL + license. Physical: signed order + fulfillment record. |
| `search_places` | x402-places | $0.002 | Places near a point or in an area. |
| `search_news` | x402-news-wire | $0.003 | Coverage of a topic in a window. |
| `check_domain` | x402-domains | $0.001 | Registration status, holder, expiry. |
| `track_confirmation` | x402-confirmations | $0.005 | Any merchant confirmation → portable record + ICS. |
| `list_commerce_tools` · `spending_report` · `discover_service` | — | free | Capabilities, ledger, and any x402 service's manifest. |

Every call returns the same envelope — the merchant's artifact plus the receipt and the exact
price paid:

```json
{
  "tool": "book_table",
  "paid": true,
  "rail": { "requested": "auto", "used": "evm" },
  "artifact": { "reservationId": "res_…", "cancelToken": "…", "ics": "…" },
  "receipt": { "success": true, "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
  "price": { "usd": 0.01, "atomic": "10000", "asset": "0x036C…" }
}
```

Full reference: [docs/api.md](docs/api.md) · [openapi.json](openapi.json)

## Choosing a payment rail

Every suite merchant offers USDC on Base **and** USDC on Solana in the same 402. Five layers
decide which one gets signed — later wins:

| Layer | Where | Example |
|---|---|---|
| Registry default | `config/tools.json` → `defaults.rail` | `"rail": "auto"` |
| Server-wide | env | `X402_RAIL=solana` |
| Per tool, in config | the tool's `rail` field | `"rail": "evm"` |
| Per tool, from env | env | `X402_RAIL_BOOK_TABLE=evm` |
| Per call | the model | `book_table({…, rail: "solana"})` |

`auto` takes a rail this process holds a key for, EVM first. The choice is honoured strictly: if
the requested rail isn't in the upstream's `accepts`, the call fails with `RAIL_UNAVAILABLE`
rather than quietly paying on the other one.

The EVM rail signs an EIP-3009 authorization with a viem account. The Solana rail signs an SPL
`transferChecked` whose network fee is covered by the facilitator's sponsor — so the agent needs
USDC and no SOL.

## Spending caps

Checked **before** any payment is signed, against the real price in the upstream's 402 — so a
runaway loop stops at the ledger, not at the chain.

```
MAX_PER_CALL_USD=0.05     # most this agent will pay for one call
MAX_SESSION_USD=1         # total for this process
MAX_CALLS=200             # total paid calls
ALLOWED_TOOLS=            # comma-separated allowlist; empty = all
```

A blocked call returns the cap that stopped it plus the current spending state, so the model can
explain itself rather than retry. For purchases that genuinely need to go through, escalate to a
human with [x402-approval-page](https://github.com/nirholas/x402-approval-page).

## How x402 works

1. The tool calls its upstream route with no payment → `402 Payment Required` with an `accepts`
   array listing **both rails**.
2. This server picks the rail (config, per-tool override, or the model's own `rail` argument),
   checks the real price against its caps, and signs that payment.
3. It retries with the base64 `X-PAYMENT` header; the merchant's facilitator verifies and settles.
4. `200` — the artifact comes back in the body, the receipt in `X-PAYMENT-RESPONSE`, and both
   land in the tool result.

The inspector's own paid route (`GET /attest`) speaks the same protocol from the other side:

| rail | network (default) | mainnet | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` | `NETWORK=base` | `PAY_TO_ADDRESS` | `FACILITATOR_URL` (default `https://x402.org/facilitator`) |
| Solana | `solana` | `SOLANA_NETWORK=devnet` for testing | `SOLANA_PAY_TO_ADDRESS` | `SOLANA_FACILITATOR_URL` (default `https://facilitator.payai.network`) |

Both ship with the suite's public receive addresses pre-filled in `.env.example`, so `npm run
dev` works with zero configuration.

## Real backend / API keys

Self-contained: no third-party APIs and no keys of its own. What the envs unlock is **spending
ability**, not data:

- `PRIVATE_KEY` — the EVM wallet that signs Base payments. Without it the EVM rail is unavailable.
- `SOLANA_PRIVATE_KEY` — base58 or JSON-array secret key for the Solana rail. Optional; leave it
  unset and the agent simply never takes that rail.
- `SOLANA_RPC_URL` — used to build the SPL transfer. The public endpoint is heavily rate limited.
- `SIGNING_SECRET` — HMAC key behind the attestation signature.

Upstream services have their own key policies; this server just pays them.

## For AI agents

- [`skill.md`](skill.md) — agent-facing capability sheet, served at `GET /skill.md`.
- `GET /.well-known/x402` — machine-readable manifest ([source](public/.well-known/x402)) with an
  `mcp` block describing the transport and built-in tools, in the format indexed by
  [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).
- Not an MCP client? `POST /tools/:name` runs any tool over HTTP with the same arguments and the
  same envelope. It is free to call and spends *your* wallet — keep it off the public internet.
- Guide: [docs/agents.md](docs/agents.md) · Claude wiring: [examples/mcp-tool.md](examples/mcp-tool.md).

## Docs

Site: **https://nirholas.github.io/x402-mcp-commerce/** — [tutorial](docs/tutorial.md) · [API](docs/api.md) · [agents](docs/agents.md) · [curl walkthrough](examples/curl.md)

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, bugs, integration help: **nichxbt@gmail.com**

## License

[Apache-2.0](LICENSE)
