import http from "node:http";
import net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Logger } from "pino";
import type { RequestHandler } from "express";

// ---------------------------------------------------------------------------
// Hop-by-hop headers that must not be forwarded
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

const PREVIEW_CONSOLE_CAPTURE_SCRIPT = `<script>(function(){if(window.__PASEO_PREVIEW_CONSOLE_CAPTURED__)return;window.__PASEO_PREVIEW_CONSOLE_CAPTURED__=true;function serialize(value){try{if(value instanceof Error)return{message:value.message,stack:value.stack||null};if(typeof value==="string")return{message:value,stack:null};return{message:JSON.stringify(value),stack:null};}catch{return{message:String(value),stack:null};}}function emit(kind,args){try{var items=Array.prototype.slice.call(args||[]).map(serialize);var primary=items.find(function(item){return item.message;})||{message:"Console error",stack:null};window.parent&&window.parent.postMessage({type:"paseo_preview_console_error",kind:kind,message:primary.message,stack:primary.stack,args:items,url:window.location.href,timestamp:Date.now()},"*");}catch{}}var originalError=console.error;console.error=function(){emit("console.error",arguments);return originalError.apply(console,arguments);};window.addEventListener("error",function(event){emit("window.error",[event.error||event.message]);});window.addEventListener("unhandledrejection",function(event){emit("unhandledrejection",[event.reason||"Unhandled promise rejection"]);});})();</script>`;

// ---------------------------------------------------------------------------
// ScriptRouteStore
// ---------------------------------------------------------------------------

export interface ScriptRoute {
  hostname: string;
  port: number;
}

export interface ScriptRouteEntry extends ScriptRoute {
  workspaceId: string;
  projectSlug: string;
  scriptName: string;
}

export class ScriptRouteStore {
  private routes = new Map<string, ScriptRouteEntry>();
  private workspaceHostnames = new Map<string, Set<string>>();

  registerRoute(entry: ScriptRouteEntry): void {
    const previous = this.routes.get(entry.hostname);
    if (previous) {
      this.removeHostnameFromWorkspaceIndex(previous.workspaceId, previous.hostname);
    }

    const storedEntry = { ...entry };
    this.routes.set(storedEntry.hostname, storedEntry);
    this.addHostnameToWorkspaceIndex(storedEntry.workspaceId, storedEntry.hostname);
  }

  removeRoute(hostname: string): void {
    const entry = this.routes.get(hostname);
    if (!entry) {
      return;
    }
    this.routes.delete(hostname);
    this.removeHostnameFromWorkspaceIndex(entry.workspaceId, hostname);
  }

  removeRouteForWorkspaceScript(params: { workspaceId: string; scriptName: string }): void {
    const routes = this.listRoutesForWorkspace(params.workspaceId);
    const route = routes.find((entry) => entry.scriptName === params.scriptName);
    if (!route) {
      return;
    }
    this.removeRoute(route.hostname);
  }

  removeRoutesForPort(port: number): void {
    for (const [hostname, entry] of this.routes) {
      if (entry.port === port) {
        this.routes.delete(hostname);
        this.removeHostnameFromWorkspaceIndex(entry.workspaceId, hostname);
      }
    }
  }

  findRoute(host: string): ScriptRoute | null {
    // Strip port suffix from the Host header value
    const hostname = host.replace(/:\d+$/, "");

    // 1. Exact match
    const exactRoute = this.routes.get(hostname);
    if (exactRoute !== undefined) {
      return { hostname: exactRoute.hostname, port: exactRoute.port };
    }

    // 2. Subdomain match — walk up the labels looking for a registered parent
    const parts = hostname.split(".");
    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(i).join(".");
      const candidateRoute = this.routes.get(candidate);
      if (candidateRoute !== undefined) {
        return { hostname: candidateRoute.hostname, port: candidateRoute.port };
      }
    }

