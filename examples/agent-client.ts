/**
 * Drive the MCP server the way Claude Desktop does — over stdio — and show the
 * rail choice working per call.
 *
 *   npx tsx examples/agent-client.ts
 *
 * With no wallet configured you still see the full shape of things: the tool
 * list, the spending report, free upstream routes fetched without payment, and
 * paid routes stopping at exactly the right place. Add a funded wallet to make
 * the payments real:
 *
 *   PRIVATE_KEY=0x… npx tsx examples/agent-client.ts        # pay on Base
 *   SOLANA_PRIVATE_KEY=… X402_RAIL=solana npx tsx examples/agent-client.ts
 *
 * Cheapest way to see it end to end: run x402-agent-sandbox on :4038 and point
 * the registry at it —
 *
 *   X402_TOOLS_CONFIG=./config/tools.sandbox.json npx tsx examples/agent-client.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp.ts"],
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

const client = new Client({ name: "x402-mcp-commerce-example", version: "0.1.0" }, { capabilities: {} });

function text(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content?.[0];
  if (!first?.text) return result;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  return { isError: Boolean(result.isError), body: text(result) };
}

async function main() {
  await client.connect(transport);

  // 1. What can this agent do, and what does each call cost?
  const { tools } = await client.listTools();
  console.log(`\n${tools.length} tools registered:\n  ${tools.map((t) => t.name).join(", ")}\n`);

  const listing = (await call("list_commerce_tools")).body as {
    rails: { default: string; available: string[] };
    tools: Array<{ name: string; upstream: string; price: string; rail: string }>;
  };
  console.log(`rail default: ${listing.rails.default}   wallets held: ${listing.rails.available.join(", ") || "none"}`);
  for (const t of listing.tools) {
    console.log(`  ${t.name.padEnd(20)} ${t.price.padEnd(10)} ${t.rail.padEnd(7)} → ${t.upstream}`);
  }

  // 2. What is it allowed to spend?
  const spending = (await call("spending_report")).body as { caps: Record<string, unknown>; spent: Record<string, unknown> };
  console.log("\ncaps:  ", JSON.stringify(spending.caps));
  console.log("spent: ", JSON.stringify(spending.spent), "\n");

  // 3. A free upstream route — no payment, artifact straight back.
  const catalog = await call("browse_catalog");
  console.log("browse_catalog →", catalog.isError ? `blocked: ${JSON.stringify(catalog.body)}` : summarize(catalog.body));

  // 4. A paid one, on whichever rail the config picked.
  const table = await call("book_table", argsFor("book_table"));
  console.log("book_table →", table.isError ? `blocked: ${JSON.stringify(table.body)}` : summarize(table.body));

  // 5. The same tool, rail chosen per call. This is the point of the server:
  //    the model can say "pay for this one on Solana" without any config change.
  //    (Pick whichever paid tool the loaded registry actually has.)
  const paidTool = listing.tools.find((t) => t.price.startsWith("$"));
  if (paidTool) {
    const args = argsFor(paidTool.name);
    for (const rail of ["evm", "solana"] as const) {
      const res = await call(paidTool.name, { ...args, rail });
      console.log(`${paidTool.name} (rail=${rail}) →`, res.isError ? JSON.stringify(res.body) : summarize(res.body));
    }
  }

  // 6. Discovery: read any x402 service's manifest for free before buying anything.
  const manifest = await call("discover_service", { baseUrl: "http://localhost:4038" });
  console.log("\ndiscover_service →", manifest.isError ? JSON.stringify(manifest.body) : summarize(manifest.body));

  await client.close();
}

/** Minimal valid arguments for the tools this example might reach for. */
function argsFor(name: string): Record<string, unknown> {
  const soon = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  switch (name) {
    case "book_table":
      return { date: soon(7), time: "19:00", party: 2, name: "Ada Lovelace" };
    case "book_room":
      return { checkIn: soon(7), checkOut: soon(9), guests: 2, name: "Ada Lovelace" };
    case "buy_item":
      return { sku: "sandbox-guide" };
    case "check_domain":
      return { domain: "example.com" };
    case "check_weather":
      return { lat: 37.77, lon: -122.42 };
    default:
      return {};
  }
}

function summarize(body: unknown): string {
  const b = body as { paid?: boolean; rail?: { used?: string }; price?: { usd?: number }; artifact?: unknown; manifest?: { name?: string } };
  if (b?.manifest) return `manifest for ${b.manifest.name}`;
  if (b?.artifact === undefined) return JSON.stringify(body).slice(0, 160);
  const cost = b.paid ? `paid $${b.price?.usd} on ${b.rail?.used}` : "free";
  const keys = typeof b.artifact === "object" && b.artifact ? Object.keys(b.artifact).slice(0, 5).join(",") : String(b.artifact).slice(0, 40);
  return `${cost} — artifact keys: ${keys}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
