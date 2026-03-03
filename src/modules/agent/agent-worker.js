/**
 * agent-worker.js
 * Worker assíncrono: processa a fila ajustes_automaticos a cada 10s.
 * Processa 1 registro por vez — nunca abre Playwright em paralelo.
 */

'use strict';

const { logger } = require('../../config/logger');
const { normalizeLocation }        = require('./location-normalizer');
const { executarCorrecaoEndereco } = require('./playwright-agent');
const { haversineKm, RAIO_MAXIMO_KM } = require('./routes/correcao.routes');

const INTERVALO_MS = 3_000;
let   workerAtivo  = false;

function log(msg) {
  logger.info(`[agent-worker] ${msg}`);
}

async function processarProximoPendente(pool) {
  let registro = null;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM ajustes_automaticos
       WHERE status = 'pendente'
       ORDER BY criado_em ASC
       LIMIT 1`
    );

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

    // Executar Playwright
    log(`🤖 Acionando Playwright para OS ${registro.os_numero}...`);
    const resultado = await executarCorrecaoEndereco({
      os_numero:        registro.os_numero,
      ponto:            registro.ponto,
      latitude:         coords.latitude,
      longitude:        coords.longitude,
      cod_profissional: registro.cod_profissional || null,
    });

    if (resultado.sucesso) {
      // Endereço antigo: capturado pelo playwright do modal
      const endAntigo = resultado.endereco_antigo || null;

      // Endereço corrigido: tentar geocodificação reversa das coordenadas
      let endCorrigido = resultado.endereco_corrigido || null;

      if (!endCorrigido || /^-?\d+\.\d+/.test(endCorrigido)) {
        // É coordenada ou vazio — fazer geocodificação reversa
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

      // Fallback final: coordenadas + localizacao_raw
      if (!endCorrigido) {
        endCorrigido = registro.localizacao_raw || `${coords.latitude}, ${coords.longitude}`;
      }

      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'sucesso', processado_em = NOW(), endereco_corrigido = $2, endereco_antigo = $3, frete_recalculado = $4
         WHERE id = $1`,
        [registro.id, endCorrigido, endAntigo, resultado.frete_recalculado || false]
      );
            // Salvar coordenadas do Ponto 1 se capturadas pelo playwright
      if (resultado.ponto1 && resultado.ponto1.lat) {
        await pool.query(
          `UPDATE ajustes_automaticos SET ponto1_lat = $1, ponto1_lng = $2, ponto1_endereco = $3 WHERE id = $4`,
          [resultado.ponto1.lat, resultado.ponto1.lng, resultado.ponto1.endereco || null, registro.id]
        ).catch(e => log(`⚠️ Erro ao salvar ponto1: ${e.message}`));
      }

      log(`✅ ID ${registro.id} concluído. Antigo: ${endAntigo || '—'} | Novo: ${endCorrigido || '—'} | Frete: ${resultado.frete_recalculado ? 'SIM' : 'NÃO'}`);
    } else {
      const detalhe = resultado.screenshot
        ? `${resultado.erro} [Screenshot: ${resultado.screenshot}]`
        : resultado.erro;
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [detalhe, registro.id]
      );
      log(`❌ ID ${registro.id} erro: ${resultado.erro}`);
    }

  } catch (err) {
    log(`💥 Erro crítico: ${err.message}`);
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

function startAgentWorker(pool) {
  if (workerAtivo) {
    log('⚠️  Worker já ativo, ignorando.');
    return;
  }
  workerAtivo = true;
  log('🚀 Worker iniciado — verificando fila a cada 10s...');

  setInterval(async () => {
    try {
      await processarProximoPendente(pool);
    } catch (err) {
      log(`💥 Exceção no ciclo: ${err.message}`);
    }
  }, INTERVALO_MS);
}

module.exports = { startAgentWorker };
