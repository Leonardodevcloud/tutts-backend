// testa-login.js - reproduz o auto-login da 99 COM JANELA e imprime as CLASSES
// exatas do checkbox e do botao Entrar, pra diagnosticar sem chutar.
// USO:  node testa-login.js  71982138159  "SUA_SENHA"
'use strict';
const { chromium } = require('playwright');
const readline = require('readline');

const telefone = process.argv[2];
const senha = process.argv[3];
if (!telefone || !senha) { console.error('USO: node testa-login.js TELEFONE "SENHA"'); process.exit(1); }
const DELIVERS = 'https://entrega.99app.com/v2/delivers';

(async () => {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(DELIVERS, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const aba = page.getByText('Entrar com senha', { exact: false }).first();
  if (await aba.isVisible().catch(() => false)) { await aba.click().catch(() => {}); await page.waitForTimeout(500); }

  let tel = page.locator('input[type="tel"]:visible').first();
  if (!(await tel.count())) tel = page.locator('.login-card input:visible:not([type="password"]):not([placeholder="Selecione o país"])').first();
  await tel.click(); await tel.fill(''); await tel.type(String(telefone), { delay: 50 });

  const pass = page.locator('input[type="password"]').first();
  await pass.click(); await pass.fill(''); await pass.type(String(senha), { delay: 50 });
  await page.waitForTimeout(400);

  const chkSpan = page.locator('.input-agreement-wrapper .checkbox, span.checkbox').first();
  const entrar = page.locator('.button-wrap .button, div.button').first();

  console.log('\n--- ANTES de marcar ---');
  console.log('checkbox class:', await chkSpan.getAttribute('class').catch(() => '?'));
  console.log('Entrar   class:', await entrar.getAttribute('class').catch(() => '?'));

  // clica UMA vez e observa
  await chkSpan.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  console.log('\n--- DEPOIS de 1 clique ---');
  console.log('checkbox class:', await chkSpan.getAttribute('class').catch(() => '?'));
  console.log('Entrar   class:', await entrar.getAttribute('class').catch(() => '?'));

  console.log('\n>>> Olhe a JANELA: o quadradinho "Aceito" esta MARCADO? o botao Entrar ficou COLORIDO (clicavel)?');

  await entrar.click({ timeout: 10000 }).catch(e => console.log('clique Entrar:', e.message));
  await page.waitForTimeout(4500);

  console.log('\n==== APOS O ENTRAR ====');
  console.log('URL:', page.url());
  const logado = await page.locator('button:has-text("Pesquisar")').first().isVisible().catch(() => false);
  console.log(logado ? '>> LOGOU! auto-login OK.' : '>> NAO logou. Me diga o que a janela mostra (erro de senha? OTP? botao cinza?).');

  await new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('\nENTER pra fechar... ', () => { rl.close(); res(); }); });
  await b.close();
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
