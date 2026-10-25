/**
 * Streamable-HTTP transport for the MCP server (issue #4).
 *
 * Hosts the MCP protocol over HTTP using the SDK's
 * `StreamableHTTPServerTransport`. Built on Node's stdlib `http` module so we
 * don't pull in Express just to forward requests. Routes:
 *
 *   POST   /mcp      — JSON-RPC requests/responses
 *   GET    /mcp      — SSE stream for an existing session
 *   DELETE /mcp      — terminate a session
 *   GET    /healthz  — liveness probe
 *
 * Every session gets its own transport *and* its own MCP server (see
 * `connect`), so concurrent clients never see each other's responses.
 *
 * The browser behind this server is logged in to a Google account, so the
 * endpoint is guarded:
 *   - Host header must name a loopback address when bound to loopback, which
 *     blocks DNS-rebinding attacks from web pages.
 *   - A browser `Origin` is rejected unless it is loopback or explicitly
 *     allowed via NOTEBOOKLM_ALLOWED_ORIGINS.
 *   - NOTEBOOKLM_HTTP_TOKEN, when set, is required as `Authorization: Bearer`.
 *     Binding to a non-loopback address refuses to start without one.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Bearer token clients must send. Required for non-loopback binds. */
  token?: string;
  /** Extra browser origins allowed to call the endpoint (exact match). */
  allowedOrigins?: string[];
  /** Connect callback invoked once per new session — wires a fresh MCP server to the transport. */
  connect: (transport: StreamableHTTPServerTransport) => Promise<void>;
}

export interface HttpTransportHandle {
  server: HttpServer;
  close: () => Promise<void>;
}

const SESSION_HEADER = "mcp-session-id";
/** Large enough for a pasted `add_source` text, small enough to bound memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Each session holds a server object; cap them so a client loop can't exhaust memory. */
const MAX_HTTP_SESSIONS = 64;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost") return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1";
  return false;
}

/** Split a Host header into hostname and port, handling `[v6]:port`. */
function parseHostHeader(value: string): { hostname: string; port?: string } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (v6) return { hostname: v6[1], port: v6[2] };
  const idx = value.lastIndexOf(":");
  if (idx > -1 && value.indexOf(":") === idx) {
    return { hostname: value.slice(0, idx), port: value.slice(idx + 1) };
  }
  return { hostname: value };
}

function tokensMatch(expected: string, provided: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const host = opts.host ?? "127.0.0.1";
  const loopbackBind = isLoopbackHost(host);
  if (!loopbackBind && !opts.token) {
    throw new Error(
      `Refusing to listen on ${host} without NOTEBOOKLM_HTTP_TOKEN. ` +
        "Anyone who can reach the port could drive your logged-in Google session."
    );
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer((req, res) => {
    void handleRequest(req, res, transports, opts, loopbackBind).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(`❌ [HTTP] Unhandled request error: ${err}`);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status === 500 ? "internal server error" : (err as Error).message,
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      log.success(`🌐 HTTP transport listening on http://${host}:${opts.port}/mcp`);
      if (opts.token) log.info("  🔒 Bearer token required (NOTEBOOKLM_HTTP_TOKEN)");
      resolve();
    });
  });

  return {
    server,
    close: async () => {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          /* ignore — best-effort shutdown */
        }
      }
      transports.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

/**
 * Use the McpServer high-level Server class — it accepts any Transport.
 * Bridge helper kept for callers wiring an existing McpServer instance.
 */
export async function bindMcpServer(
  mcpServer: McpServer,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  await mcpServer.connect(transport);
}

function checkAccess(
  req: IncomingMessage,
  opts: HttpTransportOptions,
  loopbackBind: boolean
): void {
  const hostHeader = headerString(req.headers.host);
  if (!hostHeader) throw new HttpError(400, "missing Host header");
  if (loopbackBind && !isLoopbackHost(parseHostHeader(hostHeader).hostname)) {
    throw new HttpError(403, "Host header must be a loopback address");
  }

  const origin = headerString(req.headers.origin);
  if (origin && !(opts.allowedOrigins ?? []).includes(origin)) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      throw new HttpError(403, "origin not allowed");
    }
    if (!isLoopbackHost(originHost)) throw new HttpError(403, "origin not allowed");
  }

  if (opts.token) {
    const auth = headerString(req.headers.authorization) ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match || !tokensMatch(opts.token, match[1].trim())) {
      throw new HttpError(401, "missing or invalid bearer token");
    }
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
  opts: HttpTransportOptions,
  loopbackBind: boolean
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz" && req.method === "GET") {
    sendJson(res, 200, { status: "ok", protocol: "mcp-streamable-http" });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not found", expected: "/mcp" });
    return;
  }

  checkAccess(req, opts, loopbackBind);

  const sessionId = headerString(req.headers[SESSION_HEADER]);

  if (req.method === "GET" || req.method === "DELETE") {
    // SSE streams + session termination — both routed by session.
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      sendJson(res, 404, { error: "unknown session" });
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET, DELETE");
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const body = await readJsonBody(req);

  // Re-use existing session, or initialise a new one when the client says so.
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (sessionId && !transport) {
    // Spec: an unknown or expired session id gets 404 so the client re-initialises.
    sendJson(res, 404, { error: "unknown session" });
    return;
  }
  if (!transport && isInitializeRequest(body)) {
    if (transports.size >= MAX_HTTP_SESSIONS) {
      sendJson(res, 503, { error: "too many sessions — DELETE an old one first" });
      return;
    }
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, created);
      },
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    await opts.connect(created);
    transport = created;
  }

  if (!transport) {
    sendJson(res, 400, {
      error: "no transport for request — pass an `Mcp-Session-Id` header or send `initialize`",
    });
    return;
  }

  await transport.handleRequest(req, res, body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON request body");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
