const { spawn } = require('child_process'); // Importa a função spawn, usada para iniciar outros processos (ex.: o servidor e o teste)
const path = require('path'); // Importa o módulo path, usado para montar caminhos de arquivos de forma segura

const backendDir = path.join(__dirname, '..'); // Calcula o caminho da pasta backend (um nível acima da pasta deste script)
const HEALTH = (process.env.BASE_URL || 'http://localhost:3001') + '/api/animais'; // Monta a URL usada para verificar se o servidor está no ar
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // Cria uma função que espera (pausa) por 'ms' milissegundos usando uma Promise

// Função que verifica se o servidor está respondendo (no ar)
async function servidorNoAr() {
  try {
    const r = await fetch(HEALTH); // Faz uma requisição HTTP para a URL de verificação
    return r.ok; // Retorna true se a resposta foi bem-sucedida (status 2xx)
  } catch {
    return false; // Se houve qualquer erro (servidor offline), retorna false
  }
}

// Função que tenta repetidamente verificar se o servidor subiu, fazendo várias tentativas
async function esperarServidor(tentativas = 40) {
  for (let i = 0; i < tentativas; i++) { // Repete o loop até o número máximo de tentativas
    if (await servidorNoAr()) return true; // Se o servidor responder, retorna true imediatamente
    await sleep(250); // Caso contrário, espera 250ms antes de tentar de novo
  }
  return false; // Se esgotou as tentativas sem sucesso, retorna false
}

// Função que executa o script de teste de estresse de adoção em um processo separado
function rodarStress() {
  return new Promise((resolve) => { // Retorna uma Promise que resolve quando o processo do teste terminar
    const child = spawn('node', ['scripts/stress-adocao.js'], { cwd: backendDir, stdio: 'inherit' }); // Inicia o script de stress com node, na pasta backend, herdando a saída no terminal
    child.on('exit', (code) => resolve(code ?? 1)); // Quando o processo encerra, resolve a Promise com o código de saída (ou 1 se for nulo)
  });
}

// Função principal que orquestra: garante o servidor no ar, roda o teste e finaliza
async function main() {
  let servidor = null; // Guarda a referência do processo do servidor (caso seja iniciado aqui); nulo se já estava rodando

  if (await servidorNoAr()) { // Verifica se o servidor já está rodando
    console.log('Servidor já está rodando na 3001 — usando o existente.\n'); // Informa que vai reutilizar o servidor existente
  } else {
    console.log('Subindo o servidor...\n'); // Informa que vai iniciar o servidor
    servidor = spawn('node', ['server.js'], { cwd: backendDir, stdio: ['ignore', 'ignore', 'inherit'] }); // Inicia o servidor com node, ignorando entrada/saída padrão mas exibindo erros no terminal
    if (!(await esperarServidor())) { // Espera o servidor ficar pronto; se não conseguir...
      console.error('Não consegui subir o servidor. Verifique o banco e as credenciais em src/config/db.js.'); // Mostra mensagem de erro com dica de solução
      servidor.kill('SIGTERM'); // Encerra o processo do servidor que foi iniciado
      process.exit(1); // Finaliza o script com código 1 (falha)
    }
  }

  const code = await rodarStress(); // Executa o teste de estresse e guarda o código de saída retornado

  if (servidor) servidor.kill('SIGTERM'); // Se este script iniciou o servidor, encerra-o ao final do teste
  process.exit(code); // Finaliza o script com o mesmo código de saída do teste de estresse
}

main(); // Chama a função principal para iniciar a execução do script
