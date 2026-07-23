-- ================================================================================
--  WORKFLOW DE APROVACAO das sugestoes da Forca de Vendas (BI&A)
--
--  1) trade_fv.sugestao_fv ganha o ciclo de aprovacao:
--       - status_aprovacao: PENDENTE (default) | APROVADA | RECUSADA
--       - decidido_por / decidido_em: quem (BI&A) e quando decidiu
--       - created_at = data de envio da sugestao (ja existia)
--     O rep NAO pode ter 2 sugestoes PENDENTES para o mesmo CNPJ x SKU
--     (indice unico parcial). Apos decisao (aprovada/recusada) ele pode enviar
--     uma nova sugestao — o historico fica preservado em linhas separadas.
--
--  2) trade_fv.fato_adequacao_estoque_unpivot_ajustada (VIEW):
--     a "sugestao padrao" (fato_adequacao_estoque_unpivot) sobrescrita pelas
--     sugestoes APROVADAS dos representantes:
--       - "Estoque Ideal" = VB aprovado (quando existir), senao o ideal do sistema
--       - "Delta" e "Ajuste" recalculados sobre o ideal final
--       - + colunas de rastreio: "Estoque Ideal Sistema", "Origem Sugestao"
--         ('Representante' | 'Sistema') e "Representante"
--     PDVs aprovados fora da base de adequacao (cadastro manual) entram como
--     linhas adicionais (snapshot da sugestao).
-- ================================================================================

ALTER TABLE trade_fv.sugestao_fv
    ADD COLUMN IF NOT EXISTS status_aprovacao TEXT NOT NULL DEFAULT 'PENDENTE',
    ADD COLUMN IF NOT EXISTS decidido_por TEXT,
    ADD COLUMN IF NOT EXISTS decidido_em TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE trade_fv.sugestao_fv
        ADD CONSTRAINT ck_sugestao_fv_status
        CHECK (status_aprovacao IN ('PENDENTE','APROVADA','RECUSADA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- o indice unico antigo (upsert) da lugar ao unico-parcial por PENDENTE
DROP INDEX IF EXISTS trade_fv.ux_sugestao_fv_cnpj_ean_rep;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sugestao_fv_pendente
    ON trade_fv.sugestao_fv ("CNPJ", "EAN", "Representante")
    WHERE status_aprovacao = 'PENDENTE';

CREATE INDEX IF NOT EXISTS ix_sugestao_fv_status
    ON trade_fv.sugestao_fv (status_aprovacao);

-- --------------------------------------------------------------------------------
-- VIEW: sugestao padrao ajustada pelas sugestoes aprovadas
-- --------------------------------------------------------------------------------
CREATE OR REPLACE VIEW trade_fv.fato_adequacao_estoque_unpivot_ajustada AS
WITH aprovadas AS (
    -- ultima sugestao APROVADA por CNPJ x SKU (independente do representante)
    SELECT DISTINCT ON ("CNPJ", "EAN")
        "CNPJ", "Rede", "CAT", "Ultima Venda (dias)", "SKU", "Cobertura FV",
        "Status", "Estoque Atual", "Estoque Ideal", "EAN",
        "Sugestao VB", "Representante"
    FROM trade_fv.sugestao_fv
    WHERE status_aprovacao = 'APROVADA'
    ORDER BY "CNPJ", "EAN", decidido_em DESC NULLS LAST
),
combinada AS (
    -- universo da base de adequacao, com o VB aprovado quando existir
    SELECT
        u."CNPJ", u."Rede", u."CAT", u."Ultima Venda (dias)", u."SKU",
        u."Cobertura FV", u."Status", u."Estoque Atual",
        u."Estoque Ideal"  AS ideal_sistema,
        u."EAN",
        a."Sugestao VB"    AS vb_aprovado,
        a."Representante"
    FROM trade_fv.fato_adequacao_estoque_unpivot u
    LEFT JOIN aprovadas a ON a."CNPJ" = u."CNPJ" AND a."EAN" = u."EAN"

    UNION ALL

    -- sugestoes aprovadas de PDVs fora da base (cadastro manual)
    SELECT
        a."CNPJ", a."Rede", a."CAT", a."Ultima Venda (dias)", a."SKU",
        a."Cobertura FV", a."Status", a."Estoque Atual",
        a."Estoque Ideal"  AS ideal_sistema,
        a."EAN",
        a."Sugestao VB"    AS vb_aprovado,
        a."Representante"
    FROM aprovadas a
    WHERE NOT EXISTS (
        SELECT 1 FROM trade_fv.fato_adequacao_estoque_unpivot u
        WHERE u."CNPJ" = a."CNPJ" AND u."EAN" = a."EAN"
    )
)
SELECT
    c."CNPJ", c."Rede", c."CAT", c."Ultima Venda (dias)", c."SKU",
    c."Cobertura FV", c."Status", c."Estoque Atual",
    COALESCE(c.vb_aprovado, c.ideal_sistema)                       AS "Estoque Ideal",
    c."EAN",
    COALESCE(COALESCE(c.vb_aprovado, c.ideal_sistema), 0)
        - COALESCE(c."Estoque Atual", 0)                           AS "Delta",
    -- mesmo SWITCH do unpivot original, sobre o ideal final
    CASE
        WHEN COALESCE(c."Estoque Atual",0) = 0
             AND (COALESCE(COALESCE(c.vb_aprovado, c.ideal_sistema),0)
                  - COALESCE(c."Estoque Atual",0)) > 0
            THEN 'Positivar'
        WHEN (COALESCE(COALESCE(c.vb_aprovado, c.ideal_sistema),0)
              - COALESCE(c."Estoque Atual",0)) = 0
            THEN 'Manter'
        WHEN COALESCE(c."Estoque Atual",0) > 0
             AND (COALESCE(COALESCE(c.vb_aprovado, c.ideal_sistema),0)
                  - COALESCE(c."Estoque Atual",0)) > 0
            THEN 'Aumentar VB'
        WHEN COALESCE(c."Estoque Atual",0) > 0
             AND COALESCE(COALESCE(c.vb_aprovado, c.ideal_sistema),0) = 0
            THEN 'Inativar'
        ELSE 'Diminuir VB'
    END                                                            AS "Ajuste",
    c.ideal_sistema                                                AS "Estoque Ideal Sistema",
    CASE WHEN c.vb_aprovado IS NOT NULL
         THEN 'Representante' ELSE 'Sistema' END                   AS "Origem Sugestao",
    c."Representante"
FROM combinada c;
