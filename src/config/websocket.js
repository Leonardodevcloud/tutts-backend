/**
 * src/config/websocket.js
 * WebSocket server para notificações em tempo real
 * 
 * Dois canais WS:
 *   /ws/financeiro       — saques, notificações financeiras (existente)
 *   /ws/disponibilidade  — sincronização em tempo real do painel de disponibilidade
 * 
 * Roteamento feito manualmente via server.on('upgrade') porque a lib `ws`
 * não suporta dois WebSocket.Server com path diferente no mesmo HTTP server.
 */

const WebSocket = require('ws');
const url = require('url');
const jwt = require('jsonwebtoken');
const env = require('./env');

// ============================================
// FINANCEIRO - clientes
// ============================================
const wsClients = {
  admins: new Set(),
  users: new Map(),
};

// ============================================
// DISPONIBILIDADE - clientes
// ============================================
const wsDispClients = new Set();
let dispWsIdCounter = 0;

/**
 * Broadcast para todos os clientes conectados ao módulo disponibilidade.
 * Envia para todos EXCETO o remetente (identificado por senderWsId).
 */
function broadcastDisponibilidade(event, data, senderWsId = null) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  let count = 0;
  wsDispClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws._dispWsId !== senderWsId) {
      ws.send(message);
      count++;
    }
  });
  if (count > 0) {
    console.log(`📡 [WS-Disp] Broadcast ${event} para ${count} cliente(s)`);
  }
}

// ============================================
// FINANCEIRO - helpers
// ============================================
function broadcastToAdmins(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wsClients.admins.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
  console.log(`📡 [WS] Broadcast para ${wsClients.admins.size} admins: ${event}`);
}

function sendToUser(userCod, event, data) {
  const userConnections = wsClients.users.get(userCod);
  if (!userConnections) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  userConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
}

function notifyNewWithdrawal(withdrawal) {
  broadcastToAdmins('NEW_WITHDRAWAL', {
    id: withdrawal.id,
    user_cod: withdrawal.user_cod,
    user_name: withdrawal.user_name,
    cpf: withdrawal.cpf,
    pix_key: withdrawal.pix_key,
    requested_amount: withdrawal.requested_amount,
    final_amount: withdrawal.final_amount,
    has_gratuity: withdrawal.has_gratuity,
    status: withdrawal.status,
    created_at: withdrawal.created_at,
  });
}

function notifyWithdrawalUpdate(withdrawal, action) {
  broadcastToAdmins('WITHDRAWAL_UPDATE', {
    id: withdrawal.id,
    user_cod: withdrawal.user_cod,
    status: withdrawal.status,
    admin_name: withdrawal.admin_name,
    approved_at: withdrawal.approved_at,
    reject_reason: withdrawal.reject_reason,
    action,
  });
  sendToUser(withdrawal.user_cod, 'MY_WITHDRAWAL_UPDATE', {
    id: withdrawal.id,
    status: withdrawal.status,
    action,
    reject_reason: withdrawal.reject_reason,
  });
}

// ============================================
// STARK BANK - notificação em tempo real
// ============================================
function notifyStarkPayment(saque, novoStatus) {
  // Broadcast para todos os admins — atualiza Pix Stark, Acerto, Conciliação
  broadcastToAdmins('STARK_PAYMENT_UPDATE', {
    id: saque.id,
    user_cod: saque.user_cod,
    user_name: saque.user_name,
    stark_transfer_id: saque.stark_transfer_id,
    stark_status: novoStatus,
    stark_erro: saque.stark_erro,
    stark_lote_id: saque.stark_lote_id,
    status: saque.status,
    final_amount: saque.final_amount,
    // Para acertos (stark_lote_itens)
    lote_id: saque.lote_id,
    cod_prof: saque.cod_prof,
    nome_prof: saque.nome_prof,
  });

  // Notificar o motoboy que recebeu o pagamento
  if (novoStatus === 'pago' && saque.user_cod) {
    sendToUser(saque.user_cod, 'MY_WITHDRAWAL_UPDATE', {
      id: saque.id,
      status: 'pago_stark',
      action: 'pago_stark',
    });
  }
}

