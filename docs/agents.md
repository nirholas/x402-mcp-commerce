# For AI agents

## What this is

Most services in the x402 suite are things an agent buys *from*. This one is the layer that does
the buying: an MCP server that turns the suite into tools a model can call, holding the wallet,
the spending caps, and the payment-rail policy so the model never touches a key.

Two ways in:

- **MCP over stdio** — `npx tsx src/mcp.ts`. This is what Claude Desktop and other MCP clients
  launch. Twelve commerce tools plus three built-ins.
- **HTTP** — `POST /tools/:name` on the inspector, same arguments, same result envelope, for
  agents that don't speak MCP.

## Discovery

- [`skill.md`](https://github.com/nirholas/x402-mcp-commerce/blob/main/skill.md) — the capability
  sheet: every tool, its price, its rail, its result shape. Served at `GET /skill.md`.
- `GET /.well-known/x402` — the machine-readable manifest, including an `mcp` block describing
  the transport and the built-in tools. Indexed by [x402scan.com](https://x402scan.com), the
  x402 Bazaar, and [agentic.market](https://agentic.market).
- `GET /tools` — the live registry after env overrides, with input schemas.
- The `discover_service` tool reads any *other* x402 service's manifest, so an agent can find new
  merchants at runtime and decide whether they are worth adding to the registry.

## What you get back

Every commerce tool returns one envelope:

```json
{
  "tool": "book_table",
  "upstream": "x402-tablebook",
  "resource": "http://localhost:4001/book",
  "paid": true,
  "rail": { "requested": "auto", "used": "evm" },
  "artifact": { "reservationId": "res_…", "cancelToken": "…", "ics": "…" },
  "receipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
  "price": { "usd": 0.01, "atomic": "10000", "asset": "0x036C…" }
}
```

`artifact` is the merchant's response verbatim — the suite's iron rule is that a paid route
returns the purchased thing in the same response, so there is never anything to poll for. The
`receipt` and `price` sit beside it, which means a model can reason about what a session has
cost without a separate accounting call.

## Choosing a rail

Every suite merchant offers **USDC on Base** and **USDC on Solana** in the same 402. This server
decides which entry to sign, and the decision is layered — later wins:

1. `defaults.rail` in `config/tools.json`
2. `X402_RAIL` (server-wide)
3. the tool's own `rail` field
4. `X402_RAIL_<TOOL_NAME>`
5. a `rail` argument on the individual call

Every commerce tool advertises that optional `rail` argument in its schema, so a model can be
told *"pay for this one on Solana"* and simply do it. `auto` picks a rail this process holds a
key for, EVM first.

The choice is honoured strictly: if the requested rail isn't in the upstream's `accepts`, the
call fails with `RAIL_UNAVAILABLE` rather than quietly paying on the other one. Under the hood,
the EVM rail signs an EIP-3009 `transferWithAuthorization` and the Solana rail signs an SPL
`transferChecked` whose network fee is covered by the facilitator's sponsor — so the agent's
wallet needs USDC on either chain and no gas token at all.

## Spending caps, and what to do when you hit one

Caps are checked **before** a payment is signed, against the real price in the upstream's 402 —
not a guess from the registry. A blocked call returns the cap that stopped it plus the current
spending state:

```json
{
  "error": "PER_CALL_CAP",
  "message": "this call costs $0.01 which exceeds MAX_PER_CALL_USD=$0.005",
  "hint": "Raise the cap in the server's env, or ask a human to approve this purchase — see x402-approval-page.",
  "spending": { "usd": 0.004, "calls": 2, "remainingUsd": 0.996, "remainingCalls": 198 }
}
```

That is a decision point, not a dead end. The right move is usually to explain the limit and
escalate: [x402-approval-page](https://github.com/nirholas/x402-approval-page) exists exactly for
this — the agent opens an approval request, a human pays through a browser modal, and the agent
fetches the signed outcome.

Call `spending_report` at any time to see caps, running total, and the full ledger.

## Rehearse before you spend

[x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) is a fake town whose three
merchants mirror the real services field for field, with deterministic confirmations. Ship
`config/tools.sandbox.json` at it and a whole booking conversation costs a fraction of a cent
and reserves nothing:

```bash
X402_TOOLS_CONFIG=./config/tools.sandbox.json npx tsx examples/agent-client.ts
```

Because the sandbox seeds every confirmation from the request body, the same tool call returns
the same ids every time — so an agent's behaviour is reproducible and a failing conversation
replays identically. When the flow works, switch registries; tool names, arguments and result
shapes don't change.

## Proving what you can spend

`GET /attest` ($0.001) sells a signed, timestamped snapshot of this agent's tool registry, rails,
caps and remaining budget, with an `affordable` flag per tool. It exists because a coordinator
routing work to this agent — or a human deciding whether to approve a purchase — should not have
to take the agent's own word for what it can do. Verify it offline with the server's
`SIGNING_SECRET`, or through the free `POST /verify`.

## A note on `POST /tools/:name`

It is free to call, because the caller isn't paying this server — they are triggering a payment
from *this agent's* wallet under *this agent's* caps. That makes it a useful bridge and a
terrible thing to leave open. Bind it to localhost or put your own auth in front of it.

## Listing this service

Operators: keep `/.well-known/x402` reachable at your public origin and submit the URL to
x402scan.com, the x402 Bazaar, and agentic.market. The manifest already carries the paid
resource's price, **both networks**, `payTo` per rail, and the output schema, plus an `mcp` block
so MCP-aware indexes can see the transport and tool list.

## Contact

**nichxbt@gmail.com**
