/**
 * Tutts Backend — src/shared/tmp-cleanup.js
 * ─────────────────────────────────────────────────────────────────────────
 * Limpeza periódica de arquivos temporários deixados por Chromium/Playwright.
 *
 * Por que isso existe?
 * ───────────────────
 * Cada chromium.launch() do Playwright cria um diretório novo em /tmp:
 *   /tmp/playwright_chromiumdev_profile-XXXXX/   (~5-30 MB cada)
 *
 * Em condições normais, esses diretórios são removidos automaticamente quando
 * browser.close() retorna. Mas em vários cenários eles ficam órfãos:
 *   - browser.close() trava → SIGKILL → cleanup do Chromium não roda
 *   - Container reiniciado no meio de execução
 *   - Processo crashado por OOM ou outro motivo
 *   - Race conditions entre profile dir e cleanup do Playwright
 *
 * Em containers do Railway, /tmp tem espaço limitado. Quando enche, o
 * próximo chromium.launch() falha com "Target page, context or browser has
 * been closed" — porque o Chromium sobe (pid criado) mas não consegue
 * gravar arquivos no profile dir → morre logo em seguida.
 *
 * Sintoma exato no Railway antes deste cleanup:
 *   - Memory cresce linear: 400 MB → 1 GB ao longo de 5h
 *   - Aos ~1 GB, todos os agentes começam a falhar simultaneamente
 *   - CPU cai pra zero (ninguém consegue subir browser)
 *   - Logs cheios de "Target page, context or browser has been closed"
 *
 * Estratégia
 * ──────────
 * A cada 30 minutos:
 *   1. Lista /tmp/playwright_chromiumdev_profile-* e similares
 *   2. Filtra os com idade > IDADE_MIN_MS (default 30 min — bem maior que
 *      qualquer execução normal de browser, que termina em segundos a
 *      poucos minutos)
 *   3. Mantém os MIN_MANTER mais recentes intocados (garantia extra contra
 *      race condition com browser ativo)
 *   4. Remove o resto recursivamente, com try/catch individual (1 falhar
 *      não trava o batch)
 *   5. Log do resumo
 *
 * Também limpa /tmp/screenshots/ (mais agressivamente — 24h, 200 arquivos).
 *
 * Importante: este módulo NÃO mata processos. Só remove arquivos órfãos.
 * Profile de browser ativo dura segundos/minutos, então 30 min é folga
 * suficiente pra garantir que nada vivo seja apagado.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = os.tmpdir(); // geralmente /tmp em Linux

// Padrões de diretórios/arquivos do Playwright/Chromium que ficam órfãos
const PADROES_PROFILE = [
  /^playwright_chromiumdev_profile-/,
  /^playwright_chromiumdev_runtime_dir-/,
  /^playwright_chromiumdev_/,           // genérico, pega outros tipos
  /^\.org\.chromium\.Chromium\./,       // Chromium tmps
  /^playwright-mcp-/,                   // MCP do Playwright
  /^playwright-artifacts-/,             // artifacts
];

const SCREENSHOT_DIR = path.join(TMP_DIR, 'screenshots');

// Idade mínima pra considerar profile órfão (não apaga nada mais novo).
// Browsers ativos terminam em segundos a alguns minutos. 30 min é bem
// conservador.
const IDADE_MIN_MS = 30 * 60 * 1000;

// Sempre mantém os N mais recentes intocados, mesmo que velhos. Garantia
// extra contra race conditions.
const MIN_MANTER = 3;

// Screenshots: idade máxima e teto.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const SCREENSHOT_MAX_FILES  = 200;

const TAG = '[tmp-cleanup]';

function log(msg) {
  console.log(`${TAG} ${msg}`);
}

/**
 * Remove diretório recursivamente. Usa fs.rmSync (Node 14.14+).
 * Se falhar, retorna false; se OK, true.
 */
