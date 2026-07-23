# trade_fv — Modelagem de Adequação de Estoque (PDVs)

Estrutura de dados em **PostgreSQL** que replica, no banco, a lógica de **adequação de
estoque de PDVs** que originalmente vivia no **Power BI** (Power Query "M" + medidas/colunas
"DAX"). O objetivo é ter as mesmas "sugestões" (positivar, aumentar, diminuir, inativar…)
disponíveis como **views/materialized views** consultáveis por qualquer ferramenta.

> **Contexto para LLM:** este documento descreve tudo que existe no schema `trade_fv`,
> as dependências entre os objetos, as regras de negócio (com a origem em M/DAX) e como o
> refresh é agendado. As lógicas foram **validadas contra exports do Power BI** (ver seção
> [Validação](#validação)) e batem 100% fora de uma diferença de *snapshot* de dados.

---

## 1. Visão geral

- **Banco:** PostgreSQL 17 (hospedado no Railway).
- **Schema principal:** `trade_fv`.
- **SKUs (apresentações) do produto (canabidiol EaseLabs):**
  | Apresentação | EAN |
  |---|---|
  | Isolado 30 mL | 7896806601243 |
  | Isolado 10 mL | 7896806601281 |
  | Isolado 20 mg 30 mL | 7896806601328 |
  | Extrato | 7896806601250 |
- **Redes atendidas:** ARAUJO, CLAMED, DPSP, DROGAL, INDIANA, PAGUEMENOS, PANVEL, RAIA, SAOJOAO, VENANCIO.

### Conexão
As credenciais ficam em `.env` (**não versionado** — ver `.gitignore`):
```
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
```
String de conexão equivalente:
`postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>`

---

## 2. Arquitetura e dependências

```
Schemas de origem (pré-existentes, fora deste projeto):
  estoque_redes.*   cddd.*   tdd.*

trade_fv.analise_estoque_pdv .............. VIEW   (cópia da view estoque_redes.analise_estoque_pdv)
        │
        ▼
trade_fv.fato_cdd_90_dias_agrupada ........ MATVIEW (sell-out 90 dias, por CHAVE_ESTOQUE_CDD)
        │
        ▼
trade_fv.fato_todos_pdvs .................. MATVIEW (1 linha por PDV×SKU: estoque + sell-out + cobertura FV)
        │
        ▼
trade_fv.fato_adequacao_estoque ........... MATVIEW (1 linha por PDV: estoque/sell-out por SKU + regras/sugestão)
        │
        ▼
trade_fv.fato_adequacao_estoque_unpivot ... VIEW   (1 linha por PDV×SKU: unpivot + EAN/Delta/Ajuste)
```

**Ordem obrigatória de refresh** (dependências):
`fato_cdd_90_dias_agrupada` → `fato_todos_pdvs` → `fato_adequacao_estoque`.
As duas **VIEWs** (`analise_estoque_pdv` e `..._unpivot`) são "ao vivo" e não precisam de refresh.

### Por que materialized views?
Recomputar toda a cadeia numa única query (cross-join + múltiplos joins pesados + dupla
leitura de `cddd.fato_cdd`) estourava a memória da instância. Materializando em camadas,
cada nível lê a matview já pronta da camada anterior; o refresh completo leva **~1m30s**.

---

## 3. Objetos do schema `trade_fv`

### 3.1 `analise_estoque_pdv` (VIEW)
Cópia **idêntica** da view `estoque_redes.analise_estoque_pdv` (universo de PDVs × 4 EANs-alvo,
com estoque mais recente por rede). Fonte "ao vivo".
Colunas: `cnpj`, `cnpj_padronizado`, `rede`, `ean`, `desc_apresentacao`, `cat_un_mercado`,
`cat_desconto_mercado`, `informe_estoque`, `estoque`.
Origem das tabelas: `estoque_redes.estoque_redes`, `estoque_redes.dim_cnpjs_rede`,
`estoque_redes.depara_tdd`, `tdd.dim_pdv`, `cddd.apres`.

### 3.2 `fato_cdd_90_dias_agrupada` (MATVIEW)
Sell-out (unidades) dos **últimos 90 dias**, agrupado por chave PDV+EAN.
- **Fonte:** `cddd.fato_cdd` (transações), enriquecida com `cddd.pdvs` (CNPJ) e `cddd.apres` (EAN/descrição).
- **Filtros:** apenas `cod_tipo_transacao = '1'` (vendas); janela = `[max(cod_anomes) − 91 dias, max(cod_anomes)]`.
- **`und_ajus` = `und / 1000`** (unidade ajustada). `Unidades Total` = `SUM(und_ajus)`.
- **Chave:** `CHAVE_ESTOQUE_CDD` = `cnpj_pdv || EAN`.
- **Índice único:** `(CHAVE_ESTOQUE_CDD, DESC_APRESENTACAO)`.
- **Colunas:** `CHAVE_ESTOQUE_CDD`, `DESC_APRESENTACAO`, `Unidades Total`.

### 3.3 `fato_todos_pdvs` (MATVIEW)
Uma linha por **PDV × SKU** com estoque atual, sell-out (via join) e cobertura de força de vendas.
- **Fonte:** `trade_fv.analise_estoque_pdv` + `trade_fv.fato_cdd_90_dias_agrupada` + cobertura FV.
- **Limpezas/padronizações (traduzidas do M):**
  - CNPJ: mantém só dígitos; descarta `'0'`, vazio e `'00000000000000'`.
  - Padroniza rede (`DROGARIA DPSP`→`DPSP`, `FARMACIA SAO JOAO`→`SAOJOAO`, `PAGUE MENOS`→`PAGUEMENOS`, `PANVEL FARMACIAS`→`PANVEL`, `RAIA DROGASIL`→`RAIA`).
  - Mapeia `apresentacao` por EAN (os 4 SKUs) e remove a apresentação `CANNABIS SATIVA … 79,14MG …`.
  - `cnpj_pdv_padronizado` = `LPAD(cnpj, 14, '0')` **exceto** `VENANCIO` e `PAGUEMENOS` (mantêm o CNPJ como veio).
  - `CHAVE_ESTOQUE_CDD` = `cnpj_pdv_padronizado || ean`.
- **Cobertura FV** (`cobertura_fv` do modelo): `cddd.forca_vendas` (territórios por `cod_utc`) ⋈
  `tdd.dim_pdv` (`UTC_PDV = cod_utc`) → traz `CNPJ_PDV` e `DESC_TERRITORIO`; join final por `cnpj_pdv`.
- **`COBERTURA FV?`**: `'Não'` se `DESC_TERRITORIO IN ('SEM REP', NULL)`, senão `'Sim'`.
- **Índices:** `(CHAVE_ESTOQUE_CDD)`, `(cnpj_pdv)` (não-únicos — a cobertura pode multiplicar linhas).
- **Colunas:** `cnpj_pdv`, `provedor_pdv`, `ean`, `cat_un_mercado`, `estoque`, `apresentacao`,
  `cnpj_pdv_padronizado`, `CHAVE_ESTOQUE_CDD`, `Unidades Total`, `DESC_TERRITORIO`, `COBERTURA FV?`.

### 3.4 `fato_adequacao_estoque` (MATVIEW)
**Coração do modelo.** Uma linha por **PDV** (`GROUP BY cnpj_pdv, cnpj_pdv_padronizado, provedor_pdv`),
com estoque e sell-out **pivotados por SKU** e todas as regras de sugestão.
- **Fonte:** `trade_fv.fato_todos_pdvs` (pivot) + `cddd.fato_cdd`/`cddd.pdvs` (para "Última Venda").
- **Índice único:** `(cnpj_pdv, cnpj_pdv_padronizado, provedor_pdv)`. Índice em `(STATUS_PARAMETRIZADO)`.
- **Colunas (na ordem):**
  `cnpj_pdv`, `cnpj_pdv_padronizado`, `provedor_pdv`, `COBERTURA FV?`, `CAT`, `POTENCIAL`,
  `Isolado 30 mL`, `Isolado 10 mL`, `Isolado 20 mg 30 mL`, `Extrato`,
  `Sell-out Isolado 30 mL`, `Sell-out Isolado 10 mL`, `Sell-out Isolado 20 mg 30 mL`, `Sell-out Extrato`,
  `Ultima Venda (dias)`,
  `Média Mensal Isolado 30 mL`, `Média Mensal Isolado 10 mL`, `Média Mensal Extrato`,
  `Estoque Ideal Isolado 30 mL`, `Estoque Ideal Isolado 10 mL`, `Estoque Ideal Extrato`, `Estoque Ideal Isolado 20 mg 30 mL`,
  `Estoque Ideal Total`, `Estoque Total`, `STATUS_PARAMETRIZADO`,
  `SALDO Estoque Ideal 30 mL`, `SALDO Estoque Ideal 10 mL`, `SALDO Estoque Ideal Extrato`, `SALDO Estoque Ideal 20 mg 30 mL`,
  `Estoque Ideal Final Isolado 30 mL`, `Estoque Ideal Final Isolado 10 mL`, `Estoque Ideal Final Extrato`, `Estoque Ideal Final Isolado 20 mg 30 mL`,
  `Estoque Ideal Final Total`.

Regras detalhadas na [seção 4](#4-regras-de-negócio).

### 3.5 `fato_adequacao_estoque_unpivot` (VIEW)
"Despivota" a `fato_adequacao_estoque`: **4 linhas por PDV** (uma por SKU), formato longo, ideal
para relatórios de positivação. Lê a matview (rápido) — não precisa refresh.
- **Colunas:** `CNPJ`, `Rede`, `CAT`, `Ultima Venda (dias)`, `SKU`, `Cobertura FV`, `Status`
  (= `STATUS_PARAMETRIZADO`, nível PDV), `Estoque Atual` (estoque do SKU), `Estoque Ideal`
  (= `Estoque Ideal Final` do SKU, `NULL` quando inativo), `EAN`, `Delta`, `Ajuste`.
- **`EAN`**: mapeado a partir do `SKU`.
- **`Delta`** = `Estoque Ideal − Estoque Atual` (blank tratado como 0).
- **`Ajuste`** (sugestão por SKU): ver [4.5](#45-ajuste-nível-sku----unpivot).

> **Granularidade:** `Status` é do **PDV** e `Ajuste` é do **SKU** — podem divergir na mesma linha
> (ex.: um PDV `INATIVAR` com um SKU específico `Manter`). Isso é esperado.

---

## 4. Regras de negócio

Todas as regras abaixo foram traduzidas **fielmente** do DAX original.

### 4.1 `Ultima Venda (dias)`
Dias entre a **última venda do CNPJ** e a **última venda global** de `cddd.fato_cdd` (apenas `tipo=1`).
Não usa a data de hoje — é estável.
`= COALESCE( max(cod_anomes global) − max(cod_anomes do CNPJ) , 2000 )`. `2000` = PDV sem venda.

### 4.2 `POTENCIAL`
`AltoPotencial` se `CAT` não é nulo **e** (`INDIANA` → `CAT ≤ 7`; **demais/geral** → `CAT ≤ 4`);
senão `BaixoPotencial`.

### 4.3 `Estoque Ideal <SKU>` (base)
Para cada SKU (30 mL, 10 mL, Extrato, 20 mg 30 mL):
```
SellOut     = COALESCE(Sell-out do SKU, 0)
MediaMensal = CEIL(SellOut / 3)                         -- ROUNDUP(DIVIDE(SellOut,3),0)

IsCAT_Principal    = (INDIANA → CAT 1..5 ; senão CAT 1..4)
RegraPrincipal     = IsCAT_Principal AND COBERTURA FV? = 'Sim'

IsCAT_Complementar = (INDIANA → CAT 6..8 ; senão CAT 5..8)
RegraComplementar  = IsCAT_Complementar AND Ultima Venda (dias) <= 120 AND SellOut > 0

Elegivel = provedor ∈ {10 redes} AND (RegraPrincipal OR RegraComplementar)

Estoque Ideal = Elegivel ? GREATEST(MediaMensal, 1) : 0     -- piso 1 quando elegível
```
- `Estoque Ideal Total` = soma dos 4 SKUs.
- `Média Mensal <SKU>` = `Sell-out / 3` (coluna de exibição). **Nuance:** no banco fica `0`
  quando não há venda; no Power BI fica em branco. Valores idênticos quando há venda.

### 4.4 `STATUS_PARAMETRIZADO` (nível PDV)
Avaliado por `SWITCH(TRUE(), …)` — **primeira condição verdadeira vence**:
```
Estoque        = COALESCE(Estoque Total, 0)          -- Estoque Total = Iso30 + Iso10 + Extrato (SEM 20mg)
EstoqueIdeal   = COALESCE(Estoque Ideal Total, 0)    -- Ideal Total = soma dos 4 SKUs (COM 20mg)
Inativo        = Ultima Venda (dias) >= 90 AND todos os 4 estoques = 0   -- (COM 20mg)
TemCoberturaFV = COBERTURA FV? = 'Sim'
SemVenda       = Ultima Venda (dias) >= 150
AltoPotencial  = POTENCIAL = 'AltoPotencial'

1) INATIVO      : Inativo AND (NOT AltoPotencial OR NOT TemCoberturaFV)
2) INATIVAR     : (NOT AltoPotencial AND SemVenda)   [OR EstoqueIdealNulo*]
3) POSITIVAR    : Inativo AND AltoPotencial AND TemCoberturaFV
4) DIMINUIR VB  : NOT Inativo AND Estoque > EstoqueIdeal
5) AUMENTAR VB  : NOT Inativo AND Estoque < EstoqueIdeal
6) MANTER VB    : NOT Inativo AND Estoque = EstoqueIdeal
else NULL
```
\* `EstoqueIdealNulo` = todos os `Estoque Ideal` nulos. Como no banco eles são `0` (nunca nulos),
esse termo **nunca dispara** — fiel ao comportamento observado.

> **Assimetria proposital (do DAX original):** `Estoque Total` soma **3** SKUs (sem o 20 mg),
> mas `Inativo` e `Estoque Ideal Total` consideram os **4**. Isso é intencional e foi mantido.

### 4.5 `Estoque Ideal Final <SKU>`
`= NULL (BLANK)` se `STATUS_PARAMETRIZADO ∈ {INATIVO, INATIVAR}`; senão o `Estoque Ideal <SKU>` base.
`Estoque Ideal Final Total` = `NULL` quando inativo/inativar; senão `Estoque Ideal Total`.

### 4.6 `SALDO Estoque Ideal <SKU>`
`= Estoque do SKU − Estoque Ideal <SKU>` (base). (No DAX o SALDO do Extrato tinha um typo
`Extrato − Extrato`; foi **corrigido** para `Extrato − Estoque Ideal Extrato`, conforme validado.)

### 4.7 `Ajuste` (nível SKU — unpivot)
`SWITCH(TRUE(), …)` com blank tratado como 0:
```
1) Positivar   : Estoque Atual = 0 AND Delta > 0
2) Manter      : Delta = 0
3) Aumentar VB : Estoque Atual > 0 AND Delta > 0
4) Inativar    : Estoque Atual > 0 AND Estoque Ideal = 0
else Diminuir VB
```

---

## 5. Origem (Power BI → SQL)

Mapeamento das queries/tabelas do modelo Power BI para as fontes do banco:

| Objeto no Power BI | Origem no banco |
|---|---|
| `analise_estoque_pdv` (API) | `estoque_redes.analise_estoque_pdv` |
| `fato_cdd` (API `cddd.fato_cdd`) | `cddd.fato_cdd` |
| `dim_pdvs` (API `cddd.pdvs`) | `cddd.pdvs` |
| `dim_apres` (Snowflake CDD.APRES) | `cddd.apres` |
| `forca_vendas` (Snowflake CDD.FORCA_VENDAS) | `cddd.forca_vendas` |
| `dim_pdv_tdd` (Snowflake TDD.DIM_PDV) | `tdd.dim_pdv` |
| `cobertura_fv` | `forca_vendas ⋈ dim_pdv_tdd` (embutido em `fato_todos_pdvs`) |
| Medidas/colunas DAX (`Estoque Ideal`, `STATUS_PARAMETRIZADO`, `Ajuste`, …) | colunas de `fato_adequacao_estoque` / `_unpivot` |

Chaves de junção principais:
- `fato_cdd.cod_pdv` (text) ⋈ `pdvs.cod_pdv`, `fato_cdd.cod_apresentacao` ⋈ `apres.cod_apresentacao`.
- `fato_todos_pdvs.CHAVE_ESTOQUE_CDD` ⋈ `fato_cdd_90_dias_agrupada.CHAVE_ESTOQUE_CDD`.
- Cobertura: `forca_vendas.cod_utc` ⋈ `dim_pdv.UTC_PDV`; depois `dim_pdv.CNPJ_PDV` ⋈ `cnpj_pdv`.

---

## 6. Scripts (`sql/trade_fv/`)

| Arquivo | Papel |
|---|---|
| `01_views_base.sql` | Cria o schema `trade_fv` e a VIEW `analise_estoque_pdv`. |
| `02_deploy_materialized.sql` | (Re)cria as 3 materialized views + índices. **Deploy/rebuild completo — fonte única do matview `fato_adequacao_estoque` (re-executável, `DROP ... CASCADE`); editar aqui, não duplicar o corpo em migrações novas.** |
| `03_refresh.sql` | `REFRESH` das 3 matviews na ordem correta. **Usado no agendamento.** |
| `04_unpivot.sql` | Cria/atualiza a VIEW `fato_adequacao_estoque_unpivot`. **Rodar de novo após qualquer rebuild do `02`** (é derrubada pelo `CASCADE`). |
| `05_sugestao_fv.sql` | Cria a TABELA `sugestao_fv` (sugestões dos representantes — ver seção 11). |
| `06_sugestao_workflow.sql` | Workflow de aprovação (status/decisão em `sugestao_fv`) + VIEW `fato_adequacao_estoque_unpivot_ajustada`. **Rodar de novo após qualquer rebuild do `02`.** |
| `07_usuarios.sql` | Login individual: VIEW `vw_representantes_ativos` + TABELA `usuario` (ver seção 11). |
| `08_index_categoria.sql` | Índice de performance em `tdd.fato_tdd` (schema de origem) — acelera a busca de Categoria do PDV de ~5s para ~100ms. |

### Deploy do zero
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/01_views_base.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/02_deploy_materialized.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/04_unpivot.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/05_sugestao_fv.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/06_sugestao_workflow.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/07_usuarios.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/08_index_categoria.sql
```

### Alterar a estrutura do matview `fato_adequacao_estoque`
Editar **diretamente em `02_deploy_materialized.sql`** (ele já é `DROP ... CASCADE` +
`CREATE`, então é seguro re-rodar). Depois, sempre recriar as views dependentes:
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/02_deploy_materialized.sql   # ~1min30s
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/04_unpivot.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/06_sugestao_workflow.sql
```

### Refresh (rotina)
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/trade_fv/03_refresh.sql
```
Opcional não-bloqueante: variante `REFRESH ... CONCURRENTLY` (comentada no arquivo) funciona em
`fato_cdd_90_dias_agrupada` e `fato_adequacao_estoque` (têm índice único); `fato_todos_pdvs`
não tem chave única, então fica sem `CONCURRENTLY`.

---

## 7. Agendamento no Railway

`pg_cron` **não está disponível** neste Postgres, então o refresh roda via **Cron Job do Railway**.

- **Build:** `Dockerfile` na raiz (imagem `postgres:17-alpine`, que já traz `psql`); o `CMD`
  executa `sql/trade_fv/03_refresh.sql` e o container encerra (~1m30s).
- **Variável:** `DATABASE_URL` referenciando o serviço Postgres do projeto
  (`Add Reference → Postgres → DATABASE_URL`). **Sem quebra de linha no valor.**
- **Cron Schedule** (Settings → Deploy): em **UTC**. Ex.: `0 9 * * *` = 06:00 BRT.
- **Log de sucesso esperado:**
  ```
  SET
  REFRESH MATERIALIZED VIEW
  REFRESH MATERIALIZED VIEW
  REFRESH MATERIALIZED VIEW
  ```

---

## 8. Validação

Comparação contra exports do Power BI (`fato_adequacao` e positivação PAGUEMENOS):

- **Geral (9.767 PDVs):** todas as colunas batem (CAT, estoques, sell-out, `Ultima Venda (dias)`,
  `Estoque Total`, `POTENCIAL`, `cnpj_pdv_padronizado`, `Rede`, ideais, saldos, finais, status).
- **PAGUEMENOS (6.228 linhas do unpivot):** **verbatim** — CAT, Cobertura FV, Estoque Atual,
  Estoque Ideal, Delta, Ajuste todos idênticos; **Positivar 541 = 541**.
- **Única divergência:** `COBERTURA FV?` em 115 PDVs (SAOJOAO/PANVEL/RAIA/CLAMED/INDIANA, **nenhum
  PAGUEMENOS**) — é **diferença de snapshot**: esses PDVs ganharam representante em
  `forca_vendas`/`dim_pdv` **após** o export do Power BI. A lógica é idêntica; a base reflete o dado novo.
  Dessas, 7 mudam de `STATUS` em cascata.

**Conclusão:** as sugestões batem 100% com o Power BI, exceto a defasagem de dados de cobertura.

---

## 9. Nuances conhecidas (para evitar "falsos bugs")

1. **Snapshot de cobertura:** `COBERTURA FV?` depende de `forca_vendas`/`dim_pdv`, que mudam no
   tempo. Diferenças pontuais vs. exports antigos são esperadas.
2. **`Média Mensal` = 0 vs. blank:** no banco é `0` quando não há venda; no Power BI é branco.
   Coluna de exibição, sem impacto em cálculo. Decisão: **mantida como 0**.
3. **Assimetria `Estoque Total` (3 SKUs) × `Estoque Ideal Total` (4 SKUs):** intencional (do DAX).
4. **`EstoqueIdealNulo` nunca dispara:** os `Estoque Ideal` são `0`, não nulos.
5. **`Status` (PDV) × `Ajuste` (SKU):** granularidades diferentes; podem divergir na mesma linha.
6. **Memória da instância:** não recomputar toda a cadeia numa única query — usar as matviews
   em camadas (por isso o modelo é materializado).

---

## 10. Estrutura de arquivos

```
.
├── Dockerfile                 # Cron Job do Railway (psql + 03_refresh.sql)
├── .gitignore                 # ignora .env, *.csv, node_modules
├── .env                       # credenciais (NÃO versionado)
├── sql/
│   └── trade_fv/
│       ├── 01_views_base.sql
│       ├── 02_deploy_materialized.sql
│       ├── 03_refresh.sql
│       ├── 04_unpivot.sql
│       ├── 05_sugestao_fv.sql
│       ├── 06_sugestao_workflow.sql
│       ├── 07_usuarios.sql
│       └── 08_index_categoria.sql
├── app/                       # Sistema web de indicação de PDVs (seção 11)
│   ├── package.json
│   ├── server.js              # Express + pg (API + estáticos)
│   └── public/
│       ├── index.html
│       ├── styles.css         # design system Ease Labs
│       └── app.js
└── ui-html/
    └── ease-labs-ui-system.html   # referência de identidade visual
```

---

## 11. Sistema web — Indicação de PDVs pela Força de Vendas (`app/`)

Sistema em que o **representante de vendas** (identificado pelo `desc_territorio` de
`cddd.forca_vendas`) indica um **PDV para positivação** e o **VB (volume base)** do SKU,
com **workflow de aprovação pelo BI&A**.

### Acesso — login individual + RLS
**Fonte dos representantes ativos** (`trade_fv.vw_representantes_ativos`):
`cddd.forca_vendas` (território) ⋈ `cddd.scd_ct_territorio`
(**CT ativo** = `data_saida_territorio IS NULL`) ⋈ `cddd.dim_ct` (`nome_abreviado_ct`,
`email_ct`), excluindo setores vagos / SEM REP e CTs demitidos.

**`trade_fv.usuario`**: admins + representantes. `usuario` = slug do `nome_abreviado_ct`
(ex.: *Rogério Sudário* → `rogerio_sudario`), `senha_hash` (**scrypt**, nunca texto puro),
`senha_padrao` (TRUE até o usuário trocar), `ativo`, `cod_ct`/`cod_territorio`/
`desc_territorio` (identidade das sugestões), `ultimo_login`.

**Sincronização automática** (boot do app + a cada 6 h + botão do admin):
novo CT ativo ⇒ usuário criado com a **senha padrão inicial** (`APP_SENHA_PADRAO`,
default `easelabs@2026`); CT que saiu do território ⇒ usuário **desativado**
(histórico preservado). Admins fixos criados no seed: `paulo_lima`, `rubens_filho`,
`natalia_miranda` (mesma senha padrão inicial; todos podem trocá-la no app —
"Alterar senha", mínimo 8 caracteres — e o admin pode **redefinir** qualquer senha
de volta à padrão).

**RLS aplicado no servidor** (sessão HMAC de 12 h em `X-Auth-Token`, payload com
uid/role/território):
- Rep **entra direto no próprio território** (sem etapa de escolha) — o corpo da
  requisição não consegue registrar sugestão em nome de outro representante.
- Rep lista apenas as próprias sugestões; `all=1`, aprovações, usuários e a lista de
  representantes são admin-only.
- Admin pode simular o fluxo de qualquer representante (etapa 1 só existe para admin).
*Futuro:* fluxo de e-mail (verificação/reset via SMTP, como no app de eventos) pode ser
plugado depois — a coluna `email` já vem do `dim_ct`.

### Navegação (SPA com rotas)
`/login`, `/representante`, `/sugerir`, `/sugerir/validar`, `/sugerir/vb`,
`/sugerir/enviada`, `/admin`, `/admin/aprovacoes`, `/admin/usuarios`, `/senha` — History
API no cliente + fallback no Express; deep links e botão voltar do navegador funcionam.
Identidade visual: logo oficial (`public/logo.png`), fundo em gradiente suave da marca.

### Fluxo do representante (login individual → 3 etapas + confirmação)
O representante já entra amarrado ao próprio território (RLS — ver acima), então o fluxo
começa direto na busca de PDV. A etapa "escolher representante" só existe para o **admin**
simular o fluxo de qualquer um (ver Painel do Administrador).
1. **Buscar PDV** — busca em `tdd.dim_pdv` por CNPJ/nome/cidade/bairro/endereço **ou rede**
   (aliases digitáveis: "pague menos", "drogasil", "são joão", "venâncio"; match de rede é
   priorizado na ordenação), retornando **apenas PDVs presentes na base de adequação**.
   Os resultados exibem o **nome normalizado da rede** (`REDE_LABEL`: RAIA → Raia Drogasil,
   PAGUEMENOS → Pague Menos, SAOJOAO → São João…) no lugar da razão social. **Cadastro
   manual** disponível para PDVs fora da base. Debounce de 150 ms no cliente — a query no
   servidor responde em ~100–400 ms (ver [Índice de performance](#índice-de-performance)).
2. **Validar PDV** — nome da rede normalizado + razão social + endereço + **Categoria**
   (só o número — sem período/`CAT_UN`, informação interna) + cobertura FV. Inclui um
   **mapa** com a localização real do PDV (ver Localização/Street View abaixo).
3. **Sugerir VB** — os 4 SKUs com Estoque Atual / **VB Sugerido Atual** / Delta / **Und por
   mês** (`Média Mensal`, mesma estilização das outras métricas, só a cor identifica que é
   qualitativa) e a **Sugestão atual** (`Ajuste`). Cada SKU tem cor de identidade (borda +
   marcador): Isolado 30 `#5661E8`, Isolado 10 `#94A8F7`, Isolado 20 mg `#C8A8F7`,
   Extrato `#6ECC64`. **Bloqueio:** sem duas sugestões PENDENTES do mesmo rep para o mesmo
   CNPJ × SKU. **O representante não vê o histórico de sugestões** (próprias ou de
   terceiros) — isso é exclusivo do BI&A no painel de Aprovações.

### Painel do Administrador
Quatro cartões: **Fluxo do Representante** (simula qualquer território, com "Voltar ao
painel" nas etapas 1 e 2), **Ajustar VB (BI&A)** (busca um PDV e define o VB diretamente —
grava com `status_aprovacao = 'APROVADA'` e `"Representante" = 'BI&A'`, sem passar pelo
bloqueio de pendência), **Aprovações (BI&A)** e **Usuários**.

### Localização do PDV (mapa)
Na etapa "Validar PDV", **mapa embutido** com [Leaflet](https://leafletjs.com/) + tiles do
**OpenStreetMap** (`unpkg.com/leaflet`, CDN público) — 100% gratuito, sem chave de API, sem
cadastro, sem cartão. Mostra o pino exato do PDV (`GOOGLE_LATITUDE`/`GOOGLE_LONGITUDE` de
`tdd.dim_pdv`) com zoom/pan.

**Cobertura real**: dos **9.767 PDVs mapeados no sistema** (redes com sugestão de VB — não
o universo inteiro da `dim_pdv`), **8.646 (88,5%)** têm coordenadas. Sem coordenadas, o
bloco do mapa é **totalmente omitido** — sem placeholder, sem mensagem — e a tela segue
direto para a tabela de dados do PDV, como se o mapa nunca tivesse existido.

*Descartamos o Google Maps Embed/Street View API e também o link de Street View real*: além
do Google exigir cartão de crédito vinculado ao projeto para habilitar qualquer API do Maps
Platform (mesmo as gratuitas), um botão extra de Street View foi avaliado como fonte de
confusão para o representante e removido.

### Categoria do PDV (CAT_UN)
`tdd.dim_pdv` (CNPJ→`COD_PDV`) ⋈ `tdd.fato_tdd` com `COD_GRUPO = 3` e o **período mais
recente** — `MAX` do anomes após o `_` de `COD_PERIODO` (ex.: `SEM01_202601` > `TRIM01_202506`),
robusto a cargas futuras. Exibida na busca, na validação e na barra de contexto.

### Índice de performance
`tdd.fato_tdd` (schema de origem, ~220 mil linhas) não tinha nenhum índice — o lookup de
Categoria por PDV disparava um `Seq Scan` completo por candidato, deixando buscas por rede
(que casam dezenas de PDVs) em 5–6 s. `08_index_categoria.sql` cria
`ix_fato_tdd_pdv_grupo_periodo ("COD_PDV", "COD_GRUPO", "COD_PERIODO" DESC)`: mesma
consulta cai para ~100 ms (`EXPLAIN ANALYZE` confirmado). Não altera dados nem lógica.

### Workflow de aprovação (`06_sugestao_workflow.sql`)
`trade_fv.sugestao_fv` (snapshot da unpivot + `"Sugestao VB"` + `"Representante"`) ganhou:
- `created_at` = **data de envio**; `status_aprovacao` (`PENDENTE` default | `APROVADA` |
  `RECUSADA`); `decidido_por` / `decidido_em`.
- Índice **único parcial** `("CNPJ","EAN","Representante") WHERE status = 'PENDENTE'` —
  garante o bloqueio de duplicidade no banco; o histórico fica em linhas separadas.
- **Modo BI&A**: quando o admin ajusta o VB diretamente (`POST /api/sugestoes` com
  `modo:'bia'`), a linha já entra com `"Representante" = 'BI&A'` e
  `status_aprovacao = 'APROVADA'` (sem passar pelo bloqueio de pendência nem pela fila).

**`trade_fv.fato_adequacao_estoque_unpivot_ajustada` (VIEW)** — a sugestão padrão
sobrescrita pelas sugestões **aprovadas**: `"Estoque Ideal"` = VB aprovado (**a mais
recente** por CNPJ × SKU — se o rep pedir 5 e depois 8 e ambas forem aprovadas, vale a
última aprovação, via `ORDER BY decidido_em DESC`), `Delta`/`Ajuste` recalculados, +
`"Estoque Ideal Sistema"`, `"Origem Sugestao"` (`Representante`/`Sistema`) e
`"Representante"`. PDVs aprovados fora da base (cadastro manual) entram como linhas
adicionais. É esta view que o downstream deve consumir como "sugestão oficial".

### API (Express)
| Rota | Auth | Descrição |
|---|---|---|
| `POST /api/login` | — | `{usuario, senha}` → `{token, role, nome, territorio, senha_padrao}`. |
| `POST /api/senha` | login | Troca a própria senha (`{senha_atual, senha_nova}`). |
| `GET /api/usuarios` | admin | Lista usuários (papel, território, ativo, senha padrão, último login). |
| `POST /api/usuarios/:id/reset-senha` | admin | Redefine a senha do usuário para a padrão. |
| `POST /api/usuarios/sync` | admin | Roda a sincronização de representantes agora. |
| `GET /api/representantes` | admin | Territórios válidos (simulação do fluxo do representante). |
| `GET /api/redes` | login | Redes da base de adequação (cadastro manual). |
| `GET /api/pdvs?q=` | login | Busca de PDVs (base de adequação) com rede e categoria. |
| `GET /api/pdv/:cnpj` | login | Dados + categoria + adequação (com `media_mensal`) + território. Sugestões existentes só vêm para `role=admin`. |
| `POST /api/sugestoes` | login | Insere sugestão (snapshot). `{modo:'bia'}` (admin) grava já aprovada como `'BI&A'`. **409** se já houver PENDENTE do rep p/ CNPJ × SKU (não se aplica ao modo BI&A). |
| `GET /api/sugestoes?rep=` \| `?cnpj=` \| `?all=1[&rep=&status=]` | admin | Histórico de sugestões (com `media_mensal`) — **exclusivo do admin**; reps recebem `[]`. |
| `PATCH /api/sugestoes/:id` | admin | `{acao: APROVADA\|RECUSADA}` → decide pendente. |

### Rodar local
```powershell
# PowerShell (Windows)
cd app
npm install   # só na primeira vez (cria node_modules/)
npm start     # http://localhost:3000 (lê ../.env)
```
```bash
# bash/zsh
cd app && npm install && npm start
```

### Deploy no Railway
Criar um serviço apontando para o repositório com **Root Directory = `app`** (Nixpacks
detecta o `package.json`; start = `npm start`) e a variável `DATABASE_URL` referenciando
o Postgres do projeto. O servidor usa `PORT` do ambiente automaticamente.
