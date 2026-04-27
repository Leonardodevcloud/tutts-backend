# 2026-04: Refeito do zero pra resolver "spawn EAGAIN" no chromium_headless_shell.
# 
# Problemas do Dockerfile antigo:
#   1. Lista de libs era pra Playwright 1.41 — versões 1.49+ exigem libs adicionais.
#   2. "RUN npx playwright install chromium" rodava 2x (uma no postinstall, outra
#      no Dockerfile) sem --with-deps na segunda, podendo deixar binário sem libs.
#   3. Sem package-lock.json, cada build podia resolver Playwright em versão diferente,
#      gerando mismatch entre node_modules e binário do Chromium baixado.
#
# Solução:
#   - Versão do Playwright TRAVADA no package.json (sem ^).
#   - Usa imagem oficial mcr.microsoft.com/playwright que JÁ vem com Chromium + libs
#     na versão exata. Garante compatibilidade total entre Node + Playwright + Chromium.
#   - Não precisa mais instalar libs do sistema manualmente.

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# Imagem oficial vem com Node 20 e usuário "pwuser" pré-configurado.
# Mas o código atual roda como root, então fixamos pra root pra não quebrar
# permissões de /root/.cache/ms-playwright (onde o binário do Chromium fica).
USER root

WORKDIR /app

# Copiar package.json e instalar deps.
# IMPORTANTE: o postinstall ("npx playwright install --with-deps chromium")
# vira essencialmente NO-OP aqui, porque a imagem JÁ tem o Chromium da versão certa.
# Mas mantemos no package.json pra dev local em quem não usa Docker.
COPY package*.json ./
RUN npm install --omit=dev=false && npm cache clean --force

# Copiar o restante do código
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
