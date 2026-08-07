/**
 * The inspector — a small HTTP surface beside the MCP server.
 *
 * The product here is `src/mcp.ts` (stdio). This process exists so operators and
 * other agents can see what the MCP server is wired to without attaching an MCP
 * client: the tool registry, the spending ledger, the discovery manifest, and
 * the skill sheet.
 *
 * It sells exactly one thing — `GET /attest`, a signed snapshot of this agent's
 * capabilities and remaining budget — and it is dual-rail like every other
 * service in the suite. Everything else is free, because a buyer has little
 * business charging for its own catalogue.
 */
import "dotenv/config";
import express from "express";
import { join } from "node:path";
import { attest } from "./attest.js";
import { loadRegistry } from "./config.js";
import { paywall, railSummary, type RoutePrices } from "./payments.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import { CapExceeded, UpstreamError, callTool } from "./pay.js";
import { getTool } from "./config.js";
import { verify } from "./sign.js";
import { availableRails, report } from "./wallet.js";

const PRICES: RoutePrices = {
  "GET /attest": {
    price: "$0.001",
    description: "Signed attestation of this agent's tool registry, payment rails, caps, and remaining budget",
    ...ROUTE_SCHEMAS["GET /attest"],
  },
};

const app = express();
app.use(express.json({ limit: "256kb" }));

// Dual-rail x402: the paid route offers USDC on Base *and* USDC on Solana.
// Verification and settlement go to the matching x402 facilitator.
app.use(paywall(PRICES));

app.use(express.static(join(process.cwd(), "public"), { dotfiles: "allow" }));

// ---------------------------------------------------------------- free routes

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-mcp-commerce", rails: ["base", "solana"] });
});

app.get("/skill.md", (_req, res) => {
  res.type("text/markdown").sendFile(join(process.cwd(), "skill.md"));
});

// The tool registry as the MCP server sees it, after env overrides.
app.get("/tools", (_req, res) => {
  const registry = loadRegistry();
  res.json({
    rails: {
      default: registry.defaults.rail,
      available: availableRails(),
      note: "Every upstream offers USDC on Base and USDC on Solana; this agent picks per call.",
    },
    tools: registry.tools.map((t) => ({
      name: t.name,
      description: t.description,
      upstream: t.upstream,
      baseUrl: t.baseUrl,
      route: `${t.method} ${t.path}`,
      price: t.price,
      rail: t.rail,
      input: t.input,
    })),
  });
});

// Caps, spend so far, and every payment this process has made.
app.get("/ledger", (_req, res) => {
  res.json(report());
});

// Verify any attestation this server signed, without holding the secret.
app.post("/verify", (req, res) => {
  const { payload, signature } = req.body || {};
  if (payload === undefined || typeof signature !== "string") {
    res.status(400).json({ error: "INVALID_REQUEST", message: "send { payload, signature }" });
    return;
  }
  res.json({ valid: verify(payload, signature) });
});

/**
 * Run one registered tool over HTTP, for agents that don't speak MCP.
 *
 * This is free: the caller is not paying *us*, they are triggering a payment
 * from this agent's own wallet, bounded by its own caps. Expose it only where
 * you trust the caller — bind to localhost, or put it behind your own auth.
 */
app.post("/tools/:name", async (req, res) => {
  const tool = getTool(req.params.name);
  if (!tool) {
    res.status(404).json({ error: "UNKNOWN_TOOL", message: `no tool named ${req.params.name}` });
    return;
  }
  const { rail, ...args } = req.body || {};
  try {
    res.json(await callTool(tool, args, rail));
  } catch (e) {
    if (e instanceof CapExceeded) {
      res.status(402).json({ error: e.code, message: e.message, spending: report().spent });
      return;
    }
    if (e instanceof UpstreamError) {
      res.status(e.status).json({ error: e.code, message: e.message });
      return;
    }
    res.status(500).json({ error: "TOOL_FAILED", message: (e as Error).message });
  }
});

// ---------------------------------------------------------------- paid route

// GET /attest ($0.001) — the signed capability + budget snapshot, in-response.
app.get("/attest", (_req, res) => {
  res.json(attest());
});

const port = Number(process.env.PORT || 4039);
app.listen(port, () => {
  const registry = loadRegistry();
  console.log(`x402-mcp-commerce inspector listening on :${port}`);
  for (const line of railSummary()) console.log(line);
  console.log(`  MCP server:  npx tsx src/mcp.ts   (${registry.tools.length} commerce tools + 3 built-ins)`);
  console.log(`  rail default: ${registry.defaults.rail}   agent wallets: ${availableRails().join(", ") || "none configured"}`);
  console.log("  paid routes:");
  for (const [route, cfg] of Object.entries(PRICES)) console.log(`    ${route}  ${cfg.price}`);
  console.log("  free routes: GET /health, /tools, /ledger, POST /verify, POST /tools/:name");
  console.log("  discovery:  GET /.well-known/x402, /skill.md");
});
