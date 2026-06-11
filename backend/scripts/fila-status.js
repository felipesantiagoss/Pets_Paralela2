// Visão rápida da fila de notificações (npm run fila).
// Mostra o resumo por status e os últimos jobs — útil para demonstrar ao vivo
// que a API enfileira (P) e o worker consome em background (C, com autor e tempo).

const pool = require('../src/config/db');

async function main() {
  const { rows: porStatus } = await pool.query(
    `SELECT status, count(*)::int AS total FROM fila_notificacoes GROUP BY status ORDER BY status`
  );
  const { rows: jobs } = await pool.query(
    `SELECT id, tipo, payload->>'nome' AS pet, payload->>'usuarioId' AS adotante,
            status, processado_por,
            to_char(criado_em, 'HH24:MI:SS') AS criado,
            CASE WHEN processado_em IS NOT NULL
                 THEN round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) || 's depois'
                 ELSE '—' END AS processado
       FROM fila_notificacoes
      ORDER BY id DESC
      LIMIT 15`
  );

  const legenda = { P: 'P (pendente)', C: 'C (concluído)', E: 'E (erro)' };
  console.log('=== FILA DE NOTIFICAÇÕES (fila_notificacoes) ===');
  if (porStatus.length === 0) {
    console.log('Fila vazia — nenhuma adoção enfileirou jobs ainda.');
  } else {
    console.log('Resumo: ' + porStatus.map((s) => `${legenda[s.status] || s.status}: ${s.total}`).join('  |  '));
    console.log('');
    console.log('Últimos jobs (mais recente primeiro):');
    console.log('  job  | status | pet                  | adotante             | criado   | processado por       | quando');
    console.log('  ' + '-'.repeat(105));
    for (const j of jobs) {
      console.log(
        `  #${String(j.id).padEnd(4)}| ${j.status}      | ${(j.pet || '—').padEnd(20)} | ${(j.adotante || '—').padEnd(20)} | ${j.criado} | ${(j.processado_por || '— aguardando worker').padEnd(20)} | ${j.processado}`
      );
    }
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(`Erro ao consultar a fila: ${err.message}`);
  if (/fila_notificacoes/.test(err.message)) {
    console.error('A tabela fila_notificacoes existe? Aplique o create-table.sql no banco petz.');
  }
  await pool.end().catch(() => {});
  process.exit(1);
});
