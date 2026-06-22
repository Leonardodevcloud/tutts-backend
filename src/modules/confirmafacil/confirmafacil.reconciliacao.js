/**
 * ════════════════════════════════════════════════════════════════════════
 *  CONFIRMAFÁCIL — RECONCILIAÇÃO DE ENTREGAS (reenvio automático)
 * ════════════════════════════════════════════════════════════════════════
 *  Resolve o furo do envio "dispara e esquece": quando o webhook tenta
 *  reportar a entrega (Cod.1) ao CF e falha (API instável / exceção / skip),
 *  o erro é engolido e nao ha retry — a corrida fica entregue do nosso lado
 *  mas "nao entregue" no CF, virando atraso.
 *
 *  Esta rotina roda no poller, acha as corridas ENTREGUES do nosso lado que
 *  NAO tem Cod.1 confirmado no CF e RE-ENVIA (reusando a mesma engine do
 *  webhook — cfService.processar, que ja tem dedupe). Tem teto de tentativas
 *  e, ao esgotar, alerta no WhatsApp (mesmo grupo da disponibilidade).
 *
 *  Nao mexe no caminho do webhook — apenas cobre o que ele perdeu.
 * ════════════════════════════════════════════════════════════════════════
 */

const MAX_TENTATIVAS = 6;   // teto de reenvios automaticos por corrida
const JANELA_HORAS   = 48;  // so reconcilia entregas das ultimas 48h
const LOTE           = 15;  // reenvios por ciclo (evita rajada)

// Envio WhatsApp (mesmo padrao/grupo da disponibilidade)
async function _enviarWhats(texto) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) return { enviado: false, motivo: 'desativado' };
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = (process.env.EVOLUTION_GROUP_ID_DISP || '').trim();
  if (!grupoId || !baseUrl || !apiKey || !instancia) return { enviado: false, motivo: 'config' };
  try {
    const resp = await fetch(`${baseUrl}/message/sendText/${instancia}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ number: grupoId, text: texto }),
    });
    return { enviado: resp.ok };
  } catch (e) { return { enviado: false, motivo: e.message }; }
}

// Já existe Cod.1 confirmado no CF para esta corrida?
async function _cfConfirmou(pool, solicitacaoId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM confirmafacil_log
     WHERE solicitacao_id = $1 AND cod_ocorrencia = '1' AND sucesso = TRUE LIMIT 1`,
    [solicitacaoId]
  );
  return rows.length > 0;
}

// Reconcilia: acha entregas concluidas no nosso lado sem Cod.1 no CF e reenvia.
async function reconciliarEntregas(pool) {
  // require tardio (evita qualquer ciclo de import)
  const { getConfirmaFacilService } = require('./confirmafacil.service');
  const cfService = getConfirmaFacilService(pool);

  const { rows: candidatos } = await pool.query(`
    SELECT DISTINCT sc.id AS solicitacao_id, sc.tutts_os_numero AS os_numero
    FROM solicitacoes_corrida sc
    JOIN confirmafacil_vinculos v ON v.solicitacao_id = sc.id
    JOIN solicitacoes_pontos sp ON sp.solicitacao_id = sc.id AND sp.ordem > 1
    WHERE sp.status = 'finalizado'
      AND sp.data_finalizado IS NOT NULL
      AND sp.numero_nota IS NOT NULL
      AND (sp.data_finalizado AT TIME ZONE 'UTC') >= now() - INTERVAL '${JANELA_HORAS} hours'
      AND (sp.motivo_finalizacao IS NULL
           OR LOWER(sp.motivo_finalizacao) NOT IN ('insucesso','ausente','fechado','recusou','nao_entregue'))
      AND NOT EXISTS (
        SELECT 1 FROM confirmafacil_log l
        WHERE l.solicitacao_id = sc.id AND l.cod_ocorrencia = '1' AND l.sucesso = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM confirmafacil_log l2
        WHERE l2.solicitacao_id = sc.id
          AND l2.status_tutts IN ('ausente','fechado','recusou','nao_entregue')
          AND l2.sucesso = TRUE)
    ORDER BY sc.id DESC
    LIMIT ${LOTE * 4}
  `);

  let reenviados = 0, alertas = 0, processados = 0;

  for (const c of candidatos) {
    if (processados >= LOTE) break;

    // estado de reconciliação (cria se nao existir)
    const { rows: [rec] } = await pool.query(
      `INSERT INTO confirmafacil_reconc (solicitacao_id)
       VALUES ($1)
       ON CONFLICT (solicitacao_id) DO UPDATE SET solicitacao_id = EXCLUDED.solicitacao_id
       RETURNING tentativas, alertado, resolvido`,
      [c.solicitacao_id]
    );
    if (rec.resolvido) continue;

    // esgotou as tentativas -> alerta uma vez e para
    if (rec.tentativas >= MAX_TENTATIVAS) {
      if (!rec.alertado) {
        // Alerta "CF nao confirmou uma entrega" desativado a pedido.
        // Mantemos a marcacao para encerrar o ciclo desta corrida (sem WhatsApp).
        await pool.query(`UPDATE confirmafacil_reconc SET alertado = TRUE WHERE solicitacao_id = $1`, [c.solicitacao_id]);
      }
      continue;
    }

    // tenta reenviar (reusa a engine do webhook; o dedupe interno protege)
    await pool.query(
      `UPDATE confirmafacil_reconc SET tentativas = tentativas + 1, ultima_em = now() WHERE solicitacao_id = $1`,
      [c.solicitacao_id]
    );
    processados++;
    try {
      await cfService.processar({
        solicitacaoId: c.solicitacao_id,
        osNumero:      c.os_numero,
        novoStatus:    'finalizado',
        pontoStatus:   'finalizado_ponto', // mapeia para Cod.1
      });
    } catch (e) {
      console.error(`[CF Reconc] erro ao reenviar OS ${c.os_numero}:`, e.message);
      continue;
    }

    // confirmou agora? marca resolvido
    if (await _cfConfirmou(pool, c.solicitacao_id)) {
      await pool.query(`UPDATE confirmafacil_reconc SET resolvido = TRUE WHERE solicitacao_id = $1`, [c.solicitacao_id]);
      reenviados++;
      console.log(`✅ [CF Reconc] OS ${c.os_numero} reenviada e confirmada no CF`);
    }
  }

  if (processados > 0 || reenviados > 0 || alertas > 0) {
    console.log(`[CF Reconc] candidatos=${candidatos.length} processados=${processados} reenviados=${reenviados} alertas=${alertas}`);
  }
  return { candidatos: candidatos.length, processados, reenviados, alertas };
}

module.exports = { reconciliarEntregas };
