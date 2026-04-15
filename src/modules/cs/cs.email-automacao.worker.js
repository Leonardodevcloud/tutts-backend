/**
 * MÓDULO CS — Worker de Automação de Email
 *
 * Funções compartilhadas entre o cron mensal (worker.js) e o endpoint
 * /disparar-agora (sub-router email-automacao.routes.js).
 *
 * Estratégia: ambos os caminhos chamam executarAutomacaoUnica(), que faz
 * 3 fetches HTTP internos pro próprio backend (Opção A — sem refactor das
 * rotas existentes do raio-x). O JWT é gerado on-the-fly com a mesma
 * JWT_SECRET que o backend usa pra validar — totalmente self-contained.
 *
 * Fluxo encadeado por automação ativa:
 *   1. POST /cs/raio-x              → gera raio-x interno (Gemini + métricas)
 *   2. POST /cs/raio-x/cliente      → monta versão cliente (HTML + mapa)
 *   3. POST /cs/raio-x/enviar-email → envia via Resend, registra em cs_emails_enviados
 *
 * Resultado: ultimo_envio_em, ultimo_envio_status, ultimo_envio_resend_id
 * (e ultimo_envio_erro em caso de falha) atualizados em cs_email_automacao.
 */

'use strict';

const jwt = require('jsonwebtoken');

const API_BASE = process.env.API_INTERNAL_URL
  || process.env.PUBLIC_API_URL
  || 'https://tutts-backend-production.up.railway.app';

// ─────────────────────────────────────────────────────────────
// Helpers de período
// ─────────────────────────────────────────────────────────────

/**
 * Calcula período do mês anterior fechado.
 * Ex: chamada em qualquer dia de abril/2026 → { inicio: '2026-03-01', fim: '2026-03-31' }
 */
function calcularPeriodoMesAnterior(refDate = new Date()) {
  const ano = refDate.getFullYear();
  const mes = refDate.getMonth(); // 0-indexed (0=jan)
  // Primeiro dia do mês anterior
  const inicio = new Date(ano, mes - 1, 1);
  // Último dia do mês anterior = dia 0 do mês corrente
  const fim = new Date(ano, mes, 0);
  return {
    inicio: inicio.toISOString().slice(0, 10),
    fim: fim.toISOString().slice(0, 10),
  };
}

/**
 * Calcula o próximo disparo agendado a partir do dia configurado.
 * - Se hoje < dia configurado neste mês → retorna esse dia neste mês
 * - Se hoje >= dia configurado → retorna esse dia no mês seguinte
 * Sempre às 06:00 horário do servidor.
 */
function calcularProximoEnvio(diaConfigurado, refDate = new Date()) {
  const dia = Math.max(1, Math.min(28, parseInt(diaConfigurado, 10) || 1));
  const ano = refDate.getFullYear();
  const mes = refDate.getMonth();
  const hoje = refDate.getDate();
  const candidato = new Date(ano, mes, dia, 6, 0, 0);
  if (hoje >= dia) candidato.setMonth(candidato.getMonth() + 1);
  return candidato;
}

// ─────────────────────────────────────────────────────────────
// Auth interna — gera JWT temporário pra chamar as rotas do API
// ─────────────────────────────────────────────────────────────

function gerarTokenInterno() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET não configurada — worker não pode autenticar');
  return jwt.sign(
    {
      codProfissional: 'AUTOMACAO_EMAIL',
      cod: 'AUTOMACAO_EMAIL',
      nome: 'Automação Email Mensal',
      role: 'admin',
      tipo: 'service-internal',
    },
    secret,
    { expiresIn: '10m' }
  );
}

async function fetchInterno(path, body, token) {
  const url = API_BASE.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} em ${path}: ${json.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.path = path;
    err.body = json;
    throw err;
  }
  return json;
}

// ─────────────────────────────────────────────────────────────
// Execução de UMA automação (1 cliente/centro)
// ─────────────────────────────────────────────────────────────

/**
 * @param {Pool} pool
 * @param {Object} cfg — linha de cs_email_automacao
 * @param {Object} periodo — { inicio: 'YYYY-MM-DD', fim: 'YYYY-MM-DD' }
 * @param {Object} opts — { manual?: boolean, disparado_por?: string }
 * @returns {Promise<{ status: 'success'|'failed', resend_id?: string, erro?: string }>}
 */
