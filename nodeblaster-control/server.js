const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.NODEBLASTER_DATA_DIR || "/data";
const WWW_DIR = process.env.NODEBLASTER_WWW_DIR || "/app/www";
const CONFIG_PATH = path.join(DATA_DIR, "app-preferences.json");
const BOOTSTRAP_STATUS = path.join(DATA_DIR, "bootstrap-status.json");
const BRIDGE_SOCKET = path.join(DATA_DIR, "host-bridge", "bridge.sock");
const BRIDGE_TOKEN = path.join(DATA_DIR, "host-bridge", "token");
const VERSION = "0.4.4";
const MAX_BODY = 16 * 1024;
const DISPLAY_STYLES = new Set([
  "shares", "dashboard", "gauges", "fleet", "slideshow", "carousel",
  "screensaver", "mesh", "orbit", "console",
]);

function send(res, status, payload, type = "application/json; charset=utf-8") {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(
    type.startsWith("application/json") ? JSON.stringify(payload) : String(payload),
  );
  res.writeHead(status, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
  });
  res.end(body);
}

async function readJson(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (!Number.isInteger(declared) || declared < 0 || declared > MAX_BODY) throw new Error("invalid_request_size");
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!total) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
  return value;
}

function mutationAllowed(req) {
  const site = String(req.headers["sec-fetch-site"] || "same-origin").toLowerCase();
  const type = String(req.headers["content-type"] || "").toLowerCase();
  return ["same-origin", "same-site", "none"].includes(site) && type.startsWith("application/json");
}

function readPreferences() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const style = DISPLAY_STYLES.has(parsed.desired_display_style) ? parsed.desired_display_style : "fleet";
    return { schema: 1, desired_display_style: style, updated_at: parsed.updated_at || null };
  } catch {
    return { schema: 1, desired_display_style: "fleet", updated_at: null };
  }
}

function readBootstrapStatus() {
  try {
    const value = JSON.parse(fs.readFileSync(BOOTSTRAP_STATUS, "utf8"));
    return { state: String(value.state || "unknown"), detail: String(value.detail || "") };
  } catch {
    return { state: "pending", detail: "Preparing signed host agent" };
  }
}

