# Wiring this into Claude

This repo *is* the MCP server, so there is nothing to write — only to configure. The full
config file is [`claude_desktop_config.json`](./claude_desktop_config.json); this page explains
what each part does.

## 1. Install and point it at some merchants

```bash
git clone https://github.com/nirholas/x402-mcp-commerce
cd x402-mcp-commerce && npm install
```

`config/tools.json` maps each tool to an upstream x402 route. The shipped `baseUrl`s follow the
suite's local-port convention (4000 + the service's suite id); change them to your own
deployments, or override one at a time from the environment:

```
X402_UPSTREAM_X402_TABLEBOOK=https://tablebook.example.com
X402_UPSTREAM_X402_STOREFRONT=https://store.example.com
```

## 2. Add it to Claude Desktop

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows
`%APPDATA%/Claude/`:

```json
{
  "mcpServers": {
    "x402-commerce": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/x402-mcp-commerce/src/mcp.ts"],
      "env": {
        "PRIVATE_KEY": "0x…a throwaway wallet funded with Base Sepolia USDC…",
        "X402_RAIL": "auto",
        "MAX_PER_CALL_USD": "0.05",
        "MAX_SESSION_USD": "1",
        "MAX_CALLS": "200"
      }
    }
  }
}
```

Restart Claude Desktop. Ask it to *"find me a table for two next Friday and book it"* and it
will call `find_tables`, then `book_table`, paying $0.001 and $0.01 in USDC along the way, and
read the confirmation straight out of the response.

Testnet USDC faucet: https://faucet.circle.com

## 3. Choosing the payment rail

Every suite merchant offers USDC on Base *and* USDC on Solana in the same 402. Which one gets
signed is layered — later wins:

| Layer | Where | Example |
|---|---|---|
| Registry default | `config/tools.json` → `defaults.rail` | `"rail": "auto"` |
| Server-wide | env | `X402_RAIL=solana` |
| Per tool, in config | `config/tools.json` → the tool's `rail` | `"rail": "evm"` |
| Per tool, from env | env | `X402_RAIL_BOOK_TABLE=evm` |
| Per call | the model | `book_table({..., rail: "solana"})` |

`auto` picks a rail this process holds a key for, EVM first. Every commerce tool advertises an
optional `rail` argument, so the model can be told *"pay for this one on Solana"* with no config
change at all.

Run mostly on Solana, but keep one merchant on Base:

```json
"env": {
  "SOLANA_PRIVATE_KEY": "…base58 secret key…",
  "SOLANA_RPC_URL": "https://your-dedicated-rpc.example.com",
  "PRIVATE_KEY": "0x…for the tools pinned to evm…",
  "X402_RAIL": "solana",
  "X402_RAIL_BOOK_TABLE": "evm"
}
```

## 4. Spending caps

Checked before any payment is signed, against the real price in the upstream's 402 — so a
runaway loop stops at the ledger rather than at the chain.

```json
"env": {
  "MAX_PER_CALL_USD": "0.05",
  "MAX_SESSION_USD": "1",
  "MAX_CALLS": "200",
  "ALLOWED_TOOLS": "find_tables,book_table,check_weather"
}
```

When a cap blocks a call, the tool result says so — `PER_CALL_CAP`, `SESSION_CAP`, `CALL_CAP` or
`TOOL_NOT_ALLOWED` — with the current spending state, so Claude can explain itself instead of
retrying blindly. For purchases above the cap, escalate to a human with
[x402-approval-page](https://github.com/nirholas/x402-approval-page).

Ask Claude to run `spending_report` at any point to see the caps, the running total, and every
payment made.

## 5. Rehearse before you spend

Point the whole toolbox at [x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox),
whose responses mirror the real merchants field for field:

```json
"x402-commerce-sandbox": {
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/x402-mcp-commerce/src/mcp.ts"],
  "env": {
    "PRIVATE_KEY": "0x…throwaway testnet wallet…",
    "X402_TOOLS_CONFIG": "/absolute/path/to/x402-mcp-commerce/config/tools.sandbox.json",
    "MAX_PER_CALL_USD": "0.01",
    "MAX_SESSION_USD": "0.10"
  }
}
```

A whole booking conversation costs a fraction of a cent and reserves nothing real. When it
works, switch back to the production registry — the tool names, arguments and result shapes do
not change.

## 6. Other MCP clients

Anything that speaks MCP over stdio works the same way. The command is
`npx tsx src/mcp.ts` (or `node dist/mcp.js` after `npm run build`), and configuration is entirely
environment variables — see [`.env.example`](../.env.example).

For clients that don't speak MCP at all, the inspector exposes `POST /tools/:name` over HTTP
with the same arguments and the same result envelope. See [`curl.md`](./curl.md).
