/**
 * Tutts Backend - worker.js
 * Processo separado para tarefas agendadas (crons)
 * Não serve HTTP — só executa jobs no banco
 * 
 * Deploy: Railway → New Service → worker.js
 * Env: mesmas variáveis do server principal
 * 
 * ⚠️  FIX: Todos os crons compartilhados com server.js agora usam withCronLock
 *     para evitar execução duplicada. Locks transacionais (xact) garantem
 *     liberação automática — impossível travar.
 */

const cron = require('node-cron');
const { pool, testConnection } = require('./src/config/database');
const { logger } = require('./src/config/logger');

// 🔒 Mutex para crons compartilhados com server.js
const { withCronLock, liberarLocksOrfaos } = require('./src/shared/utils/cronMutex');

// ─── Score ────────────────────────────────────────────────
const { aplicarGratuidadeProfissional } = require('./src/modules/score/score.service');

// ─── Auth cleanup ─────────────────────────────────────────
const bcrypt = require('bcrypt');
const { REFRESH_SECRET } = require('./src/modules/auth/auth.service');

// ─── WhatsApp Notifications ──────────────────────────────
let notificarLoteGerado, notificarResumoDiario;
try {
  const whatsapp = require('./src/modules/financial/routes/whatsapp.service');
  notificarLoteGerado = whatsapp.notificarLoteGerado;
  notificarResumoDiario = whatsapp.notificarResumoDiario;
  console.log('✅ [Worker] WhatsApp module carregado');
} catch (err) {
  console.warn('⚠️ [Worker] WhatsApp module não carregou:', err.message);
  notificarLoteGerado = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
  notificarResumoDiario = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
}

// ─── Stark Bank SDK (para saldo no resumo diário) ────────
let starkbank = null;
try {
  starkbank = require('starkbank');
  const projectId = process.env.STARK_PROJECT_ID;
  const privateKey = process.env.STARK_PRIVATE_KEY;
  const environment = process.env.STARK_ENVIRONMENT || 'production';

  if (projectId && privateKey) {
    let key = privateKey.replace(/\\n/g, '\n');
    if (!key.includes('\n')) {
      key = key
        .replace('-----BEGIN EC PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----\n')
        .replace('-----END EC PRIVATE KEY-----', '\n-----END EC PRIVATE KEY-----');
    }
    key = key.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n');

    const project = new starkbank.Project({ environment, id: projectId, privateKey: key });
    starkbank.setUser(project);
    console.log('✅ [Worker] Stark Bank SDK inicializado');
  } else {
    console.warn('⚠️ [Worker] Stark Bank: variáveis não configuradas — saldo não disponível no resumo');
    starkbank = null;
  }
} catch (err) {
  console.warn('⚠️ [Worker] Stark Bank SDK não carregou:', err.message);
  starkbank = null;
}

console.log('🔧 Tutts Worker iniciando...');
console.log(`📅 ${new Date().toISOString()}`);
console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// ════════════════════════════════════════════════════════════
// JOB 1: Score - Gratuidades (dia 1 de cada mês, 00:05 UTC)
// ════════════════════════════════════════════════════════════
cron.schedule('5 0 1 * *', async () => {
  console.log('🎁 [CRON] Iniciando aplicação de gratuidades do Score...');
  try {
    const mesReferencia = new Date().toISOString().slice(0, 7);
    const profissionais = await pool.query(`
      SELECT cod_prof, nome_prof, score_total
      FROM score_totais
      WHERE score_total >= 80
      ORDER BY score_total DESC
    `);

    let aplicados = 0;
    for (const prof of profissionais.rows) {
      try {
        const resultado = await aplicarGratuidadeProfissional(pool, prof, mesReferencia);
        if (resultado === 'criado') aplicados++;
      } catch (err) {
        console.error(`[CRON] Erro gratuidade ${prof.cod_prof}:`, err.message);
      }
    }

    console.log(`✅ [CRON] Gratuidades Score aplicadas: ${aplicados} profissionais`);
  } catch (error) {
    console.error('❌ [CRON] Erro gratuidades Score:', error.message);
  }
});

