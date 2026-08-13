-- ================================================================================
--  UPDATE / REFRESH das materialized views de trade_fv
--  Agende este script no Railway (cron job / pg_cron / job externo).
--
--  A ORDEM importa (dependencias):
--    1) fato_cdd_90_dias_agrupada   (base: cddd.fato_cdd)
--    2) fato_todos_pdvs             (le a matview fato_cdd_90 + estoque_redes.analise_estoque_pdv)
--    3) fato_adequacao_estoque      (le a matview fato_todos_pdvs)
--
--  OBS: estoque_redes.analise_estoque_pdv (schema de origem) continua sendo VIEW
--  (dados ao vivo) e NAO precisa refresh. Nao ha copia dela em trade_fv.
-- ================================================================================

SET statement_timeout = '900s';

REFRESH MATERIALIZED VIEW trade_fv.fato_cdd_90_dias_agrupada;
REFRESH MATERIALIZED VIEW trade_fv.fato_todos_pdvs;
REFRESH MATERIALIZED VIEW trade_fv.fato_adequacao_estoque;

-- ================================================================================
-- (Opcional) Versao NAO-BLOQUEANTE com CONCURRENTLY.
-- Permite consultas durante o refresh, mas exige indice UNICO em cada matview.
-- fato_cdd_90 e fato_adequacao ja tem indice unico; fato_todos_pdvs NAO tem
-- (a cobertura pode multiplicar linhas), entao ela fica sem CONCURRENTLY.
-- Para usar, comente o bloco acima e descomente abaixo:
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY trade_fv.fato_cdd_90_dias_agrupada;
-- REFRESH MATERIALIZED VIEW            trade_fv.fato_todos_pdvs;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY trade_fv.fato_adequacao_estoque;
-- ================================================================================
