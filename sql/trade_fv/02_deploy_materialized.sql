-- ================================================================================
--  DEPLOY: transforma as views derivadas de trade_fv em MATERIALIZED VIEWS
--  Logica 100% identica as views validadas (corpos extraidos do proprio banco).
--  A view trade_fv.analise_estoque_pdv permanece como VIEW (fonte "ao vivo").
--
--  Ordem de dependencia:
--    analise_estoque_pdv (VIEW)
--        -> fato_cdd_90_dias_agrupada (MATVIEW)
--        -> fato_todos_pdvs (MATVIEW)            [le a matview fato_cdd_90]
--        -> fato_adequacao_estoque (MATVIEW)     [le a matview fato_todos_pdvs]
-- ================================================================================

-- 1) Remove os objetos atuais (ordem reversa de dependencia).
--    CASCADE no matview do topo derruba as VIEWs dependentes (unpivot e
--    unpivot_ajustada) -- recrie-as depois rodando 04_unpivot.sql e
--    06_sugestao_workflow.sql. Este arquivo eh re-executavel: eh a fonte
--    unica do matview fato_adequacao_estoque (nao criar migracoes que
--    dupliquem este corpo -- editar aqui e re-rodar).
DROP MATERIALIZED VIEW IF EXISTS trade_fv.fato_adequacao_estoque CASCADE;
DROP MATERIALIZED VIEW IF EXISTS trade_fv.fato_todos_pdvs CASCADE;
DROP MATERIALIZED VIEW IF EXISTS trade_fv.fato_cdd_90_dias_agrupada CASCADE;

-- ================================================================================
-- 2) MATERIALIZED VIEW: fato_cdd_90_dias_agrupada
-- ================================================================================
CREATE MATERIALIZED VIEW trade_fv.fato_cdd_90_dias_agrupada AS
 WITH base AS (
         SELECT f.cod_anomes,
            f.cod_apresentacao,
            f.cod_pdv,
            f.cod_tipo_transacao,
            f.und::double precision / 1000.0::double precision AS und_ajus
           FROM cddd.fato_cdd f
        ), com_pdv AS (
         SELECT b.cod_anomes,
            b.cod_apresentacao,
            b.cod_tipo_transacao,
            b.und_ajus,
            p.cnpj_pdv,
            p.desc_pdv
           FROM base b
             LEFT JOIN cddd.pdvs p ON p.cod_pdv::text = b.cod_pdv
          WHERE p.cnpj_pdv IS NOT NULL
        ), com_apres AS (
         SELECT c.cod_anomes,
            c.cod_tipo_transacao,
            c.und_ajus,
            c.cnpj_pdv,
            a.ean::text AS "EAN",
            replace(replace(replace(a.desc_apresentacao::text, 'EXT CANNABIS SAT EAS EAS 36,76MG/ML GT-OR FR X 30ML N03A'::text, 'Extrato'::text), 'CANABIDIOL EAS EAS 100MG/ML GT-OR FR X 10ML N03A'::text, 'Isolado 10 mL'::text), 'CANABIDIOL EAS EAS 100MG/ML GT-OR FR X 30ML N03A'::text, 'Isolado 30 mL'::text) AS "DESC_APRESENTACAO"
           FROM com_pdv c
             LEFT JOIN cddd.apres a ON a.cod_apresentacao::text = c.cod_apresentacao
        ), tipo1 AS (
         SELECT com_apres.cod_anomes,
            com_apres.cod_tipo_transacao,
            com_apres.und_ajus,
            com_apres.cnpj_pdv,
            com_apres."EAN",
            com_apres."DESC_APRESENTACAO"
           FROM com_apres
          WHERE com_apres.cod_tipo_transacao = '1'::text
        ), limites AS (
         SELECT max(tipo1.cod_anomes) AS data_max,
            max(tipo1.cod_anomes) - 91 AS data_limite
           FROM tipo1
        ), por_data AS (
         SELECT t.cod_anomes,
            t.cod_tipo_transacao,
            t.und_ajus,
            t.cnpj_pdv,
            t."EAN",
            t."DESC_APRESENTACAO"
           FROM tipo1 t,
            limites l
          WHERE t.cod_anomes >= l.data_limite AND t.cod_anomes <= l.data_max
        )
 SELECT cnpj_pdv || "EAN" AS "CHAVE_ESTOQUE_CDD",
    "DESC_APRESENTACAO",
    sum(und_ajus) AS "Unidades Total"
   FROM por_data
  GROUP BY (cnpj_pdv || "EAN"), "DESC_APRESENTACAO"
