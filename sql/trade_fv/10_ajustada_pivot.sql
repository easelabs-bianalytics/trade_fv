-- ================================================================================
--  trade_fv.fato_adequacao_estoque_ajustada (VIEW)
--
--  MESMA FORMA (larga, 1 linha por PDV) do trade_fv.fato_adequacao_estoque —
--  é o que o Power BI/KAM exporta hoje como fato_adequacao_estoque.csv.
--  Objetivo: fazer esse export refletir o VB do representante quando APROVADO
--  pelo BI&A, sem precisar reescrever nada do DAX/M do Power BI — troque a
--  fonte da tabela por esta view (ver instrucoes no final do arquivo).
--
--  So os 5 campos "Estoque Ideal Final <SKU>" / "... Total" mudam; todo o
--  resto (estoque bruto, sell-out, media, CAT, cobertura, status etc.) vem
--  identico da fato_adequacao_estoque, ja validada verbatim contra o Power BI.
--
--  Regra (mesma de fato_adequacao_estoque_unpivot_ajustada, so pivotada):
--    Estoque Ideal Final <SKU> = COALESCE(VB aprovado mais recente, valor do
--    sistema) -- e continua NULL quando o PDV esta INATIVO/INATIVAR (nenhuma
--    aprovacao muda isso).
--
--  PDVs aprovados fora da base (cadastro manual, CNPJ que nao existe em
--  estoque_redes.analise_estoque_pdv) TAMBEM aparecem aqui como linhas
--  extras -- com o que temos deles (o snapshot gravado em sugestao_fv no
--  momento do envio: rede, SKU, estoque atual informado, VB aprovado) e NULL
--  no resto (CAT, cobertura, potencial, sell-out, media, status etc. nunca
--  foram calculados pra esses CNPJs, pois estao fora do universo rastreado).
-- ================================================================================

