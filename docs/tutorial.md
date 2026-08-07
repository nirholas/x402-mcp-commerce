# Tutorial

From a clean clone to Claude booking a table with its own wallet — rehearsed against a sandbox
first, so the first mistake costs a fraction of a cent instead of a real reservation.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-mcp-commerce
cd x402-mcp-commerce
npm install
```

Node 18+ required.

## 2. Rehearse against the sandbox

Before wiring a wallet to real merchants, point everything at
[x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) — a fake town whose
responses mirror the real services field for field.

```bash
# terminal 1 — the merchants
git clone https://github.com/nirholas/x402-agent-sandbox
cd x402-agent-sandbox && npm install && npm run dev     # :4038

# terminal 2 — this server, driving them
cd x402-mcp-commerce
X402_TOOLS_CONFIG=./config/tools.sandbox.json npx tsx examples/agent-client.ts
```

You will see the tool list, the spending caps, a free upstream route answered without payment,
and the paid ones stopping exactly where they should:

```
10 tools registered:
  list_commerce_tools, spending_report, discover_service, find_tables, book_table, search_hotels,
  browse_catalog, buy_item, book_room, town_directory

rail default: auto   wallets held: none
  find_tables          free       auto    → x402-agent-sandbox
  book_table           $0.001     auto    → x402-agent-sandbox
  …

browse_catalog → free — artifact keys: store,items,sandbox
book_table → blocked: {"error":"NO_USABLE_RAIL","message":"book_table: upstream offers base-sepolia, solana but this agent holds keys for no rail"}
```

That last line is the system working: no key, no payment, and a message that says exactly why.

## 3. Give it a wallet

```bash
cp .env.example .env
```

Set one line:

```
PRIVATE_KEY=0x…a throwaway wallet funded with Base Sepolia USDC…
```

Faucet: https://faucet.circle.com. Now re-run step 2 and the paid tools go through:

```
book_table → paid $0.001 on evm — artifact keys: reservationId,status,restaurant,confirmedTime,party
```

The artifact is the merchant's response verbatim; `receipt` beside it holds the on-chain
settlement details.

## 4. Wire it into Claude Desktop

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows
`%APPDATA%/Claude/`. The full file is in
[`examples/claude_desktop_config.json`](https://github.com/nirholas/x402-mcp-commerce/blob/main/examples/claude_desktop_config.json).

```json
{
  "mcpServers": {
    "x402-commerce": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/x402-mcp-commerce/src/mcp.ts"],
      "env": {
        "PRIVATE_KEY": "0x…throwaway testnet wallet…",
        "X402_TOOLS_CONFIG": "/absolute/path/to/x402-mcp-commerce/config/tools.sandbox.json",
        "MAX_PER_CALL_USD": "0.01",
        "MAX_SESSION_USD": "0.10"
      }
    }
  }
}
```

Restart Claude Desktop and ask: *"find me a table for two next Friday evening and book it."*
Claude calls `find_tables`, picks a slot, calls `book_table`, and reads the confirmation out of
the response. Ask it for a `spending_report` afterwards and it will show you exactly what it
spent and where.

## 5. Choose the payment rail

Every suite merchant offers USDC on Base **and** USDC on Solana in the same 402. Five places can
decide which one gets signed — later wins:

```
config/tools.json  defaults.rail      "auto"
env                X402_RAIL          solana
config/tools.json  the tool's rail    "evm"
env                X402_RAIL_BOOK_TABLE   evm
the model          rail argument      book_table({…, rail: "solana"})
```

To run mostly on Solana while keeping one merchant on Base:

```
SOLANA_PRIVATE_KEY=…base58 secret key…
SOLANA_RPC_URL=https://your-dedicated-rpc.example.com
PRIVATE_KEY=0x…for the tools pinned to evm…
X402_RAIL=solana
X402_RAIL_BOOK_TABLE=evm
```

The Solana rail signs an SPL `transferChecked`. The facilitator's sponsor pays the SOL network
fee, so the agent's wallet needs USDC and no SOL. Use a dedicated RPC — the public endpoint is
heavily rate limited.

Try both explicitly:

```bash
curl -s -X POST http://localhost:4039/tools/book_table -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-01","time":"19:00","party":2,"name":"Ada","rail":"evm"}' | jq '.rail'
curl -s -X POST http://localhost:4039/tools/book_table -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-01","time":"19:00","party":2,"name":"Ada","rail":"solana"}' | jq '.rail'
```

## 6. Set the caps you actually want

The defaults are deliberately timid. Every cap is checked *before* a payment is signed, against
the real price from the upstream's 402:

```
MAX_PER_CALL_USD=0.05     # most this agent will pay for one call
MAX_SESSION_USD=1         # total for this process
MAX_CALLS=200             # total paid calls
ALLOWED_TOOLS=find_tables,book_table,check_weather
```

A blocked call comes back as a tool error with the cap name and the current spending state, so
the model can say "that's over my limit" rather than retrying forever. For purchases that
genuinely need to go through, escalate to a human with
[x402-approval-page](https://github.com/nirholas/x402-approval-page).

## 7. Point it at real merchants

Edit `config/tools.json`, or override upstreams one at a time:

```
X402_UPSTREAM_X402_TABLEBOOK=https://tablebook.example.com
X402_UPSTREAM_X402_STOREFRONT=https://store.example.com
```

Tool names, arguments and result shapes do not change — that is the whole point of rehearsing
against the sandbox first.

## 8. Going to mainnet

- Fund the agent wallet with real USDC and **lower the caps**, not raise them. `MAX_SESSION_USD`
  is the blast radius of a bad loop.
- **EVM**: the upstreams decide their own network. Your client signs whatever their 402 asks for.
- **Solana**: set a dedicated `SOLANA_RPC_URL`.
- For the inspector's own paid route, set `PAY_TO_ADDRESS` / `SOLANA_PAY_TO_ADDRESS` to wallets
  you control and a real `SIGNING_SECRET`, and point `FACILITATOR_URL` at a mainnet facilitator
  if you move `NETWORK` off `base-sepolia`.
- Keep `POST /tools/:name` off the public internet, or behind your own auth. It is free to call
  and it spends *your* wallet.
