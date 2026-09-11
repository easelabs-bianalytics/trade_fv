# Imagem enxuta que ja traz o cliente psql
FROM postgres:17-alpine

WORKDIR /app
COPY sql ./sql

# Roda o refresh das materialized views na ordem de dependencia e encerra.
# psql le PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD nativamente -- variaveis
# discretas em vez de montar DATABASE_URL como string (convencao do projeto,
# ver docs/decisions.md do sales_force_crm). No Railway isso vinha pronto
# como DATABASE_URL das Variables do servico; na AWS (ECS) cada campo e' um
# secret proprio, injetado com esses nomes.
CMD ["psql", "-v", "ON_ERROR_STOP=1", "-f", "sql/trade_fv/03_refresh.sql"]
