import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["web.spec.ts", "cloud-web.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  outputDir: "data/qa-artifacts/playwright",
  use: {
    baseURL: "http://127.0.0.1:4312",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: process.env.AVANA_QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" },
    viewport: { width: 1440, height: 1000 },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/helpers/web-server.mjs",
    url: "http://127.0.0.1:4312/api/health",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
