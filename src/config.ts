/**
 * Tool registry loading.
 *
 * `config/tools.json` maps each MCP tool to one upstream x402 route. Nothing is
 * hardcoded — point the `baseUrl`s at your own deployments, at the public suite
 * services, or at x402-agent-sandbox to rehearse the whole toolbox for
 * fractions of a cent.
 *
 * Two override layers on top of the file:
 *   X402_TOOLS_CONFIG=/path/to/tools.json        use a different registry
 *   X402_UPSTREAM_<UPSTREAM>=https://…           override one upstream's baseUrl
 *   X402_RAIL=auto|evm|solana                    server-wide rail default
 *   X402_RAIL_<TOOL>=auto|evm|solana             per-tool rail override
 *
 * `<UPSTREAM>` and `<TOOL>` are upper-snake-cased, e.g.
 * `X402_UPSTREAM_X402_TABLEBOOK`, `X402_RAIL_BOOK_TABLE`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Rail = "auto" | "evm" | "solana";

export interface ToolInput {
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  description?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  upstream: string;
  baseUrl: string;
  method: "GET" | "POST";
  /** Path template; `{param}` segments are filled from the tool's arguments. */
  path: string;
  /** Human price string for the tool listing. The upstream 402 is authoritative. */
  price: string;
  /** Arguments that become query-string parameters on a GET. */
  query?: string[];
  input: Record<string, ToolInput>;
  /** Optional per-tool rail override. */
  rail?: Rail;
}

export interface Registry {
  defaults: { rail: Rail; timeoutMs: number };
  tools: ToolDef[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

function envKey(prefix: string, name: string): string {
  return `${prefix}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function asRail(v: string | undefined, fallback: Rail): Rail {
  return v === "evm" || v === "solana" || v === "auto" ? v : fallback;
}

let cached: Registry | null = null;

export function loadRegistry(): Registry {
  if (cached) return cached;

  const path = process.env.X402_TOOLS_CONFIG
    ? resolve(process.env.X402_TOOLS_CONFIG)
    : join(HERE, "..", "config", "tools.json");

  let raw: { defaults?: Partial<Registry["defaults"]>; tools?: ToolDef[] };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read tool registry at ${path}: ${(e as Error).message}`);
  }

  const defaults = {
    rail: asRail(process.env.X402_RAIL || raw.defaults?.rail, "auto"),
    timeoutMs: Number(process.env.X402_TIMEOUT_MS || raw.defaults?.timeoutMs || 20_000),
  };

  const tools = (raw.tools ?? []).map((t) => ({
    ...t,
    baseUrl: (process.env[envKey("X402_UPSTREAM_", t.upstream)] || t.baseUrl).replace(/\/+$/, ""),
    rail: asRail(process.env[envKey("X402_RAIL_", t.name)], t.rail ?? defaults.rail),
  }));

  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`duplicate tool name in registry: ${t.name}`);
    seen.add(t.name);
  }

  cached = { defaults, tools };
  return cached;
}

export function getTool(name: string): ToolDef | undefined {
  return loadRegistry().tools.find((t) => t.name === name);
}

/** Build the upstream URL for a tool call, filling `{param}` segments and the query string. */
export function buildUrl(tool: ToolDef, args: Record<string, unknown>): { url: string; body?: unknown } {
  let path = tool.path;
  const usedInPath = new Set<string>();
  for (const [, key] of tool.path.matchAll(/\{(\w+)\}/g)) {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`missing required path parameter "${key}" for tool ${tool.name}`);
    }
    path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    usedInPath.add(key);
  }

  const url = new URL(tool.baseUrl + path);
  if (tool.method === "GET") {
    for (const key of tool.query ?? []) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    return { url: url.toString() };
  }

  // POST: query params still go on the URL, everything else becomes the body.
  for (const key of tool.query ?? []) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (usedInPath.has(key) || (tool.query ?? []).includes(key)) continue;
    if (value !== undefined) body[key] = value;
  }
  return { url: url.toString(), body };
}
