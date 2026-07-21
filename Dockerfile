# Imagem enxuta que ja traz o cliente psql
FROM postgres:17-alpine

WORKDIR /app
COPY sql ./sql

# Roda o refresh das materialized views na ordem de dependencia e encerra.
# DATABASE_URL vem das Variables do servico no Railway (ex.: ${{Postgres.DATABASE_URL}}).
CMD ["sh", "-c", "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f sql/trade_fv/03_refresh.sql"]
