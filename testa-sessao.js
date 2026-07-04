// testa-sessao.js - abre a 99 com a sessao gravada no banco, do SEU PC.
// USO: node testa-sessao.js "postgresql://...DATABASE_URL..."
'use strict';
const { chromium } = require('playwright');
const { Client } = require('pg');
const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) { console.error('Passe a DATABASE_URL: node testa-sessao.js "postgresql://..."'); process.exit(1); }
(async () => {
  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query('SELECT storage_json FROM chat99_sessao WHERE id = 1');
  await c.end();
  if (!r.rows.length) { console.error('Sem sessao no banco (id=1).'); process.exit(1); }

  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ storageState: JSON.parse(r.rows[0].storage_json) });
  const p = await ctx.newPage();
  await p.goto('https://entrega.99app.com/v2/delivers', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);

  const logado = await p.locator('button:has-text("Pesquisar")').first().isVisible().catch(() => false)
    || await p.locator('text=ID do pedido externo').first().isVisible().catch(() => false);
  const noLogin = (p.url() || '').includes('didiglobal')
    || await p.locator('input[type="password"]').first().isVisible().catch(() => false);

  console.log('\n==================== RESULTADO ====================');
  console.log('URL atual:', p.url());
  if (logado) {
    console.log('>> ENTROU LOGADO. A sessao do banco e VALIDA e PORTATIL.');
    console.log('   Logo, o "Nao logado" no Railway e por causa do IP (datacenter).');
    console.log('   Solucao: rodar o agente atras de proxy residencial BR.');
  } else if (noLogin) {
    console.log('>> CAIU NO LOGIN aqui tambem (do seu proprio PC).');
    console.log('   A sessao nao autentica so com storageState - a 99 exige');
    console.log('   device/fingerprint. Proxy nao resolve; caminho e outro.');
  } else {
    console.log('>> Indeterminado. Olhe a janela: mostra os pedidos ou a tela de login?');
  }
  console.log('==================================================');
  console.log('A janela fica aberta. Feche-a quando terminar de olhar.');
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