// ════════════════════════════════════════════════════════════
// JOB 2: TODO - Recorrências (a cada 1 hora)
// ════════════════════════════════════════════════════════════
const processarRecorrencias = async () => {
  try {
    const result = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrencia IS NOT NULL 
        AND recorrencia != 'nenhuma'
        AND status = 'concluida'
        AND proxima_recorrencia IS NOT NULL 
        AND proxima_recorrencia <= NOW()
    `);

    let reabertas = 0;
    for (const tarefa of result.rows) {
      try {
        await pool.query(`
          UPDATE todo_tarefas 
          SET status = 'pendente', 
              atualizado_em = NOW(),
              proxima_recorrencia = CASE recorrencia
                WHEN 'diaria' THEN proxima_recorrencia + INTERVAL '1 day'
                WHEN 'semanal' THEN proxima_recorrencia + INTERVAL '7 days'
                WHEN 'mensal' THEN proxima_recorrencia + INTERVAL '1 month'
                ELSE NULL
              END
          WHERE id = $1
        `, [tarefa.id]);
        reabertas++;
      } catch (err) {
        console.error(`[CRON] Erro recorrência tarefa ${tarefa.id}:`, err.message);
      }
    }
    if (reabertas > 0) console.log(`🔄 [CRON] ${reabertas} tarefas recorrentes reabertas`);
  } catch (err) {
    console.error('❌ [CRON] Erro recorrências:', err.message);
  }
};

// Rodar a cada hora
setInterval(processarRecorrencias, 60 * 60 * 1000);
// Primeira execução após 10s
setTimeout(processarRecorrencias, 10000);

// ════════════════════════════════════════════════════════════
// JOB 3: Auth - Limpeza de bloqueios expirados (a cada 5 min)
// ════════════════════════════════════════════════════════════
const limparBloqueiosExpirados = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM login_attempts 
      WHERE blocked_until IS NOT NULL 
        AND blocked_until < NOW()
    `);
    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} bloqueio(s) de login expirado(s) removido(s)`);
    }
  } catch (err) {
    console.error('❌ [CRON] Erro limpeza bloqueios:', err.message);
  }
};

setInterval(limparBloqueiosExpirados, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// JOB 4: Auth - Limpeza de refresh tokens expirados (a cada 1h)
// ════════════════════════════════════════════════════════════
const limparRefreshTokensExpirados = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM refresh_tokens 
      WHERE expires_at < NOW() 
         OR revoked = true
    `);
    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} refresh token(s) expirado(s) removido(s)`);
    }
  } catch (err) {
    console.error('❌ [CRON] Erro limpeza refresh tokens:', err.message);
  }
};

setInterval(limparRefreshTokensExpirados, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// JOB 5: Financial - Preparar lote Stark Bank (a cada 1 hora)
// APENAS aprova saques e marca 'em_lote' para o admin revisar
// ⚠️  NÃO EXECUTA PAGAMENTO — admin faz isso manualmente via /stark/lote/executar
// 🔒 withCronLock: mesmo jobName que server.js para evitar duplicação
// ════════════════════════════════════════════════════════════

const prepararLoteStarkAutomatico = async () => {
  console.log('🏦 [CRON Stark] Verificando saques aguardando pagamento Stark...');
  try {
    const saquesProntos = await pool.query(`
      SELECT w.*
      FROM withdrawal_requests w
      WHERE w.status = 'aguardando_pagamento_stark'
        AND w.debito = true
        AND (w.stark_status IS NULL OR w.stark_status = 'erro')
      ORDER BY w.created_at ASC
    `);

    if (saquesProntos.rows.length === 0) {
      console.log('🏦 [CRON Stark] Nenhum saque pendente');
      return;
    }

    const saques = saquesProntos.rows;
    const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

    console.log(`🏦 [CRON Stark] ${saques.length} saque(s) encontrado(s) — R$ ${valorTotal.toFixed(2)}`);

    // ═══ FIX: Verificar se já existe lote 'pendente' DE HOJE — reusar ao invés de criar novo ═══
    let loteId;
    const lotePendenteExistente = await pool.query(`
      SELECT id, quantidade, valor_total FROM stark_lotes 
      WHERE status = 'pendente' AND created_at >= CURRENT_DATE
      ORDER BY created_at DESC 
      LIMIT 1
    `);

    if (lotePendenteExistente.rows.length > 0) {
      loteId = lotePendenteExistente.rows[0].id;
      const qtdAnterior = parseInt(lotePendenteExistente.rows[0].quantidade) || 0;
      const valorAnterior = parseFloat(lotePendenteExistente.rows[0].valor_total) || 0;
      await pool.query(`
        UPDATE stark_lotes 
        SET quantidade = $1, valor_total = $2
        WHERE id = $3
      `, [qtdAnterior + saques.length, valorAnterior + valorTotal, loteId]);
      console.log(`🏦 [CRON Stark] Reusando lote pendente #${loteId} — adicionando ${saques.length} saque(s)`);
    } else {
      const loteResult = await pool.query(`
        INSERT INTO stark_lotes (quantidade, valor_total, saldo_antes, status, executado_por_id, executado_por_nome)
        VALUES ($1, $2, 0, 'pendente', 0, 'Sistema (Auto-batch)')
        RETURNING *
      `, [saques.length, valorTotal]);
      loteId = loteResult.rows[0].id;
      console.log(`🏦 [CRON Stark] Novo lote #${loteId} criado`);
    }

    // Aprovar e marcar como 'em_lote'
    for (const saque of saques) {
      const novoStatus = saque.has_gratuity ? 'aprovado_gratuidade' : 'aprovado';
      await pool.query(`
        UPDATE withdrawal_requests
        SET status = $1,
            approved_at = COALESCE(approved_at, NOW()),
            lancamento_at = COALESCE(lancamento_at, NOW()),
            stark_status = 'em_lote',
            stark_lote_id = $2,
            admin_name = COALESCE(admin_name, 'Sistema (Auto-batch)'),
            updated_at = NOW()
        WHERE id = $3
      `, [novoStatus, loteId, saque.id]);
    }

    console.log(`✅ [CRON Stark] Lote #${loteId} — ${saques.length} saque(s) aprovados e marcados 'em_lote'`);

    // 📱 Notificar grupo WhatsApp (com await)
    try {
      const whatsResult = await notificarLoteGerado({ loteId, quantidade: saques.length, valorTotal, saques });
      console.log(`📱 [CRON Stark] WhatsApp lote #${loteId}: ${whatsResult.enviado ? '✅ enviado' : '⚠️ ' + (whatsResult.motivo || 'não enviado')}`);
    } catch (errWhats) {
      console.error('❌ [WhatsApp] Falha na notificação lote criado:', errWhats.message);
    }

  } catch (error) {
    console.error('❌ [CRON Stark] Erro geral:', error.message);
  }
};