// ============================================
// HANDLERS DE CONEXÃO
// ============================================

function handleFinanceiroConnection(ws) {
  console.log('🔌 [WS] Nova conexão financeiro');
  let clientType = null;
  let userCod = null;
  let authenticated = false;
  let lastToken = null;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log('⚠️ [WS] Conexão fechada por falta de autenticação');
      ws.close(4001, 'Autenticação necessária');
    }
  }, 30000);

  // 🔒 SECURITY FIX (MED-03): Re-validar JWT a cada 5 minutos
  let reAuthInterval = null;
  function startReAuth() {
    if (reAuthInterval) clearInterval(reAuthInterval);
    reAuthInterval = setInterval(() => {
      if (!lastToken || !authenticated) return;
      try {
        jwt.verify(lastToken, env.JWT_SECRET);
      } catch (err) {
        console.log(`⚠️ [WS] Token expirado para ${userCod || 'admin'}, fechando conexão`);
        ws.send(JSON.stringify({ event: 'AUTH_EXPIRED', error: 'Token expirado, reconecte com novo token' }));
        ws.close(4003, 'Token expirado');
      }
    }, 5 * 60 * 1000); // 5 minutos
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'AUTH') {
        const { token, role } = data;
        if (!token) {
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token não fornecido' }));
          return;
        }

        try {
          const decoded = jwt.verify(token, env.JWT_SECRET);
          authenticated = true;
          lastToken = token;
          clearTimeout(authTimeout);
          startReAuth();

          if (decoded.role !== role) {
            console.log(`⚠️ [WS] Role mismatch: token=${decoded.role}, informado=${role}`);
          }

          if (['admin', 'admin_master', 'admin_financeiro'].includes(decoded.role)) {
            clientType = 'admin';
            wsClients.admins.add(ws);
            ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', role: 'admin', user: decoded.nome }));
            console.log(`✅ [WS] Admin ${decoded.nome} autenticado. Total: ${wsClients.admins.size}`);
          } else if (decoded.codProfissional) {
            clientType = 'user';
            userCod = decoded.codProfissional;
            if (!wsClients.users.has(userCod)) wsClients.users.set(userCod, new Set());
            wsClients.users.get(userCod).add(ws);
            ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', role: 'user', userCod }));
            console.log(`✅ [WS] Usuário ${userCod} autenticado`);
          }
        } catch (jwtError) {
          console.log(`❌ [WS] Token inválido: ${jwtError.message}`);
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token inválido ou expirado' }));
          ws.close(4003, 'Token inválido');
        }
      }

      // 🔒 SECURITY FIX: Permitir re-auth com novo token (após refresh no frontend)
      if (data.type === 'REAUTH' && authenticated) {
        try {
          const decoded = jwt.verify(data.token, env.JWT_SECRET);
          lastToken = data.token;
          ws.send(JSON.stringify({ event: 'REAUTH_SUCCESS' }));
          console.log(`🔄 [WS] Token renovado para ${userCod || 'admin'}`);
        } catch (err) {
          ws.send(JSON.stringify({ event: 'AUTH_EXPIRED', error: 'Novo token inválido' }));
          ws.close(4003, 'Token inválido');
        }
      }

      if (data.type === 'PING' && authenticated) {
        ws.send(JSON.stringify({ event: 'PONG', timestamp: new Date().toISOString() }));
      }
    } catch (e) {
      console.error('❌ [WS] Erro:', e.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (reAuthInterval) clearInterval(reAuthInterval);
    if (clientType === 'admin') {
      wsClients.admins.delete(ws);
      console.log(`🔌 [WS] Admin desconectado. Restam: ${wsClients.admins.size}`);
    } else if (clientType === 'user' && userCod) {
      const conns = wsClients.users.get(userCod);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) wsClients.users.delete(userCod);
      }
    }
  });

  ws.send(JSON.stringify({ event: 'CONNECTED', message: 'Conectado ao Tutts - Envie AUTH com token' }));
}

