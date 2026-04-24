/**
 * agent-worker.js
 * Worker assíncrono: processa a fila ajustes_automaticos.
 * Processa 1 registro por vez — nunca abre Playwright em paralelo.
 * 
 * ⚡ Circuit breaker: se o DB falhar N vezes seguidas, faz back-off
 *    exponencial para não esgotar o pool de conexões.
 */

'use strict';

const { logger } = require('../../config/logger');
const { normalizeLocation }        = require('./location-normalizer');
const { executarCorrecaoEndereco } = require('./playwright-agent');
const { haversineKm, RAIO_MAXIMO_KM } = require('./routes/correcao.routes');
const { withBrowserLock } = require('./playwright-lock');

// ── Configuração ────────────────────────────────────────────────
const INTERVALO_NORMAL_MS  = 10_000;  // 10s — intervalo padrão de polling
const MAX_FALHAS_SEGUIDAS  = 3;       // após 3 falhas de DB, ativa back-off
const BACKOFF_BASE_MS      = 30_000;  // 30s inicial no back-off
const BACKOFF_MAX_MS       = 5 * 60_000; // teto: 5 minutos

// 🔧 REMOVIDO (2026-04): JOB_WATCHDOG_MS + comTimeout
//
// O watchdog absoluto de 4min envolvendo `executarCorrecaoEndereco` causava
// vazamento de Chromium: quando disparava, a Promise interna continuava
// rodando e tentando fechar o browser, mas `withBrowserLock` já tinha
// liberado — o próximo job pegava o lock e dava `chromium.launch()` em
// cima do anterior. Resultado: SIGTRAP / "Target page, context or browser
// has been closed" nos logs.
//
// A garantia de não-trava agora vem dos timeouts internos do playwright-agent
// (TIMEOUT=25s, NAV_TIMEOUT=45s) e do `fecharBrowserSeguro` no finally
// interno — quando a função retorna (sucesso OU erro), o Chromium está morto.

// ── Estado do circuit breaker ───────────────────────────────────
let workerAtivo       = false;
let falhasConsecutivas = 0;
let proximoTick       = null;

function log(msg) {
  logger.info(`[agent-worker] ${msg}`);
}

/**
 * Calcula delay com exponential back-off
 */
function calcularDelay() {
  if (falhasConsecutivas < MAX_FALHAS_SEGUIDAS) {
    return INTERVALO_NORMAL_MS;
  }
  const expoente = falhasConsecutivas - MAX_FALHAS_SEGUIDAS;
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, expoente), BACKOFF_MAX_MS);
  return delay;
}

/**
 * Testa se o pool está saudável antes de processar
 */
