/**
 * Sub-Router Máquinas — Endpoints chamados pelo MOTOBOY autenticado
 *
 * Protegidos por verificarToken (JWT de staff/motoboy da Central).
 *
 * Endpoint:
 *  GET /api/maquinas/meu-status → { tem_maquina, maquina }
 *    Chamado pela tela de Saque Emergencial ao montar.
 *    Se tem_maquina=true, frontend mostra banner fixo e desabilita o botão.
 */

const express = require('express');
const { verificarMaquinaPendente } = require('../maquinas.shared');

function createMaquinasMotoboyRoutes(pool, verificarToken) {
  const router = express.Router();

  router.get('/maquinas/meu-status', verificarToken, async (req, res) => {
    try {
      const cod = req.user.codProfissional;
      const nome = req.user.nome || '';
      if (!cod) return res.json({ tem_maquina: false, maquina: null });

      const m = await verificarMaquinaPendente(pool, cod, nome);
      res.json({
        tem_maquina: !!m,
        maquina: m,
      });
    } catch (err) {
      console.error('❌ [MAQUINAS/meu-status]', err.message);
      // Fail-open: na dúvida, libera (mesma filosofia do bloqueio no /withdrawals)
      res.json({ tem_maquina: false, maquina: null, erro: err.message });
    }
  });

  return router;
}

module.exports = { createMaquinasMotoboyRoutes };