async function executarAutomacaoUnica(pool, cfg, periodo, opts = {}) {
  const tag = `[CS Auto #${cfg.id} cliente=${cfg.cod_cliente}${cfg.centro_custo ? ' CC=' + cfg.centro_custo : ''}]`;
  const t0 = Date.now();
  console.log(`${tag} 🚀 Iniciando — período ${periodo.inicio} a ${periodo.fim}${opts.manual ? ' (MANUAL)' : ''}`);

  let token;
  try {
    token = gerarTokenInterno();
  } catch (e) {
    await marcarFalha(pool, cfg.id, 'JWT_SECRET ausente: ' + e.message);
    return { status: 'failed', erro: e.message };
  }

  try {
    // ─── ETAPA 1: gerar raio-x interno ───
    console.log(`${tag} 1/3 gerando raio-x interno...`);
    const interno = await fetchInterno('/api/cs/raio-x', {
      cod_cliente: cfg.cod_cliente,
      centro_custo: cfg.centro_custo || undefined,
      data_inicio: periodo.inicio,
      data_fim: periodo.fim,
      tipo: 'completo',
    }, token);
    const raioXInternoId = interno?.raio_x?.id || interno?.id;
    if (!raioXInternoId) throw new Error('raio-x interno retornou sem id: ' + JSON.stringify(interno).slice(0, 200));
    console.log(`${tag} ✅ raio-x interno id=${raioXInternoId}`);

    // ─── ETAPA 2: gerar raio-x cliente ───
    console.log(`${tag} 2/3 gerando raio-x cliente...`);
    const cliente = await fetchInterno('/api/cs/raio-x/cliente', {
      raio_x_id: raioXInternoId,
    }, token);
    const raioXClienteId = cliente?.raio_x_cliente?.id;
    if (!raioXClienteId) throw new Error('raio-x cliente retornou sem id: ' + JSON.stringify(cliente).slice(0, 200));
    console.log(`${tag} ✅ raio-x cliente id=${raioXClienteId}`);

    // ─── ETAPA 3: enviar email ───
    console.log(`${tag} 3/3 enviando email...`);
    const destinatarios = Array.isArray(cfg.destinatarios) ? cfg.destinatarios : JSON.parse(cfg.destinatarios || '[]');
    if (destinatarios.length === 0) throw new Error('config sem destinatários');

    const envio = await fetchInterno('/api/cs/raio-x/enviar-email', {
      raio_x_id: raioXClienteId,
      para: destinatarios,
    }, gerarTokenInterno()); // token novo (paranoia caso etapas 1-2 demorem perto do TTL)
    const resendId = envio?.messageId;
    if (!resendId) throw new Error('envio retornou sem messageId: ' + JSON.stringify(envio).slice(0, 200));

    const elapsed = Date.now() - t0;
    console.log(`${tag} ✅ DONE em ${elapsed}ms — Resend ID ${resendId}`);

    // Marca sucesso na config
    await pool.query(
      `UPDATE cs_email_automacao
          SET ultimo_envio_em = NOW(),
              ultimo_envio_status = 'success',
              ultimo_envio_resend_id = $1,
              ultimo_envio_erro = NULL,
              atualizada_em = NOW()
        WHERE id = $2`,
      [resendId, cfg.id]
    );

    return { status: 'success', resend_id: resendId, raio_x_cliente_id: raioXClienteId };
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error(`${tag} ❌ FALHA em ${elapsed}ms:`, err.message);
    await marcarFalha(pool, cfg.id, err.message);
    return { status: 'failed', erro: err.message };
  }
}

async function marcarFalha(pool, cfgId, mensagem) {
  try {
    await pool.query(
      `UPDATE cs_email_automacao
          SET ultimo_envio_em = NOW(),
              ultimo_envio_status = 'failed',
              ultimo_envio_erro = $1,
              atualizada_em = NOW()
        WHERE id = $2`,
      [String(mensagem).slice(0, 500), cfgId]
    );
  } catch (e) {
    console.error('[CS Auto] Falha ao registrar erro:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Execução em LOTE — chamada pelo cron diário no worker.js
// ─────────────────────────────────────────────────────────────

/**
 * Executa todas as automações ativas no dia configurado.
 * Chamada pelo cron diário no worker.js — só processa se HOJE for o
 * dia configurado em cs_config.automacao_email_dia.
 */
async function executarAutomacaoEmLote(pool) {
  const cfg = await pool.query(`SELECT valor FROM cs_config WHERE chave = 'automacao_email_dia'`);
  const diaConfigurado = parseInt(cfg.rows[0]?.valor || '1', 10);
  const hoje = new Date().getDate();

  if (hoje !== diaConfigurado) {
    // Custo zero nos outros 29 dias
    return { skipped: true, hoje, dia_configurado: diaConfigurado };
  }

  console.log(`📧 [CS Automação] HOJE é dia ${hoje} = dia configurado. Iniciando lote mensal...`);
  const periodo = calcularPeriodoMesAnterior();
  console.log(`📧 [CS Automação] Período do relatório: ${periodo.inicio} a ${periodo.fim}`);

  const ativas = await pool.query(`
    SELECT * FROM cs_email_automacao
     WHERE ativa = true
     ORDER BY cod_cliente ASC, centro_custo NULLS FIRST
  `);
  console.log(`📧 [CS Automação] ${ativas.rows.length} configurações ativas pra processar`);

  let sucessos = 0, falhas = 0;
  for (const cfg of ativas.rows) {
    // Sequencial pra não bombar Gemini com requests paralelos.
    // Pausa de 3s entre cada — evita rate limit do Gemini e do Resend.
    const r = await executarAutomacaoUnica(pool, cfg, periodo, { manual: false });
    if (r.status === 'success') sucessos++; else falhas++;
    await new Promise((res) => setTimeout(res, 3000));
  }

  console.log(`📧 [CS Automação] Lote concluído: ${sucessos} sucessos, ${falhas} falhas (de ${ativas.rows.length} totais)`);
  return { skipped: false, total: ativas.rows.length, sucessos, falhas };
}

module.exports = {
  executarAutomacaoUnica,
  executarAutomacaoEmLote,
  calcularPeriodoMesAnterior,
  calcularProximoEnvio,
};
