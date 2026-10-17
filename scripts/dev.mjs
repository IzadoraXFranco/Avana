import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const server = resolve(root, 'server/index.mjs');
const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 24 || (major === 24 && minor < 14)) {
  console.error('Avana requer Node.js 24.14 ou superior.');
  process.exit(1);
}
if (!existsSync(vite) || !existsSync(server)) {
  console.error('Projeto incompleto. Execute npm install antes de npm run dev.');
  process.exit(1);
}

const children = new Set();
let stopping = false;
let forceShutdown;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  forceShutdown = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 3000);
  forceShutdown.unref();
}

function start(label, entrypoint) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  children.add(child);
  child.once('error', (error) => {
    console.error(`Não foi possível iniciar ${label}: ${error.message}`);
    children.delete(child);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} foi encerrado${signal ? ` (${signal})` : ''}.`);
      stop(code || 1);
    }
    if (children.size === 0) clearTimeout(forceShutdown);
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
start('Servidor Avana', server);
start('Interface de desenvolvimento', vite);
console.log('Avana em desenvolvimento: http://127.0.0.1:5173 (Ctrl+C encerra ambos os processos).');
