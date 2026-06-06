CREATE TABLE animais (
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