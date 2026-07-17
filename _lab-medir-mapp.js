/**
 * medir-mapp.js — quanto a Mapp REAL demora. Somente leitura.
 * ─────────────────────────────────────────────────────────────────────────
 * A pagina falsa prova que o CODIGO conserta. Ela nao responde a outra
 * pergunta, que e igualmente importante:
 *
 *     os timeouts novos (25s no login, 10s no autocomplete) sao suficientes?
 *
 * Se a Mapp de verdade responde o autocomplete em 12s, meus 10s sao um sleep
 * de 1500 com outro numero — chute maior, mas chute. Este script mede.
 *
 * ── O QUE ELE FAZ ────────────────────────────────────────────────────────
 *   1. Abre o login e cronometra quanto o #loginEmail demora pra aparecer
 *   2. Loga
 *   3. Abre a busca e cronometra o autocomplete pra cada OS que voce passar
 *   4. Imprime as medidas
 *
 * ── O QUE ELE **NAO** FAZ ────────────────────────────────────────────────
 *   Nao clica em corrigir. Nao preenche lat/lng. Nao salva. Nao toca em NADA.
 *   Le e cronometra. Pode rodar com a operacao no ar.
 *
 * ── COMO RODAR ───────────────────────────────────────────────────────────
 *   cd C:\Users\%USERNAME%\tutts-backend
 *   $env:MAPP_EMAIL="..."; $env:MAPP_SENHA="..."
 *   node medir-mapp.js 1260753 1260848 1259191
 *
 * (as OS sao as do seu print que falharam — se elas aparecerem no autocomplete
 * agora, esta provado que "OS nao localizada" era mentira do cronometro)
 */
'use strict';

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Rode de dentro da pasta do tutts-backend (onde o playwright esta instalado).'); process.exit(1); }

const EMAIL = process.env.MAPP_EMAIL || process.env.AGENT_EMAIL || process.env.TUTTS_EMAIL;
const SENHA = process.env.MAPP_SENHA || process.env.AGENT_SENHA || process.env.TUTTS_SENHA;
const BASE  = process.env.MAPP_BASE  || 'https://tutts.com.br';
const OSS   = process.argv.slice(2);

if (!EMAIL || !SENHA) {
  console.error('\n  Faltou credencial. No PowerShell:');
  console.error('    $env:MAPP_EMAIL="seu@email"; $env:MAPP_SENHA="suasenha"');
  console.error('  (ou use os mesmos nomes de env var que o Railway usa)\n');
  process.exit(1);
}
if (OSS.length === 0) {
  console.error('\n  Passe pelo menos uma OS:  node medir-mapp.js 1260753 1260848\n');
  process.exit(1);
}

