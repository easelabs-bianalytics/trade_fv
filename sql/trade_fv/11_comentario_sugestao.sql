-- ================================================================================
--  COMENTARIO DO REPRESENTANTE em trade_fv.sugestao_fv
--
--  Justificativa livre, opcional, escrita pelo rep no momento do envio. Serve
--  para o BI&A entender o PORQUE da sugestao na hora de aprovar ou recusar --
--  contexto de campo que nenhum numero do snapshot carrega (reforma da loja,
--  pedido do gerente, ruptura observada, sazonalidade local).
--
--  UM COMENTARIO POR ENVIO: se o rep marca varios SKUs de uma vez, o mesmo
--  texto e gravado em CADA linha. Nao e normalizacao perdida -- cada linha ja
--  e um snapshot independente (Rede, CAT, Estoque, Ajuste) e uma unidade de
--  decisao independente do BI&A, entao ela tambem carrega a propria
--  justificativa. Isso mantem a tela de aprovacao e o export sem join nenhum.
--
--  Historico: apos uma decisao o rep pode reenviar a sugestao (linha nova, ver
--  06_sugestao_workflow.sql). Cada reenvio tem o proprio comentario, entao da
--  para acompanhar como o argumento dele evoluiu entre uma recusa e a proxima
--  tentativa.
-- ================================================================================

ALTER TABLE trade_fv.sugestao_fv
    ADD COLUMN IF NOT EXISTS comentario TEXT;

-- String vazia nunca entra (o servidor normaliza '' -> NULL); teto de 500
-- caracteres para o texto caber na tela de aprovacao e na celula do .xlsx
-- sem virar um campo de texto livre sem fim.
DO $$ BEGIN
    ALTER TABLE trade_fv.sugestao_fv
        ADD CONSTRAINT ck_sugestao_fv_comentario
        CHECK (comentario IS NULL OR char_length(comentario) BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN trade_fv.sugestao_fv.comentario IS
    'Justificativa opcional do representante, escrita no envio. Um por envio: '
    'replicada em todas as linhas (SKUs) daquele envio.';