// 🔒 Seg-Sex: a cada hora das 8h às 18h (com mutex — mesmo jobName do server.js)
cron.schedule('0 8-18 * * 1-5', withCronLock(pool, 'prepararLoteStark', prepararLoteStarkAutomatico), { timezone: 'America/Bahia' });
// 🔒 Sábado: a cada hora das 8h às 12h
cron.schedule('0 8-12 * * 6', withCronLock(pool, 'prepararLoteStark', prepararLoteStarkAutomatico), { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// RESUMO DIÁRIO — 19h (Seg-Sex) | 13h (Sáb)
// 🔒 withCronLock: mesmo jobName que server.js
// ════════════════════════════════════════════════════════════
const enviarResumoDiario = async () => {
  console.log('📊 [CRON Resumo] Gerando resumo diário...');
  try {
    // ═══ DEDUP: Verificar se já enviou resumo hoje ═══
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cron_execution_log (
        job_name VARCHAR(100) NOT NULL,
        execution_date DATE NOT NULL DEFAULT CURRENT_DATE,
        executed_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (job_name, execution_date)
      )
    `).catch(() => {});

    const dedup = await pool.query(`
      INSERT INTO cron_execution_log (job_name, execution_date)
      VALUES ('resumoDiario', CURRENT_DATE)
      ON CONFLICT (job_name, execution_date) DO NOTHING
      RETURNING *
    `);

    if (dedup.rows.length === 0) {
      console.log('📊 [CRON Resumo] Já enviou resumo hoje — pulando para evitar duplicata');
      return;
    }

    // Query espelhando a aba Validação (filtro por data de solicitação = created_at)
    const resumo = await pool.query(`
      SELECT 
        COUNT(*) as total_recebidas,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade', 'pago_stark')) as total_aprovadas,
        COUNT(*) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)) as sem_gratuidade,
        COUNT(*) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)) as com_gratuidade,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas,
        COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)), 0) as valor_sem_gratuidade,
        COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)), 0) as valor_com_gratuidade
      FROM withdrawal_requests
      WHERE created_at >= CURRENT_DATE
        AND created_at < (CURRENT_DATE + INTERVAL '1 day')
    `);

    const r = resumo.rows[0];
    const totalRecebidas = parseInt(r.total_recebidas) || 0;
    const totalAprovadas = parseInt(r.total_aprovadas) || 0;
    const semGratuidade = parseInt(r.sem_gratuidade) || 0;
    const comGratuidade = parseInt(r.com_gratuidade) || 0;
    const rejeitadas = parseInt(r.rejeitadas) || 0;
    const valorSemGratuidade = parseFloat(r.valor_sem_gratuidade) || 0;
    const valorComGratuidade = parseFloat(r.valor_com_gratuidade) || 0;
    const valorTotalAprovado = valorSemGratuidade + valorComGratuidade;
    const lucro = valorSemGratuidade * 0.045;
    const deixouArrecadar = valorComGratuidade * 0.045;

    // Consultar saldo Stark Bank
    let saldoStark = 0;
    if (starkbank) {
      try {
        const result = await starkbank.balance.get();
        if (Array.isArray(result)) {
          saldoStark = result.length > 0 ? result[0].amount / 100 : 0;
        } else if (result && result.amount !== undefined) {
          saldoStark = result.amount / 100;
        }
      } catch (errSaldo) {
        console.error('⚠️ [CRON Resumo] Erro ao consultar saldo Stark:', errSaldo.message);
      }
    }

    console.log(`📊 [CRON Resumo] Recebidas: ${totalRecebidas} | Aprovadas: ${totalAprovadas} | Lucro: R$ ${lucro.toFixed(2)} | Saldo: R$ ${saldoStark.toFixed(2)}`);

    await notificarResumoDiario({ totalRecebidas, totalAprovadas, semGratuidade, comGratuidade, rejeitadas, valorTotalAprovado, lucro, deixouArrecadar, saldoStark });
    console.log('📊 [CRON Resumo] ✅ Resumo enviado com sucesso');

  } catch (error) {
    console.error('❌ [CRON Resumo] Erro geral:', error.message);
    // Se falhou, remover o registro de dedup para permitir retry
    await pool.query(`DELETE FROM cron_execution_log WHERE job_name = 'resumoDiario' AND execution_date = CURRENT_DATE`).catch(() => {});
  }
};

// 🔒 Seg-Sex às 19h (com mutex)
cron.schedule('0 19 * * 1-5', withCronLock(pool, 'resumoDiario', enviarResumoDiario), { timezone: 'America/Bahia' });
// 🔒 Sábado às 13h
cron.schedule('0 13 * * 6', withCronLock(pool, 'resumoDiario', enviarResumoDiario), { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// JOB 6: Filas - Reset diário às 19h (Seg-Sáb)
// Remove TODOS da fila (aguardando + em_rota) e registra no histórico
// 🔒 withCronLock: mesmo jobName que server.js
// ════════════════════════════════════════════════════════════
const resetarFilasDiario = async () => {
  console.log('🔄 [CRON Filas] Iniciando reset diário das filas...');
  try {
    // Buscar todos que estão na fila antes de limpar (para histórico)
    const posicoes = await pool.query(`
      SELECT p.*, c.nome as central_nome
      FROM filas_posicoes p
      LEFT JOIN filas_centrais c ON c.id = p.central_id
    `);

    if (posicoes.rows.length === 0) {
      console.log('🔄 [CRON Filas] Nenhum profissional na fila — nada a resetar');
      return;
    }

    // Registrar cada remoção no histórico
    for (const pos of posicoes.rows) {
      const tempoEspera = pos.entrada_fila_at 
        ? Math.round((Date.now() - new Date(pos.entrada_fila_at).getTime()) / 60000)
        : null;
      const tempoRota = pos.saida_rota_at
        ? Math.round((Date.now() - new Date(pos.saida_rota_at).getTime()) / 60000)
        : null;

      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, tempo_rota_minutos, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        pos.central_id,
        pos.central_nome || 'Central',
        pos.cod_profissional,
        pos.nome_profissional,
        'reset_diario',
        tempoEspera,
        pos.status === 'em_rota' ? tempoRota : null,
        'Reset automático das 19h (status: ' + pos.status + ')',
        'sistema',
        'CRON Reset 19h'
      ]);
    }

    // Limpar todas as posições
    const deleted = await pool.query('DELETE FROM filas_posicoes RETURNING *');

    // Limpar notificações do dia
    await pool.query('DELETE FROM filas_notificacoes').catch(() => {});

    const aguardando = posicoes.rows.filter(p => p.status === 'aguardando').length;
    const emRota = posicoes.rows.filter(p => p.status === 'em_rota').length;

    console.log(`✅ [CRON Filas] Reset concluído — ${deleted.rowCount} removido(s) (${aguardando} aguardando, ${emRota} em rota)`);
  } catch (error) {
    console.error('❌ [CRON Filas] Erro no reset diário:', error.message);
  }
};

// 🔒 Todos os dias às 19h (Seg-Sáb) com mutex
cron.schedule('0 19 * * 1-6', withCronLock(pool, 'resetFilas', resetarFilasDiario), { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// JOB 7: Disponibilidade - Alerta WhatsApp de preenchimento
// Envia para grupo WhatsApp os clientes com < 95% de motos preenchidas
// Seg-Sex 9h-13h (1h)
// ENV: EVOLUTION_GROUP_ID_DISP (grupo específico — sem fallback)
// 🔒 withCronLock: mesmo jobName que server.js
// ════════════════════════════════════════════════════════════
const alertarDisponibilidadeWhatsApp = async () => {
  console.log('🏍️ [CRON Disp] Verificando preenchimento de disponibilidade...');
  try {
    // Buscar lojas com qtd_titulares > 0 e contar linhas preenchidas (titulares apenas)
    const result = await pool.query(`
      SELECT 
        l.id,
        l.codigo,
        l.nome,
        l.qtd_titulares,
        COUNT(li.id) FILTER (WHERE li.is_excedente = false AND li.is_reposicao = false) as total_linhas,
        COUNT(li.id) FILTER (
          WHERE li.is_excedente = false 
          AND li.is_reposicao = false 
          AND li.cod_profissional IS NOT NULL 
          AND li.cod_profissional != ''
          AND li.status = 'EM LOJA'
        ) as preenchidas,
        COUNT(li.id) FILTER (
          WHERE li.is_excedente = false 
          AND li.is_reposicao = false 
          AND li.cod_profissional IS NOT NULL 
          AND li.cod_profissional != ''
          AND li.status = 'A CAMINHO'
        ) as a_caminho,
        r.nome as regiao_nome
      FROM disponibilidade_lojas l
      LEFT JOIN disponibilidade_linhas li ON li.loja_id = l.id
      LEFT JOIN disponibilidade_regioes r ON r.id = l.regiao_id
      GROUP BY l.id, l.codigo, l.nome, l.qtd_titulares, r.nome
      HAVING COUNT(li.id) FILTER (WHERE li.is_excedente = false AND li.is_reposicao = false) > 0
      ORDER BY r.nome, l.nome
    `);

    if (result.rows.length === 0) {
      console.log('🏍️ [CRON Disp] Nenhuma loja configurada com titulares');
      return;
    }

    const LIMIAR = 95; // Aceitável: >= 95%
    let totalGeralTitulares = 0;
    let totalGeralPreenchidas = 0;
    const clientesAbaixo = [];

    for (const loja of result.rows) {
      const titulares = parseInt(loja.total_linhas) || 0;
      const preenchidas = parseInt(loja.preenchidas) || 0;
      const aCaminho = parseInt(loja.a_caminho) || 0;
      const pct = titulares > 0 ? Math.round((preenchidas / titulares) * 100) : 0;

      totalGeralTitulares += titulares;
      totalGeralPreenchidas += preenchidas;

      if (pct < LIMIAR) {
        clientesAbaixo.push({
          codigo: loja.codigo,
          nome: loja.nome,
          regiao: loja.regiao_nome || 'Sem região',
          preenchidas,
          titulares,
          faltando: titulares - preenchidas,
          pct,
          a_caminho: aCaminho
        });
      }
    }

    const pctGeral = totalGeralTitulares > 0 
      ? Math.round((totalGeralPreenchidas / totalGeralTitulares) * 100) 
      : 0;

    // Se todos >= 95%, não alertar
    if (clientesAbaixo.length === 0) {
      console.log(`✅ [CRON Disp] Todos os clientes >= ${LIMIAR}% — sem alerta (geral: ${pctGeral}%)`);
      return;
    }

    // Montar mensagem
    const agora = new Date();
    const dataHora = agora.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    let msg = `🏍️ *Alerta de Disponibilidade*\n`;
    msg += `📅 ${dataHora}\n\n`;
    msg += `📊 Preenchimento geral: *${pctGeral}%* (${totalGeralPreenchidas}/${totalGeralTitulares})\n\n`;
    msg += `⚠️ *Clientes abaixo de ${LIMIAR}%:*\n\n`;

    // Agrupar por região
    const porRegiao = {};
    for (const c of clientesAbaixo) {
      if (!porRegiao[c.regiao]) porRegiao[c.regiao] = [];
      porRegiao[c.regiao].push(c);
    }

    for (const [regiao, clientes] of Object.entries(porRegiao)) {
      msg += `📍 *${regiao}*\n`;
      for (const c of clientes) {
        const emoji = c.pct === 0 ? '🔴' : c.pct < 50 ? '🟠' : '🟡';
        msg += `${emoji} ${c.codigo} ${c.nome} — *${c.preenchidas}/${c.titulares}* (${c.pct}%)`;
        if (c.a_caminho > 0) msg += ` + ${c.a_caminho} a caminho 🚀`;
        msg += ` falta *${c.faltando}*\n`;
      }
      msg += `\n`;
    }

    msg += `_*Argos, seu sentinela operacional!*_`;

    console.log(`🏍️ [CRON Disp] ${clientesAbaixo.length} cliente(s) abaixo de ${LIMIAR}% — enviando alerta...`);

    // Enviar via Evolution API
    const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
    if (!ativo) {
      console.log('📱 [CRON Disp] WhatsApp desativado (WHATSAPP_NOTIF_ATIVO != true)');
      console.log('📱 [CRON Disp] Mensagem que seria enviada:\n', msg);
      return;
    }

    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instancia = process.env.EVOLUTION_INSTANCE;
    // 🔒 Grupo específico — sem fallback (aborts se não configurado)
    const grupoId = (process.env.EVOLUTION_GROUP_ID_DISP || '').trim();
    if (!grupoId) { console.warn('⚠️ [CRON Disp] EVOLUTION_GROUP_ID_DISP não configurado — abortando'); return; }

    if (!baseUrl || !apiKey || !instancia) {
      console.warn('⚠️ [CRON Disp] Evolution API: variáveis incompletas');
      return;
    }

    const url = `${baseUrl}/message/sendText/${instancia}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: grupoId, text: msg })
    });

    if (response.ok) {
      console.log(`✅ [CRON Disp] Alerta enviado para grupo — ${clientesAbaixo.length} cliente(s)`);
    } else {
      const data = await response.json().catch(() => ({}));
      console.error(`❌ [CRON Disp] Erro Evolution ${response.status}:`, data);
    }

  } catch (error) {
    console.error('❌ [CRON Disp] Erro geral:', error.message);
  }
};

