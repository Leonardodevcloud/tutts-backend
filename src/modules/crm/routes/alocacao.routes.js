/**
 * alocacao.routes.js
 * Sub-router: Alocação de Profissionais
 *
 * Endpoints:
 *   GET    /                    - Listar alocações (filtros + paginação)
 *   POST   /                    - Criar alocação
 *   PATCH  /:id                 - Atualizar alocação
 *   DELETE /:id                 - Remover
 *   POST   /importar            - Importar da Google Sheet
 *   POST   /atualizar-status    - Recalcular status via bi_entregas
 *   GET    /clientes            - Dropdown de clientes
 *   GET    /alocadores          - Dropdown de alocadores
 *   GET    /profissional/:cod   - Buscar nome do profissional pelo código
 */

'use strict';

const express = require('express');

// ── Sheet URL ──
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv&gid=1573041640';

function createAlocacaoRoutes(pool) {
  const router = express.Router();

  // ══════════════════════════════════════════════════════════════
  // MIGRATION (auto-executa no startup)
  // ══════════════════════════════════════════════════════════════
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crm_alocacoes (
          id SERIAL PRIMARY KEY,
          cod_cliente VARCHAR(20),
          nome_cliente VARCHAR(255),
          cod_prof VARCHAR(20) NOT NULL,
          nome_prof VARCHAR(255),
          quem_alocou VARCHAR(255),
          data_prevista DATE,
          status VARCHAR(50) DEFAULT 'nao_rodou',
          dias_operacao INT DEFAULT 0,
          ultima_entrega DATE,
          obs TEXT,
          ativo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_alocacoes_prof ON crm_alocacoes(cod_prof)`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_alocacoes_cliente ON crm_alocacoes(cod_cliente)`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_alocacoes_status ON crm_alocacoes(status)`).catch(() => {});

      // Tabela de clientes da alocação (dropdown)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crm_alocacao_clientes (
          id SERIAL PRIMARY KEY,
          cod VARCHAR(20),
          nome VARCHAR(255) UNIQUE NOT NULL
        )
      `);

      // Tabela de alocadores (dropdown)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crm_alocacao_alocadores (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(255) UNIQUE NOT NULL
        )
      `);

      console.log('  ✅ crm_alocacoes + dropdowns');
    } catch (err) {
      console.error('❌ [Alocação] Migration:', err.message);
    }
  })();

  // ══════════════════════════════════════════════════════════════
  // GET / — Listar alocações
  // ══════════════════════════════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const { cliente, status, quem_alocou, search, page = 1, limit = 50, order = 'created_at', dir = 'DESC' } = req.query;

      const where = ['ativo = true'];
      const params = [];
      let idx = 1;

      if (cliente)     { where.push(`nome_cliente = $${idx++}`); params.push(cliente); }
      if (status)      { where.push(`status = $${idx++}`);       params.push(status); }
      if (quem_alocou) { where.push(`quem_alocou = $${idx++}`); params.push(quem_alocou); }
      if (search)      { where.push(`(nome_prof ILIKE $${idx} OR cod_prof ILIKE $${idx} OR nome_cliente ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

      const whereStr = where.join(' AND ');
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const validOrders = ['created_at', 'nome_prof', 'nome_cliente', 'data_prevista', 'status', 'dias_operacao'];
      const orderCol = validOrders.includes(order) ? order : 'created_at';
      const orderDir = dir?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      const [countRes, dataRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total FROM crm_alocacoes WHERE ${whereStr}`, params),
        pool.query(
          `SELECT * FROM crm_alocacoes WHERE ${whereStr} ORDER BY ${orderCol} ${orderDir} NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
          [...params, parseInt(limit), offset]
        ),
      ]);

      const total = parseInt(countRes.rows[0].total);

      // KPIs
      const { rows: [kpis] } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'nao_rodou') as nao_rodou,
          COUNT(*) FILTER (WHERE status = 'em_operacao') as em_operacao,
          COUNT(*) FILTER (WHERE status = 'possivel_churn') as possivel_churn,
          COUNT(*) FILTER (WHERE status = 'churn') as churn,
          COUNT(*) FILTER (WHERE status = 'voltou_operacao') as voltou_operacao,
          COUNT(DISTINCT nome_cliente) as total_clientes,
          COUNT(DISTINCT quem_alocou) FILTER (WHERE quem_alocou IS NOT NULL AND quem_alocou != '') as total_alocadores
        FROM crm_alocacoes WHERE ativo = true
      `);

      res.json({
        success: true,
        data: dataRes.rows,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        kpis: {
          total: parseInt(kpis.total) || 0,
          nao_rodou: parseInt(kpis.nao_rodou) || 0,
          em_operacao: parseInt(kpis.em_operacao) || 0,
          possivel_churn: parseInt(kpis.possivel_churn) || 0,
          churn: parseInt(kpis.churn) || 0,
          voltou_operacao: parseInt(kpis.voltou_operacao) || 0,
          total_clientes: parseInt(kpis.total_clientes) || 0,
          total_alocadores: parseInt(kpis.total_alocadores) || 0,
        },
      });
    } catch (err) {
      console.error('[Alocação] GET /:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST / — Criar alocação
  // ══════════════════════════════════════════════════════════════
  router.post('/', async (req, res) => {
    try {
      const { cod_cliente, nome_cliente, cod_prof, nome_prof, quem_alocou, data_prevista, obs } = req.body;

      if (!cod_prof) return res.status(400).json({ success: false, error: 'Código do profissional é obrigatório' });

      const { rows } = await pool.query(
        `INSERT INTO crm_alocacoes (cod_cliente, nome_cliente, cod_prof, nome_prof, quem_alocou, data_prevista, obs)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [cod_cliente || null, nome_cliente || null, cod_prof, nome_prof || null, quem_alocou || null, data_prevista || null, obs || null]
      );

      // Salvar dropdowns
      if (nome_cliente) {
        await pool.query('INSERT INTO crm_alocacao_clientes (cod, nome) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING', [cod_cliente || null, nome_cliente]);
      }
      if (quem_alocou) {
        await pool.query('INSERT INTO crm_alocacao_alocadores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [quem_alocou.toUpperCase()]);
      }

      res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error('[Alocação] POST /:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // PATCH /:id — Atualizar
  // ══════════════════════════════════════════════════════════════
  router.patch('/:id', async (req, res) => {
    try {
      const { cod_cliente, nome_cliente, cod_prof, nome_prof, quem_alocou, data_prevista, obs, status } = req.body;

      const sets = [];
      const params = [];
      let idx = 1;

      if (cod_cliente !== undefined)  { sets.push(`cod_cliente = $${idx++}`);  params.push(cod_cliente || null); }
      if (nome_cliente !== undefined) { sets.push(`nome_cliente = $${idx++}`); params.push(nome_cliente || null); }
      if (cod_prof !== undefined)     { sets.push(`cod_prof = $${idx++}`);     params.push(cod_prof); }
      if (nome_prof !== undefined)    { sets.push(`nome_prof = $${idx++}`);    params.push(nome_prof || null); }
      if (quem_alocou !== undefined)  { sets.push(`quem_alocou = $${idx++}`); params.push(quem_alocou || null); }
      if (data_prevista !== undefined){ sets.push(`data_prevista = $${idx++}`); params.push(data_prevista || null); }
      if (obs !== undefined)          { sets.push(`obs = $${idx++}`);          params.push(obs || null); }
      if (status !== undefined)       { sets.push(`status = $${idx++}`);       params.push(status); }

      if (sets.length === 0) return res.status(400).json({ success: false, error: 'Nada para atualizar' });

      sets.push(`updated_at = NOW()`);
      params.push(req.params.id);

      await pool.query(`UPDATE crm_alocacoes SET ${sets.join(', ')} WHERE id = $${idx}`, params);

      // Atualizar dropdowns
      if (nome_cliente) {
        await pool.query('INSERT INTO crm_alocacao_clientes (cod, nome) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING', [cod_cliente || null, nome_cliente]);
      }
      if (quem_alocou) {
        await pool.query('INSERT INTO crm_alocacao_alocadores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [quem_alocou.toUpperCase()]);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[Alocação] PATCH:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // DELETE /:id
  // ══════════════════════════════════════════════════════════════
  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('UPDATE crm_alocacoes SET ativo = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /clientes — Dropdown
  // ══════════════════════════════════════════════════════════════
  router.get('/clientes', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT cod, nome FROM crm_alocacao_clientes ORDER BY nome ASC');
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /alocadores — Dropdown
  // ══════════════════════════════════════════════════════════════
  router.get('/alocadores', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT nome FROM crm_alocacao_alocadores ORDER BY nome ASC');
      res.json({ success: true, data: rows.map(r => r.nome) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /profissional/:cod — Buscar nome pelo código (via bi_entregas)
  // ══════════════════════════════════════════════════════════════
  router.get('/profissional/:cod', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT nome_prof FROM bi_entregas WHERE cod_prof = $1 AND nome_prof IS NOT NULL LIMIT 1`,
        [req.params.cod]
      );
      if (rows.length > 0) {
        res.json({ success: true, nome: rows[0].nome_prof });
      } else {
        res.json({ success: true, nome: null });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /importar — Importar da Google Sheet
  // ══════════════════════════════════════════════════════════════
  router.post('/importar', async (req, res) => {
    try {
      console.log('[Alocação] Importando da planilha...');
      const response = await fetch(SHEET_CSV_URL, { headers: { 'Accept': 'text/csv' } });
      if (!response.ok) throw new Error(`Sheet HTTP ${response.status}`);

      const csv = await response.text();
      const linhas = csv.split('\n');
      if (linhas.length < 2) return res.json({ success: true, importados: 0, message: 'Planilha vazia' });

      // Parser CSV robusto (lida com vírgulas dentro de aspas)
      function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQuotes = !inQuotes; }
          else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
          else if (ch !== '\r') { current += ch; }
        }
        result.push(current.trim());
        return result;
      }

      // Parsear header para encontrar índices por nome
      const headerLine = parseCSVLine(linhas[0]);
      const headers = headerLine.map(h => h.replace(/"/g, '').trim().toUpperCase());
      console.log('[Alocação] Headers:', headers);

      // Mapear índices (flexível por nome)
      const iCod    = headers.findIndex(h => h === 'COD' || h === 'CÓDIGO' || h === 'CODIGO');
      const iEmpresa = headers.findIndex(h => h === 'EMPRESA' || h === 'CLIENTE');
      const iEntregador = headers.findIndex(h => h === 'ENTREGADOR' || h.includes('ENTREGADOR'));
      const iCodProf = headers.findIndex(h => h === 'COD DO PROF' || h.includes('COD') && h.includes('PROF'));
      const iQuem   = headers.findIndex(h => h.includes('QUEM') || h.includes('ALOCOU'));
      const iData   = headers.findIndex(h => h.includes('DATA') && h.includes('RODAR'));
      const iDias   = headers.findIndex(h => h.includes('DIAS') || h.includes('RODADOS'));
      const iObs    = headers.findIndex(h => h === 'OBS' || h === 'OBS:' || h.includes('OBSERV'));

      console.log('[Alocação] Índices: cod=' + iCod + ' empresa=' + iEmpresa + ' entregador=' + iEntregador + ' codProf=' + iCodProf + ' quem=' + iQuem + ' data=' + iData + ' dias=' + iDias + ' obs=' + iObs);

      // Log primeiras linhas pra debug
      for (let d = 1; d <= Math.min(3, linhas.length - 1); d++) {
        const cols = parseCSVLine(linhas[d]);
        console.log(`[Alocação] Linha ${d}: [${cols.map((c, i) => i + '="' + c + '"').join(', ')}]`);
      }

      let importados = 0, duplicados = 0;

      for (let i = 1; i < linhas.length; i++) {
        if (!linhas[i].trim()) continue;
        const cols = parseCSVLine(linhas[i]);

        const codCliente  = (iCod >= 0 ? cols[iCod] : cols[0] || '').trim();
        const nomeCliente = (iEmpresa >= 0 ? cols[iEmpresa] : cols[1] || '').trim();
        const nomeProf    = (iEntregador >= 0 ? cols[iEntregador] : cols[2] || '').trim();
        const codProf     = (iCodProf >= 0 ? cols[iCodProf] : cols[3] || '').trim();
        const quemAlocou  = (iQuem >= 0 ? cols[iQuem] : cols[4] || '').trim();
        const dataRaw     = (iData >= 0 ? cols[iData] : cols[5] || '').trim();
        const diasRaw     = (iDias >= 0 ? cols[iDias] : cols[6] || '').trim();
        const obs         = (iObs >= 0 ? cols[iObs] : cols[7] || '').trim();

        if (!codProf) continue;

        // Verificar duplicata
        const { rows: existing } = await pool.query(
          'SELECT id FROM crm_alocacoes WHERE cod_prof = $1 AND cod_cliente = $2 AND ativo = true',
          [codProf, codCliente]
        );
        if (existing.length > 0) { duplicados++; continue; }

        // Parsear data DD/MM ou DD/MM/YYYY
        let dataPrevista = null;
        if (dataRaw) {
          const partes = dataRaw.split('/');
          if (partes.length >= 2) {
            const dia = partes[0].padStart(2, '0');
            const mes = partes[1].padStart(2, '0');
            const ano = partes[2] || new Date().getFullYear().toString();
            dataPrevista = `${ano.length === 2 ? '20' + ano : ano}-${mes}-${dia}`;
          }
        }

        // Parsear status do "dias rodados"
        let status = 'nao_rodou';
        let diasOp = 0;
        const diasUpper = diasRaw.toUpperCase();
        if (diasUpper.includes('NÃO RODOU') || diasUpper.includes('NAO RODOU')) {
          status = 'nao_rodou';
        } else if (diasUpper.includes('DIA')) {
          const match = diasUpper.match(/(\d+)/);
          if (match) {
            diasOp = parseInt(match[1]);
            status = 'em_operacao';
          }
        }

        await pool.query(
          `INSERT INTO crm_alocacoes (cod_cliente, nome_cliente, cod_prof, nome_prof, quem_alocou, data_prevista, status, dias_operacao, obs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [codCliente, nomeCliente, codProf, nomeProf, quemAlocou, dataPrevista, status, diasOp, obs || null]
        );

        // Salvar dropdowns
        if (nomeCliente) {
          await pool.query('INSERT INTO crm_alocacao_clientes (cod, nome) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING', [codCliente, nomeCliente]);
        }
        if (quemAlocou) {
          await pool.query('INSERT INTO crm_alocacao_alocadores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [quemAlocou.toUpperCase()]);
        }

        importados++;
      }

      console.log(`[Alocação] ✅ Importação: ${importados} novos, ${duplicados} duplicados`);
      res.json({ success: true, importados, duplicados, message: `${importados} alocações importadas (${duplicados} já existiam)` });
    } catch (err) {
      console.error('[Alocação] Importar:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /atualizar-status — Recalcular status via bi_entregas
  //
  // Regras:
  //   - Default: nao_rodou
  //   - Rodou (tem entregas): em_operacao (dias_operacao = count distinct dates)
  //   - Rodou mas +3 dias sem rodar: possivel_churn
  //   - Rodou mas +7 dias sem rodar: churn
  //   - Tinha churn/possivel_churn e voltou a rodar: voltou_operacao
  // ══════════════════════════════════════════════════════════════
  router.post('/atualizar-status', async (req, res) => {
    try {
      const { rows: alocacoes } = await pool.query(
        'SELECT id, cod_prof, status FROM crm_alocacoes WHERE ativo = true'
      );

      console.log(`[Alocação] Atualizando status de ${alocacoes.length} alocações...`);

      let atualizados = 0, mudaram = 0;

      for (const aloc of alocacoes) {
        // Buscar entregas do profissional nos últimos 60 dias
        const { rows: entregas } = await pool.query(
          `SELECT DISTINCT data_solicitado::date as dia
           FROM bi_entregas
           WHERE cod_prof = $1
             AND data_solicitado >= CURRENT_DATE - INTERVAL '60 days'
             AND COALESCE(ponto, 1) >= 2
           ORDER BY dia DESC`,
          [aloc.cod_prof]
        );

        let novoStatus = 'nao_rodou';
        let diasOp = entregas.length;
        let ultimaEntrega = null;

        if (entregas.length > 0) {
          ultimaEntrega = entregas[0].dia;
          const hoje = new Date();
          hoje.setHours(0, 0, 0, 0);
          const ultima = new Date(ultimaEntrega);
          ultima.setHours(0, 0, 0, 0);
          const diffDias = Math.floor((hoje - ultima) / (1000 * 60 * 60 * 24));

          if (diffDias <= 3) {
            // Rodou recentemente
            if (aloc.status === 'churn' || aloc.status === 'possivel_churn') {
              novoStatus = 'voltou_operacao';
            } else {
              novoStatus = 'em_operacao';
            }
          } else if (diffDias <= 7) {
            novoStatus = 'possivel_churn';
          } else {
            novoStatus = 'churn';
          }
        }

        // Só atualizar se mudou
        if (novoStatus !== aloc.status || diasOp !== aloc.dias_operacao) {
          if (novoStatus !== aloc.status) {
            mudaram++;
            console.log(`[Alocação] 🔄 Prof ${aloc.cod_prof}: ${aloc.status} → ${novoStatus} (${diasOp} dias, última: ${ultimaEntrega || 'nunca'})`);
          }

          await pool.query(
            `UPDATE crm_alocacoes SET status = $1, dias_operacao = $2, ultima_entrega = $3, updated_at = NOW() WHERE id = $4`,
            [novoStatus, diasOp, ultimaEntrega, aloc.id]
          );
          atualizados++;
        }
      }

      console.log(`[Alocação] ✅ Status: ${atualizados} atualizados, ${mudaram} mudaram`);
      res.json({ success: true, total: alocacoes.length, atualizados, mudaram, message: `${atualizados} atualizados (${mudaram} mudaram de status)` });
    } catch (err) {
      console.error('[Alocação] Atualizar status:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createAlocacaoRoutes };
