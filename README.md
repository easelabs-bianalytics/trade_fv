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

estoque_redes.analise_estoque_pdv (fonte externa)   cddd.fato_cdd (fonte externa)
        │                                                   │
        │                                                   ▼
        │                                trade_fv.fato_cdd_90_dias_agrupada ... MATVIEW (sell-out 90 dias)
        │                                                   │
        └───────────────────────┬───────────────────────────┘
                                 ▼
              trade_fv.fato_todos_pdvs ............. MATVIEW (1 linha por PDV×SKU: estoque + sell-out + cobertura FV)
                                 │
                                 ▼
              trade_fv.fato_adequacao_estoque ...... MATVIEW (1 linha por PDV: estoque/sell-out por SKU + regras/sugestão)
                                 │
                                 ▼
              trade_fv.fato_adequacao_estoque_unpivot ... VIEW (1 linha por PDV×SKU: unpivot + EAN/Delta/Ajuste)
```

> **Nota:** existiu uma `trade_fv.analise_estoque_pdv` (cópia da view acima) — foi **removida**
> por ser redundante. Ver [seção 9, item 7](#9-nuances-conhecidas-para-evitar-falsos-bugs).

**Ordem obrigatória de refresh** (dependências):
`fato_cdd_90_dias_agrupada` → `fato_todos_pdvs` → `fato_adequacao_estoque`.
A **VIEW** `fato_adequacao_estoque_unpivot` é "ao vivo" e não precisa de refresh.

### Por que materialized views?
Recomputar toda a cadeia numa única query (cross-join + múltiplos joins pesados + dupla
leitura de `cddd.fato_cdd`) estourava a memória da instância. Materializando em camadas,
cada nível lê a matview já pronta da camada anterior; o refresh completo leva **~1m30s**.

---

## 3. Objetos do schema `trade_fv`

### 3.1 `fato_cdd_90_dias_agrupada` (MATVIEW)
Sell-out (unidades) dos **últimos 90 dias**, agrupado por chave PDV+EAN.
- **Fonte:** `cddd.fato_cdd` (transações), enriquecida com `cddd.pdvs` (CNPJ) e `cddd.apres` (EAN/descrição).
- **Filtros:** apenas `cod_tipo_transacao = '1'` (vendas); janela = `[max(cod_anomes) − 91 dias, max(cod_anomes)]`.
- **`und_ajus` = `und / 1000`** (unidade ajustada). `Unidades Total` = `SUM(und_ajus)`.
- **Chave:** `CHAVE_ESTOQUE_CDD` = `cnpj_pdv || EAN`.
- **Índice único:** `(CHAVE_ESTOQUE_CDD, DESC_APRESENTACAO)`.
- **Colunas:** `CHAVE_ESTOQUE_CDD`, `DESC_APRESENTACAO`, `Unidades Total`.

### 3.2 `fato_todos_pdvs` (MATVIEW)
Uma linha por **PDV × SKU** com estoque atual, sell-out (via join) e cobertura de força de vendas.
- **Fonte:** `estoque_redes.analise_estoque_pdv` (schema de origem, direto — sem cópia
  intermediária em `trade_fv`) + `trade_fv.fato_cdd_90_dias_agrupada` + cobertura FV.
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

### 3.3 `fato_adequacao_estoque` (MATVIEW)
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

### 3.4 `fato_adequacao_estoque_unpivot` (VIEW)
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
| `01_views_base.sql` | Cria o schema `trade_fv` + as VIEWs iniciais `fato_cdd_90_dias_agrupada` e `fato_todos_pdvs` (passo 1 do deploy do zero — o `02` as converte em MATVIEW logo em seguida; rodar de novo depois disso falha, pois os nomes já são matviews). |
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
7. **`trade_fv.analise_estoque_pdv` foi removida.** Existiu uma cópia idêntica
   (`CREATE OR REPLACE VIEW`) da `estoque_redes.analise_estoque_pdv` dentro de `trade_fv` —
   resquício do primeiro rascunho do modelo, antes de `fato_todos_pdvs` passar a ler a
   origem diretamente. Verificação antes de excluir: contagem igual (39.068 = 39.068),
   `EXCEPT` nos dois sentidos = 0 (idênticas linha a linha), zero objetos no banco
   (`pg_depend`) e zero referências no app apontando para ela — já estava órfã. Removida em
   2026-07-23. Se precisar da view em `trade_fv` de novo por algum motivo, é só recriar
   com `CREATE VIEW trade_fv.analise_estoque_pdv AS SELECT * FROM estoque_redes.analise_estoque_pdv;`.

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

**Tela "Alterar minha senha"**: os três campos têm botão de **exibir/ocultar caracteres**
(ícone de olho, `aria-pressed` + `aria-label` alternados). Digitar uma senha nova às cegas
e ainda ter que repeti-la era a maior fonte de erro ali. A exibição **volta a ocultar
sozinha** ao sair da tela (`goTo`), para a senha não ficar à mostra num celular esquecido
na mesa. Um aviso curto lembra que a senha é pessoal e que só o próprio usuário tem acesso
a ela.

**Senha esquecida**: não há recuperação — senha é hash scrypt, não é reversível. O caminho
é **Admin → Usuários → Redefinir senha** (`POST /api/usuarios/:id/reset-senha`), que
regrava o hash para `APP_SENHA_PADRAO` e marca `senha_padrao = TRUE`, fazendo o usuário
cair de novo no aviso de troca no próximo login. Autoatendimento por e-mail (link com
token expirável, SMTP Office 365) foi avaliado e **adiado** — a coluna
`trade_fv.usuario.email` já está populada para os 32 reps ativos caso venha a ser feito.

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

### App shell (barra de navegação superior)
Barra **sticky** com fundo translúcido (`backdrop-filter`), montada dinamicamente por
`renderNav()` conforme o papel — o item ativo é derivado de `state.painelAtual`:
- **Admin:** `Painel` · `Sugerir VB ▾` (dropdown: *Como representante* / *Ajustar como BI&A*)
  · `Aprovações` (com **badge da contagem de pendentes**) · `Usuários`.
- **Representante:** `Nova sugestão` · `Minhas sugestões` (só as **próprias**, com o status da
  análise — o RLS no servidor ignora qualquer filtro por outro território/CNPJ vindo do
  cliente; o histórico continua **fora** dos cards de SKU da etapa 4).
- **Menu do usuário** no avatar (dropdown): nome/login, *Trocar representante* (só admin em
  simulação), *Alterar senha*, *Sair*. Substituiu os botões soltos do cabeçalho antigo.
- **Logo é atalho para o início** (convenção de app): representante → `Nova sugestão`;
  admin → `Painel`.
- **Largura adaptativa** (`.page-wide`): telas de tabela (Aprovações/Usuários/Minhas
  sugestões) usam 1280px no desktop —
  a tabela de Aprovações passou a caber inteira, sem scroll horizontal; o fluxo de sugestão
  segue em 920px, estreito e focado. No tablet/celular essas mesmas tabelas viram cartões
  (ver *Responsividade* abaixo).
- Como a barra é persistente, os links "Voltar ao painel" das telas de Aprovações e Usuários
  ficaram redundantes e foram removidos (o item `Painel` do nav faz o papel). Os "voltar"
  das etapas do fluxo foram mantidos.
- **Detalhes de produto**: título da aba muda por página (`Painel · Ease Labs`), cabeçalho
  das tabelas fica **fixo ao rolar** (o container rola, não a página), linhas com zebra
  sutil + hover, estados vazios com ícone e chamada para ação, e rodapé discreto.
- **Layout de altura cheia**: `body` é um flex column com `min-height: 100vh` e a `.page` tem
  `flex: 1 0 auto` — o rodapé fica **colado no fim da tela** mesmo em páginas curtas, em vez
  de boiar no meio do vazio. A `max-height` do `.table-wrapper` é calculada para o conjunto
  (topbar + cabeçalho + filtros + rodapé) caber na viewport: só as linhas rolam, sem um
  segundo scroll na página.

### Responsividade — tablet e celular (uso em campo)
Os representantes operam em **tablet Samsung** (Galaxy Tab, ~800×1280 em retrato,
1280×800 em paisagem) dentro das farmácias, em pé, com o polegar. O sistema foi validado
em três viewports (tablet retrato/paisagem e celular 412px) com Playwright emulando toque.
A régua não é "caber", é **operar com o dedo, sem enganar**:

- **Alvos de toque ≥ 44px** (WCAG 2.5.5 / guia da Apple) sob `@media (pointer: coarse)`:
  itens do nav, *Voltar*, botões, o olho da senha e principalmente o **stepper do VB**
  (−/+ passam de 38 → 52px, onde o dedo mais errava). Os controles de zoom do Leaflet
  também são ampliados para 44px. Campos de texto usam `font-size: 16px` para o iOS/Android
  **não dar zoom automático** ao focar.
- **Zero rolagem lateral**: `html { overflow-x: clip }` (não `hidden`, que criaria contexto
  de rolagem e mataria a topbar `sticky`). Confirmado empiricamente — `scrollTo(9999,0)`
  não move nada em nenhuma tela.
- **`100dvh`** no `body` e na altura da tabela: desconta a barra de endereço do navegador
  móvel, que muda a altura visível ao rolar. Área segura (`env(safe-area-inset-bottom)`)
  aplicada à barra de envio, ao rodapé e ao toast, para não ficarem atrás do gesto de
  navegação do Android.
- **Nav que rola no eixo X** abaixo de 900px, com **máscara de esmaecimento à direita**
  sinalizando "tem mais itens para o lado" — sem ela o usuário não descobre.
- **Tabelas viram cartões** abaixo de 860px (Aprovações, Usuários, Minhas sugestões): o
  `<thead>` some e cada `<td>` mostra seu rótulo via `::before` a partir de `data-label`
  (preenchido no `app.js`). Uma tabela de 11 colunas é ilegível em 412px; o cartão empilha
  rótulo → valor e cada registro fica autocontido. Em Aprovações, os botões ✓/✗ de 32px
  viram **dois botões largos com texto** ("Aprovar" / "Recusar"), lado a lado.
- **Mapa que não sequestra o gesto**: no toque, **1 dedo rola a página, 2 dedos movem o
  mapa** (`dragging` desligado, reativado só com `touches.length >= 2`), com a legenda
  *"Use dois dedos para mover o mapa"*. Sem isso o mapa engole a rolagem e prende o usuário.
- **Sem hover grudento**: os `:hover` de cards/linhas/resultados ficam sob
  `@media (hover: hover)` — no toque eles "grudavam" após o tap. No lugar, `:active` dá o
  feedback de pressionar. `-webkit-tap-highlight-color: transparent` remove o flash cinza
  do Android. `prefers-reduced-motion` zera as animações para quem pede menos movimento.

### Identidade das redes (logos e cores)
As logos das 10 redes são usadas em três pontos:
- **Etapa 2 (busca)** e **etapa 3 (validação)**: substituem o ícone genérico de prédio —
  o representante identifica a bandeira de relance.
- **Etapa 4**: a barra de contexto do PDV assume a **cor de marca da rede** no lugar do navy.

PDVs sem rede conhecida (cadastro manual) mantêm o ícone de prédio e a barra navy.

#### Pipeline das logos
```
ui-html/redes_logos/   (originais, como recebidas)
        │  python scripts/normalizar_logos.py
        ▼
