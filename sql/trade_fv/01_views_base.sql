-- =====================================================================
--  Schema trade_fv
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS trade_fv;

-- =====================================================================
--  NOTA: a cópia trade_fv.analise_estoque_pdv (que existia aqui) foi
--  removida — era 100% idêntica (EXCEPT nos dois sentidos = 0) a
--  estoque_redes.analise_estoque_pdv, sem nenhum objeto no banco nem no
--  app referenciando-a. A fato_todos_pdvs abaixo já lê a original
--  (estoque_redes.analise_estoque_pdv) diretamente.
-- =====================================================================

-- =====================================================================
--  1) View fato_cdd_90_dias_agrupada
--     Tradução do código M (fonte: cddd.fato_cdd)
-- =====================================================================
CREATE OR REPLACE VIEW trade_fv.fato_cdd_90_dias_agrupada AS
WITH base AS (
    -- Tipagem + und_ajus (und / 1000); remove colunas nao usadas
    SELECT
        f.cod_anomes::date                       AS cod_anomes,
        f.cod_apresentacao::text                 AS cod_apresentacao,
        f.cod_pdv::text                          AS cod_pdv,
        f.cod_tipo_transacao::text               AS cod_tipo_transacao,
        (f.und::double precision / 1000.0)       AS und_ajus
    FROM cddd.fato_cdd f
),
com_pdv AS (
    -- Join dim_pdvs (cddd.pdvs) em cod_pdv; filtra cnpj_pdv nao nulo
    SELECT
        b.cod_anomes,
        b.cod_apresentacao,
        b.cod_tipo_transacao,
        b.und_ajus,
        p.cnpj_pdv,
        p.desc_pdv
    FROM base b
    LEFT JOIN cddd.pdvs p ON p.cod_pdv::text = b.cod_pdv
    WHERE p.cnpj_pdv IS NOT NULL
),
com_apres AS (
    -- Join dim_apres (cddd.apres) em cod_apresentacao = COD_APRESENTACAO
    -- + substituicoes de DESC_APRESENTACAO
    SELECT
        c.cod_anomes,
        c.cod_tipo_transacao,
        c.und_ajus,
        c.cnpj_pdv,
        a.ean::text AS "EAN",
        REPLACE(REPLACE(REPLACE(a.desc_apresentacao::text,
            'EXT CANNABIS SAT EAS EAS 36,76MG/ML GT-OR FR X 30ML N03A', 'Extrato'),
            'CANABIDIOL EAS EAS 100MG/ML GT-OR FR X 10ML N03A',        'Isolado 10 mL'),
            'CANABIDIOL EAS EAS 100MG/ML GT-OR FR X 30ML N03A',        'Isolado 30 mL') AS "DESC_APRESENTACAO"
    FROM com_pdv c
    LEFT JOIN cddd.apres a ON a.cod_apresentacao::text = c.cod_apresentacao
),
tipo1 AS (
    -- Mantem apenas cod_tipo_transacao = '1'
    SELECT * FROM com_apres WHERE cod_tipo_transacao = '1'
),
limites AS (
    -- Data Maxima e Data Limite (-91 dias)
    SELECT max(cod_anomes) AS data_max,
           max(cod_anomes) - 91 AS data_limite
    FROM tipo1
),
por_data AS (
    -- Mantem registros entre Data Limite e Data Maxima (inclusive)
    SELECT t.*
    FROM tipo1 t, limites l
    WHERE t.cod_anomes >= l.data_limite
      AND t.cod_anomes <= l.data_max
)
SELECT
    (cnpj_pdv::text || "EAN"::text) AS "CHAVE_ESTOQUE_CDD",
    "DESC_APRESENTACAO",
    SUM(und_ajus) AS "Unidades Total"
FROM por_data
GROUP BY (cnpj_pdv::text || "EAN"::text), "DESC_APRESENTACAO";