WITH DATA;

-- indice unico (chave do GROUP BY) -> habilita REFRESH ... CONCURRENTLY e acelera o join
CREATE UNIQUE INDEX ux_fato_cdd_90 ON trade_fv.fato_cdd_90_dias_agrupada ("CHAVE_ESTOQUE_CDD", "DESC_APRESENTACAO");

-- ================================================================================
-- 3) MATERIALIZED VIEW: fato_todos_pdvs
-- ================================================================================
CREATE MATERIALIZED VIEW trade_fv.fato_todos_pdvs AS
 WITH cobertura AS (
         SELECT d."CNPJ_PDV",
            fv.desc_territorio AS "DESC_TERRITORIO"
           FROM cddd.forca_vendas fv
             LEFT JOIN tdd.dim_pdv d ON d."UTC_PDV" = fv.cod_utc
          WHERE fv.cod_utc IS NOT NULL AND btrim(fv.cod_utc::text) <> ''::text
        ), src AS (
         SELECT analise_estoque_pdv.cnpj::text AS cnpj_pdv,
            analise_estoque_pdv.rede::text AS provedor_pdv,
            analise_estoque_pdv.ean::text AS ean,
            analise_estoque_pdv.desc_apresentacao::text AS apresentacao,
            analise_estoque_pdv.cat_un_mercado,
            analise_estoque_pdv.estoque::bigint AS estoque
           FROM estoque_redes.analise_estoque_pdv
        ), limpa AS (
         SELECT regexp_replace(src.cnpj_pdv, '[^0-9]'::text, ''::text, 'g'::text) AS cnpj_pdv,
            src.provedor_pdv,
            src.ean,
            src.apresentacao,
            src.cat_un_mercado,
            src.estoque
           FROM src
        ), filtra_cnpj AS (
         SELECT limpa.cnpj_pdv,
            limpa.provedor_pdv,
            limpa.ean,
            limpa.apresentacao,
            limpa.cat_un_mercado,
            limpa.estoque
           FROM limpa
          WHERE btrim(limpa.cnpj_pdv) <> '0'::text AND btrim(limpa.cnpj_pdv) <> ''::text AND btrim(limpa.cnpj_pdv) <> '00000000000000'::text
        ), filtra_apres AS (
         SELECT filtra_cnpj.cnpj_pdv,
            filtra_cnpj.provedor_pdv,
            filtra_cnpj.ean,
            filtra_cnpj.apresentacao,
            filtra_cnpj.cat_un_mercado,
            filtra_cnpj.estoque
           FROM filtra_cnpj
          WHERE filtra_cnpj.apresentacao <> 'CANNABIS SATIVA EAS EAS 79,14MG GT-OR FR X 30ML N03A'::text
        ), etapa1 AS (
         SELECT filtra_apres.cnpj_pdv,
            replace(replace(replace(replace(replace(filtra_apres.provedor_pdv, 'DROGARIA DPSP'::text, 'DPSP'::text), 'FARMACIA SAO JOAO'::text, 'SAOJOAO'::text), 'PAGUE MENOS'::text, 'PAGUEMENOS'::text), 'PANVEL FARMACIAS'::text, 'PANVEL'::text), 'RAIA DROGASIL'::text, 'RAIA'::text) AS provedor_pdv,
            replace(filtra_apres.ean, 'CANABIDIOL 20M'::text, '7896806601328'::text) AS ean,
            filtra_apres.cat_un_mercado,
            filtra_apres.estoque,
            filtra_apres.apresentacao
           FROM filtra_apres
        ), etapa2 AS (
         SELECT etapa1.cnpj_pdv,
            etapa1.provedor_pdv,
            etapa1.ean,
            etapa1.cat_un_mercado,
            etapa1.estoque,
                CASE etapa1.ean
                    WHEN '7896806601328'::text THEN 'Isolado 20 mg 30 mL'::text
                    WHEN '7896806601250'::text THEN 'Extrato'::text
                    WHEN '7896806601281'::text THEN 'Isolado 10 mL'::text
                    WHEN '7896806601243'::text THEN 'Isolado 30 mL'::text
                    ELSE etapa1.apresentacao
                END AS apresentacao,
                CASE
                    WHEN etapa1.provedor_pdv = ANY (ARRAY['VENANCIO'::text, 'PAGUEMENOS'::text]) THEN etapa1.cnpj_pdv
                    ELSE lpad(etapa1.cnpj_pdv, 14, '0'::text)
                END AS cnpj_pdv_padronizado
           FROM etapa1
        ), etapa3 AS (
         SELECT etapa2.cnpj_pdv,
            etapa2.provedor_pdv,
            etapa2.ean,
            etapa2.cat_un_mercado,
            etapa2.estoque,
            etapa2.apresentacao,
            etapa2.cnpj_pdv_padronizado,
            etapa2.cnpj_pdv_padronizado || etapa2.ean AS "CHAVE_ESTOQUE_CDD"
           FROM etapa2
        )
 SELECT e.cnpj_pdv::bigint AS cnpj_pdv,
    e.provedor_pdv,
    e.ean,
    e.cat_un_mercado,
    e.estoque,
    e.apresentacao,
    e.cnpj_pdv_padronizado,
    e."CHAVE_ESTOQUE_CDD",
    g."Unidades Total",
    c."DESC_TERRITORIO",
        CASE
            WHEN c."DESC_TERRITORIO" = 'SEM REP'::text THEN 'Não'::text
            WHEN c."DESC_TERRITORIO" IS NULL THEN 'Não'::text
            ELSE 'Sim'::text
        END AS "COBERTURA FV?"
   FROM etapa3 e
     LEFT JOIN trade_fv.fato_cdd_90_dias_agrupada g ON g."CHAVE_ESTOQUE_CDD" = e."CHAVE_ESTOQUE_CDD"
     LEFT JOIN cobertura c ON c."CNPJ_PDV" = e.cnpj_pdv::bigint