app/public/redes/<codigo>.png   (256×256, servidas pelo app)
```
Cada arte vinha com uma quantidade diferente de margem embutida — no tile, umas ficavam
"afastadas" (Raia, Venâncio) e outras quase encostando na borda (Pague Menos). O script
**recorta a margem original** (bounding box do que difere do fundo) e redesenha tudo num
quadrado com o conteúdo ocupando **86%** — assim todas têm o mesmo peso visual. O tile no
front usa `object-fit: contain`, então nada é cortado.

**Para trocar uma logo:** substitua o arquivo em `ui-html/redes_logos/` e rode
`python scripts/normalizar_logos.py`. O script casa os arquivos pelo **nome normalizado**
(minúsculas, sem acento/pontuação) e aceita `.png/.jpg/.jpeg/.webp` — então `Clamed.jpg`,
`clamed.png` e `CLAMED.jpeg` são todos reconhecidos, e trocar o formato do arquivo não
quebra nada. Ele imprime a cor de marca de cada rede: **se a cor mudar, atualize
`REDE_MARCA` em `public/app.js`**.

Trocar direto em `app/public/redes/<codigo>.png` também funciona na hora (é servido
estaticamente), mas aí sem a normalização de margem — e pode ser preciso um *hard refresh*
(Ctrl+F5) por causa do cache do navegador.

#### Cores de marca
São a **cor predominante da própria logo**, extraída pelo mesmo script. Quando a cor é clara
demais para texto branco, o app troca o texto da barra para grafite (`textoEscuro`):

| Rede | Cor | Texto | Rede | Cor | Texto |
|---|---|---|---|---|---|
| Araujo | `#07419F` | branco | Pague Menos | `#0200BE` | branco |
| Clamed | `#054E31` | branco | Panvel | `#002A89` | branco |
| DPSP | `#2E3344` | branco | Raia (Drogasil) | `#E01E3B` | branco |
| Drogal | `#FEE24B` | **grafite** | São João | `#3A1267` | branco |
| Indiana | `#072AC6` | branco | Venâncio | `#D8163C` | branco |

