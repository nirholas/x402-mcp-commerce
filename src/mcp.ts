#!/usr/bin/env node
/**
 * The MCP server — the actual product.
 *
 * Every tool in `config/tools.json` becomes an MCP tool. Calling one pays the
 * upstream x402 route and returns the upstream's artifact together with the
 * payment receipt, so the model sees both what it got and what it cost.
 *
 * Three built-in tools come for free:
 *   list_commerce_tools  what this server can do, and what each call costs
 *   spending_report      caps, spend so far, and the full payment ledger
 *   discover_service     read any x402 service's /.well-known/x402 manifest
 *
 * Run:  npx tsx src/mcp.ts        (stdio — this is what Claude Desktop launches)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { loadRegistry, type ToolDef, type ToolInput } from "./config.js";
import { CapExceeded, UpstreamError, callTool } from "./pay.js";
import { availableRails, report } from "./wallet.js";

const registry = loadRegistry();

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const failure = (value: unknown) => ({ ...json(value), isError: true as const });

/** Registry input descriptors → a Zod shape the MCP SDK can advertise. */
function zodShape(tool: ToolDef): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const [name, spec] of Object.entries(tool.input)) {
    shape[name] = describe(base(spec), spec);
  }
  // Every paid tool takes an optional per-call rail override, so a model can be
  // told "pay for this one on Solana" without touching the server config.
  shape.rail = z
    .enum(["auto", "evm", "solana"])
    .optional()
    .describe(
      `Payment rail for this call. Overrides the configured default (${tool.rail}). ` +
        "auto = whichever rail this agent holds a key for.",
    );
  return shape;
}

function base(spec: ToolInput): ZodTypeAny {
  switch (spec.type) {
    case "number":
      return spec.required ? z.number() : z.number().optional();
    case "boolean":
      return spec.required ? z.boolean() : z.boolean().optional();
    case "object":
      return spec.required ? z.record(z.unknown()) : z.record(z.unknown()).optional();
    default:
      return spec.required ? z.string() : z.string().optional();
  }
}

function describe(schema: ZodTypeAny, spec: ToolInput): ZodTypeAny {
  return spec.description ? schema.describe(spec.description) : schema;
}

const server = new McpServer({ name: "x402-mcp-commerce", version: "0.1.0" });

// ───────────────────────────────────────────────────────── built-in tools ───

server.tool(
  "list_commerce_tools",
  "List every commerce tool this server exposes, with its upstream service, price, and configured payment rail. Free — no payment is made.",
  {},
  async () =>
    json({
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
      })),
    }),
);

server.tool(
  "spending_report",
  "Show this agent's spending caps, how much it has spent so far, and every payment it has made in this session. Free — no payment is made.",
  {},
  async () => json(report()),
);

server.tool(
  "discover_service",
  "Read any x402 service's /.well-known/x402 manifest to learn its routes, prices, payment rails, and response schemas. Free — no payment is made.",
  {
    baseUrl: z.string().describe("Origin of the service, e.g. https://tablebook.example.com"),
  },
  async ({ baseUrl }) => {
    const url = `${String(baseUrl).replace(/\/+$/, "")}/.well-known/x402`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(registry.defaults.timeoutMs) });
      if (!res.ok) return failure({ error: "MANIFEST_UNAVAILABLE", url, status: res.status });
      return json({ url, manifest: await res.json() });
    } catch (e) {
      return failure({ error: "MANIFEST_UNREACHABLE", url, message: (e as Error).message });
    }
  },
);

// ─────────────────────────────────────────────────────── registry tools ─────

for (const tool of registry.tools) {
  server.tool(
    tool.name,
    `${tool.description} Costs ${tool.price} per call, paid in USDC over x402 to ${tool.upstream}. ` +
      "Returns the merchant's artifact and the payment receipt.",
    zodShape(tool),
    async (args: Record<string, unknown>) => {
      const { rail, ...toolArgs } = args;
      try {
        return json(await callTool(tool, toolArgs, rail));
      } catch (e) {
        if (e instanceof CapExceeded) {
          return failure({
            error: e.code,
            message: e.message,
            hint: "Raise the cap in the server's env, or ask a human to approve this purchase — see x402-approval-page.",
            spending: report().spent,
          });
        }
        if (e instanceof UpstreamError) {
          return failure({ error: e.code, status: e.status, message: e.message });
        }
        return failure({ error: "TOOL_FAILED", message: (e as Error).message });
      }
    },
  );
}

// ────────────────────────────────────────────────────────────────── boot ────

await server.connect(new StdioServerTransport());

// stderr, not stdout — stdout is the MCP transport.
console.error(
  `x402-mcp-commerce ready — ${registry.tools.length} commerce tools + 3 built-ins, ` +
    `rail default "${registry.defaults.rail}", wallets: ${availableRails().join(", ") || "none configured"}`,
);
