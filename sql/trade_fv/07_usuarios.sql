-- ================================================================================
--  USUARIOS do sistema de indicacao de PDVs (login individual + RLS)
--
--  1) trade_fv.vw_representantes_ativos (VIEW):
--     territorio (cddd.forca_vendas) -> CT ativo no territorio
--     (cddd.scd_ct_territorio, data_saida_territorio IS NULL) -> nome/email
--     (cddd.dim_ct). Exclui setores vagos / SEM REP.
--
--  2) trade_fv.usuario (TABELA): admins + representantes ativos.
--     - senha_hash: scrypt (nunca texto puro)
--     - senha_padrao: TRUE enquanto o usuario nao trocou a senha inicial
--     - reps sao sincronizados automaticamente pelo app (boot + periodico +
--       endpoint admin): novo CT ativo => usuario criado com a senha padrao;
--       CT que saiu => usuario desativado (ativo = FALSE).
-- ================================================================================

CREATE OR REPLACE VIEW trade_fv.vw_representantes_ativos AS
SELECT DISTINCT
    fv.cod_territorio,
    fv.desc_territorio,
    s.cod_ct,
    ct.nome_abreviado_ct,
    ct.email_ct
FROM (
    SELECT DISTINCT cod_territorio, desc_territorio
    FROM cddd.forca_vendas
    WHERE desc_territorio IS NOT NULL
      AND desc_territorio <> 'SEM REP'
      AND desc_territorio NOT ILIKE '%VAGO%'
) fv
JOIN cddd.scd_ct_territorio s
  ON s.cod_territorio::text = fv.cod_territorio
 AND s.data_saida_territorio IS NULL
JOIN cddd.dim_ct ct
  ON ct.cod_ct = s.cod_ct
WHERE ct.nome_abreviado_ct NOT ILIKE '%vago%'
  AND (ct.data_demissao IS NULL);

CREATE TABLE IF NOT EXISTS trade_fv.usuario (
    id               BIGSERIAL PRIMARY KEY,
    usuario          TEXT        NOT NULL UNIQUE,
    nome             TEXT        NOT NULL,
    email            TEXT,
    role             TEXT        NOT NULL CHECK (role IN ('admin', 'rep')),
    cod_ct           BIGINT,
    cod_territorio   TEXT,
    desc_territorio  TEXT,       -- identidade usada em sugestao_fv."Representante"
    senha_hash       TEXT        NOT NULL,
    senha_padrao     BOOLEAN     NOT NULL DEFAULT TRUE,
    ativo            BOOLEAN     NOT NULL DEFAULT TRUE,
    ultimo_login     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_usuario_role_ativo ON trade_fv.usuario (role, ativo);
