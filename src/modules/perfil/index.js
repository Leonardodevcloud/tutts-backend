/**
 * MÓDULO PERFIL — Cadastro obrigatório do motoboy (2026-05)
 *
 * O motoboy (role='user') só acessa a Central após enviar:
 *   - selfie (foto ao vivo)
 *   - número de WhatsApp (validado via Evolution)
 *
 * Endpoints:
 *   GET  /api/perfil/status-cadastro   → estado atual (lê do banco)
 *   POST /api/perfil/validar-whatsapp  → confere se o número tem WhatsApp
 *   POST /api/perfil/completar-cadastro → salva selfie + whatsapp, libera acesso
 */

'use strict';

const express = require('express');
const {
  normalizarTelefoneBR,
  validarFormatoBR,
  validarWhatsApp,
} = require('../solicitacao/whatsapp-rastreio.service');

function createPerfilRoutes(pool, verificarToken) {
  const router = express.Router();

  // ── GET /perfil/status-cadastro ────────────────────────────────
  // Frontend chama pra saber se mostra o gate. Lê do banco (sempre atual).
  router.get('/perfil/status-cadastro', verificarToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT COALESCE(cadastro_completo, false) AS cadastro_completo,
                whatsapp,
                (foto_selfie IS NOT NULL) AS tem_foto,
                cadastro_completo_em
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      const row = r.rows[0];
      res.json({
        cadastro_completo: row.cadastro_completo === true,
        tem_foto: row.tem_foto === true,
        whatsapp: row.whatsapp || null,
        cadastro_completo_em: row.cadastro_completo_em || null,
        // só motoboys (role='user') são obrigados — admin nunca vê o gate
        exige_cadastro: req.user.role === 'user',
      });
    } catch (err) {
      console.error('❌ [PERFIL] status-cadastro:', err.message);
      res.status(500).json({ error: 'Erro ao consultar cadastro', detalhe: err.message });
    }
  });

  // ── POST /perfil/validar-whatsapp ──────────────────────────────
  // Confere formato + se o número tem WhatsApp (Evolution).
  router.post('/perfil/validar-whatsapp', verificarToken, async (req, res) => {
    try {
      const { telefone } = req.body || {};
      if (!telefone) {
        return res.status(400).json({ ok: false, motivo: 'telefone_vazio' });
      }
      const fmt = validarFormatoBR(telefone);
      if (!fmt.ok) {
        return res.json({ ok: false, estado: 'invalido', motivo: fmt.motivo });
      }
      const wa = await validarWhatsApp(telefone);
      if (wa.temWhatsApp === true) {
        return res.json({ ok: true, estado: 'ok', numero: normalizarTelefoneBR(telefone) });
      }
      if (wa.temWhatsApp === false) {
        return res.json({ ok: false, estado: 'sem_whatsapp', motivo: 'numero_sem_whatsapp' });
      }
      // Evolution indisponível — não trava, deixa o motoboy seguir
      return res.json({ ok: true, estado: 'indeterminado', motivo: wa.motivo || 'evolution_indisponivel' });
    } catch (err) {
      console.error('❌ [PERFIL] validar-whatsapp:', err.message);
      res.status(500).json({ ok: false, motivo: 'erro_interno' });
    }
  });

  // ── POST /perfil/completar-cadastro ────────────────────────────
  // Salva selfie + whatsapp e libera o acesso (cadastro_completo = true).
  router.post('/perfil/completar-cadastro', verificarToken, async (req, res) => {
    try {
      const { foto_selfie, telefone } = req.body || {};

      // 1. Valida a foto (data URL base64, mesmo padrão de solicitação)
      if (!foto_selfie || typeof foto_selfie !== 'string' || foto_selfie.length < 1000) {
        return res.status(400).json({ error: 'Foto inválida ou ausente' });
      }
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(foto_selfie)) {
        return res.status(400).json({ error: 'Formato de foto não suportado' });
      }
      // Limite de tamanho — evita payloads gigantes (≈ 8MB de base64)
      if (foto_selfie.length > 8 * 1024 * 1024) {
        return res.status(413).json({ error: 'Foto muito grande. Tente novamente.' });
      }

      // 2. Valida o telefone
      if (!telefone) {
        return res.status(400).json({ error: 'WhatsApp é obrigatório' });
      }
      const fmt = validarFormatoBR(telefone);
      if (!fmt.ok) {
        return res.status(400).json({ error: 'Número de WhatsApp inválido', detalhe: fmt.motivo });
      }
      const numeroNormalizado = normalizarTelefoneBR(telefone);

      // 3. Confere se tem WhatsApp (bloqueia se não tiver — número serve pra notificar)
      const wa = await validarWhatsApp(telefone);
      if (wa.temWhatsApp === false) {
        return res.status(422).json({
          error: 'sem_whatsapp',
          mensagem: 'Esse número não tem WhatsApp. Informe um número válido.',
        });
      }
      // Se Evolution estiver fora, segue (não trava o cadastro do motoboy)

      // 4. Salva tudo
      await pool.query(
        `UPDATE users
            SET foto_selfie = $1,
                whatsapp = $2,
                cadastro_completo = true,
                cadastro_completo_em = NOW()
          WHERE id = $3`,
        [foto_selfie, numeroNormalizado, req.user.id]
      );

      console.log(`✅ [PERFIL] Cadastro completo — ${req.user.nome} (cod ${req.user.codProfissional}) — WhatsApp ${numeroNormalizado}`);

      res.json({ ok: true, cadastro_completo: true });
    } catch (err) {
      console.error('❌ [PERFIL] completar-cadastro:', err.message);
      res.status(500).json({ error: 'Erro ao salvar cadastro', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createPerfilRoutes };
