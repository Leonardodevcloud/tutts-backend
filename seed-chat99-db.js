// ============================================================================
// seed-chat99-db.js  -  grava a sessao da 99 DIRETO no banco (Neon).
// Sem base64, sem paste no Railway. Voce loga na mao, ele escreve no Postgres,
// e o agente le de la no proximo deploy.
//
// USO (a partir de C:\Users\Pichau\tutts-backend):
//   node seed-chat99-db.js "postgresql://USER:SENHA@host/db?sslmode=require"
//
// A string de conexao e a mesma DATABASE_URL do Railway/Neon (copie de la).
// Se voce tiver DATABASE_URL no ambiente, pode rodar so: node seed-chat99-db.js
// (se faltar navegador do Playwright: npx playwright install chromium)
// ============================================================================
'use strict';
const { chromium } = require('playwright');
const { Client } = require('pg');
const readline = require('readline');

const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) {
  console.error('[ERRO] Passe a string de conexao: node seed-chat99-db.js "postgresql://..."');
  process.exit(1);
}

(async () => {
  console.log('Abrindo o Chromium...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://entrega.99app.com/v2/delivers', { waitUntil: 'domcontentloaded' });

  console.log('\n============================================================');
  console.log(' >>> Faca LOGIN na janela (telefone + senha + OTP/captcha).');
  console.log(' >>> Quando estiver DENTRO do painel (vendo os pedidos "Em');
  console.log('     andamento"), volte AQUI e aperte ENTER.');
  console.log('============================================================\n');

  await new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Aperte ENTER quando estiver logado... ', () => { rl.close(); res(); });
  });

  const state = await context.storageState();
  const json = JSON.stringify(state);
  const nCookies = (state.cookies || []).length;
  await browser.close();

  console.log(`\nSessao capturada: ${nCookies} cookies, ${json.length} chars. Gravando no banco...`);

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS chat99_sessao (id INT PRIMARY KEY DEFAULT 1, storage_json TEXT, atualizado_em TIMESTAMPTZ DEFAULT now())`);
  await client.query(
    `INSERT INTO chat99_sessao (id, storage_json, atualizado_em) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET storage_json = EXCLUDED.storage_json, atualizado_em = now()`,
    [json]
  );
  await client.end();

  console.log('\n[ok] Sessao gravada em chat99_sessao (id=1).');
  console.log('>>> Agora so REDEPLOY do tutts-agents. O agente le a sessao do banco.');
  process.exit(0);
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
