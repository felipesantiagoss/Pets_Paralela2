const pool = require('../src/config/db');
const { criarSessao, estatisticas, throughput } = require('./lib/relatorio');

const PERFIL = (process.env.PERFIL || 'reduzido').toLowerCase();

const PERFIS = {
  reduzido: {
    navegacao: { usuarios: 100, duracaoMs: 6000, requestsPorUsuario: [3, 6] },
    ondasAdocao: [
      { offset: 0, usuarios: 20 },
      { offset: 1, usuarios: 20 },
      { offset: 2, usuarios: 40 },
      { offset: 3, usuarios: 10 },
      { offset: 4, usuarios: 10 },
    ],
  },
  cheio: {
    navegacao: { usuarios: 1000, duracaoMs: 10000, requestsPorUsuario: [3, 7] },
    ondasAdocao: [
      { offset: 0, usuarios: 200 },
      { offset: 1, usuarios: 200 },
      { offset: 2, usuarios: 400 },
      { offset: 3, usuarios: 100 },
      { offset: 4, usuarios: 100 },
    ],
  },
};

const cfg = PERFIS[PERFIL] || PERFIS.reduzido;
const DISPARO_MS = 2000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

const ENDPOINTS_NAV = [
  'GET /api/animais',
  'GET /api/animais?porte=grande',
  'GET /api/animais?idade=filhote',
  'GET /api/animais?localizacao=taguatinga',
  'GET /api/animais?sexo=fêmea',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const escolha = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function selecionarPetsAlvo() {
  const { rows } = await pool.query(
    "SELECT id, nome FROM animais WHERE status = 'D' ORDER BY id LIMIT 5"
  );
  if (rows.length < 5) {
    throw new Error(
      `Preciso de pelo menos 5 animais com status 'D' para o cenário. Encontrei ${rows.length}. Rode: UPDATE animais SET status = 'D' WHERE id IN (1,2,3,4,5);`
    );
  }
  return rows;
}

async function navegacaoUsuario(idUsuario, idsExistentes, sessao, contador, deadlineMs) {
  const total = rand(cfg.navegacao.requestsPorUsuario[0], cfg.navegacao.requestsPorUsuario[1]);
  for (let i = 0; i < total; i++) {
    if (Date.now() - sessao.inicioMs > deadlineMs) return;

    let url;
    const ep = escolha(ENDPOINTS_NAV.concat(['GET /api/animais/:id']));
    if (ep === 'GET /api/animais/:id') {
      url = `${BASE_URL}/api/animais/${escolha(idsExistentes)}`;
    } else {
      url = BASE_URL + ep.replace('GET ', '');
    }

    const enviadoEm = Date.now() - sessao.inicioMs;
    contador.emVoo++;
    contador.navTotal++;
    try {
      const res = await fetch(url);
      await res.text();
      const respondidoEm = Date.now() - sessao.inicioMs;
      sessao.log({
        tipo: 'request',
        acao: 'navegar',
        usuarioId: idUsuario,
        enviadoEm,
        respondidoEm,
        latencia: respondidoEm - enviadoEm,
        status: res.status,
        url,
        motivo: '',
      });
      if (res.status >= 200 && res.status < 400) contador.navOK++;
      else contador.navFail++;
    } catch (err) {
      const respondidoEm = Date.now() - sessao.inicioMs;
      sessao.log({
        tipo: 'request',
        acao: 'navegar',
        usuarioId: idUsuario,
        enviadoEm,
        respondidoEm,
        latencia: respondidoEm - enviadoEm,
        status: 0,
        url,
        motivo: `Erro de rede: ${err.message}`,
      });
      contador.navFail++;
    } finally {
      contador.emVoo--;
    }

    await sleep(rand(50, 250));
  }
}

async function adotarOnda(petId, petNome, usuariosIds, sessao, contador) {
  const promessas = usuariosIds.map(async (usuarioId) => {
    const enviadoEm = Date.now() - sessao.inicioMs;
    contador.emVoo++;
    contador.adTotal++;
    try {
      const res = await fetch(`${BASE_URL}/api/animais/${petId}/adotar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuarioId }),
      });
      const corpo = await res.json().catch(() => ({}));
      const respondidoEm = Date.now() - sessao.inicioMs;
      sessao.log({
        tipo: 'request',
        acao: 'adotar',
        usuarioId,
        petId,
        nome: corpo.nome || petNome,
        enviadoEm,
        respondidoEm,
        latencia: respondidoEm - enviadoEm,
        status: res.status,
        motivo: corpo.mensagem || corpo.motivo || '',
        // Instrumentação do servidor (explica a corrida): ordem de chegada,
        // instante de recebimento (convertido para o referencial relativo) e
        // tempo gasto no banco.
        recebidoEm: corpo.recebidoEm != null ? corpo.recebidoEm - sessao.inicioMs : null,
        ordemChegada: corpo.ordemChegada != null ? corpo.ordemChegada : null,
        dbMs: corpo.dbMs != null ? corpo.dbMs : null,
        // Job de notificação enfileirado pela adoção vencedora (fila + worker).
        jobId: corpo.jobId != null ? corpo.jobId : null,
      });
      if (res.status === 200) contador.adSucesso++;
      else if (res.status === 409) contador.adConflito++;
      else contador.adErro++;
    } catch (err) {
      const respondidoEm = Date.now() - sessao.inicioMs;
      sessao.log({
        tipo: 'request',
        acao: 'adotar',
        usuarioId,
        petId,
        enviadoEm,
        respondidoEm,
        latencia: respondidoEm - enviadoEm,
        status: 0,
        motivo: `Erro de rede: ${err.message}`,
      });
      contador.adErro++;
    } finally {
      contador.emVoo--;
    }
  });

  await Promise.all(promessas);
}

async function checarUlimit(totalRequests) {
  try {
    const { execSync } = require('child_process');
    const limite = parseInt(execSync('ulimit -n', { shell: '/bin/sh' }).toString().trim(), 10);
    if (limite && limite < totalRequests + 100) {
      console.log('');
      console.log(`⚠️  AVISO: ulimit -n = ${limite}, mas o teste pode abrir até ~${totalRequests} conexões simultâneas.`);
      console.log(`   Pra evitar "EMFILE: too many open files" rode antes:`);
      console.log(`   ulimit -n 4096 && PERFIL=${PERFIL} npm run stress:cenario`);
      console.log('');
      console.log('Continuando assim mesmo em 3s. Ctrl+C pra abortar.');
      await sleep(3000);
    }
  } catch {}
}

async function checarServidor() {
  try {
    const res = await fetch(`${BASE_URL}/api/animais`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(`❌ Servidor não respondeu em ${BASE_URL}. Suba ele antes: cd backend && npm start`);
    console.error(`   Erro: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  await checarServidor();

  let pets;
  try {
    pets = await selecionarPetsAlvo();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  await pool.query(
    `UPDATE animais SET status = 'D' WHERE id = ANY($1::int[])`,
    [pets.map((p) => p.id)]
  );

  const ondas = cfg.ondasAdocao.map((o, i) => ({
    petId: pets[o.offset].id,
    petNome: pets[o.offset].nome,
    usuariosIds: Array.from({ length: o.usuarios }, (_, k) => `ad-pet${pets[o.offset].id}-u${k + 1}`),
  }));

  const totalAdocao = ondas.reduce((s, o) => s + o.usuariosIds.length, 0);
  const totalNavEstimado = cfg.navegacao.usuarios * Math.ceil((cfg.navegacao.requestsPorUsuario[0] + cfg.navegacao.requestsPorUsuario[1]) / 2);
  const totalEstimado = totalAdocao + totalNavEstimado;

  console.log('=== PLANO DO TESTE DE CENÁRIO ===');
  console.log(`Perfil: ${PERFIL}`);
  console.log(`Navegação: ${cfg.navegacao.usuarios} usuários por ${cfg.navegacao.duracaoMs}ms (≈ ${totalNavEstimado} GETs)`);
  console.log('Adoção:');
  for (const o of ondas) {
    console.log(`  - pet ${o.petId} (${o.petNome}): ${o.usuariosIds.length} usuários disparam em t=${DISPARO_MS}ms`);
  }
  console.log(`Total adoção: ${totalAdocao} requests`);
  console.log(`Total estimado: ≈ ${totalEstimado} requests`);
  console.log(`Pool PG max: ${pool.options.max}`);
  console.log('');

  await checarUlimit(totalEstimado);

  const sessao = criarSessao('stress-cenario');
  const contador = {
    emVoo: 0, navTotal: 0, navOK: 0, navFail: 0,
    adTotal: 0, adSucesso: 0, adConflito: 0, adErro: 0,
  };

  const idsExistentes = pets.map((p) => p.id);

  console.log('🚀 Disparando navegação...');
  const promessasNav = Array.from({ length: cfg.navegacao.usuarios }, (_, i) =>
    navegacaoUsuario(`nav-u${i + 1}`, idsExistentes, sessao, contador, cfg.navegacao.duracaoMs)
  );

  const interval = setInterval(() => {
    const t = Date.now() - sessao.inicioMs;
    process.stdout.write(
      `\r[+${t}ms] navegação: ${contador.navTotal} reqs (${contador.emVoo} em voo) | adoção: ${contador.adTotal}/${totalAdocao} | sucessos: ${contador.adSucesso} | erros: ${contador.adErro}   `
    );
  }, 400);

  setTimeout(() => {
    console.log(`\n💥 t=${DISPARO_MS}ms: disparando ${ondas.length} ondas de adoção em paralelo...`);
  }, DISPARO_MS);

  const promessaAdocao = sleep(DISPARO_MS).then(() =>
    Promise.all(ondas.map((o) => adotarOnda(o.petId, o.petNome, o.usuariosIds, sessao, contador)))
  );

  await Promise.all([...promessasNav, promessaAdocao]);
  clearInterval(interval);
  process.stdout.write('\n');

  const { rows: finalRows } = await pool.query(
    `SELECT id, nome, status FROM animais WHERE id = ANY($1::int[]) ORDER BY id`,
    [idsExistentes]
  );

  console.log('');
  console.log('=== RESULTADOS POR PET ===');

  const linhas = [];
  for (const onda of ondas) {
    const final = finalRows.find((r) => r.id === onda.petId);
    const eventosPet = await lerEventosLog(sessao.dir, 'adotar', onda.petId);
    const vencedor = eventosPet.find((e) => e.status === 200);
    const lat = estatisticas(eventosPet.map((e) => e.latencia));
    linhas.push({
      petId: onda.petId,
      nome: onda.petNome,
      tentativas: eventosPet.length,
      vencedor: vencedor ? vencedor.usuarioId : '(nenhum)',
      latVencedor: vencedor ? `${vencedor.latencia}ms` : '-',
      latP50: `${lat.p50}ms`,
      latP95: `${lat.p95}ms`,
      latMax: `${lat.max}ms`,
      statusFinal: final.status,
    });
  }

  console.log(
    'pet | nome'.padEnd(28) +
      ' | tent | vencedor'.padEnd(24) +
      ' | lat venc'.padEnd(11) +
      ' | p50    | p95    | max    | final'
  );
  console.log('-'.repeat(110));
  for (const l of linhas) {
    console.log(
      `${String(l.petId).padEnd(3)} | ${l.nome.padEnd(20)} | ${String(l.tentativas).padEnd(4)} | ${l.vencedor.padEnd(20)} | ${l.latVencedor.padEnd(8)} | ${l.latP50.padEnd(6)} | ${l.latP95.padEnd(6)} | ${l.latMax.padEnd(6)} | ${l.statusFinal}`
    );
  }

  const navEventos = await lerEventosLog(sessao.dir, 'navegar');
  const adEventos = await lerEventosLog(sessao.dir, 'adotar');
  const statsNav = estatisticas(navEventos.map((e) => e.latencia));
  const tpNav = throughput(navEventos);
  console.log('');
  console.log('=== NAVEGAÇÃO (carga de fundo: gente só olhando a lista) ===');
  console.log(`Total: ${contador.navTotal}  |  OK: ${contador.navOK}  |  Falhas: ${contador.navFail}`);
  console.log(`Latência (ms): min=${statsNav.min}  p50=${statsNav.p50}  p95=${statsNav.p95}  p99=${statsNav.p99}  max=${statsNav.max}`);
  console.log('  (p50 = mediana; p95 = 95% responderam até esse valor; p99 = quase pior caso.)');
  // Throughput pela JANELA REAL (1º envio → última resposta), não pela duração
  // nominal. Os usuários terminam bem antes do prazo, então dividir pelo prazo
  // cheio daria um número artificialmente baixo.
  console.log(
    `Throughput: ${tpNav.reqPorSeg} req/s  (${tpNav.reqs} requisições ÷ ${tpNav.janelaSeg}s de janela real)`
  );
  console.log(
    `  Obs.: a janela real (${tpNav.janelaSeg}s) é menor que o prazo configurado (${(cfg.navegacao.duracaoMs / 1000).toFixed(0)}s) porque`
  );
  console.log('  cada usuário faz só 3–6 GETs e termina cedo. Por isso o divisor é a janela medida, não o prazo.');

  console.log('');
  console.log('=== ADOÇÃO (a corrida do RF014: 1 pet, vários tentando) ===');
  console.log(
    `Total: ${contador.adTotal}  |  Sucessos: ${contador.adSucesso}  |  Conflitos (409): ${contador.adConflito}  |  Erros: ${contador.adErro}`
  );
  console.log('  Sucesso = pegou a trava de linha primeiro.  409 = chegou e o pet já era I.');

  const sucessosEsperados = ondas.length;
  const passouRF014 = contador.adSucesso === sucessosEsperados;
  let mensagemVer;
  if (passouRF014) {
    mensagemVer = `✅ RF014 atendido: exatamente ${sucessosEsperados} sucessos (um por pet). Concorrência sob controle.`;
  } else if (contador.adSucesso > sucessosEsperados) {
    mensagemVer = `❌ RF014 violado: ${contador.adSucesso} sucessos quando o esperado eram ${sucessosEsperados}. Algum pet foi adotado mais de uma vez.`;
  } else {
    mensagemVer = `❌ Resultado parcial: ${contador.adSucesso}/${sucessosEsperados} pets foram adotados. ${contador.adErro} erros sugerem que o servidor caiu ou o ulimit estourou.`;
  }
  console.log(mensagemVer);

  // Estatísticas de latência das requisições de adoção.
  const statsAd = estatisticas(adEventos.map((e) => e.latencia));
  const tpAd = throughput(adEventos);

  // ---- Explicação por pet: por que aquele usuário ganhou a corrida ----
  console.log('');
  console.log('=== POR QUE CADA PET TEVE 1 VENCEDOR (a causa, não só "latência") ===');
  for (const onda of ondas) {
    const reqsPet = adEventos.filter((e) => e.petId === onda.petId);
    const venc = reqsPet.find((e) => e.status === 200);
    if (!venc) {
      console.log(`• pet ${onda.petId} (${onda.petNome}): nenhum vencedor (verifique o status inicial / erros).`);
      continue;
    }
    const temInstr = reqsPet.some((e) => e.ordemChegada != null);
    const ordenados = [...reqsPet].sort((a, b) =>
      a.ordemChegada != null && b.ordemChegada != null
        ? a.ordemChegada - b.ordemChegada
        : (a.recebidoEm ?? a.enviadoEm) - (b.recebidoEm ?? b.enviadoEm)
    );
    const pos = temInstr ? ordenados.findIndex((e) => e === venc) + 1 : null;
    const minLat = Math.min(...reqsPet.map((e) => e.latencia));
    const donoMin = reqsPet.find((e) => e.latencia === minLat);
    const chegada = temInstr
      ? pos === 1
        ? 'chegou em 1º no servidor'
        : `chegou em ${pos}º no servidor (mas pegou a trava de linha antes dos que chegaram antes)`
      : 'pegou a trava de linha primeiro';
    const sobreLat =
      venc.usuarioId === donoMin.usuarioId
        ? `teve a menor latência (${minLat}ms) por consequência, não por causa`
        : `NÃO teve a menor latência — a menor (${minLat}ms) foi de "${donoMin.usuarioId}", que perdeu (409)`;
    console.log(
      `• pet ${onda.petId} (${onda.petNome}): venceu "${venc.usuarioId}" — ${chegada}; ${sobreLat}.`
    );
  }
  console.log('  Causa em 1 frase: o 1º UPDATE a pegar a TRAVA DE LINHA no Postgres vence; os demais viram 409.');

  // ---- Evidência de PARALELISMO (fila + worker) ----
  // Cada adoção vencedora enfileirou um job de notificação; o worker (processo
  // separado) consome a fila em background. Com 2+ workers de pé, os jobs saem
  // distribuídos entre eles sem duplicar (FOR UPDATE SKIP LOCKED).
  const jobsIds = adEventos.filter((e) => e.status === 200 && e.jobId != null).map((e) => e.jobId);
  let filaResumo = 'sem jobs';
  if (jobsIds.length > 0) {
    console.log('');
    console.log('=== PARALELISMO (fila + worker): notificações em background ===');
    console.log(`As ${jobsIds.length} adoções vencedoras enfileiraram jobs; as respostas HTTP já voltaram.`);
    // A fila é FIFO: jobs pendentes mais antigos saem antes dos desta rodada.
    // A janela de espera cresce com o backlog para não acusar o worker à toa.
    const { rows: backlogRows } = await pool.query(
      "SELECT count(*)::int AS n FROM fila_notificacoes WHERE status = 'P' AND id < $1",
      [Math.min(...jobsIds)]
    );
    const backlog = backlogRows[0].n;
    const maxIter = 24 + backlog * 4;
    const iterSemProgresso = 6 + backlog * 3;
    let jobsRows = [];
    for (let i = 0; i < maxIter; i++) {
      ({ rows: jobsRows } = await pool.query(
        `SELECT id, payload->>'nome' AS pet, status, processado_por,
                round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) AS seg
           FROM fila_notificacoes WHERE id = ANY($1::int[]) ORDER BY id`,
        [jobsIds]
      ));
      const concluidos = jobsRows.filter((r) => r.status === 'C').length;
      process.stdout.write(`\r  aguardando workers: ${concluidos}/${jobsIds.length} jobs concluídos...   `);
      if (concluidos === jobsIds.length) break;
      // Sem nenhum job desta rodada concluído após a tolerância, não deve haver worker de pé.
      if (i >= iterSemProgresso && concluidos === 0) break;
      await sleep(500);
    }
    process.stdout.write('\n');
    for (const r of jobsRows) {
      const quem =
        r.status === 'C'
          ? `processado por "${r.processado_por}" ${r.seg}s após a adoção`
          : 'PENDENTE — worker ocupado ou fora do ar (confira: npm run fila | suba: npm run worker)';
      console.log(`  • job #${r.id} (${r.pet}): ${quem}`);
    }
    const concluidos = jobsRows.filter((r) => r.status === 'C').length;
    const workers = [...new Set(jobsRows.filter((r) => r.processado_por).map((r) => r.processado_por))];
    filaResumo = `${concluidos}/${jobsIds.length} jobs por ${workers.length} worker(s)`;
    if (workers.length > 1) {
      console.log(`  ⚡ Jobs distribuídos entre ${workers.length} workers em PARALELO (${workers.join(', ')}),`);
      console.log('     nenhum job duplicado — é o FOR UPDATE SKIP LOCKED entregando cada job a um único worker.');
    }
  }

  sessao.salvar({
    nome: `Teste de cenário — perfil ${PERFIL}`,
    descricao: `${cfg.navegacao.usuarios} usuários navegando + ${ondas.length} ondas de adoção paralelas (${totalAdocao} adotantes).`,
    inicioISO: new Date(sessao.inicioMs).toISOString(),
    config: { PERFIL, BASE_URL, navegacao: cfg.navegacao, ondas: ondas.map((o) => ({ petId: o.petId, usuarios: o.usuariosIds.length })) },
    cards: [
      { label: 'Perfil', valor: PERFIL, dica: 'reduzido (~550 reqs) ou cheio (~6000 reqs).' },
      { label: 'Usuários navegando', valor: String(cfg.navegacao.usuarios), dica: 'Carga de fundo: pessoas só consultando a lista de animais.' },
      { label: 'Usuários adotando', valor: String(totalAdocao), dica: 'Total de tentativas de adoção somando as 5 ondas.' },
      { label: 'Adoção sucesso', valor: String(contador.adSucesso), sub: `esperado: ${sucessosEsperados}`, dica: 'Deve ser 1 por pet. Mais que o esperado = RF014 violado.' },
      { label: 'Adoção 409', valor: String(contador.adConflito), dica: 'Perdedores corretos: chegaram quando o pet já era I.' },
      { label: 'Adoção erros', valor: String(contador.adErro), dica: 'Erros de servidor/rede. Deveria ser 0.' },
      { label: 'Adoção throughput', valor: `${tpAd.reqPorSeg} req/s`, sub: `${tpAd.janelaSeg}s de janela`, dica: 'Vazão da adoção medida na janela real (1º envio → última resposta).' },
      { label: 'Navegação total', valor: String(contador.navTotal), dica: 'Quantos GETs a carga de fundo fez no total.' },
      { label: 'Nav throughput', valor: `${tpNav.reqPorSeg} req/s`, sub: `${tpNav.janelaSeg}s de janela`, dica: 'Vazão da navegação na janela real — não na duração nominal.' },
      { label: 'Nav p50', valor: `${statsNav.p50}ms`, dica: 'Mediana da latência de navegação.' },
      { label: 'Nav p95', valor: `${statsNav.p95}ms`, dica: '95% das navegações responderam em até esse tempo.' },
      { label: 'Nav p99', valor: `${statsNav.p99}ms`, dica: 'Quase pior caso da navegação.' },
      { label: 'PG pool max', valor: String(pool.options.max), dica: 'Conexões simultâneas no Postgres. Acima disso, os pedidos fazem fila.' },
      { label: 'Fila (background)', valor: filaResumo, dica: 'Jobs de notificação enfileirados pelas adoções e processados pelo(s) worker(s) em processo separado (fila + worker).' },
    ],
    veredito: { ok: passouRF014, mensagem: mensagemVer },
    estatisticas: { navegacao: statsNav, adocao: statsAd },
    throughput: { navegacao: tpNav, adocao: tpAd },
    porPet: linhas,
  });

  await sessao.fechar();
  const htmlPath = sessao.gerarHTML();

  console.log('');
  console.log(`📄 Relatório HTML: ${htmlPath}`);
  console.log(`📁 Logs JSONL:     ${sessao.dir}/log.jsonl`);
  console.log(`📁 Summary JSON:   ${sessao.dir}/summary.json`);
  console.log('');
  console.log(`Pra abrir o relatório no Mac:  open "${htmlPath}"`);

  await pool.end();
  process.exit(passouRF014 ? 0 : 1);
}

async function lerEventosLog(dir, acao, petId) {
  const fs = require('fs');
  const path = require('path');
  const linhas = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf-8').trim().split('\n').filter(Boolean);
  return linhas
    .map((l) => JSON.parse(l))
    .filter((e) => e.tipo === 'request' && e.acao === acao && (petId == null || e.petId === petId));
}

main();
