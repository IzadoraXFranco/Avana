import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer } from "../server/index.mjs";

test("email confirmation can navigate to the app while cross-site API access stays blocked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "avana-navigation-"));
  const distDir = join(dir, "dist");
  mkdirSync(distDir);
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Avana confirmation</title>");
  const server = createServer({ dataDir: join(dir, "data"), distDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const navigation = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  const send = (path, headers = navigation, method = "GET") => new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { headers, method }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
  for (const path of ["/", "/?task=example", "/index.html"]) {
    const page = await send(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.body, /Avana confirmation/);
    assert.equal(page.headers["access-control-allow-origin"], undefined);
  }
  for (const path of ["/api/bootstrap", "/api/export", "/api/cloud/status", "/api/health", "/assets/app.js"]) {
    const blocked = await send(path);
    assert.equal(blocked.status, 403, path);
    assert.equal(JSON.parse(blocked.body).code, "FORBIDDEN_ORIGIN");
  }
  for (const headers of [
    { ...navigation, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    { ...navigation, "Sec-Fetch-Dest": "iframe" },
    { "Sec-Fetch-Site": "cross-site" },
    { ...navigation, Origin: "https://attacker.example" },
  ]) {
    const blocked = await send("/", headers);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers["access-control-allow-origin"], undefined);
  }
  for (const path of ["/", "/api/tasks", "/api/cloud/config"]) {
    assert.equal((await send(path, navigation, "POST")).status, 403);
  }
  const wrongHost = await send("/", { ...navigation, Host: "attacker.example" });
  assert.equal(wrongHost.status, 403);
  assert.equal(JSON.parse(wrongHost.body).code, "FORBIDDEN_HOST");
  const local = await send("/api/health", { Origin: base, "Sec-Fetch-Site": "same-origin" });
  assert.equal(local.status, 200);
  assert.equal(local.headers["access-control-allow-origin"], base);
  assert.equal(server.store.bootstrap().tasks.length, 0);
});
