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
├── server.js                    # Entry point — inicia o servidor
└── src/
    ├── app.js                   # Configuração do Express e rotas
    ├── config/
    │   └── db.js                # Conexão com o PostgreSQL
    ├── controllers/
    │   └── animaisController.js # Lógica de negócio
    └── routes/
        └── animais.js           # Definição das rotas
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

Endpoint usado para adotar um animal de forma segura contra concorrência. A
mudança de status acontece em uma única instrução `UPDATE ... WHERE status = 'D'`,
então apenas a **primeira** requisição que chega encontra o animal disponível;
as demais recebem `409`.

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

Esta seção valida o **RF014** do documento de requisitos: o sistema deve
controlar a concorrência quando **múltiplos usuários demonstram interesse
simultâneo pelo mesmo pet**. Existem três níveis de teste, do mais simples ao
mais pesado.

| Nível                  | Comando                          | O que faz                                                      |
|------------------------|----------------------------------|----------------------------------------------------------------|
| 1. Simples             | `npm run stress`                 | N usuários tentam adotar **1** animal ao mesmo tempo           |
| 2. Cenário reduzido    | `npm run stress:cenario`         | 100 usuários navegando + 5 ondas de adoção paralelas (100 adotantes) |
| 3. Cenário cheio       | `npm run stress:cenario:cheio`   | 1000 navegando + 5 ondas paralelas (200/200/400/100/100 adotantes) |

Todos os três geram um **relatório HTML visual** em `backend/out/<nome>-<timestamp>/`
com timeline da corrida, histograma de latência e tabela filtrável.

### Pré-requisitos (uma única vez)

1. PostgreSQL rodando, banco `petz` criado e populado (passos 1–3 deste README).
2. Dependências instaladas: `cd backend && npm install`.
3. Senha do Postgres conferida em [`backend/src/config/db.js`](backend/src/config/db.js)
   (ou definida via env var `PG_PASSWORD`).

### Passo 1 — Subir o servidor

Abra um terminal **no VS Code** (menu `Terminal → New Terminal` ou `Ctrl+\``) e
deixe ele rodando durante todos os testes:

```bash
cd backend
npm start
```

Você deve ver:

```
Servidor rodando em http://localhost:3001
```

**Não feche esse terminal. Não dê Ctrl+C.** Ele precisa continuar no ar enquanto
você roda os testes.

### Passo 2 — Abrir um segundo terminal

No VS Code, clique no `+` ao lado do nome do terminal, ou `Ctrl+Shift+\``. Vai
abrir um terminal novo lado a lado com o primeiro. Entre na pasta `backend`:

```bash
cd backend
```

É nesse terminal que você vai rodar os testes.

---

### Teste 1 — Stress simples (1 animal, X usuários)

Esse é o teste mais didático: vários usuários tentam adotar **o mesmo animal**
ao mesmo tempo. Só um pode ganhar.

```bash
ANIMAL_ID=20 NUM_USUARIOS=5 npm run stress
```

- `ANIMAL_ID=20` → escolhe o pet de id 20 (use um que ainda esteja com status
  `D` no banco; uma vez adotado, o pet permanece adotado).
- `NUM_USUARIOS=5` → simula 5 pessoas.

Saída esperada:

```
=== TESTE DE ESTRESSE - ADOÇÃO CONCORRENTE (RF014) ===
Animal alvo: 20 (Nina)
Usuários simulados: 5
Status inicial: D

Resultados:
 - user-1 → 409     | "Animal já foi adotado"
 - user-2 → 200 OK  | "Adoção realizada"
 - user-3 → 409     | "Animal já foi adotado"
 - user-4 → 409     | "Animal já foi adotado"
 - user-5 → 409     | "Animal já foi adotado"

✅ Teste PASSOU: exatamente 1 usuário conseguiu adotar.

📄 Relatório HTML: backend/out/stress-adocao-<timestamp>/report.html
```

**Como interpretar:**
- ✅ **1 sucesso** → correto, RF014 atendido.
- ❌ **2 ou mais sucessos** → bug de concorrência, RF014 violado.

Variáveis disponíveis:

