/**
 * Sub-Router Máquinas — Endpoints cliente (atendente da loja)
 * Todos protegidos por verificarTokenSolicitacao.
 *
 * Endpoints:
 *  GET    /api/maquinas                      → lista cadastro completo do cliente
 *  POST   /api/maquinas                      → cadastra nova máquina
 *  PATCH  /api/maquinas/:id                  → edita máquina
 *  DELETE /api/maquinas/:id                  → exclui máquina (apenas se nunca foi despachada)
 *  GET    /api/maquinas/em-campo             → lista despachadas e não restituídas
 *  GET    /api/maquinas/disponiveis          → lista ativas + sem movimentação pendente
 *  GET    /api/maquinas/motoboys-livres      → motoboys sem máquina (proxy /solicitacao/profissionais filtrado)
 *  POST   /api/maquinas/despachar            → despacha máquina pra motoboy
 *  POST   /api/maquinas/movimentacoes/:id/restituir  → restitui máquina
 *  GET    /api/maquinas/historico            → histórico de movimentações com filtros
 *  GET    /api/maquinas/configuracao         → { horario_limite_maquinas }
 *  PATCH  /api/maquinas/configuracao         → atualiza horário limite
 */

const express = require('express');
const httpRequest = require('../../../shared/utils/httpRequest');
const { resolverMotoboyCentral } = require('../maquinas.shared');

