import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const sections = ["Backlog", "Hold", "In Progress (Do Today)", "Done Today", "Done"];
const panel = (page: Page) => page.getByRole("complementary", { name: /^Detalhes:/ });

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
}
async function createTask(page: Page, title: string, openDetails = true) {
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Uma nova tarefa" });
  await dialog.getByLabel("O que precisa ser feito?").fill(title);
  await dialog.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await expect(dialog).toBeHidden();
  if (!openDetails) return;
  if (!(await panel(page).isVisible())) await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panel(page).getByLabel("Título da tarefa")).toHaveValue(title);
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  return page.getByRole("dialog", { name: "Configurações", exact: true });
}

test("cinco seções e fluxo criar, editar, subtarefa, concluir com evidência e reabrir", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openApp(page);
  for (const section of sections) await expect(page.getByRole("region", { name: section, exact: true })).toBeVisible();
  await createTask(page, "QA · Organizar entrega");
  const details = panel(page);
  await details.getByLabel("Título da tarefa").fill("QA · Entrega revisada");
  await details.getByLabel("Prazo final", { exact: true }).fill("2026-12-20");
  await details.getByLabel("Descrição", { exact: true }).fill("Descrição preservada **com contexto**.");
  await details.getByRole("button", { name: "Salvar campos", exact: true }).first().click();
  await expect(details.getByRole("button", { name: "Salvar campos", exact: true })).toHaveCount(0);
  await details.getByLabel("Mover tarefa para seção").selectOption("today");
  await expect(details.getByLabel("Prazo final", { exact: true })).toHaveValue("2026-12-20");
  await details.getByLabel("Nova subtarefa", { exact: true }).fill("Conferir documento");
  await details.getByLabel("Nova subtarefa", { exact: true }).press("Enter");
  await expect(details.getByRole("checkbox", { name: "Concluir subtarefa Conferir documento", exact: true })).toBeVisible();
  await details.getByRole("checkbox", { name: "Concluir subtarefa Conferir documento", exact: true }).click();
  await expect(details.getByRole("checkbox", { name: "Reabrir subtarefa Conferir documento", exact: true })).toBeChecked();
  await expect(details.getByRole("button", { name: "Concluir tarefa", exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Concluir tarefa", exact: true }).click();
  const completion = page.getByRole("dialog", { name: "Concluir tarefa", exact: true });
  await completion.getByLabel(/Resultado ou evidência/).fill("Entrega validada em QA, com evidência textual.");
  await completion.getByLabel("Link da evidência").fill("https://example.com/evidencia-qa");
  await completion.getByRole("button", { name: "Concluir tarefa", exact: true }).click();
  await expect(completion).toBeHidden();
  await expect(page.getByRole("region", { name: "Done Today", exact: true }).getByRole("button", { name: "QA · Entrega revisada", exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Reabrir tarefa", exact: true }).click();
  const reopening = page.getByRole("dialog", { name: "Reabrir tarefa", exact: true });
  await expect(reopening.getByLabel("Destino")).toHaveValue("today");
  await reopening.getByRole("button", { name: "Reabrir", exact: true }).click();
  await expect(reopening).toBeHidden();
  await expect(details.getByLabel("Mover tarefa para seção")).toHaveValue("today");
  await expect(details.getByLabel("Prazo final", { exact: true })).toHaveValue("2026-12-20");
  await details.getByRole("button", { name: "Fechar detalhes", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "In Progress (Do Today)", exact: true }).getByRole("button", { name: "QA · Entrega revisada", exact: true })).toBeVisible();
  const data = await (await page.request.get("/api/export")).json();
  const task = data.data.tasks.find((item: { title: string }) => item.title === "QA · Entrega revisada");
  expect(data.data.completions.filter((item: { taskId: string }) => item.taskId === task.id)).toHaveLength(1);
  expect(data.data.comments.some((item: { taskId: string; kind: string }) => item.taskId === task.id && item.kind === "evidence")).toBe(true);
  expect(errors).toEqual([]);
});

test("rascunho de edição sobrevive a falha de salvamento e recarga", async ({ page }) => {
  await openApp(page);
  await createTask(page, "QA · Rascunho protegido");
  const details = panel(page);
  const route = "**/api/tasks/*/command";
  await page.route(route, (request) => request.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Falha simulada de QA. Tente novamente.", code: "QA_UNAVAILABLE" }) }));
  const draft = "Texto digitado que deve continuar disponível após uma falha e recarga.";
  await details.getByLabel("Descrição", { exact: true }).fill(draft);
  await details.getByRole("button", { name: "Salvar campos", exact: true }).first().click();
  await expect(details.getByRole("alert")).toContainText("Falha simulada de QA");
  await expect(details.getByLabel("Descrição", { exact: true })).toHaveValue(draft);
  await page.unroute(route);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(panel(page).getByLabel("Descrição", { exact: true })).toHaveValue(draft);
  await panel(page).getByRole("button", { name: "Salvar campos", exact: true }).first().click();
  await expect(panel(page).getByRole("button", { name: "Salvar campos", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(panel(page).getByLabel("Descrição", { exact: true })).toHaveValue(draft);
});

test("temas lilás claro e escuro persistem e preservam a organização compacta", async ({ page }, info) => {
  await openApp(page);
  let dialog = await settings(page);
  await dialog.getByRole("button", { name: "Claro", exact: true }).click();
  await dialog.getByRole("button", { name: "Salvar preferências", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await dialog.getByRole("button", { name: "Fechar janela" }).click();
  await page.screenshot({ path: info.outputPath("avana-light.png"), fullPage: true });
  await page.getByRole("button", { name: "Alternar tema" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: info.outputPath("avana-dark.png"), fullPage: true });
  dialog = await settings(page);
  await expect(dialog.getByRole("button", { name: "Escuro", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("sincronização rejeita segredo, mostra login e permite cancelar antes de congelar", async ({ page }) => {
  // Only this disposable browser fixture intercepts authentication; no real account or cloud project is contacted.
  await page.route("https://avana-qa.supabase.co/**", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error_code: "invalid_credentials", msg: "Credenciais de teste inválidas" }) }));
  await openApp(page);
  const dialog = await settings(page);
  await dialog.getByRole("button", { name: "Sincronização", exact: true }).click();
  await dialog.getByRole("button", { name: "Configurar sincronização", exact: true }).click();
  const config = page.getByRole("dialog", { name: "Configurar sincronização", exact: true });
  await config.getByLabel("URL do projeto").fill("https://avana-qa.supabase.co");
  await config.getByLabel("Chave publicável").fill("sb_secret_nao_deve_ser_aceita");
  await config.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(config.getByRole("alert")).toContainText(/chave pública|[Cc]haves? secretas?/);
  expect((await (await page.request.get("/api/cloud/status")).json()).state).toBe("local");
  await config.getByLabel("Chave publicável").fill("sb_publishable_qa_fixture_public_key");
  await config.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Entre no Avana", exact: true })).toBeVisible();
  await page.getByLabel("E-mail", { exact: true }).fill("qa@example.com");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-qa");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Credenciais de teste inválidas");
  await page.getByRole("button", { name: "Cancelar configuração e continuar localmente", exact: true }).click();
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/cloud/status")).json()).state).toBe("local");
});

test("exportação pela interface baixa JSON completo do espaço local", async ({ page }, info) => {
  await openApp(page);
  const dialog = await settings(page);
  await dialog.getByRole("button", { name: "Seus dados", exact: true }).click();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Exportar dados em JSON", exact: true }).click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/^avana-\d{4}-\d{2}-\d{2}\.json$/);
  const path = info.outputPath("avana-export.json");
  await result.saveAs(path);
  const data = JSON.parse(await readFile(path, "utf8"));
  expect(data.format).toBe("avana");
  expect(data.version).toBe(1);
  for (const table of ["projects", "tasks", "subtasks", "comments", "activity", "completions", "holds", "followUps"])
    expect(Array.isArray(data.data[table])).toBe(true);
  expect(data.data.tasks.length).toBeGreaterThan(0);
});

test("abas clonadas mantêm tentativas independentes e retry estável após commit com resposta perdida", async ({ page }) => {
  await openApp(page);
  await createTask(page, "QA · Inicializar identidade da aba");
  await panel(page).getByRole("button", { name: "Fechar detalhes", exact: true }).click();
  const popupEvent = page.waitForEvent("popup");
  await page.evaluate(() => { window.open("/", "_blank"); });
  const second = await popupEvent;
  await expect(second.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  const title = "QA · Mesmo conteúdo em duas abas";
  let firstId: string | undefined;
  const secondIds: string[] = [];
  let releaseLostResponse!: () => void;
  let committed!: () => void;
  const holdResponse = new Promise<void>((resolve) => { releaseLostResponse = resolve; });
  const waitForCommit = new Promise<void>((resolve) => { committed = resolve; });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "POST") firstId = route.request().headers()["idempotency-key"];
    await route.continue();
  });
  await second.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    secondIds.push(route.request().headers()["idempotency-key"]);
    if (secondIds.length > 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed();
    await holdResponse;
    await route.abort("failed");
  });
  await second.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  const secondDialog = second.getByRole("dialog", { name: "Uma nova tarefa" });
  await secondDialog.getByLabel("O que precisa ser feito?").fill(title);
  await secondDialog.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await waitForCommit;
  try { await createTask(page, title, false); }
  finally { releaseLostResponse(); }
  await expect(secondDialog.getByRole("alert")).toContainText(/conexão|conectar/);
  expect(firstId).toBeTruthy();
  expect(secondIds[0]).toBeTruthy();
  expect(firstId).not.toBe(secondIds[0]);
  await second.reload();
  await createTask(second, title, false);
  expect(secondIds).toHaveLength(2);
  expect(secondIds[1]).toBe(secondIds[0]);
  const data = await (await second.request.get("/api/export")).json();
  expect(data.data.tasks.filter((task: { title: string }) => task.title === title)).toHaveLength(2);
  await second.close();
});
