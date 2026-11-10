---
name: x402-commerce-tools
description: Use the x402-mcp-commerce MCP server to search flights, hotels, tables, news and domains, and to buy items, with each tool call paid in USDC over x402 under hard spend caps. Use when an agent should buy real-world data or services without ever touching a key.
---

# x402-mcp-commerce

An MCP server (stdio) that turns x402 merchant routes into tools. Calling a tool pays the upstream merchant in USDC over HTTP 402 and returns the merchant's artifact plus the payment receipt. Keys and spending caps live in the server environment, so the model never sees a key.

## Launch

The plugin's `.mcp.json` runs `npx -y @nirholas/x402-mcp-commerce` (bin `x402-mcp-commerce`, entry `dist/mcp.js`). From a clone instead: `npm install && npm run mcp`.

Export these in the shell you start Claude Code from. The server inherits that environment, and the plugin's `.mcp.json` deliberately lists no keys, so no key is ever written to a config file:

- `SOLANA_PRIVATE_KEY`: base58 or JSON-array secret key, enables the USDC-on-Solana rail. Without it, Solana payments fail with `SOLANA_PAYMENT_FAILED`.
- `PRIVATE_KEY`: EVM key, enables the USDC-on-Base rail. Without it, calls on that rail fail with `NO_WALLET`.
- Optional: `SOLANA_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, `X402_TIMEOUT_MS` (default 20000).

Use throwaway, low-balance wallets. Every payment is real USDC on the configured network.

## Upstreams

`config/tools.json` ships with `baseUrl`s of the form `http://localhost:40NN`. Point each at a live deployment with `X402_UPSTREAM_<UPSTREAM>` (upper-snake-case, for example `X402_UPSTREAM_X402_TABLEBOOK=https://...`), or use another registry file with `X402_TOOLS_CONFIG=/path/to/tools.json`. The repo also ships `config/tools.sandbox.json` for rehearsal against x402-agent-sandbox.

## Tools

Free built-ins (no payment):

- `list_commerce_tools`: every tool with upstream, route, price, rail and which rails you hold keys for.
- `spending_report`: caps, spend so far, remaining budget, full payment ledger.
- `discover_service` with `{baseUrl}`: reads any service's `/.well-known/x402` manifest.

Paid commerce tools (price is the registry hint; the upstream 402 is authoritative): `search_flights` ($0.005), `price_flight` ($0.003), `find_tables` ($0.001), `book_table` ($0.01), `search_hotels` ($0.005), `check_weather` ($0.001), `browse_catalog` (free), `buy_item` (per item), `search_places` ($0.002), `search_news` ($0.003), `check_domain` ($0.001), `track_confirmation` ($0.005). Call `list_commerce_tools` for the exact input fields of each.

Every commerce tool returns `{tool, upstream, resource, paid, rail:{requested,used}, artifact, receipt, price}`. `artifact` is the merchant's response verbatim.

## Choosing a rail

Every commerce tool accepts an optional `rail` argument: `auto`, `evm` or `solana`. Precedence, later wins: `defaults.rail` in the registry, `X402_RAIL`, the tool's own `rail`, `X402_RAIL_<TOOL_NAME>` (for example `X402_RAIL_BOOK_TABLE=evm`), then the call argument. `auto` picks a rail you hold a key for, EVM first. If the upstream does not offer the chosen rail the call fails with `RAIL_UNAVAILABLE`.

## Spend caps

Checked before anything is signed:

- `MAX_PER_CALL_USD` (default 0.05), `MAX_SESSION_USD` (default 1), `MAX_CALLS` (default 200).
- `ALLOWED_TOOLS`: comma-separated allowlist.

A blocked call returns `PER_CALL_CAP`, `SESSION_CAP`, `CALL_CAP` or `TOOL_NOT_ALLOWED` with the current spending state. Do not retry around a cap; tell the user and let them raise it.

## Workflow

1. Call `list_commerce_tools`, then `spending_report`.
2. Before a paid call, tell the user the tool, the price and the rail, and get a go-ahead for anything that books or buys (`book_table`, `buy_item`).
3. Call the tool, then report `artifact` and `receipt.transaction`.
4. Other error codes: `NO_USABLE_RAIL`, `UPSTREAM_UNREACHABLE`, `MALFORMED_CHALLENGE`, `PAYMENT_FAILED`, `UPSTREAM_ERROR`, `UNKNOWN_TOOL`.

## HTTP inspector

`npm run dev` (tsx `src/server.ts`, port from `PORT`, default 4039) serves `GET /tools`, `GET /ledger`, `POST /tools/:name`, `POST /verify`, `GET /health`, and the paid `GET /attest` ($0.001), a signed snapshot of caps and remaining budget. `POST /tools/:name` spends this agent's wallet, so expose it only to trusted callers.
