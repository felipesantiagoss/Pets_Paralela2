// Worker de processamento em background (paralelismo: fila + worker).
//
// Processo SEPARADO da API (npm run worker). Consome a tabela fila_notificacoes:
// a API produz jobs ao confirmar adoções; este worker os processa de forma
// independente da requisição HTTP — que já respondeu ao usuário há muito tempo.
//
// Pode-se subir VÁRIOS workers ao mesmo tempo (WORKER_ID=worker-A npm run worker):
// o FOR UPDATE SKIP LOCKED garante que cada job é entregue a exatamente um worker.
// O job é processado DENTRO de uma transação: se o worker morrer no meio, o
// Postgres faz rollback e o job volta para a fila automaticamente (status 'P').

const pool = require('./src/config/db');

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
// Tempo simulado do trabalho pesado (ex: envio de e-mail, geração de certificado).
const TRABALHO_MS = parseInt(process.env.TRABALHO_MS || '1500', 10);
// Intervalo entre verificações quando a fila está vazia.
const POLL_MS = parseInt(process.env.POLL_MS || '1000', 10);

let encerrando = false;

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${hora()}] [${WORKER_ID}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Executa o trabalho de um job. Aqui o "envio de e-mail" é simulado com uma
// espera; numa evolução real entraria o nodemailer, push notification etc.
async function executarJob(job) {
  const { nome, usuarioId, animalId } = job.payload;
  if (job.tipo === 'adocao_confirmada') {
    await sleep(TRABALHO_MS);
    log(`📧 e-mail de confirmação enviado para "${usuarioId}": parabéns pela adoção de ${nome} (pet ${animalId})`);
  } else {
    await sleep(TRABALHO_MS);
    log(`job de tipo "${job.tipo}" processado`);
  }
}

// Pega 1 job pendente e processa. Retorna 'job', 'vazia' ou 'erro'.
async function processarProximoJob() {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // SKIP LOCKED: se outro worker já travou um job, este pula para o próximo
    // em vez de esperar — é isso que permite consumo em paralelo sem duplicar.
    const { rows } = await client.query(
      `SELECT id, tipo, payload, criado_em
         FROM fila_notificacoes
        WHERE status = 'P'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return 'vazia';
    }

    const job = rows[0];
    log(`📬 job #${job.id} recebido (${job.tipo}) — processando...`);
    await executarJob(job);

    // clock_timestamp() = instante real da conclusão (now() devolveria o início
    // da transação, que fica aberta durante todo o processamento do job).
    await client.query(
      `UPDATE fila_notificacoes
          SET status = 'C', processado_em = clock_timestamp(), processado_por = $1
        WHERE id = $2`,
      [WORKER_ID, job.id]
    );
    await client.query('COMMIT');
    log(`✅ job #${job.id} concluído`);
    return 'job';
  } catch (err) {
    // Banco fora do ar ou erro no job: o worker NÃO morre — loga, espera e
    // tenta de novo. Se havia job em andamento, o rollback o devolve à fila.
    if (client) await client.query('ROLLBACK').catch(() => {});
    const motivo =
      err.message || err.code || (err.errors && err.errors[0] && err.errors[0].message) || String(err);
    log(`❌ erro: ${motivo} (se havia job em andamento, ele voltou para a fila)`);
    if (/fila_notificacoes/.test(motivo)) {
      log('   → a tabela fila_notificacoes existe? Aplique o create-table.sql no banco petz.');
    }
    await sleep(POLL_MS);
    return 'erro';
  } finally {
    if (client) client.release();
  }
}

async function main() {
  log(`worker iniciado — aguardando jobs na fila (trabalho simulado: ${TRABALHO_MS}ms por job)`);
  let filaVaziaAvisada = false;

  while (!encerrando) {
    const resultado = await processarProximoJob();
    if (resultado === 'job') {
      filaVaziaAvisada = false;
    } else if (resultado === 'vazia') {
      if (!filaVaziaAvisada) {
        log('📭 fila vazia — aguardando novos jobs...');
        filaVaziaAvisada = true;
      }
      await sleep(POLL_MS);
    }
    // 'erro': já logou e já esperou dentro do catch — só tenta de novo.
  }

  log('encerrado.');
  await pool.end();
  process.exit(0);
}

// Encerramento gracioso (thread/processo COM controle): termina o job atual e
// só então sai. Se for morto à força no meio de um job, o rollback da transação
// devolve o job à fila — nenhum trabalho se perde.
process.on('SIGINT', () => {
  log('SIGINT recebido — terminando o job atual antes de sair...');
  encerrando = true;
});
process.on('SIGTERM', () => {
  encerrando = true;
});

main().catch(async (err) => {
  log(`❌ erro fatal: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
