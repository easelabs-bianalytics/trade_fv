-- ================================================================================
--  INDICE DE PERFORMANCE em tdd.fato_tdd (schema de origem, fora do projeto)
--
--  A busca de PDV (GET /api/pdvs) e o detalhe (GET /api/pdv/:cnpj) calculam a
--  Categoria do PDV via LATERAL JOIN em tdd.fato_tdd (COD_PDV, COD_GRUPO=3,
--  periodo mais recente). Essa tabela tem ~220 mil linhas e NENHUM indice --
--  cada PDV candidato disparava um SEQ SCAN completo, deixando buscas por
--  rede (que casam muitos PDVs) na casa de 5-6s.
--
--  Este indice cobre exatamente o filtro (COD_PDV, COD_GRUPO) usado pela
--  LATERAL e inclui COD_PERIODO para permitir Index Only Scan na ordenacao
--  "periodo mais recente primeiro".
--
--  Nao altera dados nem logica -- apenas acelera leitura. Seguro para
--  rodar a qualquer momento; idempotente (IF NOT EXISTS).
-- ================================================================================
CREATE INDEX IF NOT EXISTS ix_fato_tdd_pdv_grupo_periodo
    ON tdd.fato_tdd ("COD_PDV", "COD_GRUPO", "COD_PERIODO" DESC);
