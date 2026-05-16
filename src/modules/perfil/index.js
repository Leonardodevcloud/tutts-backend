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
 *   GET  /api/perfil/fotos?codigos=... → mapa cod→thumbnail (pra listas admin)
 */

'use strict';

const express = require('express');
const {
  normalizarTelefoneBR,
  validarFormatoBR,
  validarWhatsApp,
} = require('../solicitacao/whatsapp-rastreio.service');

// sharp é usado pra gerar a miniatura da selfie (já é dependência do projeto)
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('⚠️ [PERFIL] sharp indisponível — thumbnails desativados'); }

/**
 * Gera uma miniatura (~96px, JPEG) a partir de uma data URL base64.
 * Retorna a data URL da miniatura, ou null se falhar / sharp ausente.
 * Usada nas listas de admin — muito mais leve que a foto cheia.
 */
async function gerarThumbnail(dataUrl) {
  if (!sharp || !dataUrl) return null;
  try {
    const base64 = String(dataUrl).replace(/^data:image\/[a-z]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const out = await sharp(buf)
      .resize(96, 96, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + out.toString('base64');
  } catch (err) {
    console.warn('⚠️ [PERFIL] gerarThumbnail falhou:', err.message);
    return null;
  }
}

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

      // 4. Gera a miniatura (best-effort — se falhar, salva sem thumb)
      const thumb = await gerarThumbnail(foto_selfie);

      // 5. Salva tudo
      await pool.query(
        `UPDATE users
            SET foto_selfie = $1,
                foto_thumb = $2,
                whatsapp = $3,
                cadastro_completo = true,
                cadastro_completo_em = NOW()
          WHERE id = $4`,
        [foto_selfie, thumb, numeroNormalizado, req.user.id]
      );

      console.log(`✅ [PERFIL] Cadastro completo — ${req.user.nome} (cod ${req.user.codProfissional}) — WhatsApp ${numeroNormalizado}`);

      res.json({ ok: true, cadastro_completo: true });
    } catch (err) {
      console.error('❌ [PERFIL] completar-cadastro:', err.message);
      res.status(500).json({ error: 'Erro ao salvar cadastro', detalhe: err.message });
    }
  });

  // ── GET /perfil/fotos?codigos=123,456 ──────────────────────────
  // Retorna mapa { cod_profissional: thumbnail } dos motoboys pedidos.
  // Usado pelas listas de admin (Usuários, Saques) pra mostrar a foto.
  // Geração lazy: quem completou o cadastro antes do thumb existir tem
  // só foto_selfie — aqui geramos a miniatura na hora e salvamos.
  router.get('/perfil/fotos', verificarToken, async (req, res) => {
    try {
      const raw = String(req.query.codigos || '').trim();
      if (!raw) return res.json({ fotos: {} });

      // sanitiza: só dígitos, máximo 200 códigos por chamada
      const codigos = raw.split(',')
        .map(c => c.trim())
        .filter(c => /^\d+$/.test(c))
        .slice(0, 200);
      if (codigos.length === 0) return res.json({ fotos: {} });

      const r = await pool.query(
        `SELECT cod_profissional, foto_thumb, foto_selfie
           FROM users
          WHERE cod_profissional = ANY($1::text[])
            AND (foto_thumb IS NOT NULL OR foto_selfie IS NOT NULL)`,
        [codigos]
      );

      const fotos = {};
      for (const row of r.rows) {
        if (row.foto_thumb) {
          fotos[row.cod_profissional] = row.foto_thumb;
        } else if (row.foto_selfie) {
          // retroativo: gera o thumb agora e persiste pra não repetir
          const thumb = await gerarThumbnail(row.foto_selfie);
          if (thumb) {
            fotos[row.cod_profissional] = thumb;
            pool.query(
              `UPDATE users SET foto_thumb = $1 WHERE cod_profissional = $2`,
              [thumb, row.cod_profissional]
            ).catch(() => {});
          } else {
            // sharp indisponível — devolve a foto cheia mesmo
            fotos[row.cod_profissional] = row.foto_selfie;
          }
        }
      }
      res.json({ fotos });
    } catch (err) {
      console.error('❌ [PERFIL] fotos:', err.message);
      res.status(500).json({ error: 'Erro ao buscar fotos', detalhe: err.message });
    }
  });

  // ── GET /perfil/foto/:codProfissional ──────────────────────────
  // Foto CHEIA de um motoboy (ex: admin clica pra ver grande).
  router.get('/perfil/foto/:codProfissional', verificarToken, async (req, res) => {
    try {
      const cod = String(req.params.codProfissional || '').trim();
      if (!/^\d+$/.test(cod)) return res.status(400).json({ error: 'Código inválido' });
      const r = await pool.query(
        `SELECT foto_selfie FROM users WHERE cod_profissional = $1`,
        [cod]
      );
      if (r.rows.length === 0 || !r.rows[0].foto_selfie) {
        return res.status(404).json({ error: 'Sem foto' });
      }
      res.json({ foto: r.rows[0].foto_selfie });
    } catch (err) {
      console.error('❌ [PERFIL] foto:', err.message);
      res.status(500).json({ error: 'Erro ao buscar foto', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createPerfilRoutes };