function rmTreeSafe(fullPath) {
  try {
    // maxRetries 2 + force pra ignorar arquivos já removidos
    fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Remove arquivo. Best-effort.
 */
function rmFileSafe(fullPath) {
  try {
    fs.unlinkSync(fullPath);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Lista entradas em /tmp que casam com PADROES_PROFILE.
 * Retorna array de { nome, full, mtime, isDir }.
 */
function listarProfilesOrfaos() {
  let nomes;
  try {
    nomes = fs.readdirSync(TMP_DIR);
  } catch (e) {
    log(`⚠️ Não conseguiu ler ${TMP_DIR}: ${e.message}`);
    return [];
  }

  const items = [];
  for (const nome of nomes) {
    // Match contra qualquer padrão
    if (!PADROES_PROFILE.some(re => re.test(nome))) continue;

    const full = path.join(TMP_DIR, nome);
    try {
      const st = fs.statSync(full);
      items.push({
        nome,
        full,
        mtime: st.mtimeMs,
        isDir: st.isDirectory(),
      });
    } catch (_) {
      // Já foi removido entre readdir e stat — ignora
    }
  }
  return items;
}

/**
 * Limpa profiles do Playwright/Chromium órfãos.
 * Retorna { encontrados, removidos, mantidosVivos, mantidosRecentes }.
 */
function limparProfilesPlaywright() {
  const items = listarProfilesOrfaos();
  if (items.length === 0) {
    return { encontrados: 0, removidos: 0, mantidosVivos: 0, mantidosRecentes: 0 };
  }

  const agora = Date.now();

  // Ordena por mtime DESC (mais recente primeiro)
  items.sort((a, b) => b.mtime - a.mtime);

  // Mantém os MIN_MANTER mais recentes (slice 0..MIN_MANTER)
  const recentes = items.slice(0, MIN_MANTER);
  // Resto é candidato a remoção (se velho o suficiente)
  const candidatos = items.slice(MIN_MANTER);

  let removidos = 0;
  let mantidosVivos = 0;

  for (const item of candidatos) {
    const idadeMs = agora - item.mtime;
    if (idadeMs < IDADE_MIN_MS) {
      mantidosVivos++;
      continue;
    }
    const ok = item.isDir ? rmTreeSafe(item.full) : rmFileSafe(item.full);
    if (ok) removidos++;
  }

  return {
    encontrados: items.length,
    removidos,
    mantidosVivos,
    mantidosRecentes: recentes.length,
  };
}

/**
 * Limpa screenshots antigos em /tmp/screenshots.
 * Mesma lógica que tinha em playwright-agent.js — duplicada aqui pra
 * o cron rodar mesmo que aquele módulo não seja inicializado.
 */
function limparScreenshots() {
  if (!fs.existsSync(SCREENSHOT_DIR)) return { removidos: 0 };

  const agora = Date.now();
  let arquivos;
  try {
    arquivos = fs.readdirSync(SCREENSHOT_DIR)
      .map(nome => {
        const full = path.join(SCREENSHOT_DIR, nome);
        try {
          const st = fs.statSync(full);
          return { nome, full, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    log(`⚠️ Falha ao ler ${SCREENSHOT_DIR}: ${e.message}`);
    return { removidos: 0 };
  }

  let removidos = 0;

  // 1. Remove por idade
  for (const f of arquivos) {
    if (agora - f.mtime > SCREENSHOT_MAX_AGE_MS) {
      if (rmFileSafe(f.full)) removidos++;
    }
  }

  // 2. Se ainda sobrou muito arquivo recente, remove os mais antigos
  const restantes = arquivos
    .filter(f => agora - f.mtime <= SCREENSHOT_MAX_AGE_MS)
    .sort((a, b) => a.mtime - b.mtime);
  if (restantes.length > SCREENSHOT_MAX_FILES) {
    const excesso = restantes.slice(0, restantes.length - SCREENSHOT_MAX_FILES);
    for (const f of excesso) {
      if (rmFileSafe(f.full)) removidos++;
    }
  }

  return { removidos };
}

/**
 * Roda 1 ciclo completo de limpeza (profiles + screenshots).
 * Sempre safe pra chamar — try/catch individual em cada parte.
 */
function rodarCicloLimpeza() {
  const t0 = Date.now();

  let profileSummary = { encontrados: 0, removidos: 0, mantidosVivos: 0, mantidosRecentes: 0 };
  let ssSummary = { removidos: 0 };

  try {
    profileSummary = limparProfilesPlaywright();
  } catch (e) {
    log(`⚠️ Falha em limparProfilesPlaywright: ${e.message}`);
  }

  try {
    ssSummary = limparScreenshots();
  } catch (e) {
    log(`⚠️ Falha em limparScreenshots: ${e.message}`);
  }

  const dur = Date.now() - t0;

  // Só loga se algo aconteceu, pra não poluir
  if (profileSummary.removidos > 0 || ssSummary.removidos > 0 || profileSummary.encontrados > 0) {
    log(
      `🧹 Ciclo concluído (${dur}ms): ` +
      `${profileSummary.removidos} profile(s) removido(s) ` +
      `(${profileSummary.encontrados} encontrado(s), ` +
      `${profileSummary.mantidosVivos} ainda vivos, ` +
      `${profileSummary.mantidosRecentes} recentes preservados), ` +
      `${ssSummary.removidos} screenshot(s) removido(s)`
    );
  }

  return { profileSummary, ssSummary, durMs: dur };
}

let _intervalo = null;

/**
 * Inicia o cleanup periódico. Chama rodarCicloLimpeza() imediatamente
 * (pra liberar /tmp logo no boot) e depois a cada `intervaloMs`.
 *
 * Idempotente: se já estiver rodando, não cria outro timer.
 */
function iniciarCleanupPeriodico(intervaloMs = 30 * 60 * 1000) {
  if (_intervalo) {
    log('⚠️ Cleanup já está rodando, ignorando segunda chamada');
    return;
  }

  log(`▶️ Iniciando cleanup periódico (a cada ${Math.round(intervaloMs / 60000)} min)`);

  // Roda 1x agora (pra limpar lixo acumulado de boot/restart)
  rodarCicloLimpeza();

  // Depois roda a cada intervaloMs
  _intervalo = setInterval(() => {
    rodarCicloLimpeza();
  }, intervaloMs);

  // unref pra não impedir o processo de encerrar quando shutdown
  if (_intervalo.unref) _intervalo.unref();
}

function pararCleanupPeriodico() {
  if (_intervalo) {
    clearInterval(_intervalo);
    _intervalo = null;
    log('⏹️ Cleanup periódico parado');
  }
}

module.exports = {
  iniciarCleanupPeriodico,
  pararCleanupPeriodico,
  rodarCicloLimpeza,
  // Exportados pra teste/uso direto se precisar
  limparProfilesPlaywright,
  limparScreenshots,
};
