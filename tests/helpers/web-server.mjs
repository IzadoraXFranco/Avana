import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../server/index.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distDir = resolve(process.env.AVANA_QA_DIST || join(root, "data", "qa-cloud-dist"));
if (!existsSync(join(distDir, "index.html"))) throw new Error("Compile a interface de QA antes de executar os testes Web (AVANA_QA_DIST).");
const temporaryRoot = resolve(tmpdir());
const dataDir = mkdtempSync(join(temporaryRoot, "avana-web-qa-"));
const server = createServer({ dataDir, distDir, storeOptions: { autoBackup: false, backupDirectory: join(dataDir, "backups") } });
let stopping = false;
function cleanup() {
  const target = resolve(dataDir);
  if (!target.startsWith(temporaryRoot + sep) || !target.slice(temporaryRoot.length + 1).startsWith("avana-web-qa-"))
    throw new Error("Diretório temporário de QA inesperado; limpeza bloqueada.");
  rmSync(target, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { cleanup(); process.exit(0); });
});
server.on("error", (error) => { server.store.close(); cleanup(); console.error(error.message); process.exit(1); });
server.listen(4312, "127.0.0.1", () => console.log("Avana Web QA isolado: http://127.0.0.1:4312"));