WITH DATA;

-- indices de leitura (nao-unicos: cobertura pode multiplicar linhas)
CREATE INDEX ix_fato_todos_chave ON trade_fv.fato_todos_pdvs ("CHAVE_ESTOQUE_CDD");
CREATE INDEX ix_fato_todos_cnpj  ON trade_fv.fato_todos_pdvs (cnpj_pdv);

-- ================================================================================
-- 4) MATERIALIZED VIEW: fato_adequacao_estoque
-- ================================================================================
CREATE MATERIALIZED VIEW trade_fv.fato_adequacao_estoque AS
 WITH sales AS (
         SELECT p.cnpj_pdv::bigint AS cnpj_pdv,
            f.cod_anomes
           FROM cddd.fato_cdd f
             JOIN cddd.pdvs p ON p.cod_pdv::text = f.cod_pdv
          WHERE f.cod_tipo_transacao = '1'::text AND p.cnpj_pdv ~ '^[0-9]+$'::text
        ), dim_ultima_venda AS (
         SELECT sales.cnpj_pdv,
            max(sales.cod_anomes) AS ultima_venda
           FROM sales
          GROUP BY sales.cnpj_pdv
        ), gmax AS (
         SELECT max(sales.cod_anomes) AS dmax
           FROM sales
        ), agg AS (
         SELECT f.cnpj_pdv,
            f.cnpj_pdv_padronizado,
            f.provedor_pdv,
            max(f."COBERTURA FV?") AS "COBERTURA FV?",
            max(f.cat_un_mercado) AS "CAT",
            max(f.estoque) FILTER (WHERE f.apresentacao = 'Isolado 30 mL'::text) AS "Isolado 30 mL",
            max(f.estoque) FILTER (WHERE f.apresentacao = 'Isolado 10 mL'::text) AS "Isolado 10 mL",
            max(f.estoque) FILTER (WHERE f.apresentacao = 'Isolado 20 mg 30 mL'::text) AS "Isolado 20 mg 30 mL",
            max(f.estoque) FILTER (WHERE f.apresentacao = 'Extrato'::text) AS "Extrato",
            sum(f."Unidades Total") FILTER (WHERE f.apresentacao = 'Isolado 30 mL'::text) AS "Sell-out Isolado 30 mL",
            sum(f."Unidades Total") FILTER (WHERE f.apresentacao = 'Isolado 10 mL'::text) AS "Sell-out Isolado 10 mL",
            sum(f."Unidades Total") FILTER (WHERE f.apresentacao = 'Isolado 20 mg 30 mL'::text) AS "Sell-out Isolado 20 mg 30 mL",
            sum(f."Unidades Total") FILTER (WHERE f.apresentacao = 'Extrato'::text) AS "Sell-out Extrato"
           FROM trade_fv.fato_todos_pdvs f
          WHERE f.cnpj_pdv <> 0
          GROUP BY f.cnpj_pdv, f.cnpj_pdv_padronizado, f.provedor_pdv
        ), base AS (
         SELECT a.cnpj_pdv,
            a.cnpj_pdv_padronizado,
            a.provedor_pdv,
            a."COBERTURA FV?",
            a."CAT",
            a."Isolado 30 mL",
            a."Isolado 10 mL",
            a."Isolado 20 mg 30 mL",
            a."Extrato",
            a."Sell-out Isolado 30 mL",
            a."Sell-out Isolado 10 mL",
            a."Sell-out Isolado 20 mg 30 mL",
            a."Sell-out Extrato",
                CASE
                    WHEN d.ultima_venda IS NULL THEN 2000
                    ELSE g.dmax - d.ultima_venda
                END AS "Ultima Venda (dias)"
           FROM agg a
             CROSS JOIN gmax g
             LEFT JOIN dim_ultima_venda d ON d.cnpj_pdv = a.cnpj_pdv
        ), calc AS (
         SELECT b.cnpj_pdv,
            b.cnpj_pdv_padronizado,
            b.provedor_pdv,
            b."COBERTURA FV?",
            b."CAT",
            b."Isolado 30 mL",
            b."Isolado 10 mL",
            b."Isolado 20 mg 30 mL",
            b."Extrato",
            b."Sell-out Isolado 30 mL",
            b."Sell-out Isolado 10 mL",
            b."Sell-out Isolado 20 mg 30 mL",
            b."Sell-out Extrato",
            b."Ultima Venda (dias)",
            COALESCE(b."Sell-out Isolado 30 mL", 0::double precision) / 3.0::double precision AS "Média Mensal Isolado 30 mL",
            COALESCE(b."Sell-out Isolado 10 mL", 0::double precision) / 3.0::double precision AS "Média Mensal Isolado 10 mL",
            COALESCE(b."Sell-out Extrato", 0::double precision) / 3.0::double precision AS "Média Mensal Extrato",
            COALESCE(b."Sell-out Isolado 20 mg 30 mL", 0::double precision) / 3.0::double precision AS "Média Mensal Isolado 20 mg 30 mL",
                CASE
                    WHEN (b.provedor_pdv = ANY (ARRAY['ARAUJO'::text, 'CLAMED'::text, 'DPSP'::text, 'DROGAL'::text, 'INDIANA'::text, 'PAGUEMENOS'::text, 'PANVEL'::text, 'RAIA'::text, 'SAOJOAO'::text, 'VENANCIO'::text])) AND (
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 1 AND b."CAT" <= 5
                        ELSE b."CAT" >= 1 AND b."CAT" <= 4
                    END AND b."COBERTURA FV?" = 'Sim'::text OR
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 6 AND b."CAT" <= 8
                        ELSE b."CAT" >= 5 AND b."CAT" <= 8
                    END AND b."Ultima Venda (dias)" <= 120 AND COALESCE(b."Sell-out Isolado 30 mL", 0::double precision) > 0::double precision) THEN GREATEST(ceil(COALESCE(b."Sell-out Isolado 30 mL", 0::double precision) / 3.0::double precision), 1::double precision)
                    ELSE 0::double precision
                END::bigint AS "Estoque Ideal Isolado 30 mL",
                CASE
                    WHEN (b.provedor_pdv = ANY (ARRAY['ARAUJO'::text, 'CLAMED'::text, 'DPSP'::text, 'DROGAL'::text, 'INDIANA'::text, 'PAGUEMENOS'::text, 'PANVEL'::text, 'RAIA'::text, 'SAOJOAO'::text, 'VENANCIO'::text])) AND (
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 1 AND b."CAT" <= 5
                        ELSE b."CAT" >= 1 AND b."CAT" <= 4
                    END AND b."COBERTURA FV?" = 'Sim'::text OR
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 6 AND b."CAT" <= 8
                        ELSE b."CAT" >= 5 AND b."CAT" <= 8
                    END AND b."Ultima Venda (dias)" <= 120 AND COALESCE(b."Sell-out Isolado 10 mL", 0::double precision) > 0::double precision) THEN GREATEST(ceil(COALESCE(b."Sell-out Isolado 10 mL", 0::double precision) / 3.0::double precision), 1::double precision)
                    ELSE 0::double precision
                END::bigint AS "Estoque Ideal Isolado 10 mL",
                CASE
                    WHEN (b.provedor_pdv = ANY (ARRAY['ARAUJO'::text, 'CLAMED'::text, 'DPSP'::text, 'DROGAL'::text, 'INDIANA'::text, 'PAGUEMENOS'::text, 'PANVEL'::text, 'RAIA'::text, 'SAOJOAO'::text, 'VENANCIO'::text])) AND (
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 1 AND b."CAT" <= 5
                        ELSE b."CAT" >= 1 AND b."CAT" <= 4
                    END AND b."COBERTURA FV?" = 'Sim'::text OR
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 6 AND b."CAT" <= 8
                        ELSE b."CAT" >= 5 AND b."CAT" <= 8
                    END AND b."Ultima Venda (dias)" <= 120 AND COALESCE(b."Sell-out Extrato", 0::double precision) > 0::double precision) THEN GREATEST(ceil(COALESCE(b."Sell-out Extrato", 0::double precision) / 3.0::double precision), 1::double precision)
                    ELSE 0::double precision
                END::bigint AS "Estoque Ideal Extrato",
                CASE
                    WHEN (b.provedor_pdv = ANY (ARRAY['ARAUJO'::text, 'CLAMED'::text, 'DPSP'::text, 'DROGAL'::text, 'INDIANA'::text, 'PAGUEMENOS'::text, 'PANVEL'::text, 'RAIA'::text, 'SAOJOAO'::text, 'VENANCIO'::text])) AND (
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 1 AND b."CAT" <= 5
                        ELSE b."CAT" >= 1 AND b."CAT" <= 4
                    END AND b."COBERTURA FV?" = 'Sim'::text OR
                    CASE
                        WHEN b.provedor_pdv = 'INDIANA'::text THEN b."CAT" >= 6 AND b."CAT" <= 8
                        ELSE b."CAT" >= 5 AND b."CAT" <= 8
                    END AND b."Ultima Venda (dias)" <= 120 AND COALESCE(b."Sell-out Isolado 20 mg 30 mL", 0::double precision) > 0::double precision) THEN GREATEST(ceil(COALESCE(b."Sell-out Isolado 20 mg 30 mL", 0::double precision) / 3.0::double precision), 1::double precision)
                    ELSE 0::double precision
                END::bigint AS "Estoque Ideal Isolado 20 mg 30 mL"
           FROM base b
        ), d1 AS (
         SELECT c.cnpj_pdv,
            c.cnpj_pdv_padronizado,
            c.provedor_pdv,
            c."COBERTURA FV?",
            c."CAT",
            c."Isolado 30 mL",
            c."Isolado 10 mL",
            c."Isolado 20 mg 30 mL",
            c."Extrato",
            c."Sell-out Isolado 30 mL",
            c."Sell-out Isolado 10 mL",
            c."Sell-out Isolado 20 mg 30 mL",
            c."Sell-out Extrato",
            c."Ultima Venda (dias)",
            c."Média Mensal Isolado 30 mL",
            c."Média Mensal Isolado 10 mL",
            c."Média Mensal Extrato",
            c."Média Mensal Isolado 20 mg 30 mL",
            c."Estoque Ideal Isolado 30 mL",
            c."Estoque Ideal Isolado 10 mL",
            c."Estoque Ideal Extrato",
            c."Estoque Ideal Isolado 20 mg 30 mL",
                CASE
                    WHEN c."CAT" IS NOT NULL AND
                    CASE
                        WHEN c.provedor_pdv = 'INDIANA'::text THEN c."CAT" <= 7
                        ELSE c."CAT" <= 4
                    END THEN 'AltoPotencial'::text
                    ELSE 'BaixoPotencial'::text
                END AS "POTENCIAL",
            COALESCE(c."Isolado 10 mL", 0::bigint) + COALESCE(c."Isolado 30 mL", 0::bigint) + COALESCE(c."Extrato", 0::bigint) AS "Estoque Total",
            c."Estoque Ideal Isolado 10 mL" + c."Estoque Ideal Isolado 30 mL" + c."Estoque Ideal Extrato" + c."Estoque Ideal Isolado 20 mg 30 mL" AS "Estoque Ideal Total"
           FROM calc c
        ), d2 AS (
         SELECT d1.cnpj_pdv,
            d1.cnpj_pdv_padronizado,
            d1.provedor_pdv,
            d1."COBERTURA FV?",
            d1."CAT",
            d1."Isolado 30 mL",
            d1."Isolado 10 mL",
            d1."Isolado 20 mg 30 mL",
            d1."Extrato",
            d1."Sell-out Isolado 30 mL",
            d1."Sell-out Isolado 10 mL",
            d1."Sell-out Isolado 20 mg 30 mL",
            d1."Sell-out Extrato",
            d1."Ultima Venda (dias)",
            d1."Média Mensal Isolado 30 mL",
            d1."Média Mensal Isolado 10 mL",
            d1."Média Mensal Extrato",
            d1."Média Mensal Isolado 20 mg 30 mL",
            d1."Estoque Ideal Isolado 30 mL",
            d1."Estoque Ideal Isolado 10 mL",
            d1."Estoque Ideal Extrato",
            d1."Estoque Ideal Isolado 20 mg 30 mL",
            d1."POTENCIAL",
            d1."Estoque Total",
            d1."Estoque Ideal Total",
                CASE
                    WHEN d1."Ultima Venda (dias)" >= 90 AND COALESCE(d1."Isolado 30 mL", 0::bigint) = 0 AND COALESCE(d1."Isolado 10 mL", 0::bigint) = 0 AND COALESCE(d1."Extrato", 0::bigint) = 0 AND COALESCE(d1."Isolado 20 mg 30 mL", 0::bigint) = 0 AND (d1."POTENCIAL" <> 'AltoPotencial'::text OR d1."COBERTURA FV?" <> 'Sim'::text) THEN 'INATIVO'::text
                    WHEN d1."POTENCIAL" <> 'AltoPotencial'::text AND d1."Ultima Venda (dias)" >= 150 OR d1."Estoque Ideal Isolado 10 mL" IS NULL AND d1."Estoque Ideal Isolado 30 mL" IS NULL AND d1."Estoque Ideal Extrato" IS NULL AND d1."Estoque Ideal Isolado 20 mg 30 mL" IS NULL THEN 'INATIVAR'::text
                    WHEN d1."Ultima Venda (dias)" >= 90 AND COALESCE(d1."Isolado 30 mL", 0::bigint) = 0 AND COALESCE(d1."Isolado 10 mL", 0::bigint) = 0 AND COALESCE(d1."Extrato", 0::bigint) = 0 AND COALESCE(d1."Isolado 20 mg 30 mL", 0::bigint) = 0 AND d1."POTENCIAL" = 'AltoPotencial'::text AND d1."COBERTURA FV?" = 'Sim'::text THEN 'POSITIVAR'::text
                    WHEN NOT (d1."Ultima Venda (dias)" >= 90 AND COALESCE(d1."Isolado 30 mL", 0::bigint) = 0 AND COALESCE(d1."Isolado 10 mL", 0::bigint) = 0 AND COALESCE(d1."Extrato", 0::bigint) = 0 AND COALESCE(d1."Isolado 20 mg 30 mL", 0::bigint) = 0) AND d1."Estoque Total" > d1."Estoque Ideal Total" THEN 'DIMINUIR VB'::text
                    WHEN NOT (d1."Ultima Venda (dias)" >= 90 AND COALESCE(d1."Isolado 30 mL", 0::bigint) = 0 AND COALESCE(d1."Isolado 10 mL", 0::bigint) = 0 AND COALESCE(d1."Extrato", 0::bigint) = 0 AND COALESCE(d1."Isolado 20 mg 30 mL", 0::bigint) = 0) AND d1."Estoque Total" < d1."Estoque Ideal Total" THEN 'AUMENTAR VB'::text
                    WHEN NOT (d1."Ultima Venda (dias)" >= 90 AND COALESCE(d1."Isolado 30 mL", 0::bigint) = 0 AND COALESCE(d1."Isolado 10 mL", 0::bigint) = 0 AND COALESCE(d1."Extrato", 0::bigint) = 0 AND COALESCE(d1."Isolado 20 mg 30 mL", 0::bigint) = 0) AND d1."Estoque Total" = d1."Estoque Ideal Total" THEN 'MANTER VB'::text
                    ELSE NULL::text
                END AS "STATUS_PARAMETRIZADO"
           FROM d1
        )
 SELECT cnpj_pdv,
    cnpj_pdv_padronizado,
    provedor_pdv,
    "COBERTURA FV?",
    "CAT",
    "POTENCIAL",
    "Isolado 30 mL",
    "Isolado 10 mL",
    "Isolado 20 mg 30 mL",
    "Extrato",
    "Sell-out Isolado 30 mL",
    "Sell-out Isolado 10 mL",
    "Sell-out Isolado 20 mg 30 mL",
    "Sell-out Extrato",
    "Ultima Venda (dias)",
    "Média Mensal Isolado 30 mL",
    "Média Mensal Isolado 10 mL",
    "Média Mensal Extrato",
    "Média Mensal Isolado 20 mg 30 mL",
    "Estoque Ideal Isolado 30 mL",
    "Estoque Ideal Isolado 10 mL",
    "Estoque Ideal Extrato",
    "Estoque Ideal Isolado 20 mg 30 mL",
    "Estoque Ideal Total",
    "Estoque Total",
    "STATUS_PARAMETRIZADO",
    COALESCE("Isolado 30 mL", 0::bigint) - "Estoque Ideal Isolado 30 mL" AS "SALDO Estoque Ideal 30 mL",
    COALESCE("Isolado 10 mL", 0::bigint) - "Estoque Ideal Isolado 10 mL" AS "SALDO Estoque Ideal 10 mL",
    COALESCE("Extrato", 0::bigint) - "Estoque Ideal Extrato" AS "SALDO Estoque Ideal Extrato",
    COALESCE("Isolado 20 mg 30 mL", 0::bigint) - "Estoque Ideal Isolado 20 mg 30 mL" AS "SALDO Estoque Ideal 20 mg 30 mL",
        CASE
            WHEN "STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO'::text, 'INATIVAR'::text]) THEN NULL::bigint
            ELSE "Estoque Ideal Isolado 30 mL"
        END AS "Estoque Ideal Final Isolado 30 mL",
        CASE
            WHEN "STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO'::text, 'INATIVAR'::text]) THEN NULL::bigint
            ELSE "Estoque Ideal Isolado 10 mL"
        END AS "Estoque Ideal Final Isolado 10 mL",
        CASE
            WHEN "STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO'::text, 'INATIVAR'::text]) THEN NULL::bigint
            ELSE "Estoque Ideal Extrato"
        END AS "Estoque Ideal Final Extrato",
        CASE
            WHEN "STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO'::text, 'INATIVAR'::text]) THEN NULL::bigint
            ELSE "Estoque Ideal Isolado 20 mg 30 mL"
        END AS "Estoque Ideal Final Isolado 20 mg 30 mL",
        CASE
            WHEN "STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO'::text, 'INATIVAR'::text]) THEN NULL::bigint
            ELSE "Estoque Ideal Total"
        END AS "Estoque Ideal Final Total"
   FROM d2
WITH DATA;

-- indice unico (chave do GROUP BY) -> habilita REFRESH ... CONCURRENTLY e acelera leituras
CREATE UNIQUE INDEX ux_fato_adequacao ON trade_fv.fato_adequacao_estoque (cnpj_pdv, cnpj_pdv_padronizado, provedor_pdv);
CREATE INDEX ix_fato_adequacao_status ON trade_fv.fato_adequacao_estoque ("STATUS_PARAMETRIZADO");
