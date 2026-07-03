// ============================================================================
// rodar-chat99-local.js  (v2)
// Roda SO o agente chat99, localmente (IP residencial BR), pra 99 aceitar a
// sessao que ela recusa do IP de datacenter do Railway.
//
// Coloque na RAIZ do repo (C:\Users\Pichau\tutts-backend) e rode:
//   node rodar-chat99-local.js
//
// .env na raiz precisa ter SO:
//   DATABASE_URL=postgresql://...   (com a senha NOVA do Neon)
//   CHAT99_SESSION_FILE=./chat99-session.json
//   CHAT99_LOOP_MS=25000
//
// (JWT_SECRET/REFRESH_SECRET NAO sao necessarios: o chat99 nao usa auth JWT.
//  Este runner injeta placeholders so pra satisfazer a validacao do env.js.)
//
// IMPORTANTE: desligue o chat99 no Railway (CHAT99_AGENT_ATIVO=false) pra nao
// ter duas sessoes brigando na mesma conta da 99.
// ============================================================================
'use strict';

// carrega o .env primeiro
try { require('dotenv').config(); } catch (_) {}

// Placeholders pra passar pela validacao do src/config/env.js. O chat99 nao usa
// esses segredos - ele so fala com a 99 e com o banco. Nao substitui nada real
// (so define se estiver ausente).
if (!process.env.JWT_SECRET)     process.env.JWT_SECRET = 'local-chat99-nao-usa-jwt-placeholder-0000000000';
if (!process.env.REFRESH_SECRET) process.env.REFRESH_SECRET = 'local-chat99-nao-usa-refresh-placeholder-0000000000';
if (!process.env.NODE_ENV)       process.env.NODE_ENV = 'production';

if (!process.env.DATABASE_URL) {
  console.error('[ERRO] Falta DATABASE_URL no .env (ou no ambiente).');
  process.exit(1);
}

const { Pool } = require('pg');
const chat99 = require('./src/modules/agent/agents/chat99.agent');

if (typeof chat99.tickGlobal !== 'function') {
  console.error('[ERRO] O agente chat99 nao expoe tickGlobal. Confira o arquivo.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const intervalo = Number(process.env.CHAT99_LOOP_MS || chat99.intervalo || 25000);

let parar = false;
const slotState = {};
const ctx = {
  slotId: 'local',
  slotIdx: 0,
  log: (m) => console.log(new Date().toLocaleTimeString('pt-BR'), '[chat99]', m),
  sessao: null,
  slotState,
  ehParaParar: () => parar,
};

process.on('SIGINT', () => { console.log('\nEncerrando...'); parar = true; setTimeout(() => process.exit(0), 500); });

(async () => {
  console.log('=================================================');
  console.log(' chat99 LOCAL rodando. Loop a cada', intervalo / 1000, 's. Ctrl+C pra parar.');
  console.log(' Sessao vem do banco (chat99_sessao). IP local = residencial BR.');
  console.log('=================================================');
  while (!parar) {
    try {
      await chat99.tickGlobal(pool, ctx);
    } catch (e) {
      console.error(new Date().toLocaleTimeString('pt-BR'), '[chat99] tick erro:', e.message);
    }
    if (parar) break;
    await new Promise((r) => setTimeout(r, intervalo));
  }
  await pool.end().catch(() => {});
})();