    return null;
  }

  getRouteEntry(hostname: string): ScriptRouteEntry | null {
    const entry = this.routes.get(hostname);
    return entry ? { ...entry } : null;
  }

  listRoutes(): ScriptRouteEntry[] {
    return Array.from(this.routes.values()).map((entry) => Object.assign({}, entry));
  }

  listRoutesForWorkspace(workspaceId: string): ScriptRouteEntry[] {
    const hostnames = this.workspaceHostnames.get(workspaceId);
    if (!hostnames) {
      return [];
    }

    const routes: ScriptRouteEntry[] = [];
    for (const hostname of hostnames) {
      const entry = this.routes.get(hostname);
      if (entry) {
        routes.push({ ...entry });
      }
    }
    return routes;
  }

  private addHostnameToWorkspaceIndex(workspaceId: string, hostname: string): void {
    const hostnames = this.workspaceHostnames.get(workspaceId) ?? new Set<string>();
    hostnames.add(hostname);
    this.workspaceHostnames.set(workspaceId, hostnames);
  }

  private removeHostnameFromWorkspaceIndex(workspaceId: string, hostname: string): void {
    const hostnames = this.workspaceHostnames.get(workspaceId);
    if (!hostnames) {
      return;
    }

    hostnames.delete(hostname);
    if (hostnames.size === 0) {
      this.workspaceHostnames.delete(workspaceId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHopByHopHeaders(
  rawHeaders: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function shouldInjectPreviewConsoleCapture(headers: http.IncomingHttpHeaders): boolean {
  const contentType = headers["content-type"];
  const contentEncoding = headers["content-encoding"];
  return (
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("text/html") &&
    contentEncoding === undefined
  );
}

function injectPreviewConsoleCapture(html: string): string {
  if (html.includes("__PASEO_PREVIEW_CONSOLE_CAPTURED__")) {
    return html;
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${PREVIEW_CONSOLE_CAPTURE_SCRIPT}`);
  }
  return `${PREVIEW_CONSOLE_CAPTURE_SCRIPT}${html}`;
}

// ---------------------------------------------------------------------------
// createScriptProxyMiddleware
// ---------------------------------------------------------------------------

export function createScriptProxyMiddleware({
  routeStore,
  logger,
}: {
  routeStore: ScriptRouteStore;
  logger: Logger;
}): RequestHandler {
  return (req, res, next) => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      next();
      return;
    }

    const route = routeStore.findRoute(hostHeader);
    if (!route) {
      next();
      return;
    }

    const forwardedHeaders = stripHopByHopHeaders(req.headers);
    forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
    forwardedHeaders["x-forwarded-host"] = hostHeader.replace(/:\d+$/, "");
    forwardedHeaders["x-forwarded-proto"] = req.protocol;
    forwardedHeaders["accept-encoding"] = "identity";

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: route.port,
        path: req.originalUrl,
        method: req.method,
        headers: forwardedHeaders,
      },
      (proxyRes) => {
        const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
        if (shouldInjectPreviewConsoleCapture(proxyRes.headers)) {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          proxyRes.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const injected = injectPreviewConsoleCapture(body);
            delete responseHeaders["content-length"];
            res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
            res.end(injected);
          });
          proxyRes.on("error", () => {
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain" });
            }
            res.end("502 Bad Gateway");
          });
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res, { end: true });
      },
    );

    proxyReq.on("error", (err) => {
      logger.warn(
        { err, hostname: route.hostname, port: route.port },
        "Script proxy: upstream unreachable",
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("502 Bad Gateway");
      }
    });

    req.pipe(proxyReq, { end: true });
  };
}

// ---------------------------------------------------------------------------
// createScriptProxyUpgradeHandler
// ---------------------------------------------------------------------------

export function createScriptProxyUpgradeHandler({
  routeStore,
  logger,
}: {
  routeStore: ScriptRouteStore;
  logger: Logger;
}): (req: IncomingMessage, socket: net.Socket, head: Buffer) => void {
  return (req, socket, head) => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      return;
    }

    const route = routeStore.findRoute(hostHeader);
    if (!route) {
      return;
    }

    const targetSocket = net.connect({ host: "127.0.0.1", port: route.port }, () => {
      // Reconstruct the raw HTTP upgrade request to send to the target
      const forwardedHeaders = stripHopByHopHeaders(req.headers);
      forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
      forwardedHeaders["x-forwarded-host"] = hostHeader.replace(/:\d+$/, "");
      forwardedHeaders["x-forwarded-proto"] = "http";

      // Re-include upgrade and connection headers — they are required for
      // WebSocket handshake even though they are hop-by-hop.
      forwardedHeaders["connection"] = "Upgrade";
      forwardedHeaders["upgrade"] = req.headers.upgrade ?? "websocket";

      const headerLines: string[] = [];
      headerLines.push(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`);
      for (const [key, value] of Object.entries(forwardedHeaders)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headerLines.push(`${key}: ${v}`);
          }
        } else {
          headerLines.push(`${key}: ${value}`);
        }
      }
      headerLines.push("\r\n");

      targetSocket.write(headerLines.join("\r\n"));

      if (head.length > 0) {
        targetSocket.write(head);
      }

      // Pipe in both directions
      targetSocket.pipe(socket);
      socket.pipe(targetSocket);
    });

    targetSocket.on("error", (err) => {
      logger.warn(
        { err, hostname: route.hostname, port: route.port },
        "Script proxy: WebSocket upstream unreachable",
      );
      socket.end();
    });

    socket.on("error", () => {
      targetSocket.destroy();
    });
  };
}

// ---------------------------------------------------------------------------
// findFreePort
// ---------------------------------------------------------------------------

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to get assigned port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", reject);
  });
}
