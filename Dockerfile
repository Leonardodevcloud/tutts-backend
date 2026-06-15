# 2026-06 v4: Dockerfile SEM dependencia do mcr.microsoft.com.
#
# Por que mudou: o build do Railway falhou ao puxar a imagem oficial
# mcr.microsoft.com/playwright:v1.49.1-jammy com erro de auth no registry
# da Microsoft (mcrprod.azurecr.io/oauth2/token). Pra nao ficar refem do MCR,
# trocamos a base pro node:20-jammy (Docker Hub) e instalamos o Chromium 1.49.1
# via Playwright no MESMO path que a imagem oficial usava (/ms-playwright).
#
# Mantido o que importa do v3:
#   - dumb-init como PID 1 (reaper de zombies do Chromium -> cura o spawn EAGAIN)
#   - Chromium da versao casada com playwright 1.49.1
#   - ENTRYPOINT/CMD identicos (worker-agents continua usando o mesmo start command)

FROM node:20-bookworm

USER root
WORKDIR /app

# Chromium fica no MESMO path da imagem oficial Playwright, pra nao quebrar nada
# que dependa de /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Garante que o install explicito do Chromium (abaixo) nao seja pulado por env.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# dumb-init (init reaper). As libs de SO do Chromium sao instaladas pelo
# `playwright install --with-deps` mais abaixo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

# Deps do Node.
COPY package*.json ./
RUN npm install --omit=dev=false && npm cache clean --force

# Baixa o Chromium da versao casada com o playwright 1.49.1 + libs de SO.
# Isso baixa do CDN do Playwright (nao do MCR), eliminando o ponto de falha.
RUN npx playwright install --with-deps chromium

# Codigo
COPY . .

EXPOSE 3000

# FIX DO EAGAIN: dumb-init vira PID 1, faz reaping de zombies do Chromium.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
