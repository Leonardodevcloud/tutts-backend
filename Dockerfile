# 2026-04 v3: A causa real do "spawn EAGAIN" foi descoberta.
#
# NÃO era memória (32GB já alocados no Railway, sobrando muito).
# NÃO era versão do Playwright/Chromium (já travada em 1.49.1).
#
# A causa real: Node.js rodando como PID 1 no container.
# Chromium spawna ~50 subprocessos cada. Quando algo dá erro e os processos
# do Chromium morrem, seus FILHOS ficam órfãos. PID 1 é o "reaper" de zombies
# no Linux — mas Node.js NÃO sabe fazer isso. Os zombies se acumulam até
# atingir o limite de PIDs do cgroup do container (~4096 default Docker)
# e o fork() retorna EAGAIN = "Resource temporarily unavailable".
#
# Documentação oficial do Playwright (https://playwright.dev/docs/docker):
#   "Chromium spawns subprocesses. Without an init system, they become zombies.
#    Using --init Docker flag is recommended to avoid special treatment for
#    processes with PID=1."
#
# A solução é usar `dumb-init` (já incluído na imagem oficial Playwright) como
# PID 1. Ele:
#   1. Faz reap automático dos zombies (fix do EAGAIN)
#   2. Faz forward dos sinais (SIGTERM) pro Node corretamente
#   3. É leve (~30KB)

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# Imagem oficial vem com Node 20 e dumb-init pré-instalados.
USER root

WORKDIR /app

# Copiar package.json e instalar deps.
# A imagem JÁ tem o Chromium 1.49.1 instalado em /ms-playwright/.
# Definimos SKIP_PLAYWRIGHT_INSTALL=1 nas envs do Railway pra pular o postinstall.
COPY package*.json ./
RUN npm install --omit=dev=false && npm cache clean --force

# Copiar o restante do código
COPY . .

EXPOSE 3000

# 🔥 FIX DO EAGAIN: dumb-init vira PID 1, faz reaping de zombies do Chromium.
# Sem isso, os subprocessos do Chromium acumulam e estouram o PID limit do cgroup.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