Todas as combinações passam no contraste **WCAG AA** (mínimo 4,5:1) — a menor é a do
Raia, com 4,75.

### Fundo da página (variantes)
As quatro opções ficam prontas no CSS como classes do `<body>` — trocar é mudar **uma
palavra** em `index.html`, sem perder nenhuma:

| Classe | Descrição |
|---|---|
| `bg-gradiente` | **Padrão atual** — gradiente da marca (verde + índigo). |
| `bg-neutro` | Cinza `#F7F8FA` liso; cor fica reservada aos dados. |
| `bg-pontos` | Neutro com grid de pontos (textura de ferramenta técnica). |
| `bg-suave` | Gradiente da marca com metade da saturação. |

> **Leaflet + painel oculto:** o mapa da etapa 3 precisa ser montado com o painel **já
> visível** — se o container estiver `display:none`, o Leaflet mede 0×0 e os tiles nunca
> carregam (o mapa fica cinza). Por isso `goTo()` vem **antes** de `renderValidacao()` em
> todos os caminhos, e `montarMapaPdv()` ainda chama `invalidateSize()` no próximo frame e
> ao fim da animação de entrada.

### Painel do admin (`/admin`)
Home com **KPIs ao vivo** (`GET /api/dashboard`): aguardando análise (clicável → Aprovações),
aprovadas no mês, representantes ativos e PDVs na base. Abaixo, *Ações rápidas* com
**Fluxo do Representante** e **Ajustar VB (BI&A)** — Aprovações e Usuários vivem no nav.

