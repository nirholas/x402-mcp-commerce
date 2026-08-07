# Raw x402 flow with curl

The MCP tools are consumed over stdio, but the inspector beside them is plain HTTP — and it
sells one thing, so the 402 → pay → 200 walkthrough works exactly as it does everywhere else in
the suite. Start it with `npm run dev` (both rails use the suite defaults, so no configuration).

## 1. Look before you buy — free routes

```bash
# what this agent can do, what each call costs, and on which rail
curl -s http://localhost:4039/tools | jq '.rails, [.tools[] | {name, price, rail, upstream}]'

# what it is allowed to spend, and what it has spent
curl -s http://localhost:4039/ledger | jq '{caps, spent}'

curl -s http://localhost:4039/health
```

## 2. Hit the paid route without payment → 402

```bash
curl -i http://localhost:4039/attest
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

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
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",          // $0.001 in 6-decimal USDC units
      "resource": "http://localhost:4039/attest",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "1000",
      "amount": "1000",
      "resource": "http://localhost:4039/attest",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 60,
      "extra": { "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "name": "USDC", "decimals": 6 }
    }
  ]
}
```

Two entries, two rails. Take whichever your wallet can sign — the server settles that one.

```bash
curl -s http://localhost:4039/attest | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

## 3. Pay

`X-PAYMENT` is a base64 payment matching **one** `accepts` entry: an EIP-3009
`transferWithAuthorization` signature on the Base entry, or a signed SPL `transferChecked`
transaction on the Solana entry. Produce it with any x402 client rather than by hand.

## 4. Retry with X-PAYMENT → 200

```bash
curl -i http://localhost:4039/attest -H "X-PAYMENT: $PAYMENT_B64"
```

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…

{
  "payload": {
    "attestationId": "att_…",
    "issuedAt": "2026-08-07T12:00:00.000Z",
    "expiresAt": "2026-08-07T12:05:00.000Z",
    "rails": { "default": "auto", "available": ["evm"], "note": "…" },
    "caps": { "maxPerCallUsd": 0.05, "maxSessionUsd": 1, "maxCalls": 200, "allowedTools": "all registered tools" },
    "budget": { "usd": 0.016, "calls": 3, "remainingUsd": 0.984, "remainingCalls": 197 },
    "tools": [ { "name": "book_table", "price": "$0.01", "rail": "auto", "affordable": true } ]
  },
  "signature": "…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

Verify it later without the secret:

```bash
curl -s -X POST http://localhost:4039/verify \
  -H 'Content-Type: application/json' \
  -d '{"payload":{…},"signature":"…"}' | jq
```

## 5. Running a tool over HTTP

For agents that don't speak MCP. This route is free to *call* — the money that moves is this
agent's, paid to the upstream merchant under this agent's caps.

```bash
# free upstream route → artifact, no payment
curl -s -X POST http://localhost:4039/tools/browse_catalog \
  -H 'Content-Type: application/json' -d '{}' | jq '{paid, artifact: (.artifact | keys)}'

# paid upstream route, rail chosen per call
curl -s -X POST http://localhost:4039/tools/book_table \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-01","time":"19:00","party":2,"name":"Ada Lovelace","rail":"evm"}' | jq

# the same call on Solana
curl -s -X POST http://localhost:4039/tools/book_table \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-09-01","time":"19:00","party":2,"name":"Ada Lovelace","rail":"solana"}' | jq
```

A successful call returns the merchant's artifact plus the receipt:

```json
{
  "tool": "book_table",
  "upstream": "x402-tablebook",
  "resource": "http://localhost:4001/book",
  "paid": true,
  "rail": { "requested": "evm", "used": "evm" },
  "artifact": { "reservationId": "res_…", "cancelToken": "…", "ics": "…" },
  "receipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
  "price": { "usd": 0.01, "atomic": "10000", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }
}
```

A cap stops the call before anything is signed:

```json
{
  "error": "PER_CALL_CAP",
  "message": "this call costs $0.01 which exceeds MAX_PER_CALL_USD=$0.005",
  "spending": { "usd": 0, "calls": 0, "remainingUsd": 1, "remainingCalls": 200 }
}
```

And a rail the upstream doesn't offer fails loudly rather than quietly paying on the other one:

```json
{ "error": "RAIL_UNAVAILABLE", "message": "book_table: upstream does not accept a Solana rail (offered: base-sepolia)" }
```

## 6. Rehearse the whole thing for nothing

Run [x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) on `:4038` and point the
registry at it — the sandbox mirrors the real merchants' response schemas field for field:

```bash
# terminal 1
cd ../x402-agent-sandbox && npm run dev

# terminal 2
X402_TOOLS_CONFIG=./config/tools.sandbox.json npm run dev
curl -s -X POST http://localhost:4039/tools/town_directory -d '{}' -H 'Content-Type: application/json' | jq '.artifact.merchants[].name'
```