-- =====================================================================
--  2) View fato_todos_pdvs
--     Tradução do código M (fonte: estoque_redes.analise_estoque_pdv)
-- =====================================================================
CREATE OR REPLACE VIEW trade_fv.fato_todos_pdvs AS
WITH cobertura AS (
    -- cobertura_fv = forca_vendas (cddd.forca_vendas) JOIN dim_pdv_tdd (tdd.dim_pdv)
    --                em COD_UTC = UTC_PDV, expandindo COD_PDV, CNPJ_PDV
    SELECT
        d."CNPJ_PDV"          AS "CNPJ_PDV",
        fv.desc_territorio    AS "DESC_TERRITORIO"
    FROM cddd.forca_vendas fv
    LEFT JOIN tdd.dim_pdv d ON d."UTC_PDV" = fv.cod_utc
    WHERE fv.cod_utc IS NOT NULL
      AND btrim(fv.cod_utc::text) <> ''
),
src AS (
    -- Expansao + tipagem inicial (cnpj/ean como texto); rename; remove colunas
    SELECT
        cnpj::text                    AS cnpj_pdv,       -- ex-cnpj
        rede::text                    AS provedor_pdv,   -- ex-rede
        ean::text                     AS ean,
        desc_apresentacao::text       AS apresentacao,   -- ex-desc_apresentacao
        cat_un_mercado,
        estoque::bigint               AS estoque
    FROM estoque_redes.analise_estoque_pdv
),
limpa AS (
    -- Limpa CNPJ: mantem apenas digitos
    SELECT
        regexp_replace(cnpj_pdv, '[^0-9]', '', 'g') AS cnpj_pdv,
        provedor_pdv, ean, apresentacao, cat_un_mercado, estoque
    FROM src
),
filtra_cnpj AS (
    -- Remove CNPJs indesejados / em branco
    SELECT * FROM limpa
    WHERE btrim(cnpj_pdv) <> '0'
      AND btrim(cnpj_pdv) <> ''
      AND btrim(cnpj_pdv) <> '00000000000000'
),
filtra_apres AS (
    -- Remove apresentacao especifica
    SELECT * FROM filtra_cnpj
    WHERE apresentacao <> 'CANNABIS SATIVA EAS EAS 79,14MG GT-OR FR X 30ML N03A'
),
etapa1 AS (
    -- Substituicao no EAN + padronizacao das redes (provedor_pdv)
    SELECT
        cnpj_pdv,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(provedor_pdv,
            'DROGARIA DPSP',     'DPSP'),
            'FARMACIA SAO JOAO', 'SAOJOAO'),
            'PAGUE MENOS',       'PAGUEMENOS'),
            'PANVEL FARMACIAS',  'PANVEL'),
            'RAIA DROGASIL',     'RAIA')                    AS provedor_pdv,
        REPLACE(ean, 'CANABIDIOL 20M', '7896806601328')     AS ean,
        cat_un_mercado,
        estoque,
        apresentacao
    FROM filtra_apres
),
etapa2 AS (
    -- Mapa de apresentacao por EAN + chave/cnpj padronizado
    SELECT
        cnpj_pdv,
        provedor_pdv,
        ean,
        cat_un_mercado,
        estoque,
        CASE ean
            WHEN '7896806601328' THEN 'Isolado 20 mg 30 mL'
            WHEN '7896806601250' THEN 'Extrato'
            WHEN '7896806601281' THEN 'Isolado 10 mL'
            WHEN '7896806601243' THEN 'Isolado 30 mL'
            ELSE apresentacao
        END AS apresentacao,
        -- VENANCIO e PAGUEMENOS nao recebem LPAD
        CASE
            WHEN provedor_pdv IN ('VENANCIO', 'PAGUEMENOS') THEN cnpj_pdv
            ELSE lpad(cnpj_pdv, 14, '0')
        END AS cnpj_pdv_padronizado
    FROM etapa1
),
etapa3 AS (
    SELECT
        cnpj_pdv,
        provedor_pdv,
        ean,
        cat_un_mercado,
        estoque,
        apresentacao,
        cnpj_pdv_padronizado,
        (cnpj_pdv_padronizado || ean) AS "CHAVE_ESTOQUE_CDD"
    FROM etapa2
)
SELECT
    e.cnpj_pdv::bigint              AS cnpj_pdv,          -- conversao final p/ numero
    e.provedor_pdv,
    e.ean,
    e.cat_un_mercado::bigint        AS cat_un_mercado,    -- conversao final p/ numero
    e.estoque,
    e.apresentacao,
    e.cnpj_pdv_padronizado,
    e."CHAVE_ESTOQUE_CDD",
    g."Unidades Total",
    c."DESC_TERRITORIO",
    CASE
        WHEN c."DESC_TERRITORIO" = 'SEM REP' THEN 'Não'
        WHEN c."DESC_TERRITORIO" IS NULL     THEN 'Não'
        ELSE 'Sim'
    END AS "COBERTURA FV?"
FROM etapa3 e
LEFT JOIN trade_fv.fato_cdd_90_dias_agrupada g
       ON g."CHAVE_ESTOQUE_CDD" = e."CHAVE_ESTOQUE_CDD"
LEFT JOIN cobertura c
       ON c."CNPJ_PDV" = e.cnpj_pdv::bigint;
