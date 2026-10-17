import http from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, AppError } from "./store.mjs";
import { createCloudCoordinator } from "./cloud.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}
async function body(request) {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AppError("Use conteúdo JSON.", 415, "UNSUPPORTED_MEDIA_TYPE");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024)
      throw new AppError(
        "O arquivo excede o limite de 32 MB.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("JSON inválido.");
  }
}
function verifyLocal(request, port) {
  const host = request.headers.host;
  if (
    !host ||
    !new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(host.toLowerCase())
  )
    throw new AppError("Host local inválido.", 403, "FORBIDDEN_HOST");
  // Email confirmation returns from Supabase to the public app document.
  // Only a top-level GET may cross sites; APIs, frames and fetches stay blocked.
  const appNavigation =
    request.method === "GET" &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document" &&
    ["/", "/index.html"].includes(new URL(request.url, "http://127.0.0.1").pathname);
  if (request.headers["sec-fetch-site"] === "cross-site" && !appNavigation)
    throw new AppError(
      "Solicitação externa bloqueada.",
      403,
      "FORBIDDEN_ORIGIN",
    );
  const origin = request.headers.origin;
  if (
    origin &&
    !new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]).has(origin)
  )
    throw new AppError("Origem externa bloqueada.", 403, "FORBIDDEN_ORIGIN");
}
export function createServer(options = {}) {
  const dataDir = resolve(
    options.dataDir || process.env.AVANA_DATA_DIR || join(root, "data"),
  );
  const distDir = resolve(options.distDir || join(root, "dist"));
  // Read the durable migration lock before opening SQLite or running maintenance.
  const cloud = createCloudCoordinator(dataDir, { fetch: options.fetch });
  const store = options.store || createStore(join(dataDir, "avana.sqlite"), {
    ...options.storeOptions,
    isFrozen: cloud.isLocked,
  });
  store.setFrozenGuard?.(cloud.isLocked);
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${cloud.connectSources()}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
    );
    try {
      verifyLocal(request, server.address().port);
      if (request.headers.origin) {
        response.setHeader(
          "Access-Control-Allow-Origin",
          request.headers.origin,
        );
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Idempotency-Key",
        });
        response.end();
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname;
      const mutate = (payload, fn) => {
        cloud.assertWritable();
        return store.executeRequest(
          request.headers["idempotency-key"],
          `${request.method} ${path}`,
          payload,
          fn,
        );
      };
      if (path === "/api/health" && request.method === "GET")
        return json(response, 200, { ok: true, app: "avana" });
      if (path === "/api/cloud/status" && request.method === "GET")
        return json(response, 200, cloud.status());
      if (path === "/api/cloud/config" && request.method === "POST")
        return json(response, 200, cloud.configure(await body(request)));
      if (path === "/api/cloud/freeze" && request.method === "POST")
        return json(response, 200, cloud.freeze(await body(request), store));
      if (path === "/api/cloud/activate" && request.method === "POST")
        return json(response, 200, await cloud.activate(await body(request)));
      if (path === "/api/cloud/cancel" && request.method === "POST")
        return json(response, 200, cloud.cancel());
      // Guard future domain routes too, not just the currently implemented mutations.
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method))
        cloud.assertWritable();
      if (path === "/api/bootstrap" && request.method === "GET")
        return json(response, 200, store.bootstrap());
      if (path === "/api/export" && request.method === "GET")
        return json(response, 200, store.exportData(), {
          "Content-Disposition": `attachment; filename="avana-${new Date().toISOString().slice(0, 10)}.json"`,
        });
      if (path === "/api/backup" && request.method === "POST")
        return json(
          response,
          200,
          mutate(null, () => store.backup()),
        );
      if (path === "/api/restore" && request.method === "POST") {
        const input = await body(request);
        return json(
          response,
          200,
          mutate(input, () => store.restore(input.data)),
        );
      }
      if (path === "/api/settings" && request.method === "PATCH") {
        const input = await body(request);
        return json(
          response,
          200,
          mutate(input, () => store.updateSettings(input)),
        );
      }
      if (path === "/api/projects" && request.method === "POST") {
        const input = await body(request);
        return json(
          response,
          201,
          mutate(input, () => store.createProject(input)),
        );
      }
      if (path === "/api/tasks" && request.method === "POST") {
        const input = await body(request);
        return json(
          response,
          201,
          mutate(input, () => store.createTask(input)),
        );
      }
      let match = path.match(/^\/api\/projects\/([^/]+)$/);
      if (match && request.method === "PATCH") {
        const input = await body(request);
        return json(
          response,
          200,
          mutate(input, () =>
            store.updateProject(decodeURIComponent(match[1]), input),
          ),
        );
      }
      match = path.match(/^\/api\/tasks\/([^/]+)(\/command)?$/);
      if (match && !match[2] && request.method === "GET")
        return json(response, 200, store.getTask(decodeURIComponent(match[1])));
      if (match && match[2] && request.method === "POST") {
        const input = await body(request);
        return json(
          response,
          200,
          mutate(input, () =>
            store.command(decodeURIComponent(match[1]), input),
          ),
        );
      }
      if (path.startsWith("/api/"))
        return json(response, 404, {
          error: "Rota não encontrada.",
          code: "NOT_FOUND",
        });
      if (!["GET", "HEAD"].includes(request.method))
        return json(response, 405, { error: "Método não permitido." });
      let target = resolve(distDir, `.${decodeURIComponent(path)}`);
      if (target !== distDir && !target.startsWith(distDir + sep))
        throw new AppError("Caminho inválido.", 403);
      if (!existsSync(target) || !statSync(target).isFile()) {
        if (extname(path))
          return json(response, 404, { error: "Arquivo não encontrado." });
        target = join(distDir, "index.html");
      }
      if (!existsSync(target))
        return json(response, 503, {
          error:
            "A interface ainda não foi compilada. Execute npm run build ou npm run dev.",
        });
      response.writeHead(200, {
        "Content-Type": types[extname(target)] || "application/octet-stream",
        "Cache-Control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(target);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof AppError)) console.error("[Avana]", error);
      json(response, error instanceof AppError ? error.status : 500, {
        error:
          error instanceof AppError
            ? error.message
            : "Não foi possível salvar. Seus dados anteriores foram preservados; tente novamente.",
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const upkeep = setInterval(() => {
    try {
      if (!cloud.isLocked()) store.maintenance();
    } catch (error) {
      console.error("[Avana] Falha na manutenção diária:", error.message);
    }
  }, 60000);
  upkeep.unref();
  server.on("close", () => {
    clearInterval(upkeep);
    if (!options.store) store.close();
  });
  server.store = store;
  server.cloud = cloud;
  return server;
}
export function startServer(options = {}) {
  const server = createServer(options);
  const port = Number(options.port || process.env.PORT || 4310);
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Avana disponível em http://127.0.0.1:${server.address().port}`,
    ),
  );
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = startServer();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
}
