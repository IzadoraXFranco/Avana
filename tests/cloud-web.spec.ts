import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("cloud retoma após falha de estado e importa dados antigos sem substituir", async ({ page }) => {
  const config = { url: "https://avana-qa.supabase.co", publishableKey: "sb_publishable_qa_fixture_public_key" };
  const owner = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  const portable = await (await page.request.get("/api/export")).json();
  const configured = await page.request.post("/api/cloud/config", { data: config });
  expect(configured.ok()).toBe(true);
  let failStatus = false;
  let bootstraps = 0;
  let imported: unknown = null;
  try {
    await page.route("**/api/cloud/status", route => route.fulfill({
      status: failStatus ? 503 : 200,
      json: failStatus ? { error: "Estado temporariamente indisponível" } : { state: "cloud", config },
    }));
    await page.route("https://avana-qa.supabase.co/auth/v1/token**", route => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return route.fulfill({ json: {
        access_token: `${segment({ alg: "HS256", typ: "JWT" })}.${segment({ sub: owner, exp, role: "authenticated" })}.fixture`,
        refresh_token: "qa-only-refresh", expires_in: 3600, expires_at: exp, token_type: "bearer",
        user: { id: owner, aud: "authenticated", role: "authenticated", email: "qa@example.com", created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} },
      } });
    });
    await page.route("https://avana-qa.supabase.co/rest/v1/rpc/avana_api", route => {
      const input = route.request().postDataJSON();
      expect(input.p_expected_user_id).toBe(owner);
      if (input.p_path === "/api/import") {
        expect(input.p_method).toBe("POST");
        imported = input.p_body.data;
        return route.fulfill({ json: { workspaceId, sourceId: "qa-import", hash: "qa", counts: {}, settingsApplied: false } });
      }
      expect(input.p_path).toBe("/api/bootstrap");
      bootstraps++;
      return route.fulfill({ json: { ...bootstrap, workspaceId, revision: 1 } });
    });
    await page.goto("/");
    await page.getByLabel("E-mail", { exact: true }).fill("qa@example.com");
    await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-qa");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
    failStatus = true;
    await page.evaluate(() => window.dispatchEvent(new Event("avana:cloud-state-changed")));
    await expect(page.getByRole("heading", { name: "A conexão precisa de atenção" })).toBeVisible();
    const beforeRetry = bootstraps;
    failStatus = false;
    await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
    expect(bootstraps).toBeGreaterThan(beforeRetry);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Configurações", exact: true });
    await settings.getByRole("button", { name: "Seus dados", exact: true }).click();
    await settings.getByLabel("Escolher exportação ou pacote do navegador").setInputFiles({
      name: "browser-recovery.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ format: "avana-browser-recovery", version: 1, exportedAt: new Date().toISOString(), origin: "http://old-installation", entries: { "avana.export": JSON.stringify(portable) } })),
    });
    await settings.getByRole("button", { name: "Importar sem substituir: avana.export", exact: true }).click();
    await expect.poll(() => imported).toEqual(portable);
    await expect(page.getByText("Importação concluída. Os dados que já estavam neste espaço foram preservados.", { exact: true })).toBeVisible();
  } finally {
    await page.request.post("/api/cloud/cancel", { data: {} });
  }
});

test("rascunho desconhecido é preservado e baixável sem quebrar os detalhes", async ({ page }, info) => {
  const created = await page.request.post("/api/tasks", { data: { title: "QA · Recuperação de rascunho antigo" } });
  expect(created.ok()).toBe(true);
  const detail = await created.json();
  const raw = JSON.stringify({ version: 1, base: { main: {} }, draft: { main: {}, comment: { text: "Texto de uma versão desconhecida" } } });
  const key = `avana:task-draft:${detail.task.id}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
  await page.goto(`/?task=${detail.task.id}`);
  const panel = page.getByRole("complementary", { name: /^Detalhes:/ });
  await expect(panel.getByLabel("Título da tarefa")).toHaveValue(detail.task.title);
  const archived = await page.evaluate(id => Object.entries(localStorage).filter(([key]) => key.startsWith(`avana:unrecognized-task-draft:${id}:`)), detail.task.id);
  expect(archived.length).toBeGreaterThan(0);
  expect(archived[0][1]).toBe(raw);
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Baixar rascunho original" }).click();
  const download = await downloading;
  const filename = info.outputPath("unknown-draft.json");
  await download.saveAs(filename);
  expect(JSON.parse(await readFile(filename, "utf8")).entries[key]).toBe(raw);
  expect(errors).toEqual([]);
});
