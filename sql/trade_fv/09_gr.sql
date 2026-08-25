-- ================================================================================
--  ROLE "gr" (Gerente Regional) — lidera uma equipe de representantes.
--
--  Fonte: mesma familia de tabelas SCD ja usada para os reps (cddd.*), um nivel
--  acima:
--    cddd.dim_gr             cadastro do GR (cod_gr, nome_gr, admissao/demissao)
--    cddd.scd_gr_territorio  SCD: qual GR gerencia qual territorio
--                            (data_fim_gerenciamento IS NULL = vinculo ativo)
--
--  Ao contrario do rep (1 usuario = 1 territorio), 1 GR gerencia N territorios —
--  por isso NAO da pra usar as colunas cod_territorio/desc_territorio de
--  trade_fv.usuario para o GR (elas ficam NULL nessa linha). Em vez disso,
--  guardamos cod_gr e resolvemos os territorios da equipe em tempo de consulta
--  via trade_fv.vw_gr_territorios (join dinamico com a janela ativa da SCD).
--
--  dim_gr NAO tem coluna de email -> os 3 GRs atuais foram cadastrados
--  manualmente no seed do app (GRS_SEED em server.js), com nome derivado do
--  proprio email (padrao identico ao dos admins).
-- ================================================================================

ALTER TABLE trade_fv.usuario
    DROP CONSTRAINT usuario_role_check,
    ADD CONSTRAINT usuario_role_check CHECK (role IN ('admin', 'rep', 'gr'));

ALTER TABLE trade_fv.usuario
    ADD COLUMN IF NOT EXISTS cod_gr BIGINT;

CREATE INDEX IF NOT EXISTS ix_usuario_cod_gr ON trade_fv.usuario (cod_gr) WHERE role = 'gr';

-- Territorios atualmente sob cada GR (janela ativa da SCD + GR nao demitido),
-- ja com o desc_territorio usado em sugestao_fv."Representante". DISTINCT pois
-- cddd.forca_vendas tem varias linhas por territorio (fan-out por cod_utc).
-- desc_territorio fica NULL quando o territorio do GR nao tem linha em
-- forca_vendas (territorio sem rep ativo no momento — nao gera sugestoes).
-- Usada para: (a) resolver a equipe do GR nas rotas do app, (b) reaproveitar
-- em qualquer relatorio futuro de cobertura por GR.
CREATE OR REPLACE VIEW trade_fv.vw_gr_territorios AS
SELECT DISTINCT
    g.cod_gr,
    g.nome_gr,
    t.cod_territorio::text AS cod_territorio,
    fv.desc_territorio
FROM cddd.scd_gr_territorio t
JOIN cddd.dim_gr g ON g.cod_gr = t.cod_gr
LEFT JOIN cddd.forca_vendas fv ON fv.cod_territorio = t.cod_territorio::text
WHERE t.data_fim_gerenciamento IS NULL
  AND g.data_demissao IS NULL
  AND g.nome_gr <> 'SEM REP';
