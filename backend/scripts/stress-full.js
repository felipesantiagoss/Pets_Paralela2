const { spawn } = require('child_process');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const HEALTH = (process.env.BASE_URL || 'http://localhost:3001') + '/api/animais';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function servidorNoAr() {
  try {
    const r = await fetch(HEALTH);
    return r.ok;
  } catch {
    return false;
  }
}

async function esperarServidor(tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    if (await servidorNoAr()) return true;
    await sleep(250);
  }
  return false;
}

function rodarStress() {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/stress-adocao.js'], { cwd: backendDir, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  let servidor = null;

  if (await servidorNoAr()) {
    console.log('Servidor já está rodando na 3001 — usando o existente.\n');
  } else {
    console.log('Subindo o servidor...\n');
    servidor = spawn('node', ['server.js'], { cwd: backendDir, stdio: ['ignore', 'ignore', 'inherit'] });
    if (!(await esperarServidor())) {
      console.error('Não consegui subir o servidor. Verifique o banco e as credenciais em src/config/db.js.');
      servidor.kill('SIGTERM');
      process.exit(1);
    }
  }

  const code = await rodarStress();

  if (servidor) servidor.kill('SIGTERM');
  process.exit(code);
}

main();
