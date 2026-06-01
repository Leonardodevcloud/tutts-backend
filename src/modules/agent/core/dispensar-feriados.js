/**
 * src/modules/agent/core/dispensar-feriados.js
 *
 * Helper COMPARTILHADO de código (NÃO de login/sessão).
 *
 * IMPORTANTE: cada agente mantém seu PRÓPRIO login, sua PRÓPRIA sessão
 * (getSessionFile) e suas PRÓPRIAS credenciais. A MAPP invalida sessões quando
 * o mesmo login entra de vários lugares, então NUNCA compartilhamos cookies/
 * storageState entre agentes. Aqui só centralizamos a LÓGICA de dispensar a
 * tela de feriados — cada agente chama passando sua própria `page`.
 *
 * A tela (confirmada 2026-05-31):
 *   URL: /expresso/expressoat/notificacao-feriados
 *   <form action="principal" method="GET">
 *     <button type="submit" class="btn btn-outline-secondary">IGNORAR</button>
 *   </form>
 * Enquanto a sessão não passa por aqui, qualquer goto a /acompanhamento-servicos
 * faz redirect chain de volta a principal.php (e o agente trava com Timeout).
 */
'use strict';

const FERIADOS_URL = 'https://tutts.com.br/expresso/expressoat/notificacao-feriados';
const PRINCIPAL_URL = 'https://tutts.com.br/expresso/expressoat/principal';

const SELETORES_FECHAR_FERIADO = [
  'form[action="principal"] button[type="submit"]',
  'button:has-text("IGNORAR")',
  'button:has-text("Ignorar")',
  'a[href*="principal"]',
  'button:has-text("Fechar")',
  'button:has-text("Continuar")',
  'button:has-text("Prosseguir")',
  'button:has-text("OK")',
  'button:has-text("Ok")',
  'a:has-text("Continuar")',
  'a:has-text("Fechar")',
  '.btn-fechar',
  '.close',
];

/**
 * @param {import('playwright').Page} page
 * @param {function} [logFn]
 */
async function dispensarFeriados(page, logFn) {
  const log = logFn || (() => {});
  const urlAtual = page.url();

  // Só navega pra feriados se ainda não estamos lá
  if (!urlAtual.includes('/notificacao-feriados')) {
    log('🗓️ [dispensarFeriados] navegando para notificacao-feriados');
    try {
      await page.goto(FERIADOS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(800);
    } catch (e) {
      log(`⚠️ [dispensarFeriados] goto falhou: ${e.message}`);
      return;
    }
  }

  // Se nem caiu na tela de feriados, não há o que dispensar (ex.: feriado já passou)
  if (!page.url().includes('/notificacao-feriados')) {
    log('🗓️ [dispensarFeriados] sem tela de feriados — nada a dispensar');
    return;
  }

  // Clica o IGNORAR (submit GET → principal) e aguarda sair da tela
  for (const sel of SELETORES_FECHAR_FERIADO) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await Promise.all([
          page.waitForURL((u) => !u.toString().includes('notificacao-feriados'), { timeout: 15000 }).catch(() => {}),
          el.click(),
        ]);
        await page.waitForTimeout(600);
        log(`🗓️ [dispensarFeriados] dispensado via selector "${sel}" — URL: ${page.url()}`);
        if (!page.url().includes('notificacao-feriados')) return;
      }
    } catch (_) { /* tenta próximo */ }
  }

  // Fallback: navega direto pra principal pra marcar a sessão como pós-feriados
  log('🗓️ [dispensarFeriados] nenhum botão encontrado — navegando direto pra principal');
  try {
    await page.goto(PRINCIPAL_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);
  } catch (e) {
    log(`⚠️ [dispensarFeriados] goto principal falhou: ${e.message}`);
  }
}

module.exports = { dispensarFeriados, FERIADOS_URL, SELETORES_FECHAR_FERIADO };