CREATE OR REPLACE VIEW trade_fv.fato_adequacao_estoque_ajustada AS
WITH pivot_ajustado AS (
    SELECT
        "CNPJ"::bigint AS cnpj_pdv,
        MAX("Estoque Ideal") FILTER (WHERE "SKU" = 'Isolado 30 mL')       AS ideal_final_30,
        MAX("Estoque Ideal") FILTER (WHERE "SKU" = 'Isolado 10 mL')       AS ideal_final_10,
        MAX("Estoque Ideal") FILTER (WHERE "SKU" = 'Extrato')             AS ideal_final_ext,
        MAX("Estoque Ideal") FILTER (WHERE "SKU" = 'Isolado 20 mg 30 mL') AS ideal_final_20mg
    FROM trade_fv.fato_adequacao_estoque_unpivot_ajustada
    GROUP BY "CNPJ"
),
-- PDVs aprovados que NAO existem na base (cadastro manual) — pivota o que
-- tem no snapshot da sugestao. NOT EXISTS em vez de "Origem Sugestao" pois
-- um CNPJ pode ter algumas SKUs aprovadas fora da base e nenhuma na base.
manual_pivot AS (
    SELECT
        u."CNPJ"::bigint AS cnpj_pdv,
        MAX(u."Rede") AS rede,
        MAX(u."Estoque Atual") FILTER (WHERE u."SKU" = 'Isolado 30 mL')       AS atual_30,
        MAX(u."Estoque Atual") FILTER (WHERE u."SKU" = 'Isolado 10 mL')       AS atual_10,
        MAX(u."Estoque Atual") FILTER (WHERE u."SKU" = 'Extrato')             AS atual_ext,
        MAX(u."Estoque Atual") FILTER (WHERE u."SKU" = 'Isolado 20 mg 30 mL') AS atual_20mg,
        MAX(u."Estoque Ideal") FILTER (WHERE u."SKU" = 'Isolado 30 mL')       AS ideal_final_30,
        MAX(u."Estoque Ideal") FILTER (WHERE u."SKU" = 'Isolado 10 mL')       AS ideal_final_10,
        MAX(u."Estoque Ideal") FILTER (WHERE u."SKU" = 'Extrato')             AS ideal_final_ext,
        MAX(u."Estoque Ideal") FILTER (WHERE u."SKU" = 'Isolado 20 mg 30 mL') AS ideal_final_20mg
    FROM trade_fv.fato_adequacao_estoque_unpivot_ajustada u
    WHERE NOT EXISTS (
        SELECT 1 FROM trade_fv.fato_adequacao_estoque f WHERE f.cnpj_pdv = u."CNPJ"::bigint
    )
    GROUP BY u."CNPJ"
)
SELECT
    f.cnpj_pdv,
    f.cnpj_pdv_padronizado,
    f.provedor_pdv,
    f."COBERTURA FV?",
    f."CAT",
    f."POTENCIAL",
    f."Isolado 30 mL",
    f."Isolado 10 mL",
    f."Isolado 20 mg 30 mL",
    f."Extrato",
    f."Sell-out Isolado 30 mL",
    f."Sell-out Isolado 10 mL",
    f."Sell-out Isolado 20 mg 30 mL",
    f."Sell-out Extrato",
    f."Ultima Venda (dias)",
    f."Média Mensal Isolado 30 mL",
    f."Média Mensal Isolado 10 mL",
    f."Média Mensal Extrato",
    f."Média Mensal Isolado 20 mg 30 mL",
    f."Estoque Ideal Isolado 30 mL",
    f."Estoque Ideal Isolado 10 mL",
    f."Estoque Ideal Extrato",
    f."Estoque Ideal Isolado 20 mg 30 mL",
    f."Estoque Ideal Total",
    f."Estoque Total",
    f."STATUS_PARAMETRIZADO",
    f."SALDO Estoque Ideal 30 mL",
    f."SALDO Estoque Ideal 10 mL",
    f."SALDO Estoque Ideal Extrato",
    f."SALDO Estoque Ideal 20 mg 30 mL",
    COALESCE(p.ideal_final_30,   f."Estoque Ideal Final Isolado 30 mL")       AS "Estoque Ideal Final Isolado 30 mL",
    COALESCE(p.ideal_final_10,   f."Estoque Ideal Final Isolado 10 mL")       AS "Estoque Ideal Final Isolado 10 mL",
    COALESCE(p.ideal_final_ext,  f."Estoque Ideal Final Extrato")             AS "Estoque Ideal Final Extrato",
    COALESCE(p.ideal_final_20mg, f."Estoque Ideal Final Isolado 20 mg 30 mL") AS "Estoque Ideal Final Isolado 20 mg 30 mL",
    CASE
        WHEN f."STATUS_PARAMETRIZADO" = ANY (ARRAY['INATIVO','INATIVAR']) THEN NULL
        ELSE COALESCE(p.ideal_final_30,   f."Estoque Ideal Final Isolado 30 mL",       0)
           + COALESCE(p.ideal_final_10,   f."Estoque Ideal Final Isolado 10 mL",       0)
           + COALESCE(p.ideal_final_ext,  f."Estoque Ideal Final Extrato",             0)
           + COALESCE(p.ideal_final_20mg, f."Estoque Ideal Final Isolado 20 mg 30 mL", 0)
    END AS "Estoque Ideal Final Total"
FROM trade_fv.fato_adequacao_estoque f
LEFT JOIN pivot_ajustado p ON p.cnpj_pdv = f.cnpj_pdv

UNION ALL

