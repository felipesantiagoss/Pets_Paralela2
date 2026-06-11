CREATE TABLE IF NOT EXISTS animais (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    sexo VARCHAR(10) NOT NULL,
    porte VARCHAR(20) NOT NULL,
    idade VARCHAR(20) NOT NULL,
    cor VARCHAR(50) NOT NULL,
    raca VARCHAR(100) NOT NULL,
    localizacao VARCHAR(255) NOT NULL,
    descricao TEXT,
    status CHAR(1) NOT NULL DEFAULT 'D' -- 'D' para disponível ou 'I' para indisponível
);

-- Fila de jobs para processamento em background (paralelismo: fila + worker).
-- A API é a PRODUTORA: ao confirmar uma adoção, insere um job e responde na hora.
-- O worker (processo separado: npm run worker) é o CONSUMIDOR: pega jobs pendentes
-- com FOR UPDATE SKIP LOCKED, o que permite vários workers em paralelo sem que
-- dois peguem o mesmo job.
CREATE TABLE IF NOT EXISTS fila_notificacoes (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL,            -- ex: 'adocao_confirmada'
    payload JSONB NOT NULL,               -- dados do job: { animalId, nome, usuarioId }
    status CHAR(1) NOT NULL DEFAULT 'P',  -- 'P' pendente | 'C' concluído | 'E' erro
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    processado_em TIMESTAMPTZ,
    processado_por VARCHAR(50)            -- qual worker processou o job
);

-- Índice parcial: o worker só varre os pendentes, então o índice cobre apenas eles.
CREATE INDEX IF NOT EXISTS idx_fila_pendentes ON fila_notificacoes (id) WHERE status = 'P';