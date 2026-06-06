# Petz — Sistema de Adoção de Animais

API REST para gerenciamento de animais disponíveis para adoção, desenvolvida com **Node.js**, **Express** e **PostgreSQL**.

---

## Pré-requisitos

Antes de começar, certifique-se de ter instalado na sua máquina:

- [Node.js](https://nodejs.org/) (versão 18 ou superior)
- [PostgreSQL](https://www.postgresql.org/) (versão 14 ou superior)

---

## Passo a passo para rodar o projeto

### 1. Criar o banco de dados

Abra o **pgAdmin** ou o terminal do PostgreSQL (`psql`) e crie o banco:

```sql
CREATE DATABASE petz;
```

### 2. Criar a tabela

Com o banco `petz` selecionado, execute o conteúdo do arquivo [`create-table.sql`](create-table.sql):

```sql
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
    status CHAR(1) NOT NULL DEFAULT 'D'
);
```

> `status` aceita dois valores: `D` (disponível) ou `I` (indisponível).

### 3. Popular o banco com os dados iniciais

Execute o conteúdo do arquivo [`insert.sql`](insert.sql) para inserir os animais de exemplo.

No pgAdmin, basta abrir o arquivo e clicar em **Execute**. Pelo terminal:

```bash
psql -U postgres -d petz -f insert.sql
```

### 4. Configurar a conexão com o banco

Abra o arquivo `backend/src/config/db.js` e ajuste as credenciais conforme o seu ambiente:

```js
const pool = new Pool({
  host: 'localhost',
  user: 'postgres',   // seu usuário do PostgreSQL
  password: '',       // sua senha
  database: 'petz',
  port: 5432,
});
```

### 5. Instalar as dependências do backend

```bash
cd backend
npm install
```

### 6. Iniciar o servidor

```bash
npm start
```

O servidor vai subir em `http://localhost:3001`.

---

## Estrutura do projeto

```
backend/
├── server.js                       # Entry point — inicia o servidor
├── scripts/                        # Testes de estresse de concorrência
│   ├── stress-adocao.js            # Teste de adoção simples (N usuários, 1 animal)
│   ├── stress-cenario.js           # Cenário com navegação + ondas de adoção
│   ├── stress-full.js              # Sobe o servidor e executa o teste simples
│   └── lib/
│       └── relatorio.js            # Estatísticas e geração dos relatórios
└── src/
    ├── app.js                      # Configuração do Express e rotas
    ├── config/
    │   └── db.js                   # Conexão com o PostgreSQL
    ├── controllers/
    │   └── animaisController.js    # Lógica de negócio
    └── routes/
        └── animais.js              # Definição das rotas
```

---

## Rotas disponíveis

Base URL: `http://localhost:3001/api/animais`

| Método   | Rota                  | Descrição                                      |
|----------|-----------------------|------------------------------------------------|
| `GET`    | `/`                   | Lista todos os animais (aceita filtros)        |
| `GET`    | `/:id`                | Busca um animal pelo ID                        |
| `POST`   | `/`                   | Cadastra um novo animal                        |
| `PUT`    | `/:id`                | Atualiza todos os dados de um animal           |
| `DELETE` | `/:id`                | Remove um animal                               |
| `PATCH`  | `/:id/status`         | Alterna o status entre disponível e indisponível |
| `POST`   | `/:id/adotar`         | Adota um animal de forma atômica (concorrência-safe) |

### Filtros disponíveis no `GET /`

Todos os parâmetros são opcionais e podem ser combinados:

```
GET /api/animais?sexo=macho&porte=pequeno&idade=filhote&cor=preto&raca=labrador&localizacao=taguatinga
```

| Parâmetro    | Exemplo         |
|--------------|-----------------|
| `sexo`       | `macho`, `fêmea` |
| `porte`      | `pequeno`, `médio`, `grande` |
| `idade`      | `filhote`, `adulto`, `idoso` |
| `cor`        | `preto`, `caramelo` |
| `raca`       | `labrador`, `vira-lata` |
| `localizacao`| `taguatinga`, `asa sul` |

### Exemplo de corpo para `POST` e `PUT`

```json
{
  "nome": "Thor",
  "sexo": "macho",
  "porte": "grande",
  "idade": "adulto",
  "cor": "preto",
  "raca": "Labrador",
  "localizacao": "Ceilândia, Brasília, DF",
  "descricao": "Muito brincalhão e enérgico.",
  "status": "D"
}
```

### Resposta do `PATCH /:id/status`

```json
{
  "mensagem": "Animal marcado como indisponível",
  "status": "I"
}
```

### Adoção atômica — `POST /:id/adotar`

Endpoint para adotar um animal de forma segura contra concorrência. A mudança de
status ocorre em uma única instrução `UPDATE ... WHERE status = 'D'`, protegida
por trava de linha do PostgreSQL. Apenas a primeira requisição cujo `UPDATE`
obtém a trava encontra o animal disponível; as demais recebem `409`.

Corpo da requisição:

```json
{ "usuarioId": "user-1" }
```

| Situação                          | Status | Resposta |
|-----------------------------------|--------|----------|
| Adoção bem-sucedida               | `200`  | `{ "sucesso": true, "mensagem": "Adoção realizada", "usuarioId": "user-1", "animalId": 1, "nome": "Thor" }` |
| Animal já adotado                 | `409`  | `{ "sucesso": false, "motivo": "Animal já foi adotado" }` |
| Animal não encontrado             | `404`  | `{ "sucesso": false, "motivo": "Animal não encontrado" }` |

---

## Testes de Estresse

Os testes de estresse validam o **RF014**: o sistema deve controlar a
concorrência quando múltiplos usuários demonstram interesse simultâneo pelo mesmo
animal, garantindo que apenas **uma** adoção seja bem-sucedida por animal.

### Scripts disponíveis

| Script | Comando | Descrição |
|--------|---------|-----------|
| Adoção simples | `npm run stress` | N usuários tentam adotar **1** animal simultaneamente. |
| Adoção simples (autônomo) | `npm run stress:full` | Sobe o servidor automaticamente, executa o teste simples e encerra o servidor. |
| Cenário reduzido | `npm run stress:cenario` | 100 usuários navegando + 5 ondas de adoção paralelas (100 adotantes, ~550 requisições). |
| Cenário cheio | `npm run stress:cenario:cheio` | 1000 usuários navegando + 5 ondas paralelas (1000 adotantes, ~6000 requisições). |

Cada execução gera um conjunto de artefatos em
`backend/out/<script>-<timestamp>/` (detalhado em [Artefatos gerados](#artefatos-gerados)).

### Pré-requisitos

1. PostgreSQL em execução, com o banco `petz` criado e populado (passos 1 a 3 deste README).
2. Dependências instaladas: `cd backend && npm install`.
3. Credenciais do PostgreSQL configuradas em
   [`backend/src/config/db.js`](backend/src/config/db.js) ou via variável de
   ambiente `PG_PASSWORD`.

### Execução

Os testes exigem o servidor em execução. Utilize dois terminais.

**Terminal 1 — servidor** (mantenha em execução durante os testes):

```bash
cd backend
npm start
```

Aguarde a mensagem `Servidor rodando em http://localhost:3001`.

**Terminal 2 — testes:**

```bash
cd backend
```

> O script `npm run stress:full` dispensa o Terminal 1, pois inicia e encerra o
> servidor automaticamente.

### Teste de adoção simples

Vários usuários tentam adotar o mesmo animal simultaneamente:

```bash
ANIMAL_ID=50 NUM_USUARIOS=8 npm run stress
```

Variáveis:

| Variável       | Padrão                  | Descrição                          |
|----------------|-------------------------|------------------------------------|
| `ANIMAL_ID`    | `1`                     | ID do animal disputado.            |
| `NUM_USUARIOS` | `3`                     | Quantidade de usuários paralelos.  |
| `BASE_URL`     | `http://localhost:3001` | URL base da API.                   |

Saída resumida:

```
=== TESTE DE ESTRESSE - ADOÇÃO CONCORRENTE (RF014) ===
Animal alvo: 50 (Pipoca)
Usuários simulados: 8
Status inicial: D

Resultados:
 - user-1 → 409     | "Animal já foi adotado"
 - user-3 → 200 OK  | "Adoção realizada"
 ...

Linha do tempo da corrida (ordenada pela chegada no SERVIDOR):
  chegada | usuário | enviou | chegou | resp.  | status | latência | banco
  ...

✅ Teste PASSOU: exatamente 1 usuário conseguiu adotar.
```

Além da lista de resultados, o console apresenta a ordem de chegada de cada
requisição ao servidor e a análise de qual usuário venceu a corrida (ver
[Interpretação das métricas](#interpretação-das-métricas)).

> A adoção é **definitiva**: uma vez adotado (`status = 'I'`), o animal não volta
> a ficar disponível. Para repetir o teste, utilize um `ANIMAL_ID` ainda em
> `status = 'D'`. Para listar os disponíveis:
>
> ```bash
> node -e "const p=require('./src/config/db');p.query(\"SELECT id,nome FROM animais WHERE status='D' ORDER BY id LIMIT 10\").then(r=>{console.table(r.rows);p.end()})"
> ```

### Teste de cenário

Simula carga realista: usuários navegando pela API enquanto várias corridas de
adoção ocorrem em paralelo, cada uma em um animal distinto.

```bash
npm run stress:cenario          # perfil reduzido
npm run stress:cenario:cheio    # perfil cheio
```

Fluxo de execução:

1. Seleciona os 5 primeiros animais disponíveis e garante o `status = 'D'`.
2. Dispara os usuários de navegação (`GET /api/animais` e variações com filtros).
3. Em `t = 2s`, dispara 5 ondas de adoção em paralelo, uma por animal.
4. Imprime os resultados por animal, as métricas de navegação e gera o relatório.

Cada animal deve registrar exatamente 1 vencedor (total de 5 adoções
bem-sucedidas). O teste reativa os animais automaticamente, podendo ser repetido.

#### Ajustes para o perfil cheio

O perfil cheio abre milhares de conexões. Recomenda-se elevar o limite de
descritores de arquivo do sistema operacional e aumentar o pool de conexões do
PostgreSQL:

```bash
ulimit -n 4096
PG_POOL_MAX=50 npm run stress:cenario:cheio
```

Sem esses ajustes, podem ocorrer:

- `EMFILE: too many open files` — limite de descritores insuficiente;
- latência p99 elevada — pool de conexões saturado, formando fila.

### Artefatos gerados

Cada execução cria a pasta `backend/out/<script>-<timestamp>/` com:

| Arquivo | Conteúdo |
|---------|----------|
| `log.jsonl` | Registro bruto: uma linha JSON por requisição, com tempos, status e instrumentação. |
| `summary.json` | Resumo consolidado: configuração, cards, veredito e estatísticas. |
| `report.html` | Relatório visual navegável. |

Para abrir o relatório no macOS:

```bash
open backend/out/<script>-<timestamp>/report.html
```

### Estrutura do relatório HTML

- **Veredito** — resultado do teste (verde: aprovado; vermelho: reprovado).
- **Resumo** — cards com os principais indicadores (vencedor, sucessos,
  conflitos, throughput e latências). Cada card exibe uma descrição ao passar o
  cursor.
- **Quem ganhou e por quê** — para cada animal, a análise da corrida com a ordem
  de chegada ao servidor e o vencedor destacado.
- **Timeline da corrida** — representação temporal de cada tentativa
  (verde: vencedor; amarelo: conflito; vermelho: erro).
- **Throughput** — vazão medida sobre a janela real de execução.
- **Distribuição de latência** — histograma por faixas.
- **Glossário** — definição de cada métrica.
- **Eventos** — tabela completa de requisições, filtrável por animal, status e ação.

### Interpretação das métricas

**Resolução da concorrência.** A operação de adoção executa
`UPDATE animais SET status='I' WHERE id=? AND status='D'`. O PostgreSQL aplica
uma trava de linha (*row lock*) sobre o registro: a primeira transação a obter a
trava encontra `status='D'`, efetua a alteração e retorna `rowCount=1` (adoção
bem-sucedida). As requisições subsequentes executam o mesmo comando quando o
registro já está em `status='I'`; a cláusula `WHERE` não é satisfeita,
`rowCount=0`, e a API responde `409`. A ordem de chegada ao servidor e a latência
observada no cliente **não** determinam o vencedor — apenas a ordem de aquisição
da trava de linha.

**Campos de instrumentação.** Cada resposta de adoção inclui, e o log registra:

| Campo | Significado |
|-------|-------------|
| `recebidoEm` | Instante em que o servidor recebeu a requisição. |
| `ordemChegada` | Ordem sequencial de chegada da requisição ao servidor. |
| `dbMs` | Tempo de permanência no banco (fila do pool + aquisição da trava + execução do `UPDATE`). |

**Latência e percentis.** Latência é o tempo de ida e volta de cada requisição,
medido no cliente. Os percentis `p50`, `p95` e `p99` são calculados por
interpolação linear (método equivalente ao padrão do NumPy e à função
`PERCENTIL.INC` do Excel). O `p50` é a mediana; `p95` e `p99` evidenciam a cauda
da distribuição (os piores casos), informação que a média isolada não revela.

**Throughput.** Número de requisições por segundo, calculado sobre a **janela
real** de execução — do envio da primeira requisição ao recebimento da última
resposta. A janela real é normalmente inferior à duração nominal configurada,
pois os usuários virtuais concluem suas requisições antes do prazo máximo; o
cálculo utiliza o intervalo efetivamente medido.

**Status HTTP.**

| Status | Significado |
|--------|-------------|
| `200` | Adoção bem-sucedida (vencedor da corrida). |
| `409` | Animal já adotado — resultado esperado das requisições perdedoras. |
| `404` | Animal inexistente. |
| `5xx` / `0` | Erro de servidor ou de rede. |

### Critérios de aprovação (RF014)

O teste é considerado **aprovado** quando:

- ✅ o número de adoções bem-sucedidas (`200`) é exatamente **1 por animal** disputado;
- ✅ não há erros (`5xx` ou falhas de rede);
- ✅ o status final do animal no banco é `I`;
- ✅ as requisições perdedoras recebem `409`.

Duas ou mais adoções bem-sucedidas no mesmo animal caracterizam falha de
concorrência (*race condition*) e violação do RF014.

### Variáveis de ambiente

| Variável       | Padrão                  | Descrição                                       |
|----------------|-------------------------|-------------------------------------------------|
| `PERFIL`       | `reduzido`              | Perfil do cenário: `reduzido` ou `cheio`.       |
| `BASE_URL`     | `http://localhost:3001` | URL base da API.                                |
| `PG_POOL_MAX`  | `10`                    | Tamanho do pool de conexões do PostgreSQL.      |
| `PG_PASSWORD`  | (definido em `db.js`)   | Senha do PostgreSQL.                            |

A estrutura dos perfis (quantidade de usuários, duração da navegação e endpoints
utilizados) é definida na constante `PERFIS`, no início de
[`backend/scripts/stress-cenario.js`](backend/scripts/stress-cenario.js).
