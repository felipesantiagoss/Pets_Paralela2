const pool = require('../config/db');

async function listar(req, res) {
  const { sexo, porte, idade, cor, raca, localizacao } = req.query;

  let query = 'SELECT * FROM animais WHERE 1=1';
  const params = [];
  let i = 1;

  if (sexo)        { query += ` AND sexo = $${i++}`;            params.push(sexo); }
  if (porte)       { query += ` AND porte = $${i++}`;           params.push(porte); }
  if (idade)       { query += ` AND idade = $${i++}`;           params.push(idade); }
  if (cor)         { query += ` AND cor = $${i++}`;             params.push(cor); }
  if (raca)        { query += ` AND raca ILIKE $${i++}`;        params.push(`%${raca}%`); }
  if (localizacao) { query += ` AND localizacao ILIKE $${i++}`; params.push(`%${localizacao}%`); }

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar animais', detalhe: err.message });
  }
}

async function buscarPorId(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM animais WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Animal não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar animal', detalhe: err.message });
  }
}

async function criar(req, res) {
  const { nome, sexo, porte, idade, cor, raca, localizacao, descricao, status } = req.body;

  if (!nome || !sexo || !porte || !idade || !cor || !raca || !localizacao) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, sexo, porte, idade, cor, raca, localizacao' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO animais (nome, sexo, porte, idade, cor, raca, localizacao, descricao, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [nome, sexo, porte, idade, cor, raca, localizacao, descricao || null, status || 'D']
    );
    res.status(201).json({ id: rows[0].id, mensagem: 'Animal cadastrado com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar animal', detalhe: err.message });
  }
}

async function atualizar(req, res) {
  const { nome, sexo, porte, idade, cor, raca, localizacao, descricao, status } = req.body;

  if (!nome || !sexo || !porte || !idade || !cor || !raca || !localizacao) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, sexo, porte, idade, cor, raca, localizacao' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE animais SET nome=$1, sexo=$2, porte=$3, idade=$4, cor=$5, raca=$6, localizacao=$7, descricao=$8, status=$9 WHERE id=$10',
      [nome, sexo, porte, idade, cor, raca, localizacao, descricao || null, status || 'D', req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Animal não encontrado' });
    res.json({ mensagem: 'Animal atualizado com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar animal', detalhe: err.message });
  }
}

async function remover(req, res) {
  try {
    const { rowCount } = await pool.query('DELETE FROM animais WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ erro: 'Animal não encontrado' });
    res.json({ mensagem: 'Animal removido com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover animal', detalhe: err.message });
  }
}

async function toggleStatus(req, res) {
  try {
    const { rows } = await pool.query('SELECT status FROM animais WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Animal não encontrado' });

    const novoStatus = rows[0].status === 'D' ? 'I' : 'D';
    await pool.query('UPDATE animais SET status = $1 WHERE id = $2', [novoStatus, req.params.id]);

    const label = novoStatus === 'D' ? 'disponível' : 'indisponível';
    res.json({ mensagem: `Animal marcado como ${label}`, status: novoStatus });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar status', detalhe: err.message });
  }
}

// Contador global de chegada (vive enquanto o servidor está no ar).
// Serve para registrar a ORDEM EXATA em que o servidor recebeu cada pedido de
// adoção — é a peça que explica "quem chegou primeiro" sem depender só da
// latência medida no cliente.
let _ordemChegadaAdocao = 0;

async function adotar(req, res) {
  // Instante em que o servidor começou a tratar este pedido. Como cliente e
  // servidor rodam na mesma máquina (localhost), os relógios são o mesmo, então
  // dá pra comparar este valor com o "enviadoEm" do cliente.
  const recebidoEm = Date.now();
  // Ordem de chegada no servidor: 1 = primeiro pedido que o event loop do Node
  // desempacotou, 2 = segundo, e assim por diante. Mesmo disparando "juntos",
  // os pedidos entram aqui um de cada vez.
  const ordemChegada = ++_ordemChegadaAdocao;

  const { id } = req.params;
  const { usuarioId } = req.body;

  if (!usuarioId) {
    return res
      .status(400)
      .json({ sucesso: false, motivo: 'Campo obrigatório: usuarioId', recebidoEm, ordemChegada });
  }

  try {
    // Coração do RF014: o UPDATE só altera a linha se ela AINDA estiver como 'D'.
    // O Postgres coloca uma TRAVA DE LINHA (row lock): o primeiro UPDATE a pegar
    // a trava muda D→I (rowCount=1, vence); todos os outros, ao rodar o mesmo
    // comando, encontram status já='I', o WHERE não casa (rowCount=0) e perdem.
    // É o banco — não o JavaScript — que serializa a disputa e garante 1 vencedor.
    const t0 = Date.now();
    const { rows, rowCount } = await pool.query(
      "UPDATE animais SET status = 'I' WHERE id = $1 AND status = 'D' RETURNING id, nome",
      [id]
    );
    // Tempo que o pedido passou no banco: fila do pool de conexões + espera da
    // trava de linha + execução do UPDATE. É aqui que a corrida é decidida.
    const dbMs = Date.now() - t0;

    if (rowCount === 1) {
      return res.json({
        sucesso: true,
        mensagem: 'Adoção realizada',
        usuarioId,
        animalId: rows[0].id,
        nome: rows[0].nome,
        recebidoEm,
        ordemChegada,
        dbMs,
      });
    }

    const existe = await pool.query('SELECT id FROM animais WHERE id = $1', [id]);
    if (existe.rowCount === 0) {
      return res
        .status(404)
        .json({ sucesso: false, motivo: 'Animal não encontrado', recebidoEm, ordemChegada, dbMs });
    }
    return res
      .status(409)
      .json({ sucesso: false, motivo: 'Animal já foi adotado', recebidoEm, ordemChegada, dbMs });
  } catch (err) {
    res.status(500).json({
      sucesso: false,
      motivo: 'Erro ao processar adoção',
      detalhe: err.message,
      recebidoEm,
      ordemChegada,
    });
  }
}

module.exports = { listar, buscarPorId, criar, atualizar, remover, toggleStatus, adotar };
