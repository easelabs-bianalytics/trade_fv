-- ================================================================================
--  TABELA trade_fv.sugestao_fv
--  Sugestoes feitas pelos representantes de vendas no sistema web (indicacao_pdvs_fv).
--  Mesmas colunas da fato_adequacao_estoque_unpivot (snapshot no momento da sugestao)
--  + "Sugestao VB" (volume base sugerido) + "Representante" (desc_territorio).
--  Upsert por (CNPJ, EAN, Representante): o rep pode revisar a propria sugestao.
-- ================================================================================
CREATE TABLE IF NOT EXISTS trade_fv.sugestao_fv (
    id                    BIGSERIAL PRIMARY KEY,
    -- snapshot da fato_adequacao_estoque_unpivot
    "CNPJ"                BIGINT      NOT NULL,
    "Rede"                TEXT,
    "CAT"                 BIGINT,
    "Ultima Venda (dias)" INTEGER,
    "SKU"                 TEXT        NOT NULL,
    "Cobertura FV"        TEXT,
    "Status"              TEXT,
    "Estoque Atual"       BIGINT,
    "Estoque Ideal"       BIGINT,
    "EAN"                 TEXT        NOT NULL,
    "Delta"               BIGINT,
    "Ajuste"              TEXT,
    -- colunas da sugestao
    "Sugestao VB"         INTEGER     NOT NULL CHECK ("Sugestao VB" >= 0),
    "Representante"       TEXT        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sugestao_fv_cnpj_ean_rep
    ON trade_fv.sugestao_fv ("CNPJ", "EAN", "Representante");

CREATE INDEX IF NOT EXISTS ix_sugestao_fv_cnpj
    ON trade_fv.sugestao_fv ("CNPJ");
