/**
 * src/config/websocket.js
 * WebSocket server para notificações em tempo real
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const env = require('./env');

const wsClients = {
  admins: new Set(),
  users: new Map(),
};

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
    action,
  });
  sendToUser(withdrawal.user_cod, 'MY_WITHDRAWAL_UPDATE', {
    id: withdrawal.id,
    status: withdrawal.status,
    action,
    reject_reason: withdrawal.reject_reason,
  });
}

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws/financeiro' });

  wss.on('connection', (ws) => {
    console.log('🔌 [WS] Nova conexão');
    let clientType = null;
    let userCod = null;
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        console.log('⚠️ [WS] Conexão fechada por falta de autenticação');
        ws.close(4001, 'Autenticação necessária');
      }
    }, 30000);

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
            clearTimeout(authTimeout);

            if (decoded.role !== role) {
              console.log(`⚠️ [WS] Role mismatch: token=${decoded.role}, informado=${role}`);
            }

            if (['admin', 'admin_master', 'admin_financeiro'].includes(decoded.role)) {
              clientType = 'admin';
              wsClients.admins.add(ws);
              ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', role: 'admin', user: decoded.fullName }));
              console.log(`✅ [WS] Admin ${decoded.fullName} autenticado. Total: ${wsClients.admins.size}`);
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

        if (data.type === 'PING' && authenticated) {
          ws.send(JSON.stringify({ event: 'PONG', timestamp: new Date().toISOString() }));
        }
      } catch (e) {
        console.error('❌ [WS] Erro:', e.message);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
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
  });

  return wss;
}

// Exportar para global (módulos legados usam global.notifyNewWithdrawal)
function registerGlobals() {
  global.notifyNewWithdrawal = notifyNewWithdrawal;
  global.notifyWithdrawalUpdate = notifyWithdrawalUpdate;
  global.broadcastToAdmins = broadcastToAdmins;
}

module.exports = { setupWebSocket, registerGlobals, broadcastToAdmins, sendToUser, notifyNewWithdrawal, notifyWithdrawalUpdate };