function handleDisponibilidadeConnection(ws) {
  console.log('🔌 [WS-Disp] Nova conexão');
  let authenticated = false;

  ws._dispWsId = `disp_${++dispWsIdCounter}_${Date.now()}`;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log('⚠️ [WS-Disp] Conexão fechada por falta de autenticação');
      ws.close(4001, 'Autenticação necessária');
    }
  }, 30000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'AUTH') {
        const { token } = data;
        if (!token) {
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token não fornecido' }));
          return;
        }

        try {
          const decoded = jwt.verify(token, env.JWT_SECRET);
          authenticated = true;
          clearTimeout(authTimeout);

          if (['admin', 'admin_master', 'admin_financeiro'].includes(decoded.role)) {
            wsDispClients.add(ws);
            ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', wsId: ws._dispWsId, user: decoded.nome }));
            console.log(`✅ [WS-Disp] ${decoded.nome} autenticado (${ws._dispWsId}). Total: ${wsDispClients.size}`);
          } else {
            ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Acesso restrito a admins' }));
            ws.close(4003, 'Acesso restrito');
          }
        } catch (jwtError) {
          console.log(`❌ [WS-Disp] Token inválido: ${jwtError.message}`);
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token inválido ou expirado' }));
          ws.close(4003, 'Token inválido');
        }
      }

      if (data.type === 'PING' && authenticated) {
        ws.send(JSON.stringify({ event: 'PONG', timestamp: new Date().toISOString() }));
      }
    } catch (e) {
      console.error('❌ [WS-Disp] Erro:', e.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    wsDispClients.delete(ws);
    console.log(`🔌 [WS-Disp] Desconectado (${ws._dispWsId}). Restam: ${wsDispClients.size}`);
  });

  ws.send(JSON.stringify({ event: 'CONNECTED', message: 'Conectado ao Tutts Disponibilidade - Envie AUTH com token' }));
}

// ============================================
// SETUP - roteamento manual via upgrade
// ============================================
function setupWebSocket(server) {
  // Criar dois WSS sem path fixo (noServer: true)
  const wssFinanceiro = new WebSocket.Server({ noServer: true });
  const wssDisp = new WebSocket.Server({ noServer: true });

  wssFinanceiro.on('connection', handleFinanceiroConnection);
  wssDisp.on('connection', handleDisponibilidadeConnection);

  // Interceptar o evento upgrade do HTTP server para rotear por path
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);

    if (pathname === '/ws/financeiro') {
      wssFinanceiro.handleUpgrade(request, socket, head, (ws) => {
        wssFinanceiro.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/disponibilidade') {
      wssDisp.handleUpgrade(request, socket, head, (ws) => {
        wssDisp.emit('connection', ws, request);
      });
    } else {
      console.log(`⚠️ [WS] Path desconhecido: ${pathname}`);
      socket.destroy();
    }
  });

  console.log('🔌 [WS] Servidor WebSocket configurado: /ws/financeiro + /ws/disponibilidade');
  return wssFinanceiro;
}

// Exportar para global (módulos legados usam global.notifyNewWithdrawal)
function registerGlobals() {
  global.notifyNewWithdrawal = notifyNewWithdrawal;
  global.notifyWithdrawalUpdate = notifyWithdrawalUpdate;
  global.broadcastToAdmins = broadcastToAdmins;
  global.sendToUser = sendToUser;
  global.broadcastDisponibilidade = broadcastDisponibilidade;
  global.notifyStarkPayment = notifyStarkPayment;
}

module.exports = { setupWebSocket, registerGlobals, broadcastToAdmins, sendToUser, notifyNewWithdrawal, notifyWithdrawalUpdate, notifyStarkPayment, broadcastDisponibilidade };
