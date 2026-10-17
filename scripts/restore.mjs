import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../server/store.mjs";
import { createCloudCoordinator } from "../server/cloud.mjs";

const source = process.argv[2];
if (!source || !process.argv.includes("--replace")) {
  console.error(
    "Uso: node scripts/restore.mjs caminho/avana.json --replace [--data-dir caminho]\nEncerre o servidor antes. A restauração substitui os dados e cria um backup anterior.",
  );
  process.exitCode = 1;
} else {
  let store;
  try {
    const port = Number(process.env.PORT || 4310);
    let running = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1200),
      });
      running = response.ok;
    } catch {}
    if (running)
      throw new Error("Encerre o servidor Avana antes da restauração técnica.");
    const index = process.argv.indexOf("--data-dir");
    if (index >= 0 && !process.argv[index + 1])
      throw new Error("Informe a pasta após --data-dir.");
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const directory = resolve(
      index >= 0
        ? process.argv[index + 1]
        : process.env.AVANA_DATA_DIR || join(root, "data"),
    );
    const cloud = createCloudCoordinator(directory);
    cloud.assertWritable();
    const payload = JSON.parse(readFileSync(resolve(source), "utf8"));
    store = createStore(join(directory, "avana.sqlite"));
    store.restore(payload);
    console.log(
      `Restauração concluída em ${directory}. Os vínculos e o histórico foram preservados.`,
    );
  } catch (error) {
    console.error(`Restauração não concluída: ${error.message}`);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