### Fluxo do representante (login individual → 3 etapas + confirmação)
O representante já entra amarrado ao próprio território (RLS — ver acima), então o fluxo
começa direto na busca de PDV. A etapa "escolher representante" só existe para o **admin**
simular o fluxo de qualquer um (ver Painel do Administrador).
1. **Buscar PDV** — busca em `tdd.dim_pdv` por CNPJ/nome/cidade/bairro/endereço **ou rede**
   (aliases digitáveis: "pague menos", "drogasil", "são joão", "venâncio"), retornando
   **apenas PDVs presentes na base de adequação**.
   Os resultados exibem o **nome normalizado da rede** (`REDE_LABEL`: RAIA → Raia Drogasil,
   PAGUEMENOS → Pague Menos, SAOJOAO → São João…) no lugar da razão social. **Cadastro
   manual** disponível para PDVs fora da base. Debounce de 150 ms no cliente — a query no
   servidor responde em ~100–400 ms (ver [Índice de performance](#índice-de-performance)).
   - **Acentos são ignorados.** A base está praticamente sem acentos (≈2 linhas em 28 mil),
     então o termo digitado é normalizado no servidor (`semAcento`, NFD + remoção de
     diacríticos): "Goiânia" casa com `GOIANIA`, "São Paulo" com `SAO PAULO`.
   - **Busca por várias palavras** vira `AND` de tokens (até 6): cada palavra precisa
     aparecer em algum campo. "raia goiania" devolve as lojas da Raia em Goiânia.
   - **Ordenação por relevância** — cidade exata primeiro (é como o rep pensa: *"quero em
     Goiânia"*), depois bairro, depois a rede digitada; só então situação ATIVA e ordem
     alfabética. Sem isso, buscar uma cidade grande devolvia 25 PDVs quaisquer entre
     centenas.
   - **Sem contador de resultados.** Chegou a existir um aviso *"Mostrando 25 de 1643"*,
     removido a pedido: o número assustava mais do que orientava, e o `COUNT(*) OVER()`
     que o alimentava obrigava o Postgres a materializar todas as linhas antes do
     `LIMIT 25`. A rota devolve o array direto.
2. **Validar PDV** — nome da rede normalizado + razão social + endereço + **Categoria**
   (só o número — sem período/`CAT_UN`, informação interna) + cobertura FV. Inclui um
   **mapa** com a localização real do PDV (ver Localização/Street View abaixo).
3. **Sugerir VB** — três métricas por SKU (**Estoque atual**, **VB Sugerido Atual**,
   **Und/mês**) mais a **Sugestão atual** (`Ajuste`). *O Delta foi removido* (número solto,
   só poluía) e a **barra comparativa estoque × VB também** — ela dava a impressão de que o
   VB "certo" era o do BI e confundia o representante, que é justamente quem deve propor
   outro número.
   - **Cores por SKU** (`--sku-color`): Isolado 30 `#5661E8`, Isolado 10 `#94A8F7`,
     Isolado 20 mg `#C8A8F7`, Extrato `#6ECC64`. Aparecem na faixa lateral, no marcador, no
     **hover**, no **:active** (pressionar) e na **seleção** — card selecionado usa a cor do
     SKU na borda, no fundo (7%), no halo e no checkbox. O índigo padrão fica só como
     fallback para SKU sem cor mapeada.
   - **Seleção múltipla:** o representante marca quantos SKUs quiser e define o VB de cada
     um; um clique em Enviar grava todos. Cada SKU vira um **registro independente** em
     `sugestao_fv`, aprovado ou recusado separadamente pelo BI&A.
   - **Dica condicional** dentro da caixa do VB: aparece com transição suave (ícone de
     lâmpada) só quando a proposta destoa em **2 ou mais unidades** da média mensal —
     acima, avisa sobre *produto parado na prateleira*; abaixo, sobre *falta de estoque no
     PDV*. Some sozinha quando o valor volta à faixa.
   - **Bloqueios de envio** (nada é gravado quando algum deles dispara):
     1. **VB igual ao do BI** — repetir o número que o BI já sugere não é uma sugestão. O
        aviso sai **só no Enviar** ("*O VB 10 que você sugeriu para Isolado 30 mL já é o VB
        sugerido atualmente neste PDV*"); não há mais aviso *inline* enquanto o rep mexe no
        número — ficava barulhento durante a digitação. Num lote, **basta um SKU nessa
        situação para barrar o lote inteiro** — o rep ajusta e reenvia.
     2. **Sugestão PENDENTE duplicada** para o mesmo CNPJ × SKU. Quando mais de um SKU
        cai nesse caso, a mensagem é **consolidada** ("*você já tem uma pendente para
        Isolado 30 mL, Isolado 10 mL e Extrato*") em vez de mostrar só a primeira.
     > Os dois bloqueios existem no cliente (feedback imediato) **e** no servidor
     > (`POST /api/sugestoes` responde 409) — o cliente é conveniência, o servidor é a regra.
   - **Nenhum histórico aparece nos cards de SKU** — o representante acompanha as próprias
     sugestões na página `Minhas sugestões`; as de **terceiros** são exclusivas do BI&A no
     painel de Aprovações.

> **Nota sobre o VB padrão:** ao marcar um SKU, o campo vem preenchido com o VB do BI (é a
> referência). Como repetir esse valor é bloqueado, o aviso laranja aparece de imediato,
> deixando explícito que o rep precisa decidir um número próprio. Se preferirmos que o campo
> comece vazio ou já deslocado, é uma linha em `alternarSku()`.

### Modos do administrador
**Fluxo do Representante** (simula qualquer território, com "Voltar ao painel" nas etapas 1
e 2) e **Ajustar VB (BI&A)** — busca um PDV e define o VB diretamente, gravando com
`status_aprovacao = 'APROVADA'` e `"Representante" = 'BI&A'`, sem passar pelo bloqueio de
pendência. Ambos acessíveis pelo dropdown `Sugerir VB ▾` do nav ou pelas ações rápidas.

### Revisão da sugestão por IA (etapa 4) — **DESATIVADA**

> ⚠️ **Estado atual: desligada.** O envio vai direto para o banco, sem passar pelo modal de
> revisão. Todo o código continua no repositório, pronto e testado — nada foi removido.
>
> **Para reativar**, troque uma linha em `public/app.js`:
> ```js
> $('#btnEnviar').addEventListener('click', () => enviarSelecionados($('#btnEnviar')));  // atual
> $('#btnEnviar').addEventListener('click', abrirRevisao);                               // com IA
> ```
> Continuam intactos: o endpoint `POST /api/revisao`, a função `abrirRevisao`, o modal no
> `index.html` e o fallback determinístico.

O que a revisão fazia (e voltará a fazer quando religada): o representante marca **quantos
SKUs quiser** e define o VB de cada um; ao clicar em **Enviar**, antes de gravar qualquer
coisa, abre um modal com:

1. **Contexto do PDV** — "Este PDV da rede *X* é de Categoria Alta/Baixa, com/sem cobertura
   de força de vendas."
2. **Um comentário por SKU proposto** — "O VB *N* que você sugeriu é menor que a média
   mensal (12,7 un/mês), o que traz risco de ruptura antes da próxima visita."
3. Botões **Voltar e ajustar** / **Confirmar envio**. Nada é gravado até confirmar.

SKUs cujo VB está fora da média ganham um selo (`Risco de ruptura` / `Estoque sobrando`)
calculado em código — o selo não depende da IA.

#### Decisão de arquitetura: a IA não faz conta

A primeira versão pedia à IA que **sugerisse** o VB. Foi descartada: nos testes o
`qwen2.5:3b` errava a aplicação da regra (detalhes na tabela abaixo). Um número errado na
tela é pior que nenhuma recomendação.

Na versão final o **código faz todas as comparações** (`lerProposta()` em `server.js`) e
entrega ao modelo um campo `Leitura` já pronto, por SKU:

```
Leitura: o VB proposto (3) é MENOR que a media mensal (12.7 un/mes); e ABAIXO da sugestao do BI (13).
```

O modelo apenas **traduz isso para prosa**. Ele não compara, não arredonda e não propõe
número — logo, não tem como errar a matemática. O pior caso vira uma frase mal redigida.

**Fallback determinístico:** se o Ollama estiver fora do ar ou responder fora do formato, o
endpoint devolve `origem: "fallback"` com a mesma leitura escrita por código. O representante
nunca fica sem a análise — só sem a redação da IA. O fluxo de envio jamais trava por causa
da IA.

#### Histórico dos testes de prompt

Todos os testes rodaram contra `qwen2.5:3b` local, temperatura 0.1–0.15. Os scripts estão
descritos aqui para poderem ser refeitos ao trocar de modelo.

**Rodada 1 — IA sugere o VB, prompt só com as regras**

| Cenário | Esperado | Saída | Veredito |
|---|---|---|---|
| Cat 1, média 9,7/mês, estoque 5 | ~10 | **VB 1** — *"Categoria baixa (1) e produto isolado, mantendo ao menos 1 unidade para captura de demanda."* | ❌ confundiu o piso de 1 com a meta |
| Cat 2, média 0, nunca dispensou | 1 | VB 1 | ✅ |
| Cat 8, nunca vendeu, estoque 6 | 0 | VB 0 | ✅ |

Latência: 70 s na 1ª chamada (carga do modelo), ~1,4 s depois.

**Rodada 2 — procedimento de decisão passo a passo + few-shot**

| Cenário | Esperado | Saída | Veredito |
|---|---|---|---|
| Cat 1, média 9,7 | ~10 | VB 10 | ✅ |
| Cat 2, média 0 | 1 | VB 1 | ✅ |
| Cat 8, nunca vendeu | 0 | VB 0 | ✅ |
| Cat 5, média 12,7, estoque 14 | ~13 | **VB 1** — *"A categoria 5 requer cobertura […] para um VB maior que zero."* | ❌ mesmo erro, outro caminho |

Conclusão: reforçar o texto da regra não resolve. Um modelo 3B não aplica regra condicional
com confiabilidade.

**Rodada 3 — código passa a faixa coerente; IA escolhe dentro dela**

Faixa = `[max(1, VB_BI − 1), VB_BI + 2]`, ou `[0,0]` quando o PDV não é elegível.

| Cenário | Faixa | Saída | Veredito |
|---|---|---|---|
| Cat 1, média 9,7 | 9–12 | VB 10 | ✅ |
| Cat 2, média 0 | 1–3 | VB 2 | ✅ dentro da faixa |
| Cat 8, nunca vendeu | 0–0 | VB 0 | ✅ |
| Cat 5, média 12,7 | 12–15 | VB 14 | ✅ dentro da faixa |
| Cat 3, média 2,4, estoque 0 | 2–5 | VB 3 | ✅ |

**5/5 dentro da faixa.** Mas duas justificativas tinham **erro factual** — disseram "estoque
abaixo da média" para um PDV com estoque 14 e média 12,7 (acima).

**Rodada 4 — código também entrega a comparação pronta**

| Cenário | Saída | Veredito |
|---|---|---|
| Cat 1, média 9,7, estoque 5 | VB 10 — *"Estoque abaixo da média, manter em 10 para evitar ruptura."* | ✅ |
| Cat 2, média 0, estoque 0 | VB 2 — *"Estoque zero, subir para evitar ruptura."* | ✅ |
| Cat 8, nunca vendeu, estoque 6 | VB 0 — *"Estoque alto e sem vendas recentes, manter VB zero."* | ✅ |
| Cat 5, média 12,7, estoque 14 | VB 13 — *"Estoque em linha com média mensal, manter o VB do BI."* | ✅ corrigido |
| Cat 3, média 2,4, estoque 0 | VB 3 — *"Estoque abaixo da média, manter em 3."* | ✅ |

**5/5 corretos e sem erro factual.** Esta rodada validou o princípio que sustenta o desenho
atual: *toda conta que sai do modelo e vai para o código elimina uma classe de erro*.

**Rodada 5 — formato final (IA comenta, não sugere)**

Primeiro resultado ficou correto mas robótico — o modelo copiava a `Leitura` com parênteses
e ponto-e-vírgula. Corrigido com exemplo de estilo no prompt.

Segundo problema, mais sutil: o prompt estava escrito **sem acentos** (por precaução com
encoding) e o modelo **espelhou isso**, produzindo `"voce"`, `"esta"` e até
`"media mensual"` — palavra em espanhol. Reescrever o prompt com acentuação correta e uma
instrução explícita de idioma resolveu:

| Antes (prompt sem acento) | Depois (prompt acentuado) |
|---|---|
| "O VB 3 que **voce** sugeriu e MENOR que a **media mensual**" | "O VB 3 que **você** sugeriu é menor que a **média mensal** (12,7 un/mês), o que traz risco de ruptura antes da próxima visita." |

**Limitação conhecida:** mesmo com o prompt corrigido, o `qwen2.5:3b` ainda escorrega em
"mensual" em ~1 de cada 3 respostas. É limitação de tamanho do modelo, não de prompt — os
**números permanecem sempre corretos** porque vêm do código.

#### Qual modelo usar

Recomendação com base nos testes acima:

| Cenário | Modelo | Por quê |
|---|---|---|
| **Local, produção** | **`qwen2.5:7b-instruct`** (~4,7 GB) | Mesma família já validada, mas sem os escorregões de português do 3B. É o menor salto que resolve o problema real observado. Roda em máquina com 8 GB de RAM livre. |
| Local, máquina modesta | `qwen2.5:3b` (atual) | Funciona e é seguro (números vêm do código); só a redação escorrega. |
| **API paga** | **`gpt-4o-mini`** ou **`claude-haiku-4-5`** | Português impecável e latência ~1 s. Só trocar as variáveis de ambiente. |

**Custo estimado.** Cada revisão consome ~900 tokens de entrada e ~200 de saída. Dimensionando
com **32 representantes ativos**, 10 revisões/dia cada = **320 revisões/dia ≈ 7.000/mês**:

| Opção | Custo mensal | Observação |
|---|---|---|
| Ollama local (3B ou 7B) | **R$ 0** | Só o custo da máquina que já existe |
| `gpt-4o-mini` | **≈ US$ 2,00/mês** | ~6,3 M tokens entrada + 1,4 M saída |
| `claude-haiku-4-5` | **≈ US$ 8,00/mês** | |
| `gpt-4o` | ≈ US$ 30/mês | injustificável para esta tarefa |

Ou seja: mesmo a opção paga mais cara sai por menos de R$ 50/mês nesse volume. **A decisão
não deveria ser por custo, e sim por operação** — manter o Ollama exige uma máquina ligada e
acessível pelo servidor do Railway, o que hoje não existe. Se o app for para produção no
Railway, a API paga é o caminho natural; o local serve bem para desenvolvimento e validação.

> Números de preço são de tabela pública e mudam. Confirme antes de contratar.

#### Configuração

O backend fala o dialeto OpenAI (`/v1/chat/completions`), que o Ollama expõe. Trocar de
provedor é só variável de ambiente — nenhuma linha de código muda:

| Variável | Padrão | Observação |
|---|---|---|
| `IA_URL` | `http://localhost:11434/v1/chat/completions` | endpoint compatível com OpenAI |
| `IA_MODELO` | `qwen2.5:3b` | |
| `IA_API_KEY` | *(vazio)* | quando preenchida, vai como `Authorization: Bearer` |
| `IA_TIMEOUT_MS` | `90000` | |

> **Cold start:** a 1ª chamada ao Ollama carrega os pesos e leva ~70 s; quente responde em
> ~2 s. O servidor dispara um *warm-up* no boot para o representante não pegar essa espera.

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
| `GET /api/dashboard` | admin | KPIs do painel (pendentes, aprovadas no mês, reps ativos, PDVs). |
| `POST /api/recomendacao` | login | `{cnpj, ean}` → recomendação de VB pela IA (ver seção própria). |
| `GET /api/pdvs?q=` | login | Busca de PDVs (base de adequação) com rede e categoria. Acento-insensível, multi-token, ranqueada por cidade/bairro/rede, `LIMIT 25`. |
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