async function poolSaudavel(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function processarProximoPendente(pool) {
  let registro = null;

  try {
    // ── Health check rápido antes de processar ──
    if (falhasConsecutivas >= MAX_FALHAS_SEGUIDAS) {
      const ok = await poolSaudavel(pool);
      if (!ok) {
        throw new Error('Pool ainda indisponível (health check falhou)');
      }
      log(`✅ Conexão com DB restaurada após ${falhasConsecutivas} falhas`);
      falhasConsecutivas = 0;
    }

    const { rows } = await pool.query(
      `SELECT * FROM ajustes_automaticos
       WHERE status = 'pendente'
       ORDER BY criado_em ASC
       LIMIT 1`
    );

    // Reset do circuit breaker — query funcionou
    if (falhasConsecutivas > 0) {
      log(`✅ Circuit breaker resetado (era ${falhasConsecutivas} falhas)`);
    }
    falhasConsecutivas = 0;

    if (rows.length === 0) return;

    registro = rows[0];
    log(`📋 Processando ID ${registro.id} — OS ${registro.os_numero} — Ponto ${registro.ponto}`);

    // Marcar como processando (evitar duplo processamento)
    await pool.query(
      `UPDATE ajustes_automaticos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );

    // Normalizar localização
    let coords;
    try {
      coords = await normalizeLocation(registro.localizacao_raw);
      log(`📍 Coords: ${coords.latitude}, ${coords.longitude}`);
    } catch (err) {
      log(`❌ Normalização falhou: ${err.message}`);
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [`[Normalização] ${err.message}`, registro.id]
      );
      return;
    }

    // Salvar coords extraídas
    await pool.query(
      `UPDATE ajustes_automaticos SET latitude = $1, longitude = $2 WHERE id = $3`,
      [coords.latitude, coords.longitude, registro.id]
    );

    // Validar proximidade: motoboy deve estar a no máximo 2km das coordenadas informadas
    if (registro.motoboy_lat && registro.motoboy_lng) {
      const distancia = haversineKm(
        parseFloat(registro.motoboy_lat),
        parseFloat(registro.motoboy_lng),
        coords.latitude,
        coords.longitude
      );
      log(`📏 Distância motoboy → ponto: ${distancia.toFixed(2)} km (máx: ${RAIO_MAXIMO_KM} km)`);

      if (distancia > RAIO_MAXIMO_KM) {
        await pool.query(
          `UPDATE ajustes_automaticos
           SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
           WHERE id = $2`,
          [`[Segurança] Motoboy está a ${distancia.toFixed(2)} km do ponto informado. Máximo permitido: ${RAIO_MAXIMO_KM} km. Certifique-se de estar próximo ao local.`, registro.id]
        );
        return;
      }
    }

    // Executar Playwright (com lock global + watchdog absoluto)
    log(`🤖 Acionando Playwright para OS ${registro.os_numero}...`);

    // Marco inicial: registro saiu do 'pendente' e vai abrir browser.
    // O Playwright só começará a reportar a partir de 15% (login).
    await pool.query(
      `UPDATE ajustes_automaticos SET etapa_atual = 'iniciando', progresso = 5 WHERE id = $1`,
      [registro.id]
    ).catch(() => {});

    const resultado = await withBrowserLock(`agent-os-${registro.os_numero}`, () =>
      executarCorrecaoEndereco({
        os_numero:        registro.os_numero,
        ponto:            registro.ponto,
        latitude:         coords.latitude,
        longitude:        coords.longitude,
        cod_profissional: registro.cod_profissional || null,
        // Callback que o Playwright chama em marcos do fluxo.
        // Falha no UPDATE não pode derrubar o job — silenciar com .catch.
        onProgresso: (etapa, pct) => {
          pool.query(
            `UPDATE ajustes_automaticos SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
            [etapa, pct, registro.id]
          ).catch(() => {});
        },
      })
    );

    if (resultado.sucesso) {
      const endAntigo = resultado.endereco_antigo || null;
      let endCorrigido = resultado.endereco_corrigido || null;

      if (!endCorrigido || /^-?\d+\.\d+/.test(endCorrigido)) {
        try {
          const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
          if (GOOGLE_API_KEY && coords.latitude && coords.longitude) {
            const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coords.latitude},${coords.longitude}&key=${GOOGLE_API_KEY}&language=pt-BR`;
            const geoRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const geoData = await geoRes.json();
            if (geoData.status === 'OK' && geoData.results && geoData.results[0]) {
              endCorrigido = geoData.results[0].formatted_address;
              log(`📍 Geocode reverso: ${endCorrigido}`);
            }
          }
        } catch (geoErr) {
          log(`⚠️ Geocode reverso falhou: ${geoErr.message}`);
        }
      }

      if (!endCorrigido) {
        endCorrigido = registro.localizacao_raw || `${coords.latitude}, ${coords.longitude}`;
      }

      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'sucesso', processado_em = NOW(), endereco_corrigido = $2, endereco_antigo = $3, frete_recalculado = $4, valores_antes = $5, valores_depois = $6
         WHERE id = $1`,
        [registro.id, endCorrigido, endAntigo, resultado.frete_recalculado || false,
         resultado.valores_antes ? JSON.stringify(resultado.valores_antes) : null,
         resultado.valores_depois ? JSON.stringify(resultado.valores_depois) : null]
      );

      if (endAntigo) {
        try {
          const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
          if (GOOGLE_API_KEY) {
            const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endAntigo)}&key=${GOOGLE_API_KEY}&language=pt-BR&components=country:BR`;
            const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
            const geoData = await geoRes.json();
            if (geoData.status === 'OK' && geoData.results && geoData.results[0]) {
              const loc = geoData.results[0].geometry.location;
              await pool.query(
                `UPDATE ajustes_automaticos SET endereco_antigo_lat = $1, endereco_antigo_lng = $2 WHERE id = $3`,
                [loc.lat, loc.lng, registro.id]
              );
              log(`📍 Endereço antigo geocodificado: ${loc.lat}, ${loc.lng}`);
            }
          }
        } catch (geoErr) {
          log(`⚠️ Geocode endereço antigo falhou: ${geoErr.message}`);
        }
      }

      if (resultado.ponto1 && resultado.ponto1.lat) {
        await pool.query(
          `UPDATE ajustes_automaticos SET ponto1_lat = $1, ponto1_lng = $2, ponto1_endereco = $3 WHERE id = $4`,
          [resultado.ponto1.lat, resultado.ponto1.lng, resultado.ponto1.endereco || null, registro.id]
        ).catch(e => log(`⚠️ Erro ao salvar ponto1: ${e.message}`));
      }

      log(`✅ ID ${registro.id} concluído. Antigo: ${endAntigo || '—'} | Novo: ${endCorrigido || '—'} | Frete: ${resultado.frete_recalculado ? 'SIM' : 'NÃO'}`);
    } else {
      const detalhe = resultado.screenshot
        ? `${resultado.detalhe || resultado.erro} [Screenshot: ${resultado.screenshot}]`
        : (resultado.detalhe || resultado.erro);
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [detalhe, registro.id]
      );
      log(`❌ ID ${registro.id} erro: ${resultado.erro}`);
    }

  } catch (err) {
    // ── Circuit breaker: incrementar falhas SÓ se for erro de conexão de DB ──
    // Cuidado: "timeout" genérico captura errors do Playwright tb (page.goto
    // timeout, waitForSelector timeout). Esses NÃO são erro de DB — não devem
    // acionar o back-off do pool.
    const msg = err.message || '';
    const isDbError =
         msg.includes('Connection terminated')
      || msg.includes('ECONNREFUSED')
      || msg.includes('ECONNRESET')
      || msg.includes('too many clients')
      || msg.includes('Client has encountered a connection error')
      || /pool.*timeout/i.test(msg)
      || /timeout exceeded when trying to connect/i.test(msg);

    if (isDbError) {
      falhasConsecutivas++;
      const delay = calcularDelay();
      log(`💥 Erro DB (${falhasConsecutivas}x seguidas): ${err.message} — próximo tick em ${Math.round(delay / 1000)}s`);
    } else {
      log(`💥 Erro no job: ${err.message}`);
    }

    if (registro?.id) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [`[Worker] ${err.message}`, registro.id]
      ).catch(() => {});
    }
  }
}

function agendarProximoTick(pool) {
  let delay = INTERVALO_NORMAL_MS;
  try {
    delay = calcularDelay();
  } catch (_) { /* fallback pro padrão */ }

  proximoTick = setTimeout(async () => {
    try {
      await processarProximoPendente(pool);
    } catch (err) {
      // Nunca propagar — se lançar aqui, interrompe o worker pra sempre
      try { log(`💥 Exceção no ciclo: ${err.message}`); } catch (_) {}
    } finally {
      // Re-agendamento DEVE acontecer mesmo se tudo acima falhou.
      // Se não chegar aqui, o worker morre silenciosamente (era o bug).
      try {
        agendarProximoTick(pool);
      } catch (e) {
        // Último recurso: setTimeout raw direto, sem log, sem delay dinâmico
        setTimeout(() => agendarProximoTick(pool), INTERVALO_NORMAL_MS);
      }
    }
  }, delay);
}

function startAgentWorker(pool) {
  if (workerAtivo) {
    log('⚠️  Worker já ativo, ignorando.');
    return;
  }
  workerAtivo = true;
  log(`🚀 Worker iniciado — polling a cada ${INTERVALO_NORMAL_MS / 1000}s (circuit breaker ativo)`);

  agendarProximoTick(pool);
}

module.exports = { startAgentWorker };
