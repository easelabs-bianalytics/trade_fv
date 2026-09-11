# Imagem do servidor web (Express) do trade_fv. Sem etapa de build (não há
# TypeScript/bundler) — só instala dependências e roda. No Railway isso
# subia via Nixpacks; na AWS precisa de um Dockerfile próprio (ECS).
FROM node:20-alpine

WORKDIR /app

# Só os arquivos de dependência primeiro — camada cacheada enquanto eles
# não mudarem.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# .env não existe na imagem (gitignored) — em produção as env vars vêm
# direto do ambiente do container (ECS secrets/environment), dotenv.config()
# no server.js não falha quando o arquivo não existe, só não sobrescreve nada.

EXPOSE 3000
CMD ["node", "server.js"]