| Variável       | Padrão                  | Descrição                              |
|----------------|-------------------------|----------------------------------------|
| `ANIMAL_ID`    | `1`                     | ID do animal alvo                      |
| `NUM_USUARIOS` | `3`                     | Quantidade de usuários paralelos       |
| `BASE_URL`     | `http://localhost:3001` | URL base da API                        |

> A adoção é **definitiva**: uma vez adotado (status `I`), o pet não volta a
> ficar disponível. Para repetir a corrida, escolha um `ANIMAL_ID` que ainda
> esteja com status `D`.

---

### Teste 2 — Cenário reduzido (recomendado pra primeira vez)

Esse simula um cenário mais realista: muita gente navegando enquanto várias
corridas de adoção acontecem em paralelo, cada uma em um pet diferente.

```bash
npm run stress:cenario
```

O que vai acontecer:

1. O script força os 5 primeiros pets disponíveis pra status `D`.
2. Dispara 100 "usuários virtuais" que ficam navegando (`GET /api/animais`,
   filtros, detalhes) por 6 segundos.
3. Em `t = 2s`, dispara **5 ondas de adoção em paralelo**:
   - 20 usuários → pet A
   - 20 usuários → pet B
   - 40 usuários → pet C
   - 10 usuários → pet D
   - 10 usuários → pet E
4. Imprime tabela por pet, métricas de navegação e gera o relatório HTML.

Resultado esperado:

```
✅ RF014 atendido: exatamente 5 sucessos (um por pet). Concorrência sob controle.
```

Cada pet deve ter exatamente 1 vencedor. Total de sucessos = 5.

---

### Teste 3 — Cenário cheio (carga pesada)

Mesma estrutura do reduzido, mas com 10x mais carga: 1000 navegando + 1000
adotando (em 5 ondas: 200/200/400/100/100). Total: ~6000 requests.

**Antes de rodar**, ajuste dois limites do sistema operacional e do banco:

```bash
# 1) Aumenta o limite de file descriptors do macOS/Linux
ulimit -n 4096

# 2) Roda com pool de PG maior (50 em vez de 10)
PG_POOL_MAX=50 npm run stress:cenario:cheio
```

Somente cenario 1000 (1000+1000):
npm run stress:cenario:cheio

Sem esses ajustes, dois sintomas comuns aparecem:
- `EMFILE: too many open files` → ulimit baixo.
- Latência p99 explodindo (segundos) → pool do PG está fazendo fila.

Resultado esperado (igual ao reduzido, mas com mais tentativas por pet):

```
pet | nome    | tent | vencedor       | lat venc | p50    | p95    | max    | final
1   | Thor    | 200  | ad-pet1-u47    | 38ms     | 52ms   | 184ms  | 312ms  | I
...
✅ RF014 atendido: exatamente 5 sucessos (um por pet). Concorrência sob controle.
```

---

### Passo 3 — Abrir o relatório HTML

No final de qualquer teste, o caminho do `report.html` é impresso. Pra abrir no
macOS:

```bash
open backend/out/stress-cenario-<timestamp>/report.html
```

O relatório tem:
- **Veredito** (verde se passou, vermelho se falhou).
- **Cards de resumo**: total de requests, sucessos, throughput e latências p50/p95/p99
  (passe o mouse em cada card para ver a explicação).
- **🏁 Quem ganhou e por quê**: para cada pet, explica com os números reais por que
  aquele usuário venceu — e por que a latência sozinha não explica.
- **Timeline visual**: cada pet tem sua faixa, cada tentativa é uma barrinha
  colorida (verde = ganhou, amarelo = perdeu, vermelho = erro). O vencedor
  aparece com borda destacada.
- **Throughput (vazão)**: requisições por segundo medidas na **janela real**.
- **Histograma de latência**: distribuição em buckets (< 10ms, 10–25ms, …, > 2.5s).
- **Glossário**: o que cada número significa.
- **Tabela de eventos**: filtrável por pet, status e ação.

---

### Entendendo o teste — o que explicar para cada número

Esta é a parte que mais cai em pergunta. Use como roteiro.

#### 1. Por que um usuário "chega primeiro" / ganha a corrida?

Quando N usuários disparam a adoção do mesmo pet "ao mesmo tempo", **só um vence**.
A causa **não é a latência** — é uma cadeia de etapas:

