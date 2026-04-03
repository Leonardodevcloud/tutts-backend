/**
 * Sub-Router: Limites de Saque (Solicitação + Liberação)
 * 
 * Endpoints:
 *   GET    /withdrawals/limites/:userCod           — limites do usuário (atualizado com liberações)
 *   POST   /withdrawals/solicitar-limite            — motoboy solicita mais limite
 *   GET    /withdrawals/solicitacoes-limite          — admin lista solicitações
 *   PATCH  /withdrawals/solicitacoes-limite/:id/liberar — admin libera limite
 *   PATCH  /withdrawals/solicitacoes-limite/:id/rejeitar — admin rejeita solicitação
 *   GET    /withdrawals/solicitacoes-limite/contadores — contadores para badge
 */

const express = require('express');

function createLimitesRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  // Plific config (mesma lógica do financial.routes.js)
  const PLIFIC_AMBIENTE = process.env.PLIFIC_AMBIENTE || 'teste';
  const PLIFIC_BASE_URL = PLIFIC_AMBIENTE === 'producao' 
    ? 'https://tutts.com.br/sem/v1/rotas.php/integracao-plific-saldo-prof'
    : 'https://mototaxionline.com/sem/v1/rotas.php/integracao-plific-saldo-prof';
  const PLIFIC_TOKEN = process.env.PLIFIC_TOKEN;

  // ═══════════════════════════════════════════════════════════
  // HELPER: Calcular início e fim do ciclo atual (terça a segunda)
  // ═══════════════════════════════════════════════════════════
  function getCicloAtual() {
    // Usar UTC-3 (Bahia) de forma confiável sem toLocaleString
    const agora = new Date();
    const utcMs = agora.getTime() + agora.getTimezoneOffset() * 60000;
    const hojeBR = new Date(utcMs - 3 * 3600000);
    const dow = hojeBR.getDay(); // 0=Dom, 1=Seg, 2=Ter

    let diasDesdeInicio;
    if (dow === 0) diasDesdeInicio = 5;
    else if (dow === 1) diasDesdeInicio = 6;
    else diasDesdeInicio = dow - 2;

    const inicio = new Date(hojeBR);
    inicio.setDate(inicio.getDate() - diasDesdeInicio);
    const fim = new Date(inicio);
    fim.setDate(fim.getDate() + 6);

    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { inicio: fmt(inicio), fim: fmt(fim) };
  }

  // SQL para calcular início do ciclo (terça) — reutilizado em várias queries
  const SQL_CICLO_INICIO = `(date_trunc('week', CURRENT_DATE - interval '1 day') + interval '1 day')::date`;
  const SQL_CICLO_FIM = `(date_trunc('week', CURRENT_DATE - interval '1 day') + interval '7 days')::date`;

  // ═══════════════════════════════════════════════════════════
  // GET /withdrawals/limites/:userCod — Limites com liberações
  // ═══════════════════════════════════════════════════════════
  router.get('/withdrawals/limites/:userCod', verificarToken, async (req, res) => {
    try {
      const { userCod } = req.params;
      
      // Segurança: só o próprio ou admin
      const isAdmin = req.user && ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
      const userCodToken = String(req.user.codProfissional || req.user.cod_profissional || '');
      if (!isAdmin && userCodToken !== String(userCod)) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
      
      const LIMITE_POR_SAQUE = parseFloat(process.env.LIMITE_MAX_SAQUE || '1000');
      const LIMITE_DIARIO = parseFloat(process.env.LIMITE_DIARIO_SAQUE || '1000');
      const LIMITE_SEMANAL = parseFloat(process.env.LIMITE_SEMANAL_SAQUE || '1500');

      const [sacadoHoje, sacadoSemana, liberacoes, solicitacaoPendente, todasSolicitacoes] = await Promise.all([
        // Total sacado hoje
        pool.query(
          `SELECT COALESCE(SUM(requested_amount), 0) as total
           FROM withdrawal_requests 
           WHERE user_cod = $1 
             AND created_at >= CURRENT_DATE
             AND status NOT IN ('rejeitado', 'excluido')`,
          [userCod]
        ),
        // Total sacado no ciclo atual (terça a segunda)
        pool.query(
          `SELECT COALESCE(SUM(requested_amount), 0) as total
           FROM withdrawal_requests 
           WHERE user_cod = $1 
             AND created_at >= ${SQL_CICLO_INICIO}
             AND status NOT IN ('rejeitado', 'excluido')`,
          [userCod]
        ),
        // Total de liberações ativas no ciclo atual
        pool.query(
          `SELECT COALESCE(SUM(valor_extra), 0) as total_extra
           FROM withdrawal_limit_liberacoes
           WHERE user_cod = $1 
             AND status = 'liberado'
             AND ciclo_inicio = ${SQL_CICLO_INICIO}`,
          [userCod]
        ),
        // Verificar se já tem solicitação pendente no ciclo
        pool.query(
          `SELECT id, created_at FROM withdrawal_limit_liberacoes
           WHERE user_cod = $1 
             AND status = 'pendente'
             AND ciclo_inicio = ${SQL_CICLO_INICIO}
           LIMIT 1`,
          [userCod]
        ),
        // Todas as solicitações do motoboy no ciclo atual (para mostrar no histórico)
        pool.query(
          `SELECT * FROM withdrawal_limit_liberacoes
           WHERE user_cod = $1 
             AND ciclo_inicio = ${SQL_CICLO_INICIO}
           ORDER BY created_at DESC`,
          [userCod]
        )
      ]);

      const totalHoje = parseFloat(sacadoHoje.rows[0].total);
      const totalSemana = parseFloat(sacadoSemana.rows[0].total);
      const totalExtraLiberado = parseFloat(liberacoes.rows[0].total_extra);
      const limiteDiarioEfetivo = LIMITE_DIARIO + totalExtraLiberado;
      const limiteSemanalEfetivo = LIMITE_SEMANAL + totalExtraLiberado;
      const temSolicitacaoPendente = solicitacaoPendente.rows.length > 0;

      const ciclo = getCicloAtual();

      res.json({
        por_saque: { limite: LIMITE_POR_SAQUE },
        diario: { 
          limite: LIMITE_DIARIO,
          limite_efetivo: limiteDiarioEfetivo,
          utilizado: totalHoje, 
          disponivel: Math.max(0, limiteDiarioEfetivo - totalHoje),
          extra_liberado: totalExtraLiberado
        },
        semanal: { 
          limite: LIMITE_SEMANAL,
          limite_efetivo: limiteSemanalEfetivo,
          utilizado: totalSemana, 
          disponivel: Math.max(0, limiteSemanalEfetivo - totalSemana),
          extra_liberado: totalExtraLiberado
        },
        ciclo: {
          inicio: ciclo.inicio,
          fim: ciclo.fim,
          reseta_em: 'terça-feira'
        },
        solicitacao_pendente: temSolicitacaoPendente,
        solicitacao_pendente_id: temSolicitacaoPendente ? solicitacaoPendente.rows[0].id : null,
        solicitacoes: todasSolicitacoes.rows,
        max_disponivel: Math.min(
          LIMITE_POR_SAQUE, 
          Math.max(0, limiteDiarioEfetivo - totalHoje), 
          Math.max(0, limiteSemanalEfetivo - totalSemana)
        )
      });
    } catch (error) {
      console.error('❌ Erro ao buscar limites:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // POST /withdrawals/solicitar-limite — Motoboy solicita mais limite
  // ═══════════════════════════════════════════════════════════
  router.post('/withdrawals/solicitar-limite', verificarToken, async (req, res) => {
    try {
      let { userCod, userName, motivo } = req.body;

      // Segurança: para motoboy, SEMPRE usar o código do próprio token (nunca confiar no body)
      const isAdmin = req.user && ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
      if (!isAdmin) {
        userCod = String(req.user.codProfissional || req.user.cod_profissional || userCod);
        userName = req.user.nome || req.user.fullName || req.user.username || userName;
      }

      if (!userCod || !userName) {
        return res.status(400).json({ error: 'Campos obrigatórios: userCod, userName' });
      }

      console.log(`📋 [Limites] Solicitação recebida — user: ${userCod} (${userName}), token: codProfissional=${req.user.codProfissional}, cod_profissional=${req.user.cod_profissional}`);

      const ciclo = getCicloAtual();

      // Verificar se já existe solicitação pendente no ciclo
      const existente = await pool.query(
        `SELECT id FROM withdrawal_limit_liberacoes
         WHERE user_cod = $1 AND status = 'pendente' AND ciclo_inicio = $2`,
        [userCod, ciclo.inicio]
      );

      if (existente.rows.length > 0) {
        return res.status(409).json({ 
          error: 'Você já possui uma solicitação de limite pendente para este ciclo. Aguarde a liberação.',
          solicitacao_id: existente.rows[0].id
        });
      }

      // =============== VALIDAR SALDO PLIFIC (só solicita se tiver saldo) ===============
      if (PLIFIC_BASE_URL && PLIFIC_TOKEN) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          
          const saldoResp = await fetch(
            `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${userCod}`,
            {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' },
              signal: controller.signal
            }
          );
          clearTimeout(timeout);
          
          const saldoData = await saldoResp.json();
          
          if (saldoData.status === '200' || saldoData.status === 200) {
            const saldoStr = String(saldoData.dados?.profissional?.saldo || '0');
            const saldoNum = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
            
            if (saldoNum <= 0) {
              return res.status(400).json({ 
                error: 'Você não possui saldo disponível para solicitar mais limite. Só é possível solicitar com saldo positivo.',
                saldo: saldoNum
              });
            }
          }
        } catch (errSaldo) {
          // Se falhar a consulta, permite solicitar (não bloqueia por erro de rede)
          console.warn(`⚠️ [Limites] Erro ao consultar saldo Plific para ${userCod}: ${errSaldo.message}`);
        }
      }

      // Calcular quanto já usou no ciclo (para renovar o ciclo, não dar extra)
      const LIMITE_SEMANAL = parseFloat(process.env.LIMITE_SEMANAL_SAQUE || '1500');
      const LIMITE_DIARIO = parseFloat(process.env.LIMITE_DIARIO_SAQUE || '1000');
      
      const [usadoNoCiclo, usadoHoje] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(requested_amount), 0) as total
           FROM withdrawal_requests 
           WHERE user_cod = $1 
             AND created_at >= ${SQL_CICLO_INICIO}
             AND status NOT IN ('rejeitado', 'excluido')`,
          [userCod]
        ),
        pool.query(
          `SELECT COALESCE(SUM(requested_amount), 0) as total
           FROM withdrawal_requests 
           WHERE user_cod = $1 
             AND created_at >= CURRENT_DATE
             AND status NOT IN ('rejeitado', 'excluido')`,
          [userCod]
        )
      ]);
      
      const valorUsadoCiclo = parseFloat(usadoNoCiclo.rows[0].total);
      const valorUsadoHoje = parseFloat(usadoHoje.rows[0].total);
      
      // Detectar qual limite foi esgotado: diário ou semanal
      const diarioEsgotado = valorUsadoHoje >= LIMITE_DIARIO;
      const semanalEsgotado = valorUsadoCiclo >= LIMITE_SEMANAL;
      const tipoLimite = diarioEsgotado && !semanalEsgotado ? 'diario' : 'semanal';
      
      // valor_extra = quanto já usou → ao liberar, disponível volta ao LIMITE_SEMANAL original
      const valorExtra = valorUsadoCiclo;
      
      const result = await pool.query(
        `INSERT INTO withdrawal_limit_liberacoes 
         (user_cod, user_name, tipo, status, valor_extra, motivo, ciclo_inicio, ciclo_fim, tipo_limite)
         VALUES ($1, $2, 'solicitacao', 'pendente', $3, $4, $5, $6, $7)
         RETURNING *`,
        [userCod, userName, valorExtra, motivo || null, ciclo.inicio, ciclo.fim, tipoLimite]
      );

      const solicitacao = result.rows[0];

      // Auditoria
      await registrarAuditoria(req, 'LIMIT_REQUEST_CREATE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawal_limit_liberacoes', solicitacao.id, {
        user_cod: userCod,
        user_name: userName,
        valor_extra: valorExtra,
        valor_usado_ciclo: valorUsadoCiclo,
        valor_usado_hoje: valorUsadoHoje,
        tipo_limite: tipoLimite,
        ciclo: `${ciclo.inicio} a ${ciclo.fim}`
      });

      // Notificar admins via WebSocket em tempo real
      if (global.broadcastToAdmins) {
        global.broadcastToAdmins('NEW_LIMIT_REQUEST', {
          id: solicitacao.id,
          user_cod: userCod,
          user_name: userName,
          valor_extra: valorExtra,
          tipo_limite: tipoLimite,
          motivo: motivo || null,
          created_at: solicitacao.created_at
        });
      }

      console.log(`📋 [Limites] Nova solicitação de ${userName} (${userCod}) — tipo: ${tipoLimite}, usado ciclo: R$ ${valorUsadoCiclo.toFixed(2)}, hoje: R$ ${valorUsadoHoje.toFixed(2)}, renovação: R$ ${valorExtra.toFixed(2)}`);

      res.status(201).json({ 
        success: true, 
        solicitacao,
        message: 'Solicitação de limite enviada! O financeiro será notificado.'
      });
    } catch (error) {
      console.error('❌ Erro ao solicitar limite:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /withdrawals/solicitacoes-limite — Admin lista solicitações
  // ═══════════════════════════════════════════════════════════
  router.get('/withdrawals/solicitacoes-limite', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { status, ciclo } = req.query;
      
      let where = 'WHERE 1=1';
      const params = [];

      if (status) {
        params.push(status);
        where += ` AND wll.status = $${params.length}`;
      }

      if (ciclo === 'atual') {
        where += ` AND wll.ciclo_inicio = ${SQL_CICLO_INICIO}`;
      }

      const result = await pool.query(`
        SELECT wll.*,
          EXTRACT(EPOCH FROM (NOW() - wll.created_at))/3600 as horas_aguardando
        FROM withdrawal_limit_liberacoes wll
        ${where}
        ORDER BY 
          CASE WHEN wll.status = 'pendente' THEN 0 ELSE 1 END,
          wll.created_at DESC
      `, params);

      res.json(result.rows);
    } catch (error) {
      console.error('❌ Erro ao listar solicitações de limite:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /withdrawals/solicitacoes-limite/contadores
  // ═══════════════════════════════════════════════════════════
  router.get('/withdrawals/solicitacoes-limite/contadores', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
          COUNT(*) FILTER (WHERE status = 'liberado') as liberados,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
          COUNT(*) FILTER (WHERE status = 'pendente' AND ciclo_inicio = ${SQL_CICLO_INICIO}) as pendentes_ciclo_atual,
          COUNT(*) FILTER (WHERE status = 'liberado' AND ciclo_inicio = ${SQL_CICLO_INICIO}) as liberados_ciclo_atual
        FROM withdrawal_limit_liberacoes
      `);
      res.json(result.rows[0]);
    } catch (error) {
      console.error('❌ Erro contadores limites:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PATCH /withdrawals/solicitacoes-limite/:id/liberar — Admin libera
  // ═══════════════════════════════════════════════════════════
  router.patch('/withdrawals/solicitacoes-limite/:id/liberar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { id } = req.params;
      const adminName = req.user.nome || req.user.fullName || req.user.username || 'Admin';
      const adminId = req.user.id;

      // Verificar se existe e está pendente
      const check = await pool.query(
        `SELECT * FROM withdrawal_limit_liberacoes WHERE id = $1`,
        [id]
      );

      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Solicitação não encontrada' });
      }

      if (check.rows[0].status !== 'pendente') {
        return res.status(400).json({ error: `Solicitação já está com status: ${check.rows[0].status}` });
      }

      // Liberar
      const result = await pool.query(
        `UPDATE withdrawal_limit_liberacoes 
         SET status = 'liberado', 
             admin_id = $1, 
             admin_name = $2, 
             liberado_at = NOW(),
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [adminId, adminName, id]
      );

      const liberacao = result.rows[0];

      // Auditoria
      await registrarAuditoria(req, 'LIMIT_REQUEST_APPROVE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawal_limit_liberacoes', id, {
        user_cod: liberacao.user_cod,
        user_name: liberacao.user_name,
        valor_extra: liberacao.valor_extra,
        admin: adminName
      });

      // Notificar o motoboy via WebSocket
      if (global.broadcastToAdmins) {
        // Tentar enviar diretamente para o motoboy
        try {
          const { sendToUser } = require('../../config/websocket');
          sendToUser(liberacao.user_cod, 'LIMIT_APPROVED', {
            id: liberacao.id,
            valor_extra: liberacao.valor_extra,
            admin_name: adminName
          });
        } catch (e) {
          // Se falhar o import, prosseguir sem notificação individual
        }
      }

      // Notificar admins para atualizar a lista
      if (global.broadcastToAdmins) {
        global.broadcastToAdmins('LIMIT_REQUEST_UPDATE', {
          id: liberacao.id,
          status: 'liberado',
          admin_name: adminName,
          user_cod: liberacao.user_cod,
          user_name: liberacao.user_name
        });
      }

      console.log(`✅ [Limites] Liberação #${id} aprovada por ${adminName} — ${liberacao.user_name} (${liberacao.user_cod}) +R$ ${liberacao.valor_extra}`);

      res.json({ success: true, liberacao });
    } catch (error) {
      console.error('❌ Erro ao liberar limite:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PATCH /withdrawals/solicitacoes-limite/:id/rejeitar — Admin rejeita
  // ═══════════════════════════════════════════════════════════
  router.patch('/withdrawals/solicitacoes-limite/:id/rejeitar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body;
      const adminName = req.user.nome || req.user.fullName || req.user.username || 'Admin';

      const check = await pool.query(
        `SELECT * FROM withdrawal_limit_liberacoes WHERE id = $1 AND status = 'pendente'`,
        [id]
      );

      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Solicitação pendente não encontrada' });
      }

      const result = await pool.query(
        `UPDATE withdrawal_limit_liberacoes 
         SET status = 'rejeitado', 
             admin_name = $1,
             motivo = COALESCE($2, motivo),
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [adminName, motivo || null, id]
      );

      const rejeitada = result.rows[0];

      await registrarAuditoria(req, 'LIMIT_REQUEST_REJECT', AUDIT_CATEGORIES.FINANCIAL, 'withdrawal_limit_liberacoes', id, {
        user_cod: rejeitada.user_cod,
        admin: adminName,
        motivo
      });

      if (global.broadcastToAdmins) {
        global.broadcastToAdmins('LIMIT_REQUEST_UPDATE', {
          id: rejeitada.id,
          status: 'rejeitado',
          admin_name: adminName,
          user_cod: rejeitada.user_cod,
          user_name: rejeitada.user_name
        });
      }

      console.log(`❌ [Limites] Solicitação #${id} rejeitada por ${adminName}`);
      res.json({ success: true, rejeitada });
    } catch (error) {
      console.error('❌ Erro ao rejeitar solicitação:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createLimitesRoutes };