function createMaquinasClienteRoutes(pool, helpers) {
  const router = express.Router();
  const { verificarTokenSolicitacao } = helpers;

  // ═══════════════════════════════════════════════════════════
  // Helpers internos
  // ═══════════════════════════════════════════════════════════

  // Normaliza identificador e marca (CAPS LOCK do lado do servidor — defense in depth)
  const upperTrim = (s) => (s == null ? '' : String(s).trim().toUpperCase());
  const obterAtendenteId = (req) =>
    req.clienteSolicitacao.email || req.clienteSolicitacao.nome || `cliente#${req.clienteSolicitacao.id}`;

  // ═══════════════════════════════════════════════════════════
  // CADASTRO — CRUD do parque de máquinas do cliente
  // ═══════════════════════════════════════════════════════════

  // GET /api/maquinas — lista cadastro completo
  router.get('/maquinas', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const result = await pool.query(
        `SELECT
           m.id, m.identificador, m.marca, m.observacao, m.ativa,
           m.created_at, m.updated_at,
           CASE WHEN mm.id IS NOT NULL THEN true ELSE false END AS em_uso,
           mm.motoboy_nome     AS em_uso_motoboy_nome,
           mm.motoboy_codigo   AS em_uso_motoboy_codigo,
           mm.despachada_em    AS em_uso_desde
         FROM maquinas m
         LEFT JOIN LATERAL (
           SELECT id, motoboy_codigo, motoboy_nome, despachada_em
           FROM maquinas_movimentacoes
           WHERE maquina_id = m.id AND restituida_em IS NULL
           ORDER BY despachada_em DESC LIMIT 1
         ) mm ON true
         WHERE m.cliente_id = $1
         ORDER BY m.identificador ASC`,
        [clienteId]
      );
      console.log(`📋 [MAQUINAS] Cliente ${clienteId} listou ${result.rows.length} máquinas`);
      res.json({ maquinas: result.rows });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro ao listar:', err.message);
      res.status(500).json({ error: 'Erro ao listar máquinas', detalhe: err.message });
    }
  });

  // POST /api/maquinas — cadastra nova
  router.post('/maquinas', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const identificador = upperTrim(req.body.identificador);
      const marca = upperTrim(req.body.marca);
      const observacao = req.body.observacao ? String(req.body.observacao).trim() : null;
      const ativa = req.body.ativa !== false; // default true

      if (!identificador) return res.status(400).json({ error: 'Identificador obrigatório' });
      if (!marca) return res.status(400).json({ error: 'Marca obrigatória' });
      if (identificador.length > 50) return res.status(400).json({ error: 'Identificador acima de 50 caracteres' });
      if (marca.length > 80) return res.status(400).json({ error: 'Marca acima de 80 caracteres' });

      const result = await pool.query(
        `INSERT INTO maquinas (cliente_id, identificador, marca, observacao, ativa, criada_por)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, identificador, marca, observacao, ativa, created_at`,
        [clienteId, identificador, marca, observacao, ativa, obterAtendenteId(req)]
      );
      console.log(`✅ [MAQUINAS] Cliente ${clienteId} cadastrou ${identificador} ${marca} (id=${result.rows[0].id})`);
      res.status(201).json({ maquina: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Já existe uma máquina com esse identificador' });
      }
      console.error('❌ [MAQUINAS] Erro ao cadastrar:', err.message);
      res.status(500).json({ error: 'Erro ao cadastrar máquina', detalhe: err.message });
    }
  });

  // PATCH /api/maquinas/:id — edita
  router.patch('/maquinas/:id', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const fields = [];
      const values = [];
      let p = 1;
      if (req.body.identificador !== undefined) {
        fields.push(`identificador = $${p++}`);
        values.push(upperTrim(req.body.identificador));
      }
      if (req.body.marca !== undefined) {
        fields.push(`marca = $${p++}`);
        values.push(upperTrim(req.body.marca));
      }
      if (req.body.observacao !== undefined) {
        fields.push(`observacao = $${p++}`);
        values.push(req.body.observacao ? String(req.body.observacao).trim() : null);
      }
      if (req.body.ativa !== undefined) {
        fields.push(`ativa = $${p++}`);
        values.push(!!req.body.ativa);
      }
      if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id, clienteId);

      const result = await pool.query(
        `UPDATE maquinas SET ${fields.join(', ')}
         WHERE id = $${p} AND cliente_id = $${p + 1}
         RETURNING id, identificador, marca, observacao, ativa, updated_at`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Máquina não encontrada' });
      console.log(`✏️  [MAQUINAS] Cliente ${clienteId} editou máquina ${id}`);
      res.json({ maquina: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Já existe uma máquina com esse identificador' });
      }
      console.error('❌ [MAQUINAS] Erro ao editar:', err.message);
      res.status(500).json({ error: 'Erro ao editar máquina', detalhe: err.message });
    }
  });

  // DELETE /api/maquinas/:id — exclui (apenas se nunca foi despachada OU se inativa)
  router.delete('/maquinas/:id', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      // Verificar se está em campo agora
      const emCampo = await pool.query(
        `SELECT id FROM maquinas_movimentacoes
         WHERE maquina_id = $1 AND restituida_em IS NULL LIMIT 1`,
        [id]
      );
      if (emCampo.rows.length > 0) {
        return res.status(409).json({ error: 'Máquina está em campo — restitua antes de excluir' });
      }

      const result = await pool.query(
        `DELETE FROM maquinas WHERE id = $1 AND cliente_id = $2 RETURNING id`,
        [id, clienteId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Máquina não encontrada' });
      console.log(`🗑️  [MAQUINAS] Cliente ${clienteId} excluiu máquina ${id}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro ao excluir:', err.message);
      res.status(500).json({ error: 'Erro ao excluir máquina', detalhe: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // OPERAÇÃO — em campo, despacho e restituição
  // ═══════════════════════════════════════════════════════════

  // GET /api/maquinas/em-campo — máquinas despachadas e não restituídas
  router.get('/maquinas/em-campo', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      // Horário limite do cliente (default 17:00 se nunca configurado)
      const horarioLimite = req.clienteSolicitacao.horario_limite_maquinas || '17:00:00';

      const result = await pool.query(
        `SELECT
           mm.id            AS movimentacao_id,
           mm.maquina_id,
           m.identificador,
           m.marca,
           m.observacao,
           mm.motoboy_codigo,
           mm.motoboy_codigo_tutts,
           mm.motoboy_nome,
           mm.vinculado_central,
           mm.despachada_em,
           mm.despachada_por,
           EXTRACT(EPOCH FROM (NOW() - mm.despachada_em))/60 AS minutos_em_campo,
           -- pendente = passou do horário limite local (timezone do servidor)
           CASE
             WHEN (CURRENT_TIME) >= $2::time THEN true
             ELSE false
           END AS pendente_apos_limite
         FROM maquinas_movimentacoes mm
         JOIN maquinas m ON m.id = mm.maquina_id
         WHERE mm.cliente_id = $1 AND mm.restituida_em IS NULL
         ORDER BY mm.despachada_em ASC`,
        [clienteId, horarioLimite]
      );
      res.json({
        em_campo: result.rows,
        horario_limite: horarioLimite,
        agora: new Date().toISOString(),
      });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro em-campo:', err.message);
      res.status(500).json({ error: 'Erro ao listar máquinas em campo', detalhe: err.message });
    }
  });

  // GET /api/maquinas/disponiveis — máquinas ativas que não estão em campo
  router.get('/maquinas/disponiveis', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const result = await pool.query(
        `SELECT m.id, m.identificador, m.marca, m.observacao
         FROM maquinas m
         WHERE m.cliente_id = $1
           AND m.ativa = true
           AND NOT EXISTS (
             SELECT 1 FROM maquinas_movimentacoes mm
             WHERE mm.maquina_id = m.id AND mm.restituida_em IS NULL
           )
         ORDER BY m.identificador ASC`,
        [clienteId]
      );
      res.json({ disponiveis: result.rows });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro disponiveis:', err.message);
      res.status(500).json({ error: 'Erro ao listar disponíveis', detalhe: err.message });
    }
  });

  // GET /api/maquinas/motoboys-livres — proxy /solicitacao/profissionais filtrando
  // quem já tem máquina em mãos (regra: 1 máquina por motoboy por vez)
  router.get('/maquinas/motoboys-livres', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
      if (!codCliente) {
        return res.json({ motoboys: [], aviso: 'Código do cliente Tutts não configurado' });
      }

      // 1. Buscar profissionais da API Tutts
      const payloadTutts = {
        token: process.env.TUTTS_TOKEN_PROFISSIONAIS,
        codCliente: codCliente,
      };
      let profissionais = [];
      try {
        const response = await fetch('https://tutts.com.br/integracao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadTutts),
        });
        const resultado = await response.json();
        if (resultado.Sucesso && Array.isArray(resultado.Sucesso)) {
          profissionais = resultado.Sucesso.map(p => ({
            codigo: String(p.codigo),
            nome: p.nome,
            foto: p.foto || p.Foto || null,
            placa: p.placa || null,
          }));
        }
      } catch (e) {
        console.warn('⚠️ [MAQUINAS] Erro ao buscar profissionais Tutts:', e.message);
      }

      // 2. Buscar quem ESTÁ com máquina (deste cliente) — checa o codigo Tutts
      //    porque o select de motoboys vem da API Tutts
      const ocupados = await pool.query(
        `SELECT DISTINCT motoboy_codigo_tutts FROM maquinas_movimentacoes
         WHERE cliente_id = $1 AND restituida_em IS NULL AND motoboy_codigo_tutts IS NOT NULL`,
        [clienteId]
      );
      const codigosOcupados = new Set(ocupados.rows.map(r => String(r.motoboy_codigo_tutts)));

      // 3. Filtrar livres
      const livres = profissionais.filter(p => !codigosOcupados.has(String(p.codigo)));

      res.json({ motoboys: livres, total_profissionais: profissionais.length, ocupados: codigosOcupados.size });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro motoboys-livres:', err.message);
      res.status(500).json({ error: 'Erro ao listar motoboys', detalhe: err.message });
    }
  });

  // POST /api/maquinas/despachar — despacha máquina pra motoboy
  router.post('/maquinas/despachar', verificarTokenSolicitacao, async (req, res) => {
    const client = await pool.connect();
    try {
      const clienteId = req.clienteSolicitacao.id;
      const maquinaId = parseInt(req.body.maquina_id, 10);
      const motoboyCodigoTutts = String(req.body.motoboy_codigo || '').trim();
      const motoboyNomeTutts = String(req.body.motoboy_nome || '').trim();

      if (!maquinaId) return res.status(400).json({ error: 'maquina_id obrigatório' });
      if (!motoboyCodigoTutts) return res.status(400).json({ error: 'motoboy_codigo obrigatório' });
      if (!motoboyNomeTutts) return res.status(400).json({ error: 'motoboy_nome obrigatório' });

      // 🔗 Cross-reference com cadastro da Central (users)
      // Tenta em 3 camadas: código direto → nome exato → prefixo nome+sobrenome
      const central = await resolverMotoboyCentral(pool, motoboyNomeTutts, motoboyCodigoTutts);
      const codigoFinal = central ? central.cod_profissional : motoboyCodigoTutts;
      const nomeFinal = central ? central.full_name : motoboyNomeTutts;
      const vinculadoCentral = !!central;

      await client.query('BEGIN');

      // 1. Validar máquina pertence ao cliente, está ativa, não está em campo
      const mq = await client.query(
        `SELECT m.id, m.identificador, m.marca, m.observacao, m.ativa,
           EXISTS (SELECT 1 FROM maquinas_movimentacoes mm
                   WHERE mm.maquina_id = m.id AND mm.restituida_em IS NULL) AS em_campo
         FROM maquinas m
         WHERE m.id = $1 AND m.cliente_id = $2
         FOR UPDATE`,
        [maquinaId, clienteId]
      );
      if (mq.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Máquina não encontrada' });
      }
      if (!mq.rows[0].ativa) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Máquina está inativa' });
      }
      if (mq.rows[0].em_campo) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Máquina já está em campo' });
      }

      // 2. Validar que motoboy não tem outra máquina (regra: 1 por vez)
      //    Checa por ambos: codigo final (Central) e codigo Tutts (segurança extra)
      const ocupado = await client.query(
        `SELECT mm.id, m.identificador, m.marca
         FROM maquinas_movimentacoes mm
         JOIN maquinas m ON m.id = mm.maquina_id
         WHERE (mm.motoboy_codigo = $1::text OR mm.motoboy_codigo_tutts = $2::text)
           AND mm.cliente_id = $3
           AND mm.restituida_em IS NULL
         LIMIT 1`,
        [codigoFinal, motoboyCodigoTutts, clienteId]
      );
      if (ocupado.rows.length > 0) {
        await client.query('ROLLBACK');
        const o = ocupado.rows[0];
        return res.status(409).json({
          error: 'motoboy_com_maquina',
          mensagem: `${nomeFinal} já está com a máquina ${o.identificador} ${o.marca}. Restitua antes de despachar outra.`,
        });
      }

      // 3. Despachar — grava com vínculo resolvido
      const mov = await client.query(
        `INSERT INTO maquinas_movimentacoes
           (maquina_id, cliente_id, motoboy_codigo, motoboy_codigo_tutts,
            motoboy_nome, despachada_por, vinculado_central)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, despachada_em`,
        [maquinaId, clienteId, codigoFinal, motoboyCodigoTutts,
         nomeFinal, obterAtendenteId(req), vinculadoCentral]
      );

      await client.query('COMMIT');
      console.log(`🚚 [MAQUINAS] Despachou ${mq.rows[0].identificador} ${mq.rows[0].marca} → ${nomeFinal} (Central=${codigoFinal}, Tutts=${motoboyCodigoTutts}, vinculado=${vinculadoCentral}) cliente=${clienteId}`);
      res.status(201).json({
        ok: true,
        movimentacao_id: mov.rows[0].id,
        despachada_em: mov.rows[0].despachada_em,
        vinculado_central: vinculadoCentral,
        // Se não vinculado, frontend deve avisar que o bloqueio do saque
        // emergencial NÃO vai ativar pra esse motoboy específico.
        aviso_vinculo: vinculadoCentral
          ? null
          : `${motoboyNomeTutts} não foi encontrado no cadastro da Central. O bloqueio do saque emergencial não vai funcionar pra esse motoboy específico até que ele seja cadastrado.`,
        maquina: { id: maquinaId, identificador: mq.rows[0].identificador, marca: mq.rows[0].marca, observacao: mq.rows[0].observacao },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ [MAQUINAS] Erro despachar:', err.message);
      res.status(500).json({ error: 'Erro ao despachar máquina', detalhe: err.message });
    } finally {
      client.release();
    }
  });

  // POST /api/maquinas/movimentacoes/:id/restituir — restitui máquina
  router.post('/maquinas/movimentacoes/:id/restituir', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const movimentacaoId = parseInt(req.params.id, 10);
      if (isNaN(movimentacaoId)) return res.status(400).json({ error: 'ID inválido' });
      const observacao = req.body.observacao ? String(req.body.observacao).trim() : null;

      const result = await pool.query(
        `UPDATE maquinas_movimentacoes
         SET restituida_em = CURRENT_TIMESTAMP,
             restituida_por = $1,
             observacao_restituicao = $2
         WHERE id = $3 AND cliente_id = $4 AND restituida_em IS NULL
         RETURNING id, maquina_id, motoboy_nome, despachada_em, restituida_em`,
        [obterAtendenteId(req), observacao, movimentacaoId, clienteId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Movimentação não encontrada ou já restituída' });
      }
      console.log(`🔙 [MAQUINAS] Restituiu movimentação ${movimentacaoId} (motoboy=${result.rows[0].motoboy_nome}) cliente=${clienteId}`);
      res.json({ ok: true, movimentacao: result.rows[0] });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro restituir:', err.message);
      res.status(500).json({ error: 'Erro ao restituir máquina', detalhe: err.message });
    }
  });

  // GET /api/maquinas/historico/filtros — listas pros selects de filtro
  // Retorna motoboys e máquinas que JÁ tiveram movimentação (sem repetir)
  router.get('/maquinas/historico/filtros', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const [motoboys, maquinas] = await Promise.all([
        pool.query(
          `SELECT DISTINCT motoboy_codigo, motoboy_nome
             FROM maquinas_movimentacoes
            WHERE cliente_id = $1
            ORDER BY motoboy_nome ASC`,
          [clienteId]
        ),
        pool.query(
          `SELECT DISTINCT m.id, m.identificador, m.marca, m.observacao
             FROM maquinas m
             JOIN maquinas_movimentacoes mm ON mm.maquina_id = m.id
            WHERE m.cliente_id = $1
            ORDER BY m.identificador ASC`,
          [clienteId]
        ),
      ]);
      res.json({
        motoboys: motoboys.rows,
        maquinas: maquinas.rows,
      });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro filtros:', err.message);
      res.status(500).json({ error: 'Erro ao listar filtros', detalhe: err.message });
    }
  });

  // GET /api/maquinas/historico — log de movimentações (com filtros opcionais)
  router.get('/maquinas/historico', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const { inicio, fim, motoboy_codigo, maquina_id, limit } = req.query;
      const params = [clienteId];
      let where = `mm.cliente_id = $1`;
      if (inicio) {
        params.push(inicio);
        where += ` AND mm.despachada_em >= $${params.length}`;
      }
      if (fim) {
        params.push(fim);
        where += ` AND mm.despachada_em <= $${params.length}`;
      }
      if (motoboy_codigo) {
        params.push(String(motoboy_codigo));
        where += ` AND mm.motoboy_codigo = $${params.length}::text`;
      }
      if (maquina_id) {
        params.push(parseInt(maquina_id, 10));
        where += ` AND mm.maquina_id = $${params.length}`;
      }
      const lim = Math.min(parseInt(limit, 10) || 200, 1000);
      params.push(lim);

      const result = await pool.query(
        `SELECT
           mm.id, mm.maquina_id, m.identificador, m.marca, m.observacao,
           mm.motoboy_codigo, mm.motoboy_nome,
           mm.despachada_em, mm.despachada_por,
           mm.restituida_em, mm.restituida_por, mm.observacao_restituicao,
           EXTRACT(EPOCH FROM (COALESCE(mm.restituida_em, NOW()) - mm.despachada_em))/60 AS minutos_total
         FROM maquinas_movimentacoes mm
         JOIN maquinas m ON m.id = mm.maquina_id
         WHERE ${where}
         ORDER BY mm.despachada_em DESC
         LIMIT $${params.length}`,
        params
      );
      res.json({ historico: result.rows });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro histórico:', err.message);
      res.status(500).json({ error: 'Erro ao listar histórico', detalhe: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CONFIGURAÇÃO — horário limite do cliente
  // ═══════════════════════════════════════════════════════════

  router.get('/maquinas/configuracao', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const result = await pool.query(
        `SELECT horario_limite_maquinas FROM clientes_solicitacao WHERE id = $1`,
        [clienteId]
      );
      res.json({
        horario_limite: result.rows[0]?.horario_limite_maquinas || '17:00:00',
      });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro config:', err.message);
      res.status(500).json({ error: 'Erro ao buscar configuração', detalhe: err.message });
    }
  });

  router.patch('/maquinas/configuracao', verificarTokenSolicitacao, async (req, res) => {
    try {
      const clienteId = req.clienteSolicitacao.id;
      const horario = String(req.body.horario_limite || '').trim();
      // Validar HH:MM ou HH:MM:SS
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(horario)) {
        return res.status(400).json({ error: 'Formato inválido. Use HH:MM (ex: 17:00)' });
      }
      const result = await pool.query(
        `UPDATE clientes_solicitacao
         SET horario_limite_maquinas = $1::time
         WHERE id = $2
         RETURNING horario_limite_maquinas`,
        [horario, clienteId]
      );
      console.log(`⏰ [MAQUINAS] Cliente ${clienteId} atualizou horário limite para ${horario}`);
      res.json({ horario_limite: result.rows[0].horario_limite_maquinas });
    } catch (err) {
      console.error('❌ [MAQUINAS] Erro patch config:', err.message);
      res.status(500).json({ error: 'Erro ao atualizar configuração', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createMaquinasClienteRoutes };