function writePreferences(style) {
  if (!DISPLAY_STYLES.has(style)) throw new Error("unsupported_display_style");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { schema: 1, desired_display_style: style, updated_at: new Date().toISOString() };
  const temp = `${CONFIG_PATH}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, CONFIG_PATH);
  return payload;
}

function bridgeAvailable() {
  try {
    return fs.statSync(BRIDGE_SOCKET).isSocket() && fs.readFileSync(BRIDGE_TOKEN, "utf8").trim().length >= 32;
  } catch {
    return false;
  }
}

function bridgeRequest(method, requestPath, payload) {
  return new Promise((resolve, reject) => {
    if (!bridgeAvailable()) return reject(new Error("host_agent_unavailable"));
    const token = fs.readFileSync(BRIDGE_TOKEN, "utf8").trim();
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const request = http.request({
      socketPath: BRIDGE_SOCKET,
      path: requestPath,
      method,
      timeout: 5000,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error("bridge_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          if ((response.statusCode || 500) >= 400) {
            const bridgeError = new Error(result.error || "bridge_request_failed");
            bridgeError.bridgeResponse = true;
            bridgeError.statusCode = response.statusCode || 502;
            reject(bridgeError);
          }
          else resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("bridge_timeout")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function publicRequestError(error) {
  const message = String(error?.message || "");
  const allowed = new Set([
    "host_agent_unavailable", "unsupported_display_style", "invalid_request_size",
    "request_too_large", "object_required", "bridge_timeout",
    "bridge_response_too_large",
  ]);
  if (allowed.has(message)) return { status: message === "host_agent_unavailable" ? 503 : 400, error: message };
  if (error instanceof SyntaxError) return { status: 400, error: "invalid_json" };
  if (error?.bridgeResponse) {
    const safe = message.length <= 160 && /^[A-Za-z0-9 _.:+()-]+$/.test(message)
      ? message
      : "bridge_request_failed";
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 502;
    return { status, error: safe };
  }
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(error?.code || ""))) {
    return { status: 502, error: "bridge_connection_failed" };
  }
  return { status: 400, error: "request_failed" };
}

async function statusPayload() {
  const preferences = readPreferences();
  if (!bridgeAvailable()) {
    return {
      ok: true,
      app_version: VERSION,
      bootstrap: readBootstrapStatus(),
      host_agent: { state: "not_installed" },
      license: { state: "inactive", message: "Install the signed host agent to activate the suite." },
      display: { installed: false, style: preferences.desired_display_style, pending: true },
    };
  }
  const host = await bridgeRequest("GET", "/v1/status");
  return { ok: true, app_version: VERSION, host_agent: { state: "connected" }, ...host };
}

function safeStaticPath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(WWW_DIR, relative);
  return candidate.startsWith(path.resolve(WWW_DIR) + path.sep) ? candidate : null;
}

function serveStatic(requestPath, res) {
  const file = safeStaticPath(requestPath);
  if (!file) return send(res, 403, "forbidden\n", "text/plain; charset=utf-8");
  fs.readFile(file, (error, data) => {
    if (error) return fs.readFile(path.join(WWW_DIR, "index.html"), (indexError, index) => {
      if (indexError) return send(res, 404, "not found\n", "text/plain; charset=utf-8");
      send(res, 200, index, "text/html; charset=utf-8");
    });
    const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
    send(res, 200, data, types[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (req.method === "GET" && pathname === "/api/health") return send(res, 200, { ok: true, version: VERSION });
    if (req.method === "GET" && pathname === "/api/status") return send(res, 200, await statusPayload());
    if (req.method === "GET" && pathname === "/api/license/status") {
      const status = await statusPayload();
      return send(res, 200, { ...status.license, host_agent: status.host_agent.state });
    }
    if (req.method === "POST" && pathname === "/api/license/activate") {
      if (!mutationAllowed(req)) return send(res, 403, { ok: false, error: "same_origin_json_required" });
      if (!bridgeAvailable()) return send(res, 503, { ok: false, error: "host_agent_unavailable" });
      const body = await readJson(req);
      const licenseKey = String(body.license_key || "").trim();
      const transferGrant = String(body.transfer_grant || "").trim();
      if (Boolean(licenseKey) === Boolean(transferGrant)) {
        return send(res, 400, { ok: false, error: "one_activation_claim_required" });
      }
      if (Math.max(licenseKey.length, transferGrant.length) > 256) {
        return send(res, 400, { ok: false, error: "activation_claim_too_long" });
      }
      return send(res, 200, await bridgeRequest("POST", "/v1/license/activate", {
        ...(licenseKey ? { license_key: licenseKey } : { transfer_grant: transferGrant }),
      }));
    }
    if (req.method === "GET" && pathname === "/api/display-config") {
      const preferences = readPreferences();
      if (!bridgeAvailable()) return send(res, 200, { style: preferences.desired_display_style, pending: true, installed: false });
      return send(res, 200, await bridgeRequest("GET", "/v1/display"));
    }
    if (req.method === "PUT" && pathname === "/api/display-config") {
      if (!mutationAllowed(req)) return send(res, 403, { ok: false, error: "same_origin_json_required" });
      const body = await readJson(req);
      const style = String(body.style || "").trim().toLowerCase();
      writePreferences(style);
      if (!bridgeAvailable()) return send(res, 409, { ok: false, error: "host_agent_unavailable", pending: true });
      return send(res, 200, await bridgeRequest("PUT", "/v1/display", { style }));
    }
    if (req.method === "GET" && pathname === "/api/diagnostics") {
      return send(res, 200, {
        ok: true,
        app_version: VERSION,
        data_writable: (() => { try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; } catch { return false; } })(),
        host_agent_available: bridgeAvailable(),
        bootstrap: readBootstrapStatus(),
        bridge_transport: "unix_socket",
        privileged_container: false,
      });
    }
    if (req.method === "GET") return serveStatic(pathname, res);
    return send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    const safe = publicRequestError(error);
    return send(res, safe.status, { ok: false, error: safe.error });
  }
});

server.listen(PORT, "0.0.0.0");
