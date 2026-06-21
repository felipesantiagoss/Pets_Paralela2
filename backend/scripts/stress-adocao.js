const pool = require('../src/config/db'); // Importa o pool de conexões com o banco PostgreSQL (configurado em src/config/db)
const { criarSessao, estatisticas, throughput } = require('./lib/relatorio'); // Importa funções auxiliares: criar sessão, calcular estatísticas e calcular o throughput (vazão)

// Garante a tabela e ZERA antes de disparar, para a corrida_trava refletir SÓ esta
// execução. Durante as requisições, o servidor (controller adotar) grava 1 linha por
// usuário — vencedor e perdedores — com o horário REAL em que cada um pegou a trava.
// Por isso o SELECT depois mostra exatamente os usuários desta última execução.
async function prepararCorridaTrava() { // Função que cria (se não existir) e zera a tabela corrida_trava antes do teste
  // Cria a tabela corrida_trava caso ela ainda não exista, com colunas para registrar cada disputa pela trava
  await pool.query(`CREATE TABLE IF NOT EXISTS corrida_trava (
    id SERIAL PRIMARY KEY,
    animal_id INT,
    usuario TEXT,
    travou_em TIMESTAMPTZ,
    encontrou CHAR(1),
    venceu BOOLEAN,
    registrado_em TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query('TRUNCATE corrida_trava RESTART IDENTITY'); // Esvazia a tabela e reinicia o contador de id, para guardar só esta execução
}

// Lê corrida_trava com o MESMO SELECT que você roda no pgAdmin/psql e imprime aqui,
// para o console BATER com o banco: mesmos usuários, mesmos horários, mesmo vencedor.
async function mostrarCorridaTrava() { // Função que lê a tabela corrida_trava e imprime os dados no console
  // Consulta os registros da corrida, formatando o horário da trava com microssegundos e ordenando pelo instante da trava
  const { rows } = await pool.query(
    `SELECT usuario,
            to_char(travou_em, 'HH24:MI:SS.US') AS pegou_a_trava,
            encontrou, venceu
       FROM corrida_trava
      ORDER BY travou_em`
  );
  console.log('🗄️  TABELA corrida_trava (última execução) — confere com o banco:'); // Cabeçalho explicando que a tabela bate com o banco
  console.log("     SELECT usuario, to_char(travou_em,'HH24:MI:SS.US') AS pegou_a_trava,"); // Mostra o SELECT equivalente (parte 1)
  console.log('            encontrou, venceu FROM corrida_trava ORDER BY travou_em;'); // Mostra o SELECT equivalente (parte 2)
  console.log(''); // Linha em branco para espaçamento
  if (rows.length === 0) { // Se não há linhas, o servidor não gravou nada nesta execução
    console.log('   (vazia) — o servidor não gravou nada nesta execução.'); // Avisa que a tabela está vazia
    console.log('   Reinicie o servidor com o código atualizado (npm start / npm run dev) e rode de novo.'); // Sugere reiniciar o servidor
    console.log(''); // Linha em branco
    return; // Encerra a função, pois não há nada a exibir
  }
  console.log('   usuário  | pegou_a_trava    | encontrou | venceu'); // Cabeçalho das colunas da tabela
  console.log('   ' + '-'.repeat(46)); // Linha separadora com 46 traços
  for (const r of rows) { // Percorre cada linha retornada da tabela
    const venceu = r.venceu ? 'true 🏆' : 'false'; // Formata o campo "venceu" mostrando troféu se for o vencedor
    // Imprime a linha alinhando cada coluna com padEnd para deixar a tabela legível
    console.log(
      `   ${String(r.usuario).padEnd(8)} | ${String(r.pegou_a_trava).padEnd(16)} | ${('  ' + r.encontrou).padEnd(9)} | ${venceu}`
    );
  }
  console.log(''); // Linha em branco
  console.log(`   → ${rows.length} usuário(s) gravados nesta execução (esperado: ${NUM_USUARIOS}).`); // Mostra quantos usuários foram gravados vs. esperado
  console.log(''); // Linha em branco
}

// Sem ANIMAL_ID na env, o teste escolhe sozinho o primeiro animal disponível
// (status 'D') — evita disparar a corrida contra um animal já adotado.
let ANIMAL_ID = process.env.ANIMAL_ID ? parseInt(process.env.ANIMAL_ID, 10) : null; // Lê o id do animal da variável de ambiente; se não houver, fica null (escolhe depois)
const NUM_USUARIOS = parseInt(process.env.NUM_USUARIOS || '3', 10); // Lê quantos usuários simular (padrão 3) da variável de ambiente
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'; // Lê a URL base da API (padrão localhost:3001) da variável de ambiente

async function adotar(usuarioId, sessao) { // Função que faz UM usuário tentar adotar o animal via requisição HTTP
  const enviadoEm = Date.now() - sessao.inicioMs; // Marca o instante (em ms desde o início da sessão) em que a requisição foi enviada
  try {
    // Envia uma requisição POST para o endpoint de adoção do animal na API
    const res = await fetch(`${BASE_URL}/api/animais/${ANIMAL_ID}/adotar`, {
      method: 'POST', // Método HTTP POST (cria/altera o estado da adoção)
      headers: { 'Content-Type': 'application/json' }, // Informa que o corpo da requisição é JSON
      body: JSON.stringify({ usuarioId }), // Envia o id do usuário no corpo, em formato JSON
    });
    const corpo = await res.json().catch(() => ({})); // Tenta converter a resposta em JSON; se falhar, usa objeto vazio
    const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante em que a resposta chegou (em ms desde o início)
    const ev = { // Monta o objeto de evento com todos os dados desta requisição
      tipo: 'request', // Tipo do evento: requisição
      acao: 'adotar', // Ação realizada: adotar
      usuarioId, // Id do usuário que fez a tentativa
      petId: ANIMAL_ID, // Id do animal alvo
      nome: corpo.nome, // Nome do animal (vindo da resposta, se houver)
      enviadoEm, // Momento do envio (ms relativos)
      respondidoEm, // Momento da resposta (ms relativos)
      latencia: respondidoEm - enviadoEm, // Latência: tempo total entre enviar e receber a resposta
      status: res.status, // Código de status HTTP retornado (200, 409, etc.)
      motivo: corpo.mensagem || corpo.motivo || '', // Mensagem/motivo retornado pelo servidor (ou string vazia)
      // Campos vindos do servidor (instrumentação que explica a corrida):
      // recebidoEm vem como epoch absoluto; convertemos para o mesmo referencial
      // relativo (ms desde o disparo) usado em enviadoEm/respondidoEm.
      recebidoEm: corpo.recebidoEm != null ? corpo.recebidoEm - sessao.inicioMs : null, // Instante em que o servidor recebeu o pedido, convertido para ms relativos
      ordemChegada: corpo.ordemChegada != null ? corpo.ordemChegada : null, // Ordem em que o servidor recebeu este pedido (1º, 2º...)
      dbMs: corpo.dbMs != null ? corpo.dbMs : null, // Tempo gasto pelo servidor na operação de banco (ms)
      // Job de notificação enfileirado pela adoção vencedora (fila + worker).
      jobId: corpo.jobId != null ? corpo.jobId : null, // Id do job de notificação enfileirado (só a adoção vencedora gera)
    };
    sessao.log(ev); // Registra o evento no arquivo de log da sessão
    return ev; // Retorna o evento para ser usado na análise final
  } catch (err) { // Captura erros de rede (servidor fora do ar, conexão recusada, etc.)
    const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante do erro (em ms relativos)
    const ev = { // Monta um evento representando a falha de rede
      tipo: 'request', // Tipo do evento: requisição
      acao: 'adotar', // Ação: adotar
      usuarioId, // Id do usuário
      petId: ANIMAL_ID, // Id do animal alvo
      enviadoEm, // Momento do envio
      respondidoEm, // Momento em que o erro ocorreu
      latencia: respondidoEm - enviadoEm, // Latência até o erro
      status: 0, // Status 0 indica que não houve resposta HTTP (erro de rede)
      motivo: `Erro de rede: ${err.message}`, // Mensagem descrevendo o erro de rede
    };
    sessao.log(ev); // Registra o evento de erro no log
    return ev; // Retorna o evento de erro
  }
}

async function main() { // Função principal que orquestra todo o teste de estresse
  const sessao = criarSessao('stress-adocao'); // Cria uma sessão de relatório identificada como 'stress-adocao'

  let statusInicial; // Guardará o status do animal antes do teste
  let nomeAnimal; // Guardará o nome do animal alvo
  try {
    if (ANIMAL_ID == null) { // Se nenhum ANIMAL_ID foi informado, escolhe um automaticamente
      // Busca o primeiro animal disponível (status 'D'), ordenado por id
      const { rows: disponiveis } = await pool.query(
        "SELECT id FROM animais WHERE status = 'D' ORDER BY id LIMIT 1"
      );
      if (disponiveis.length === 0) { // Se não há nenhum animal disponível
        // Exibe erro orientando como reativar animais no banco
        console.error(
          "Nenhum animal disponível (status 'D'). Reative alguns: UPDATE animais SET status='D' WHERE id IN (1,2,3,4,5);"
        );
        await sessao.fechar(); // Fecha a sessão de relatório
        await pool.end(); // Encerra a conexão com o banco
        process.exit(1); // Sai do programa com código de erro 1
      }
      ANIMAL_ID = disponiveis[0].id; // Usa o id do primeiro animal disponível encontrado
      console.log(`ANIMAL_ID não informado — usando o primeiro disponível: ${ANIMAL_ID}`); // Informa qual animal foi escolhido
    }

    const { rows } = await pool.query('SELECT nome, status FROM animais WHERE id = $1', [ANIMAL_ID]); // Busca nome e status do animal alvo
    if (rows.length === 0) { // Se o animal informado não existe no banco
      console.error(`Animal id=${ANIMAL_ID} não existe no banco. Abortando.`); // Exibe erro
      await sessao.fechar(); // Fecha a sessão
      await pool.end(); // Encerra a conexão
      process.exit(1); // Sai com código de erro
    }
    nomeAnimal = rows[0].nome; // Armazena o nome do animal
    statusInicial = rows[0].status; // Armazena o status inicial do animal
  } catch (err) { // Captura erros de conexão/consulta ao banco
    console.error(`Erro ao conectar/preparar o banco: ${err.message}`); // Exibe a mensagem de erro
    await sessao.fechar(); // Fecha a sessão
    await pool.end(); // Encerra a conexão
    process.exit(1); // Sai com código de erro
  }

  const ids = Array.from({ length: NUM_USUARIOS }, (_, i) => `user-${i + 1}`); // Gera um array de ids de usuários: user-1, user-2, ...

  // Zera a corrida_trava ANTES de disparar: assim ela guarda só esta execução.
  await prepararCorridaTrava(); // Prepara (cria e zera) a tabela corrida_trava

  const inicio = Date.now(); // Marca o instante de início da corrida
  const resultados = await Promise.all(ids.map((u) => adotar(u, sessao))); // Dispara TODAS as adoções ao mesmo tempo e espera todas terminarem
  const tempoTotal = Date.now() - inicio; // Calcula o tempo total da corrida (do disparo à última resposta)

  const { rows: finalRows } = await pool.query('SELECT status FROM animais WHERE id = $1', [ANIMAL_ID]); // Consulta o status final do animal após o teste
  const statusFinal = finalRows[0] ? finalRows[0].status : '?'; // Define o status final (ou '?' se não encontrar)

  const sucessos = resultados.filter((r) => r.status === 200); // Filtra as requisições bem-sucedidas (status 200)
  const conflitos = resultados.filter((r) => r.status === 409); // Filtra os conflitos (status 409 = animal já adotado)
  const inesperados = resultados.filter((r) => r.status !== 200 && r.status !== 409); // Filtra respostas inesperadas (nem 200 nem 409)

  console.log('=== TESTE DE ESTRESSE - ADOÇÃO CONCORRENTE (RF014) ==='); // Título do relatório no console
  console.log(`Animal alvo: ${ANIMAL_ID} (${nomeAnimal})`); // Mostra o id e nome do animal alvo
  console.log(`Usuários simulados: ${NUM_USUARIOS}`); // Mostra quantos usuários foram simulados
  console.log(`Status inicial: ${statusInicial}`); // Mostra o status do animal antes do teste
  console.log(''); // Linha em branco
  console.log('Resultados:'); // Cabeçalho da lista de resultados
  for (const r of resultados) { // Percorre cada resultado de requisição
    const label = r.status === 200 ? '200 OK ' : String(r.status).padEnd(7, ' '); // Formata o status (200 OK ou outro código alinhado)
    console.log(` - ${r.usuarioId} → ${label} | "${r.motivo}"`); // Imprime usuário, status e motivo
  }
  console.log(''); // Linha em branco

  // Ordena pela ORDEM DE CHEGADA NO SERVIDOR (quando o servidor instrumentado
  // devolve ordemChegada). É essa ordem — não a latência — que explica a corrida.
  const temInstrumentacao = resultados.some((r) => r.ordemChegada != null); // Verifica se o servidor devolveu a ordem de chegada (instrumentação)
  const ordenados = [...resultados].sort((a, b) => { // Cria uma cópia dos resultados ordenada
    if (a.ordemChegada != null && b.ordemChegada != null) return a.ordemChegada - b.ordemChegada; // Ordena pela ordem de chegada no servidor, se disponível
    return a.respondidoEm - b.respondidoEm; // Caso contrário, ordena pelo momento da resposta
  });

  console.log('Linha do tempo da corrida (ordenada pela chegada no SERVIDOR):'); // Cabeçalho da linha do tempo
  console.log(`  Os ${NUM_USUARIOS} pedidos saíram do cliente "juntos" (Promise.all, t ≈ 0 ms), mas o`); // Explica que os pedidos saíram juntos
  console.log('  event loop do Node os envia um a um e o servidor os recebe em sequência.'); // Explica que o Node os envia em sequência
  console.log(''); // Linha em branco
  console.log('  chegada | usuário  | enviou | chegou | resp.  | status | latência | banco'); // Cabeçalho das colunas
  console.log('  ' + '-'.repeat(74)); // Linha separadora com 74 traços
  ordenados.forEach((r, i) => { // Percorre os resultados já ordenados, com o índice i
    // Posição RELATIVA na corrida (1º, 2º...), não o contador global do servidor.
    const ordem = (r.ordemChegada != null ? `${i + 1}º` : '—').padEnd(7); // Posição na corrida (ou '—' se sem instrumentação), alinhada
    const usuario = r.usuarioId.padEnd(8); // Id do usuário alinhado em 8 caracteres
    const enviou = `+${r.enviadoEm}ms`.padEnd(6); // Momento de envio formatado e alinhado
    const chegou = (r.recebidoEm != null ? `+${r.recebidoEm}ms` : '—').padEnd(6); // Momento de chegada ao servidor (ou '—'), alinhado
    const resp = `+${r.respondidoEm}ms`.padEnd(6); // Momento da resposta formatado e alinhado
    const label = (r.status === 200 ? '200 OK' : String(r.status)).padEnd(6); // Status formatado e alinhado
    const lat = `${r.latencia}ms`.padEnd(8); // Latência formatada e alinhada
    const banco = r.dbMs != null ? `${r.dbMs}ms` : '—'; // Tempo de banco (ou '—' se ausente)
    const marca = r.status === 200 ? ' 🏆 GANHOU' : ''; // Marca de vencedor para quem teve sucesso
    console.log(`  ${ordem} | ${usuario} | ${enviou} | ${chegou} | ${resp} | ${label} | ${lat} | ${banco}${marca}`); // Imprime a linha da tabela
  });
  console.log(''); // Linha em branco

  const vencedor = sucessos.length > 0 ? sucessos[0].usuarioId : '(nenhum)'; // Define o vencedor (primeiro sucesso) ou '(nenhum)'
  // Resumo numérico: quantidade de sucessos, conflitos e erros inesperados
  console.log(
    `Sucessos: ${sucessos.length}  |  Conflitos (409): ${conflitos.length}  |  Erros inesperados: ${inesperados.length}`
  );
  console.log(`Status final no banco: ${statusFinal}`); // Mostra o status final do animal no banco
  console.log(`Tempo total da corrida: ${tempoTotal}ms`); // Mostra o tempo total da corrida
  console.log(''); // Linha em branco

  // ---- Throughput (vazão): requisições por segundo na janela real ----
  // Janela real = do 1º pedido enviado até a última resposta recebida (não é o
  // tempo configurado). Vazão = total de requisições ÷ janela. Reusa a mesma
  // função que monta a seção de throughput do relatório HTML, pra bater igual.
  const tp = throughput(resultados); // Calcula a vazão a partir dos enviadoEm/respondidoEm de cada requisição
  console.log('⚡ THROUGHPUT (vazão):'); // Cabeçalho da seção de throughput
  console.log(`   ${tp.reqs} requisições ÷ ${tp.janelaSeg}s de janela real = ${tp.reqPorSeg} req/s`); // Mostra a conta e o resultado em req/s
  console.log(`   (janela real: do 1º envio à última resposta = ${tp.janelaMs}ms)`); // Detalha de onde sai a janela
  console.log(''); // Linha em branco

  // ---- Explicação: POR QUE esse usuário ganhou (com os dados reais) ----
  if (sucessos.length === 1) { // Só explica a vitória quando houve exatamente 1 sucesso (caso correto)
    const venc = sucessos[0]; // Pega o resultado do usuário vencedor
    const minLat = Math.min(...resultados.map((r) => r.latencia)); // Calcula a menor latência entre todos os resultados
    const donoMinLat = resultados.find((r) => r.latencia === minLat); // Descobre qual usuário teve essa menor latência
    const posChegada = temInstrumentacao // Calcula a posição de chegada do vencedor, se houver instrumentação
      ? ordenados.findIndex((r) => r === venc) + 1 // Encontra a posição do vencedor na lista ordenada (+1 para começar em 1)
      : null; // Sem instrumentação, não há posição

    console.log(`🏁 POR QUE "${venc.usuarioId}" GANHOU (e não foi "só latência"):`); // Cabeçalho da explicação da vitória
    if (temInstrumentacao && posChegada === 1) { // Caso o vencedor tenha sido o 1º a chegar ao servidor
      console.log(`   1) Foi o 1º pedido a CHEGAR no servidor (de ${NUM_USUARIOS}). Chegou primeiro na fila.`); // Explica que chegou primeiro
    } else if (temInstrumentacao) { // Caso tenha vencido mas NÃO tenha sido o 1º a chegar
      console.log(`   1) Chegou ao servidor na ${posChegada}ª posição (de ${NUM_USUARIOS}) — NÃO foi o primeiro a`); // Mostra a posição de chegada
      console.log(`      chegar, mas seu UPDATE pegou a trava de linha antes (a fila do pool reordena).`); // Explica que a trava decidiu
    } else { // Caso não haja instrumentação
      console.log(`   1) Seu UPDATE foi o primeiro a pegar a trava de linha no Postgres.`); // Explica de forma genérica
    }
    console.log(`   2) Rodou  UPDATE animais SET status='I' WHERE id=${ANIMAL_ID} AND status='D'  e achou o`); // Mostra o comando UPDATE executado
    console.log(`      pet ainda 'D' → mudou para 'I' e o banco respondeu rowCount=1 (vitória).`); // Explica que o pet ainda estava disponível
    console.log(`   3) Os outros ${NUM_USUARIOS - 1} rodaram o MESMO comando, mas o pet já era 'I'. O WHERE não casou,`); // Explica o que aconteceu com os perdedores
    console.log(`      rowCount=0, e por isso receberam 409 "Animal já foi adotado".`); // Explica o rowCount=0 e o 409
    if (venc.usuarioId === donoMinLat.usuarioId) { // Se o vencedor também teve a menor latência
      console.log(`   4) Sobre latência: ele por acaso TAMBÉM teve a menor (${minLat}ms) — mas isso é`); // Explica que foi coincidência
      console.log(`      CONSEQUÊNCIA (não esperou a trava de ninguém), não a causa da vitória.`); // Esclarece que latência é consequência, não causa
    } else { // Se outro usuário teve a menor latência mas perdeu
      console.log(`   4) Sobre latência: a MENOR latência foi ${minLat}ms, do "${donoMinLat.usuarioId}", que MESMO`); // Mostra quem teve a menor latência
      console.log(`      ASSIM PERDEU (409). Ou seja: latência não decide quem ganha — a trava de linha decide.`); // Reforça que a trava decide
    }
    console.log(''); // Linha em branco
    console.log('   Resumo da causa: event loop do Node → fila do pool de conexões → TRAVA DE LINHA no'); // Resumo da cadeia de causas (parte 1)
    console.log('   Postgres. Quem a trava atende primeiro no UPDATE é quem vence. O resto é 409.'); // Resumo da cadeia de causas (parte 2)
    console.log(''); // Linha em branco
  }

  const violou = sucessos.length >= 2; // Houve violação se 2 ou mais usuários conseguiram adotar o mesmo animal
  const passou = !violou && (sucessos.length === 1 || statusInicial === 'I'); // O teste passa se não houve violação e houve 1 sucesso (ou o animal já estava adotado)
  let mensagemVeredito; // Variável que guardará a mensagem do veredito

  if (violou) { // Caso tenha havido race condition (2+ sucessos)
    mensagemVeredito = `❌ Teste FALHOU: ${sucessos.length} usuários adotaram o MESMO animal — race condition, RF014 não foi atendido.`; // Mensagem de falha por concorrência
  } else if (sucessos.length === 1) { // Caso exatamente 1 usuário tenha adotado (resultado ideal)
    mensagemVeredito = '✅ Teste PASSOU: exatamente 1 usuário conseguiu adotar.'; // Mensagem de sucesso
  } else if (statusInicial === 'I') { // Caso o animal já estivesse adotado antes do teste
    mensagemVeredito = '✅ Teste PASSOU: o animal já estava adotado, então ninguém conseguiu adotar de novo. Para testar a corrida, escolha outro ANIMAL_ID que ainda esteja disponível.'; // Explica que o teste passou mas não testou a corrida
  } else { // Caso ninguém tenha adotado um animal disponível
    mensagemVeredito = '❌ Teste FALHOU: ninguém adotou um animal que estava disponível. Provável servidor fora do ar.'; // Mensagem de falha (servidor provavelmente fora)
  }
  console.log(mensagemVeredito); // Imprime o veredito no console
  console.log(''); // Linha em branco

  // ---- Prova no BANCO: a corrida_trava desta execução ----
  // Mostra, com o mesmo SELECT do pgAdmin/psql, todos os usuários que pegaram a
  // trava nesta corrida e quem venceu — para o console bater com o banco.
  await mostrarCorridaTrava(); // Imprime a tabela corrida_trava (prova no banco) desta execução

  // ---- Evidência de PARALELISMO (fila + worker) ----
  // A adoção vencedora enfileirou um job em fila_notificacoes e a resposta HTTP
  // voltou na hora; quem processa é o worker (outro processo), em background.
  // Aqui o teste acompanha o job até o worker concluí-lo.
  let filaEvidencia = '—'; // Texto que resumirá a evidência da fila no relatório (padrão '—')
  if (sucessos.length === 1 && sucessos[0].jobId != null) { // Só acompanha a fila se houve 1 sucesso e um job foi enfileirado
    const jobId = sucessos[0].jobId; // Pega o id do job enfileirado pela adoção vencedora
    console.log(''); // Linha em branco
    console.log('📨 PARALELISMO (fila + worker):'); // Cabeçalho da seção de paralelismo
    console.log(`   A adoção vencedora enfileirou o job #${jobId} e a resposta HTTP voltou na hora.`); // Explica que o job foi enfileirado
    console.log('   O processamento acontece em BACKGROUND, no worker (processo separado).'); // Explica que o worker processa em background
    // A fila é FIFO: jobs pendentes mais antigos são processados antes do nosso.
    // A janela de espera cresce com o backlog para não acusar o worker à toa.
    // Conta quantos jobs pendentes ('P') existem na frente deste na fila
    const { rows: backlogRows } = await pool.query(
      "SELECT count(*)::int AS n FROM fila_notificacoes WHERE status = 'P' AND id < $1",
      [jobId]
    );
    const backlog = backlogRows[0].n; // Número de jobs pendentes à frente do nosso
    const maxTentativas = 8 + backlog * 4; // Define o limite de tentativas de espera (cresce com o backlog)
    let job = null; // Guardará o estado do job consultado
    for (let i = 0; i < maxTentativas; i++) { // Tenta verificar o job repetidamente até o limite
      // Consulta o status do job, quem o processou e quantos segundos depois da criação foi processado
      const { rows } = await pool.query(
        `SELECT status, processado_por,
                round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) AS seg
           FROM fila_notificacoes WHERE id = $1`,
        [jobId]
      );
      job = rows[0]; // Atualiza o estado atual do job
      if (job && job.status === 'C') break; // Se o job foi concluído ('C'), para de esperar
      await new Promise((r) => setTimeout(r, 500)); // Aguarda 500ms antes da próxima tentativa
    }
    if (job && job.status === 'C') { // Se o job foi concluído pelo worker
      console.log(`   ✅ Job #${jobId} processado por "${job.processado_por}" ${job.seg}s DEPOIS da adoção —`); // Mostra quem processou e quando
      console.log('      execução independente da requisição principal.'); // Reforça que rodou de forma independente
      filaEvidencia = `job #${jobId} → ${job.processado_por}`; // Registra a evidência de sucesso para o relatório
    } else { // Se o job não foi concluído dentro do limite
      const naFrente = backlog > 0 ? ` (${backlog} job(s) na frente na fila)` : ''; // Texto opcional informando jobs na frente
      console.log(`   ⏳ Job #${jobId} segue pendente${naFrente} — worker ocupado ou fora do ar.`); // Avisa que o job segue pendente
      console.log('      Confira a fila: npm run fila   |   suba um worker: npm run worker'); // Sugere comandos para inspecionar/subir o worker
      filaEvidencia = `job #${jobId} pendente`; // Registra a evidência de pendência para o relatório
    }
  }

  const statsLatencia = estatisticas(resultados.map((r) => r.latencia)); // Calcula estatísticas (p50, p95...) das latências de todas as requisições

  sessao.salvar({ // Salva todos os dados do teste na sessão de relatório
    nome: 'Teste de adoção concorrente (RF014)', // Nome do teste
    descricao: `${NUM_USUARIOS} usuários tentando adotar o animal ${ANIMAL_ID} (${nomeAnimal}) ao mesmo tempo.`, // Descrição resumida do cenário
    inicioISO: new Date(sessao.inicioMs).toISOString(), // Horário de início no formato ISO
    config: { ANIMAL_ID, NUM_USUARIOS, BASE_URL }, // Configuração usada no teste
    cards: [ // Lista de "cards" com métricas para exibir no relatório
      { label: 'Animal alvo', valor: `${ANIMAL_ID} — ${nomeAnimal}`, dica: 'Pet que todos tentaram adotar ao mesmo tempo.' }, // Card do animal alvo
      { label: 'Usuários', valor: String(NUM_USUARIOS), dica: 'Quantas pessoas dispararam a adoção em paralelo.' }, // Card da quantidade de usuários
      { label: 'Sucessos', valor: String(sucessos.length), sub: 'esperado: 1', dica: 'Deve ser exatamente 1. Mais que isso = bug de concorrência (RF014 violado).' }, // Card de sucessos
      { label: 'Conflitos (409)', valor: String(conflitos.length), dica: 'Quem chegou tarde: o pet já era I. Comportamento correto dos perdedores.' }, // Card de conflitos
      { label: 'Erros', valor: String(inesperados.length), dica: 'Respostas inesperadas (5xx, rede). Deveria ser 0.' }, // Card de erros inesperados
      { label: 'Tempo total', valor: `${tempoTotal}ms`, dica: 'Do disparo até a última resposta chegar.' }, // Card do tempo total
      { label: 'Latência p50', valor: `${statsLatencia.p50}ms`, dica: 'Mediana: metade das adoções respondeu mais rápido que isso.' }, // Card da latência mediana (p50)
      { label: 'Latência p95', valor: `${statsLatencia.p95}ms`, dica: '95% das adoções responderam em até esse tempo (interpolação linear).' }, // Card da latência p95
      { label: 'Status final', valor: statusFinal, dica: "Status do pet no banco ao fim: I = adotado (esperado)." }, // Card do status final
      { label: 'Vencedor', valor: vencedor, dica: 'Usuário cujo UPDATE pegou a trava de linha primeiro.' }, // Card do vencedor
      { label: 'Fila (background)', valor: filaEvidencia, dica: 'Job de notificação enfileirado pela adoção e processado pelo worker em outro processo (fila + worker).' }, // Card da evidência da fila
    ],
    veredito: { ok: passou, mensagem: mensagemVeredito }, // Veredito final (passou ou não) e mensagem
    estatisticas: { adocao: statsLatencia }, // Estatísticas de latência da adoção
  });

  await sessao.fechar(); // Fecha a sessão de relatório (encerra o arquivo de log)
  const htmlPath = sessao.gerarHTML(); // Gera o relatório em HTML e guarda o caminho do arquivo

  console.log(''); // Linha em branco
  console.log(`📄 Relatório HTML: ${htmlPath}`); // Mostra o caminho do relatório HTML gerado
  console.log(`📁 Logs JSONL:     ${sessao.dir}/log.jsonl`); // Mostra o caminho do arquivo de logs JSONL

  await pool.end(); // Encerra a conexão com o banco
  process.exit(passou ? 0 : 1); // Sai com código 0 se o teste passou, ou 1 se falhou
}

main(); // Executa a função principal
