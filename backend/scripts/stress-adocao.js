const pool = require('../src/config/db');
const { criarSessao, estatisticas } = require('./lib/relatorio');

// Sem ANIMAL_ID na env, o teste escolhe sozinho o primeiro animal disponível
// (status 'D') — evita disparar a corrida contra um animal já adotado.
let ANIMAL_ID = process.env.ANIMAL_ID ? parseInt(process.env.ANIMAL_ID, 10) : null;
const NUM_USUARIOS = parseInt(process.env.NUM_USUARIOS || '3', 10);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

async function adotar(usuarioId, sessao) {
  const enviadoEm = Date.now() - sessao.inicioMs;
  try {
    const res = await fetch(`${BASE_URL}/api/animais/${ANIMAL_ID}/adotar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuarioId }),
    });
    const corpo = await res.json().catch(() => ({}));
    const respondidoEm = Date.now() - sessao.inicioMs;
    const ev = {
      tipo: 'request',
      acao: 'adotar',
      usuarioId,
      petId: ANIMAL_ID,
      nome: corpo.nome,
      enviadoEm,
      respondidoEm,
      latencia: respondidoEm - enviadoEm,
      status: res.status,
      motivo: corpo.mensagem || corpo.motivo || '',
      // Campos vindos do servidor (instrumentação que explica a corrida):
      // recebidoEm vem como epoch absoluto; convertemos para o mesmo referencial
      // relativo (ms desde o disparo) usado em enviadoEm/respondidoEm.
      recebidoEm: corpo.recebidoEm != null ? corpo.recebidoEm - sessao.inicioMs : null,
      ordemChegada: corpo.ordemChegada != null ? corpo.ordemChegada : null,
      dbMs: corpo.dbMs != null ? corpo.dbMs : null,
      // Job de notificação enfileirado pela adoção vencedora (fila + worker).
      jobId: corpo.jobId != null ? corpo.jobId : null,
    };
    sessao.log(ev);
    return ev;
  } catch (err) {
    const respondidoEm = Date.now() - sessao.inicioMs;
    const ev = {
      tipo: 'request',
      acao: 'adotar',
      usuarioId,
      petId: ANIMAL_ID,
      enviadoEm,
      respondidoEm,
      latencia: respondidoEm - enviadoEm,
      status: 0,
      motivo: `Erro de rede: ${err.message}`,
    };
    sessao.log(ev);
    return ev;
  }
}

async function main() {
  const sessao = criarSessao('stress-adocao');

  let statusInicial;
  let nomeAnimal;
  try {
    if (ANIMAL_ID == null) {
      const { rows: disponiveis } = await pool.query(
        "SELECT id FROM animais WHERE status = 'D' ORDER BY id LIMIT 1"
      );
      if (disponiveis.length === 0) {
        console.error(
          "Nenhum animal disponível (status 'D'). Reative alguns: UPDATE animais SET status='D' WHERE id IN (1,2,3,4,5);"
        );
        await sessao.fechar();
        await pool.end();
        process.exit(1);
      }
      ANIMAL_ID = disponiveis[0].id;
      console.log(`ANIMAL_ID não informado — usando o primeiro disponível: ${ANIMAL_ID}`);
    }

    const { rows } = await pool.query('SELECT nome, status FROM animais WHERE id = $1', [ANIMAL_ID]);
    if (rows.length === 0) {
      console.error(`Animal id=${ANIMAL_ID} não existe no banco. Abortando.`);
      await sessao.fechar();
      await pool.end();
      process.exit(1);
    }
    nomeAnimal = rows[0].nome;
    statusInicial = rows[0].status;
  } catch (err) {
    console.error(`Erro ao conectar/preparar o banco: ${err.message}`);
    await sessao.fechar();
    await pool.end();
    process.exit(1);
  }

  const ids = Array.from({ length: NUM_USUARIOS }, (_, i) => `user-${i + 1}`);

  const inicio = Date.now();
  const resultados = await Promise.all(ids.map((u) => adotar(u, sessao)));
  const tempoTotal = Date.now() - inicio;

  const { rows: finalRows } = await pool.query('SELECT status FROM animais WHERE id = $1', [ANIMAL_ID]);
  const statusFinal = finalRows[0] ? finalRows[0].status : '?';

  const sucessos = resultados.filter((r) => r.status === 200);
  const conflitos = resultados.filter((r) => r.status === 409);
  const inesperados = resultados.filter((r) => r.status !== 200 && r.status !== 409);

  console.log('=== TESTE DE ESTRESSE - ADOÇÃO CONCORRENTE (RF014) ===');
  console.log(`Animal alvo: ${ANIMAL_ID} (${nomeAnimal})`);
  console.log(`Usuários simulados: ${NUM_USUARIOS}`);
  console.log(`Status inicial: ${statusInicial}`);
  console.log('');
  console.log('Resultados:');
  for (const r of resultados) {
    const label = r.status === 200 ? '200 OK ' : String(r.status).padEnd(7, ' ');
    console.log(` - ${r.usuarioId} → ${label} | "${r.motivo}"`);
  }
  console.log('');

  // Ordena pela ORDEM DE CHEGADA NO SERVIDOR (quando o servidor instrumentado
  // devolve ordemChegada). É essa ordem — não a latência — que explica a corrida.
  const temInstrumentacao = resultados.some((r) => r.ordemChegada != null);
  const ordenados = [...resultados].sort((a, b) => {
    if (a.ordemChegada != null && b.ordemChegada != null) return a.ordemChegada - b.ordemChegada;
    return a.respondidoEm - b.respondidoEm;
  });

  console.log('Linha do tempo da corrida (ordenada pela chegada no SERVIDOR):');
  console.log(`  Os ${NUM_USUARIOS} pedidos saíram do cliente "juntos" (Promise.all, t ≈ 0 ms), mas o`);
  console.log('  event loop do Node os envia um a um e o servidor os recebe em sequência.');
  console.log('');
  console.log('  chegada | usuário  | enviou | chegou | resp.  | status | latência | banco');
  console.log('  ' + '-'.repeat(74));
  ordenados.forEach((r, i) => {
    // Posição RELATIVA na corrida (1º, 2º...), não o contador global do servidor.
    const ordem = (r.ordemChegada != null ? `${i + 1}º` : '—').padEnd(7);
    const usuario = r.usuarioId.padEnd(8);
    const enviou = `+${r.enviadoEm}ms`.padEnd(6);
    const chegou = (r.recebidoEm != null ? `+${r.recebidoEm}ms` : '—').padEnd(6);
    const resp = `+${r.respondidoEm}ms`.padEnd(6);
    const label = (r.status === 200 ? '200 OK' : String(r.status)).padEnd(6);
    const lat = `${r.latencia}ms`.padEnd(8);
    const banco = r.dbMs != null ? `${r.dbMs}ms` : '—';
    const marca = r.status === 200 ? ' 🏆 GANHOU' : '';
    console.log(`  ${ordem} | ${usuario} | ${enviou} | ${chegou} | ${resp} | ${label} | ${lat} | ${banco}${marca}`);
  });
  console.log('');

  const vencedor = sucessos.length > 0 ? sucessos[0].usuarioId : '(nenhum)';
  console.log(
    `Sucessos: ${sucessos.length}  |  Conflitos (409): ${conflitos.length}  |  Erros inesperados: ${inesperados.length}`
  );
  console.log(`Status final no banco: ${statusFinal}`);
  console.log(`Tempo total da corrida: ${tempoTotal}ms`);
  console.log('');

  // ---- Explicação: POR QUE esse usuário ganhou (com os dados reais) ----
  if (sucessos.length === 1) {
    const venc = sucessos[0];
    const minLat = Math.min(...resultados.map((r) => r.latencia));
    const donoMinLat = resultados.find((r) => r.latencia === minLat);
    const posChegada = temInstrumentacao
      ? ordenados.findIndex((r) => r === venc) + 1
      : null;

    console.log(`🏁 POR QUE "${venc.usuarioId}" GANHOU (e não foi "só latência"):`);
    if (temInstrumentacao && posChegada === 1) {
      console.log(`   1) Foi o 1º pedido a CHEGAR no servidor (de ${NUM_USUARIOS}). Chegou primeiro na fila.`);
    } else if (temInstrumentacao) {
      console.log(`   1) Chegou ao servidor na ${posChegada}ª posição (de ${NUM_USUARIOS}) — NÃO foi o primeiro a`);
      console.log(`      chegar, mas seu UPDATE pegou a trava de linha antes (a fila do pool reordena).`);
    } else {
      console.log(`   1) Seu UPDATE foi o primeiro a pegar a trava de linha no Postgres.`);
    }
    console.log(`   2) Rodou  UPDATE animais SET status='I' WHERE id=${ANIMAL_ID} AND status='D'  e achou o`);
    console.log(`      pet ainda 'D' → mudou para 'I' e o banco respondeu rowCount=1 (vitória).`);
    console.log(`   3) Os outros ${NUM_USUARIOS - 1} rodaram o MESMO comando, mas o pet já era 'I'. O WHERE não casou,`);
    console.log(`      rowCount=0, e por isso receberam 409 "Animal já foi adotado".`);
    if (venc.usuarioId === donoMinLat.usuarioId) {
      console.log(`   4) Sobre latência: ele por acaso TAMBÉM teve a menor (${minLat}ms) — mas isso é`);
      console.log(`      CONSEQUÊNCIA (não esperou a trava de ninguém), não a causa da vitória.`);
    } else {
      console.log(`   4) Sobre latência: a MENOR latência foi ${minLat}ms, do "${donoMinLat.usuarioId}", que MESMO`);
      console.log(`      ASSIM PERDEU (409). Ou seja: latência não decide quem ganha — a trava de linha decide.`);
    }
    console.log('');
    console.log('   Resumo da causa: event loop do Node → fila do pool de conexões → TRAVA DE LINHA no');
    console.log('   Postgres. Quem a trava atende primeiro no UPDATE é quem vence. O resto é 409.');
    console.log('');
  }

  const violou = sucessos.length >= 2;
  const passou = !violou && (sucessos.length === 1 || statusInicial === 'I');
  let mensagemVeredito;

  if (violou) {
    mensagemVeredito = `❌ Teste FALHOU: ${sucessos.length} usuários adotaram o MESMO animal — race condition, RF014 não foi atendido.`;
  } else if (sucessos.length === 1) {
    mensagemVeredito = '✅ Teste PASSOU: exatamente 1 usuário conseguiu adotar.';
  } else if (statusInicial === 'I') {
    mensagemVeredito = '✅ Teste PASSOU: o animal já estava adotado, então ninguém conseguiu adotar de novo. Para testar a corrida, escolha outro ANIMAL_ID que ainda esteja disponível.';
  } else {
    mensagemVeredito = '❌ Teste FALHOU: ninguém adotou um animal que estava disponível. Provável servidor fora do ar.';
  }
  console.log(mensagemVeredito);

  // ---- Evidência de PARALELISMO (fila + worker) ----
  // A adoção vencedora enfileirou um job em fila_notificacoes e a resposta HTTP
  // voltou na hora; quem processa é o worker (outro processo), em background.
  // Aqui o teste acompanha o job até o worker concluí-lo.
  let filaEvidencia = '—';
  if (sucessos.length === 1 && sucessos[0].jobId != null) {
    const jobId = sucessos[0].jobId;
    console.log('');
    console.log('📨 PARALELISMO (fila + worker):');
    console.log(`   A adoção vencedora enfileirou o job #${jobId} e a resposta HTTP voltou na hora.`);
    console.log('   O processamento acontece em BACKGROUND, no worker (processo separado).');
    // A fila é FIFO: jobs pendentes mais antigos são processados antes do nosso.
    // A janela de espera cresce com o backlog para não acusar o worker à toa.
    const { rows: backlogRows } = await pool.query(
      "SELECT count(*)::int AS n FROM fila_notificacoes WHERE status = 'P' AND id < $1",
      [jobId]
    );
    const backlog = backlogRows[0].n;
    const maxTentativas = 8 + backlog * 4;
    let job = null;
    for (let i = 0; i < maxTentativas; i++) {
      const { rows } = await pool.query(
        `SELECT status, processado_por,
                round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) AS seg
           FROM fila_notificacoes WHERE id = $1`,
        [jobId]
      );
      job = rows[0];
      if (job && job.status === 'C') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (job && job.status === 'C') {
      console.log(`   ✅ Job #${jobId} processado por "${job.processado_por}" ${job.seg}s DEPOIS da adoção —`);
      console.log('      execução independente da requisição principal.');
      filaEvidencia = `job #${jobId} → ${job.processado_por}`;
    } else {
      const naFrente = backlog > 0 ? ` (${backlog} job(s) na frente na fila)` : '';
      console.log(`   ⏳ Job #${jobId} segue pendente${naFrente} — worker ocupado ou fora do ar.`);
      console.log('      Confira a fila: npm run fila   |   suba um worker: npm run worker');
      filaEvidencia = `job #${jobId} pendente`;
    }
  }

  const statsLatencia = estatisticas(resultados.map((r) => r.latencia));

  sessao.salvar({
    nome: 'Teste de adoção concorrente (RF014)',
    descricao: `${NUM_USUARIOS} usuários tentando adotar o animal ${ANIMAL_ID} (${nomeAnimal}) ao mesmo tempo.`,
    inicioISO: new Date(sessao.inicioMs).toISOString(),
    config: { ANIMAL_ID, NUM_USUARIOS, BASE_URL },
    cards: [
      { label: 'Animal alvo', valor: `${ANIMAL_ID} — ${nomeAnimal}`, dica: 'Pet que todos tentaram adotar ao mesmo tempo.' },
      { label: 'Usuários', valor: String(NUM_USUARIOS), dica: 'Quantas pessoas dispararam a adoção em paralelo.' },
      { label: 'Sucessos', valor: String(sucessos.length), sub: 'esperado: 1', dica: 'Deve ser exatamente 1. Mais que isso = bug de concorrência (RF014 violado).' },
      { label: 'Conflitos (409)', valor: String(conflitos.length), dica: 'Quem chegou tarde: o pet já era I. Comportamento correto dos perdedores.' },
      { label: 'Erros', valor: String(inesperados.length), dica: 'Respostas inesperadas (5xx, rede). Deveria ser 0.' },
      { label: 'Tempo total', valor: `${tempoTotal}ms`, dica: 'Do disparo até a última resposta chegar.' },
      { label: 'Latência p50', valor: `${statsLatencia.p50}ms`, dica: 'Mediana: metade das adoções respondeu mais rápido que isso.' },
      { label: 'Latência p95', valor: `${statsLatencia.p95}ms`, dica: '95% das adoções responderam em até esse tempo (interpolação linear).' },
      { label: 'Status final', valor: statusFinal, dica: "Status do pet no banco ao fim: I = adotado (esperado)." },
      { label: 'Vencedor', valor: vencedor, dica: 'Usuário cujo UPDATE pegou a trava de linha primeiro.' },
      { label: 'Fila (background)', valor: filaEvidencia, dica: 'Job de notificação enfileirado pela adoção e processado pelo worker em outro processo (fila + worker).' },
    ],
    veredito: { ok: passou, mensagem: mensagemVeredito },
    estatisticas: { adocao: statsLatencia },
  });

  await sessao.fechar();
  const htmlPath = sessao.gerarHTML();

  console.log('');
  console.log(`📄 Relatório HTML: ${htmlPath}`);
  console.log(`📁 Logs JSONL:     ${sessao.dir}/log.jsonl`);

  await pool.end();
  process.exit(passou ? 0 : 1);
}

main();