-- linhas extras: PDVs aprovados fora da base (cadastro manual)
SELECT
    m.cnpj_pdv,
    CASE WHEN m.rede IN ('VENANCIO','PAGUEMENOS') THEN m.cnpj_pdv::text
         ELSE lpad(m.cnpj_pdv::text, 14, '0') END          AS cnpj_pdv_padronizado,
    m.rede                                                 AS provedor_pdv,
    NULL::text                                              AS "COBERTURA FV?",
    NULL::bigint                                            AS "CAT",
    NULL::text                                              AS "POTENCIAL",
    m.atual_30                                              AS "Isolado 30 mL",
    m.atual_10                                              AS "Isolado 10 mL",
    m.atual_20mg                                            AS "Isolado 20 mg 30 mL",
    m.atual_ext                                             AS "Extrato",
    NULL::double precision                                  AS "Sell-out Isolado 30 mL",
    NULL::double precision                                  AS "Sell-out Isolado 10 mL",
    NULL::double precision                                  AS "Sell-out Isolado 20 mg 30 mL",
    NULL::double precision                                  AS "Sell-out Extrato",
    NULL::integer                                           AS "Ultima Venda (dias)",
    NULL::double precision                                  AS "Média Mensal Isolado 30 mL",
    NULL::double precision                                  AS "Média Mensal Isolado 10 mL",
    NULL::double precision                                  AS "Média Mensal Extrato",
    NULL::double precision                                  AS "Média Mensal Isolado 20 mg 30 mL",
    NULL::bigint                                            AS "Estoque Ideal Isolado 30 mL",
    NULL::bigint                                            AS "Estoque Ideal Isolado 10 mL",
    NULL::bigint                                            AS "Estoque Ideal Extrato",
    NULL::bigint                                            AS "Estoque Ideal Isolado 20 mg 30 mL",
    NULL::bigint                                            AS "Estoque Ideal Total",
    -- mesma regra da base: Estoque Total soma so 3 SKUs (sem o 20mg)
    (COALESCE(m.atual_30,0) + COALESCE(m.atual_10,0) + COALESCE(m.atual_ext,0))::bigint AS "Estoque Total",
    NULL::text                                              AS "STATUS_PARAMETRIZADO",
    NULL::bigint                                            AS "SALDO Estoque Ideal 30 mL",
    NULL::bigint                                            AS "SALDO Estoque Ideal 10 mL",
    NULL::bigint                                            AS "SALDO Estoque Ideal Extrato",
    NULL::bigint                                            AS "SALDO Estoque Ideal 20 mg 30 mL",
    m.ideal_final_30                                        AS "Estoque Ideal Final Isolado 30 mL",
    m.ideal_final_10                                        AS "Estoque Ideal Final Isolado 10 mL",
    m.ideal_final_ext                                       AS "Estoque Ideal Final Extrato",
    m.ideal_final_20mg                                      AS "Estoque Ideal Final Isolado 20 mg 30 mL",
    (COALESCE(m.ideal_final_30,0) + COALESCE(m.ideal_final_10,0)
     + COALESCE(m.ideal_final_ext,0) + COALESCE(m.ideal_final_20mg,0))::bigint AS "Estoque Ideal Final Total"
FROM manual_pivot m;

-- ================================================================================
--  COMO LIGAR NO POWER BI (menor esforco: 1 query, sem tocar no resto do modelo)
--
--  Hoje o Power Query monta #fato_adequacao_estoque a partir de
--  #fato_todos_pdvs (API Web.Contents) + SUMMARIZE em DAX. Substitua essa
--  cadeia inteira (fato_todos_pdvs -> #fato_adequacao_estoque) por UMA query
--  nova, conectada direto no Postgres via conector nativo do Power BI
--  ("Obter Dados" -> "Banco de dados PostgreSQL"):
--
--    Servidor: <DB_HOST>:<DB_PORT>   (mesmos valores do .env do projeto)
--    Banco:    <DB_NAME>
--    Modo de conectividade de dados: Import (ou DirectQuery, se preferir
--      sempre-ao-vivo em vez de esperar o refresh agendado do PBI)
--
--  M da nova query (renomeie para manter o nome "fato_adequacao_estoque" e
--  nao precisar reapontar nenhuma medida/visual que ja usa essa tabela):
--
--    let
--        Origem = PostgreSQL.Database("<DB_HOST>:<DB_PORT>", "<DB_NAME>"),
--        tabela = Origem{[Schema="trade_fv", Item="fato_adequacao_estoque_ajustada"]}[Data]
--    in
--        tabela
--
--  Isso elimina TODO o DAX/M duplicado (ja validado verbatim contra esta
--  fonte) — qualquer sugestao aprovada pelo BI&A no app passa a refletir no
--  proximo refresh do Power BI automaticamente, sem manutencao adicional.
-- ================================================================================