const ms = (t0) => Date.now() - t0;
const linha = (a, b) => console.log('  ' + String(a).padEnd(46) + b);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const medidas = { login: null, barra: [], autocomplete: [] };

  try {
    console.log('\n' + '='.repeat(66));
    console.log('  MEDINDO A MAPP REAL (somente leitura)');
    console.log('='.repeat(66) + '\n');

    // ── 1. Login ──
    let t0 = Date.now();
    await page.goto(`${BASE}/expresso/loginFuncionarioNovo`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    linha('page.goto (domcontentloaded)', ms(t0) + 'ms');

    t0 = Date.now();
    let apareceu = true;
    try {
      await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 30000 });
    } catch { apareceu = false; }
    medidas.login = ms(t0);
    linha('#loginEmail apareceu em', apareceu ? medidas.login + 'ms' : 'NAO APARECEU em 30s');

    if (apareceu) {
      const veredito = medidas.login <= 1500
        ? 'o sleep de 1500ms bastava NESTA RODADA'
        : '>>> O SLEEP DE 1500ms TERIA FALHADO AQUI <<<';
      linha('', veredito);
    }
    if (!apareceu) { await browser.close(); return; }

    await page.fill('#loginEmail', EMAIL);
    await page.fill('input[type="password"]', SENHA);
    t0 = Date.now();
    await page.locator('input[name="logar"]').first().click();
    await page.waitForURL(u => !u.toString().includes('loginFuncionarioNovo'),
      { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => {});
    linha('login -> saiu da tela de login em', ms(t0) + 'ms');

    // ── 2. Autocomplete, por OS ──
    console.log('\n  ' + '-'.repeat(62));
    console.log('  AUTOCOMPLETE (o buraco de 120 jobs)');
    console.log('  ' + '-'.repeat(62));

    for (const os of OSS) {
      await page.goto(`${BASE}/expresso/expressoat/acompanhamento-servicos`,
        { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      // ── EXPANDIR A BARRA (o passo que faltava na v1 deste script) ──
      // Em 16/07 esta medicao devolveu "campo de busca nao apareceu em 15s" nas 3
      // OS. Nao era a Mapp: era ESTE script cometendo o MESMO erro do robo — ir
      // direto no #search-autocomplete-input, que NAO EXISTE ate a barra
      // "Pesquisar servicos" ser clicada. Foi assim que o bug foi encontrado.
      const barra = page.locator('text=Pesquisar serviços').first();
      let t1 = Date.now();
      const barraVeio = await barra.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      const dtBarra = ms(t1);
      if (!barraVeio) { linha(`OS ${os}`, 'a barra "Pesquisar servicos" nao apareceu em 15s'); continue; }
      medidas.barra.push(dtBarra);
      await barra.click();

      const select = page.locator('#search-type');
      if (await select.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
        await select.selectOption({ label: 'Serviço' }).catch(() => {});
      }

      const input = page.locator('#search-autocomplete-input, input[placeholder*="número do serviço"]').first();
      const temInput = await input.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      if (!temInput) { linha(`OS ${os}`, 'campo de busca nao apareceu em 15s (mesmo com a barra aberta)'); continue; }

      await input.fill(String(os));
      t0 = Date.now();
      const veio = await page.waitForFunction(
        () => document.querySelectorAll('.ui-menu-item .ui-menu-item-wrapper, .ui-menu-item-wrapper').length > 0,
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
      const dt = ms(t0);
      medidas.autocomplete.push({ os, veio, dt });

      linha(`OS ${os}`,
        veio
          ? `${dt}ms  ${dt > 1500 ? '>>> o sleep de 1500ms TERIA FALHADO' : '(o sleep bastava)'}`
          : `nao veio em 15s (OS pode nao existir mesmo)`);
      await page.waitForTimeout(400); // gentileza com o servidor deles
    }

    // ── Veredito ──
    console.log('\n' + '='.repeat(66));
    if (medidas.barra.length) {
      const b = medidas.barra.sort((a, z) => a - z);
      linha('barra "Pesquisar servicos": mediana', b[Math.floor(b.length / 2)] + 'ms');
      linha('barra "Pesquisar servicos": pior caso', b[b.length - 1] + 'ms');
      const teriaPulado = b.filter(x => x > 50).length;
      linha('quantas o isVisible() teria PULADO', `${teriaPulado} de ${b.length}  <-- os 120 'localizando'`);
      if (b[b.length - 1] > 10000) linha('ATENCAO', 'barra passou de 10s — subir o timeout do patch 07');
      console.log('');
    }
    const vieram = medidas.autocomplete.filter(m => m.veio);
    if (vieram.length) {
      const tempos = vieram.map(m => m.dt).sort((a, b) => a - b);
      const pior = tempos[tempos.length - 1];
      const mediana = tempos[Math.floor(tempos.length / 2)];
      const teriamFalhado = vieram.filter(m => m.dt > 1500).length;
      linha('autocomplete: mediana', mediana + 'ms');
      linha('autocomplete: pior caso', pior + 'ms');
      linha('quantas o sleep de 1500ms teria matado', `${teriamFalhado} de ${vieram.length}`);
      console.log('');
      if (pior > 10000)  linha('ATENCAO', 'pior caso passou de 10s — subir o timeout do patch 03');
      else if (pior > 5000) linha('OK', 'os 10s do patch 03 tem folga, mas nao muita');
      else linha('OK', 'os 10s do patch 03 tem folga confortavel');
    }
    if (medidas.login > 15000) linha('ATENCAO', 'login passou de 15s — revisar o timeout do patch 01');
    console.log('='.repeat(66) + '\n');

  } catch (e) {
    console.error('\n  Erro:', e.message.split('\n')[0], '\n');
  } finally {
    await browser.close();
  }
})();
