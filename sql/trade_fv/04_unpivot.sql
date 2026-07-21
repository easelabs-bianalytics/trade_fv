-- ================================================================================
--  VIEW trade_fv.fato_adequacao_estoque_unpivot
--  Traducao do UNION/SELECTCOLUMNS (DAX) sobre fato_adequacao_estoque.
--  Le a matview fato_adequacao_estoque (rapido) -> nao precisa de refresh proprio.
-- ================================================================================
CREATE OR REPLACE VIEW trade_fv.fato_adequacao_estoque_unpivot AS
WITH u AS (
    -- SKU: Isolado 30 mL
    SELECT
        cnpj_pdv                              AS "CNPJ",
        provedor_pdv                          AS "Rede",
        "CAT",
        "Ultima Venda (dias)",
        'Isolado 30 mL'::text                 AS "SKU",
        "COBERTURA FV?"                       AS "Cobertura FV",
        "STATUS_PARAMETRIZADO"                AS "Status",
        "Isolado 30 mL"                       AS "Estoque Atual",
        "Estoque Ideal Final Isolado 30 mL"   AS "Estoque Ideal"
    FROM trade_fv.fato_adequacao_estoque

    UNION ALL
    -- SKU: Isolado 10 mL
    SELECT
        cnpj_pdv, provedor_pdv, "CAT", "Ultima Venda (dias)",
        'Isolado 10 mL'::text,
        "COBERTURA FV?", "STATUS_PARAMETRIZADO",
        "Isolado 10 mL",
        "Estoque Ideal Final Isolado 10 mL"
    FROM trade_fv.fato_adequacao_estoque

    UNION ALL
    -- SKU: Isolado 20 mg 30 mL
    SELECT
        cnpj_pdv, provedor_pdv, "CAT", "Ultima Venda (dias)",
        'Isolado 20 mg 30 mL'::text,
        "COBERTURA FV?", "STATUS_PARAMETRIZADO",
        "Isolado 20 mg 30 mL",
        "Estoque Ideal Final Isolado 20 mg 30 mL"
    FROM trade_fv.fato_adequacao_estoque

    UNION ALL
    -- SKU: Extrato
    SELECT
        cnpj_pdv, provedor_pdv, "CAT", "Ultima Venda (dias)",
        'Extrato'::text,
        "COBERTURA FV?", "STATUS_PARAMETRIZADO",
        "Extrato",
        "Estoque Ideal Final Extrato"
    FROM trade_fv.fato_adequacao_estoque
)
SELECT
    u."CNPJ",
    u."Rede",
    u."CAT",
    u."Ultima Venda (dias)",
    u."SKU",
    u."Cobertura FV",
    u."Status",
    u."Estoque Atual",
    u."Estoque Ideal",
    -- EAN por SKU
    CASE u."SKU"
        WHEN 'Isolado 20 mg 30 mL' THEN '7896806601328'
        WHEN 'Extrato'             THEN '7896806601250'
        WHEN 'Isolado 10 mL'       THEN '7896806601281'
        WHEN 'Isolado 30 mL'       THEN '7896806601243'
        ELSE NULL
    END AS "EAN",
    -- Delta = Estoque Ideal - Estoque Atual  (BLANK->0)
    (COALESCE(u."Estoque Ideal", 0) - COALESCE(u."Estoque Atual", 0)) AS "Delta",
    -- Ajuste (SWITCH TRUE()), com BLANK tratado como 0
    CASE
        WHEN COALESCE(u."Estoque Atual",0) = 0
             AND (COALESCE(u."Estoque Ideal",0) - COALESCE(u."Estoque Atual",0)) > 0
            THEN 'Positivar'
        WHEN (COALESCE(u."Estoque Ideal",0) - COALESCE(u."Estoque Atual",0)) = 0
            THEN 'Manter'
        WHEN COALESCE(u."Estoque Atual",0) > 0
             AND (COALESCE(u."Estoque Ideal",0) - COALESCE(u."Estoque Atual",0)) > 0
            THEN 'Aumentar VB'
        WHEN COALESCE(u."Estoque Atual",0) > 0
             AND COALESCE(u."Estoque Ideal",0) = 0
            THEN 'Inativar'
        ELSE 'Diminuir VB'
    END AS "Ajuste"
FROM u;