// 🔒 Seg-Sex: 9h-13h (1h) com mutex
cron.schedule('0 9-13 * * 1-5', withCronLock(pool, 'alertaDisp', alertarDisponibilidadeWhatsApp), { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════
(async () => {
  try {
    await testConnection();

    // 🧹 Limpar advisory locks órfãos de deploys anteriores
    await liberarLocksOrfaos(pool);

    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  🔧 Tutts Worker ONLINE');
    console.log('  📋 Jobs ativos:');
    console.log('     ⏰ Score gratuidades — dia 1/mês 00:05');
    console.log('     ⏰ TODO recorrências — a cada 1h');
    console.log('     ⏰ Auth bloqueios    — a cada 5min');
    console.log('     ⏰ Auth tokens       — a cada 1h');
    console.log('     ⏰ Stark auto-batch  — Seg-Sex 8h-18h | Sáb 8h-12h 🔒');
    console.log('     ⏰ Resumo diário     — Seg-Sex 19h | Sáb 13h 🔒');
    console.log('     ⏰ Filas reset       — Seg-Sáb 19h 🔒');
    console.log('     ⏰ Disp alerta WA   — Seg-Sex 9h-13h (1h) 🔒');
    console.log('  🔒 = protegido por CronMutex (xact lock)');
    console.log('══════════════════════════════════════════');
    console.log('');
  } catch (error) {
    console.error('❌ Worker falhou ao conectar no banco:', error.message);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Worker recebeu SIGTERM, encerrando...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Worker recebeu SIGINT, encerrando...');
  await pool.end();
  process.exit(0);
});