1. **Event loop do Node (cliente)**: o `Promise.all` dispara os pedidos "juntos",
   mas o JavaScript é single-thread: ele envia um `fetch` de cada vez, em sequência.
2. **Rede + servidor**: cada pedido chega ao servidor em um instante ligeiramente
   diferente. O servidor registra a **ordem de chegada** (1º, 2º, 3º...).
3. **Pool de conexões do Postgres** (padrão: 10): se chegam mais pedidos que conexões,
   eles **fazem fila**. A ordem da fila pode reordenar quem encosta no banco primeiro.
4. **Trava de linha (row lock) no Postgres** — *aqui a corrida é decidida*. A adoção é:
   ```sql
   UPDATE animais SET status = 'I' WHERE id = ? AND status = 'D'
   ```
   O Postgres trava a linha do pet. O **primeiro** `UPDATE` a pegar a trava encontra
   `status = 'D'`, muda para `'I'` e retorna `rowCount = 1` → **venceu**. Todos os
   outros, ao rodar o **mesmo** comando, já acham `status = 'I'`, o `WHERE` não casa,
   `rowCount = 0` → recebem **409**.

> **A frase-chave para o professor:** *"Quem ganha é o primeiro `UPDATE` a obter a
> trava de linha no banco. A menor latência do vencedor é **consequência** (ele não
> esperou a trava de ninguém), não a causa."* O relatório prova isso: muitas vezes o
> vencedor **não** teve a menor latência, e às vezes **não** foi nem o primeiro a chegar.

Para tornar isso visível, o servidor foi instrumentado e agora devolve, em cada
resposta de adoção:
- `recebidoEm` — instante em que o servidor recebeu o pedido;
- `ordemChegada` — ordem de chegada no servidor;
- `dbMs` — tempo que o pedido passou no banco (fila do pool + trava + UPDATE).

#### 2. Latência e percentis (p50 / p95 / p99)

- **Latência**: tempo de ida e volta de uma requisição (medido no cliente).
- **p50** (mediana): metade das requisições foi mais rápida que esse valor.
- **p95**: 95% responderam em até esse tempo. **p99**: 99%. Mostram a "cauda" (os
  casos lentos), que é o que trava o usuário real — por isso são melhores que a média.
- Os percentis são calculados por **interpolação linear** (o mesmo método do NumPy e
  do Excel). *Obs.: a versão antiga tinha um erro que fazia o p95/p99 colarem no
  máximo em amostras pequenas; isso foi corrigido.*

#### 3. Throughput (vazão)

Vazão = **total de requisições ÷ janela real**, onde a janela real vai do primeiro
pedido enviado até a última resposta recebida.

> **Cuidado com a pergunta clássica:** a janela real é **menor** que a duração
> configurada do teste (ex.: 1s em vez de 6s) porque cada usuário virtual faz só 3–6
> requisições e termina cedo. Por isso dividimos pela janela **medida**, não pelo prazo
> nominal — senão o número sairia várias vezes menor que o real.

#### 4. Status HTTP

| Status | Significado |
|--------|-------------|
| `200`  | Adotou — venceu a corrida |
| `409`  | Chegou tarde, o pet já era `'I'` — **perdedor correto** (era o esperado) |
| `404`  | Pet não existe |
| `5xx` / `0` | Erro de servidor ou de rede (deveria ser 0) |

---

### Customizando

Variáveis de ambiente disponíveis para os cenários:

| Variável       | Padrão                  | Descrição                                              |
|----------------|-------------------------|--------------------------------------------------------|
| `PERFIL`       | `reduzido`              | `reduzido` ou `cheio`                                  |
| `BASE_URL`     | `http://localhost:3001` | URL base da API                                        |
| `PG_POOL_MAX`  | `10`                    | Tamanho do pool de conexões do Postgres                |
| `PG_PASSWORD`  | (default em `db.js`)    | Senha do PostgreSQL                                    |

Pra mudar a estrutura dos perfis (quantidade de usuários, duração da navegação,
endpoints chamados), edite a constante `PERFIS` no topo de
[`backend/scripts/stress-cenario.js`](backend/scripts/stress-cenario.js).
