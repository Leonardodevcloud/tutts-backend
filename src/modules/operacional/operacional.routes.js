/**
 * MÓDULO OPERACIONAL - Routes
 * 22 endpoints: 7 avisos-op + 9 incentivos-op + 6 operações
 */

const express = require('express');

function createAvisosRouter(pool) {
  const router = express.Router();

  // Listar todas as regiões (cidades) da planilha
  router.get('/regioes', async (req, res) => {
    try {
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1); // pular header
      
      const regioes = new Set();
      lines.forEach(line => {
        const cols = line.split(',');
        const cidade = cols[3]?.trim(); // coluna Cidade
        if (cidade && cidade.length > 0 && cidade !== '') {
          regioes.add(cidade);
        }
      });
      
      res.json([...regioes].sort());
    } catch (err) {
      console.error('❌ Erro ao buscar regiões:', err);
      res.json([]);
    }
  });

  // Listar todos os avisos (para admin)
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT a.*, 
          (SELECT COUNT(*) FROM avisos_visualizacoes WHERE aviso_id = a.id) as total_visualizacoes
        FROM avisos a 
        ORDER BY created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar avisos:', err);
      res.json([]);
    }
  });

  // Criar novo aviso
  router.post('/', async (req, res) => {
    try {
      const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by } = req.body;
      
      const result = await pool.query(`
        INSERT INTO avisos (titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [titulo, regioes || [], todas_regioes || false, data_inicio, data_fim, recorrencia_tipo || 'uma_vez', recorrencia_intervalo || 0, imagem_url, created_by]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Atualizar aviso
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo } = req.body;
      
      const result = await pool.query(`
        UPDATE avisos 
        SET titulo = $1, regioes = $2, todas_regioes = $3, data_inicio = $4, data_fim = $5, 
            recorrencia_tipo = $6, recorrencia_intervalo = $7, imagem_url = $8, ativo = $9, updated_at = NOW()
        WHERE id = $10
        RETURNING *
      `, [titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo, id]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Deletar aviso
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM avisos WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Buscar avisos para um usuário específico (baseado na região)
  router.get('/usuario/:cod', async (req, res) => {
    try {
      const { cod } = req.params;
      
      // Buscar região do usuário na planilha
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1);
      
      let userRegiao = null;
      for (const line of lines) {
        const cols = line.split(',');
        if (cols[0]?.trim() === cod) {
          userRegiao = cols[3]?.trim(); // coluna Cidade
          break;
        }
      }
      
      const now = new Date();
      
      // Buscar avisos ativos para a região do usuário
      const result = await pool.query(`
        SELECT a.* FROM avisos a
        WHERE a.ativo = true
          AND a.data_inicio <= $1
          AND a.data_fim >= $1
          AND (a.todas_regioes = true OR $2 = ANY(a.regioes) OR $2 IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM avisos_visualizacoes av 
            WHERE av.aviso_id = a.id AND av.user_cod = $3
            AND (
              a.recorrencia_tipo = 'uma_vez'
              OR (a.recorrencia_tipo = 'diario' AND av.visualizado_em > NOW() - INTERVAL '1 day')
              OR (a.recorrencia_tipo = 'intervalo_horas' AND av.visualizado_em > NOW() - (a.recorrencia_intervalo || ' hours')::INTERVAL)
            )
          )
        ORDER BY a.created_at DESC
        LIMIT 1
      `, [now, userRegiao, cod]);
      
      res.json(result.rows[0] || null);
    } catch (err) {
      console.error('❌ Erro ao buscar avisos do usuário:', err);
      res.json(null);
    }
  });

  // Marcar aviso como visualizado
  router.post('/:id/visualizar', async (req, res) => {
    try {
      const { id } = req.params;
      const { user_cod } = req.body;
      
      await pool.query(`
        INSERT INTO avisos_visualizacoes (aviso_id, user_cod, visualizado_em)
        VALUES ($1, $2, NOW())
        ON CONFLICT (aviso_id, user_cod) DO UPDATE SET visualizado_em = NOW()
      `, [id, user_cod]);
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao marcar visualização:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function createIncentivosRouter(pool) {
  const router = express.Router();

  // Buscar estatísticas de incentivos (DEVE VIR ANTES DE :id)
  router.get('/stats', async (req, res) => {
    try {
      const hoje = new Date().toISOString().split('T')[0];
      const em7dias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const stats = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'ativo' AND data_inicio <= $1 AND data_fim >= $1) as ativos,
          COUNT(*) FILTER (WHERE status = 'ativo' AND data_fim >= $1 AND data_fim <= $2) as vencendo_em_breve,
          COUNT(*) FILTER (WHERE status = 'pausado') as pausados,
          COUNT(*) FILTER (WHERE data_fim < $1) as encerrados,
          COUNT(*) as total
        FROM incentivos_operacionais
      `, [hoje, em7dias]);
      
      res.json(stats.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao buscar stats incentivos:', err);
      res.json({ ativos: 0, vencendo_em_breve: 0, pausados: 0, encerrados: 0, total: 0 });
    }
  });

  // Buscar incentivos por mês (para calendário) (DEVE VIR ANTES DE :id)
  router.get('/mes/:ano/:mes', async (req, res) => {
    try {
      const { ano, mes } = req.params;
      const inicioMes = `${ano}-${mes.padStart(2, '0')}-01`;
      const fimMes = new Date(ano, mes, 0).toISOString().split('T')[0];
      
      const result = await pool.query(`
        SELECT * FROM incentivos_operacionais 
        WHERE (data_inicio <= $2 AND data_fim >= $1)
        ORDER BY data_inicio ASC
      `, [inicioMes, fimMes]);
      
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao buscar incentivos do mês:', err);
      res.json([]);
    }
  });

  // Calcular custo do incentivo baseado nas OS do BI (DEVE VIR ANTES DE :id)
  router.get('/calcular/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const incResult = await pool.query('SELECT * FROM incentivos_operacionais WHERE id = $1', [id]);
      if (incResult.rows.length === 0) {
        return res.status(404).json({ error: 'Incentivo não encontrado' });
      }
      
      const incentivo = incResult.rows[0];
      
      if (incentivo.tipo !== 'incentivo') {
        return res.json({ 
          quantidade_os: 0, 
          valor_total: 0, 
          mensagem: 'Cálculo disponível apenas para tipo Incentivo' 
        });
      }
      
      if (!incentivo.valor_incentivo) {
        return res.json({ 
          quantidade_os: 0, 
          valor_total: 0, 
          mensagem: 'Valor do incentivo não configurado' 
        });
      }
      
      // Buscar máscaras para obter nomes dos clientes
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
      const mascaras = {};
      mascarasResult.rows.forEach(m => {
        mascaras[String(m.cod_cliente)] = m.mascara;
      });
      
      // Construir query para buscar OS
      let queryParams = [incentivo.data_inicio, incentivo.data_fim];
      let clienteFilter = '';
      
      if (incentivo.clientes_vinculados && incentivo.clientes_vinculados.length > 0) {
        clienteFilter = ` AND cod_cliente = ANY($3)`;
        queryParams.push(incentivo.clientes_vinculados);
      }
      
      let horaFilter = '';
      if (incentivo.hora_inicio && incentivo.hora_fim) {
        horaFilter = ` AND hora_solicitado >= $${queryParams.length + 1} AND hora_solicitado <= $${queryParams.length + 2}`;
        queryParams.push(incentivo.hora_inicio, incentivo.hora_fim);
      }
      
      const osResult = await pool.query(`
        SELECT 
          COUNT(DISTINCT os) as quantidade_os,
          COALESCE(SUM(CASE WHEN ponto = 1 THEN 1 ELSE 0 END), COUNT(DISTINCT os)) as quantidade_entregas
        FROM bi_entregas
        WHERE data_solicitado >= $1 
          AND data_solicitado <= $2
          ${clienteFilter}
          ${horaFilter}
      `, queryParams);
      
      const quantidadeOS = parseInt(osResult.rows[0]?.quantidade_os || 0);
      const valorIncentivo = parseFloat(incentivo.valor_incentivo) || 0;
      const valorTotal = quantidadeOS * valorIncentivo;
      
      // Buscar detalhes por cliente se houver clientes vinculados
      let detalhesPorCliente = [];
      if (incentivo.clientes_vinculados && incentivo.clientes_vinculados.length > 0) {
        const detalhesResult = await pool.query(`
          SELECT 
            cod_cliente,
            MAX(nome_cliente) as nome_cliente,
            COUNT(DISTINCT os) as quantidade_os
          FROM bi_entregas
          WHERE data_solicitado >= $1 
            AND data_solicitado <= $2
            AND cod_cliente = ANY($3)
            ${horaFilter}
          GROUP BY cod_cliente
          ORDER BY COUNT(DISTINCT os) DESC
        `, horaFilter ? [incentivo.data_inicio, incentivo.data_fim, incentivo.clientes_vinculados, incentivo.hora_inicio, incentivo.hora_fim] : [incentivo.data_inicio, incentivo.data_fim, incentivo.clientes_vinculados]);
        
        detalhesPorCliente = detalhesResult.rows.map(row => ({
          cod_cliente: row.cod_cliente,
          nome_display: mascaras[String(row.cod_cliente)] || row.nome_cliente || `Cliente ${row.cod_cliente}`,
          quantidade_os: parseInt(row.quantidade_os),
          valor: parseInt(row.quantidade_os) * valorIncentivo
        }));
      }
      
      res.json({
        quantidade_os: quantidadeOS,
        valor_unitario: valorIncentivo,
        valor_total: valorTotal,
        detalhes_por_cliente: detalhesPorCliente,
        periodo: {
          data_inicio: incentivo.data_inicio,
          data_fim: incentivo.data_fim,
          hora_inicio: incentivo.hora_inicio,
          hora_fim: incentivo.hora_fim
        },
        mensagem: quantidadeOS > 0 ? null : 'Nenhuma OS encontrada no período/horário configurado'
      });
    } catch (err) {
      console.error('❌ Erro ao calcular incentivo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Relatório de custos de incentivos (DEVE VIR ANTES DE :id)
  router.get('/relatorio/custos', async (req, res) => {
    try {
      const { mes, ano } = req.query;
      
      let queryParams = [];
      
      // Buscar todos os incentivos do tipo 'incentivo'
      const result = await pool.query(`
        SELECT * FROM incentivos_operacionais 
        WHERE tipo = 'incentivo'
        ${mes && ano ? `AND (
          (EXTRACT(MONTH FROM data_inicio) = $1 AND EXTRACT(YEAR FROM data_inicio) = $2)
          OR (EXTRACT(MONTH FROM data_fim) = $1 AND EXTRACT(YEAR FROM data_fim) = $2)
        )` : ''}
        ORDER BY data_inicio DESC
      `, mes && ano ? [mes, ano] : []);
      
      // Buscar máscaras
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
      const mascaras = {};
      mascarasResult.rows.forEach(m => {
        mascaras[String(m.cod_cliente)] = m.mascara;
      });
      
      // Calcular valores para cada incentivo
      let custoTotal = 0;
      let totalOS = 0;
      
      const relatorio = await Promise.all(result.rows.map(async (inc) => {
        if (!inc.valor_incentivo) {
          return { ...inc, quantidade_os: 0, valor_total: 0 };
        }
        
        let qParams = [inc.data_inicio, inc.data_fim];
        let clienteFilter = '';
        
        if (inc.clientes_vinculados && inc.clientes_vinculados.length > 0) {
          clienteFilter = ` AND cod_cliente = ANY($3)`;
          qParams.push(inc.clientes_vinculados);
        }
        
        let horaFilter = '';
        if (inc.hora_inicio && inc.hora_fim) {
          horaFilter = ` AND hora_solicitado >= $${qParams.length + 1} AND hora_solicitado <= $${qParams.length + 2}`;
          qParams.push(inc.hora_inicio, inc.hora_fim);
        }
        
        const osResult = await pool.query(`
          SELECT COUNT(DISTINCT os) as quantidade_os
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
          ${clienteFilter} ${horaFilter}
        `, qParams);
        
        const qtdOS = parseInt(osResult.rows[0]?.quantidade_os || 0);
        const valorTotal = qtdOS * parseFloat(inc.valor_incentivo);
        
        custoTotal += valorTotal;
        totalOS += qtdOS;
        
        // Mapear nomes dos clientes
        const clientesNomes = (inc.clientes_vinculados || []).map(cod => 
          mascaras[String(cod)] || `Cliente ${cod}`
        );
        
        return {
          id: inc.id,
          titulo: inc.titulo,
          data_inicio: inc.data_inicio,
          data_fim: inc.data_fim,
          hora_inicio: inc.hora_inicio,
          hora_fim: inc.hora_fim,
          valor_incentivo: inc.valor_incentivo,
          clientes: clientesNomes,
          quantidade_os: qtdOS,
          valor_total: valorTotal,
          status: inc.status
        };
      }));
      
      res.json({
        incentivos: relatorio,
        resumo: {
          total_incentivos: relatorio.length,
          total_os: totalOS,
          custo_total: custoTotal
        }
      });
    } catch (err) {
      console.error('❌ Erro ao gerar relatório:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Listar todos os incentivos com cálculo automático
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT * FROM incentivos_operacionais 
        ORDER BY data_inicio DESC, created_at DESC
      `);
      
      // Buscar máscaras
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
      const mascaras = {};
      mascarasResult.rows.forEach(m => {
        mascaras[String(m.cod_cliente)] = m.mascara;
      });
      
      // Para cada incentivo do tipo 'incentivo', calcular o valor
      const incentivosComCalculo = await Promise.all(result.rows.map(async (inc) => {
        if (inc.tipo === 'incentivo' && inc.valor_incentivo) {
          try {
            let queryParams = [inc.data_inicio, inc.data_fim];
            let clienteFilter = '';
            
            if (inc.clientes_vinculados && inc.clientes_vinculados.length > 0) {
              clienteFilter = ` AND cod_cliente = ANY($3)`;
              queryParams.push(inc.clientes_vinculados);
            }
            
            let horaFilter = '';
            if (inc.hora_inicio && inc.hora_fim) {
              horaFilter = ` AND hora_solicitado >= $${queryParams.length + 1} AND hora_solicitado <= $${queryParams.length + 2}`;
              queryParams.push(inc.hora_inicio, inc.hora_fim);
            }
            
            const osResult = await pool.query(`
              SELECT COUNT(DISTINCT os) as quantidade_os
              FROM bi_entregas
              WHERE data_solicitado >= $1 
                AND data_solicitado <= $2
                ${clienteFilter}
                ${horaFilter}
            `, queryParams);
            
            const quantidadeOS = parseInt(osResult.rows[0]?.quantidade_os || 0);
            const valorTotal = quantidadeOS * parseFloat(inc.valor_incentivo);
            
            // Mapear nomes dos clientes
            const clientesNomes = (inc.clientes_vinculados || []).map(cod => ({
              cod_cliente: cod,
              nome_display: mascaras[String(cod)] || `Cliente ${cod}`
            }));
            
            return {
              ...inc,
              calculo: {
                quantidade_os: quantidadeOS,
                valor_total: valorTotal,
                tem_dados: quantidadeOS > 0
              },
              clientes_nomes: clientesNomes
            };
          } catch (err) {
            console.error('Erro ao calcular incentivo:', inc.id, err);
            return { ...inc, calculo: null };
          }
        }
        
        // Para outros tipos, mapear nomes dos clientes se houver
        const clientesNomes = (inc.clientes_vinculados || []).map(cod => ({
          cod_cliente: cod,
          nome_display: mascaras[String(cod)] || `Cliente ${cod}`
        }));
        
        return { ...inc, calculo: null, clientes_nomes: clientesNomes };
      }));
      
      res.json(incentivosComCalculo);
    } catch (err) {
      console.error('❌ Erro ao listar incentivos:', err);
      res.json([]);
    }
  });

  // Buscar incentivo por ID
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query('SELECT * FROM incentivos_operacionais WHERE id = $1', [id]);
      res.json(result.rows[0] || null);
    } catch (err) {
      console.error('❌ Erro ao buscar incentivo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Criar novo incentivo
  router.post('/', async (req, res) => {
    try {
      const { 
        titulo, descricao, tipo, operacoes, todas_operacoes,
        data_inicio, data_fim, hora_inicio, hora_fim,
        valor, valor_incentivo, clientes_vinculados,
        condicoes, cor, created_by 
      } = req.body;
      
      const result = await pool.query(`
        INSERT INTO incentivos_operacionais 
          (titulo, descricao, tipo, operacoes, todas_operacoes, data_inicio, data_fim, 
           hora_inicio, hora_fim, valor, valor_incentivo, clientes_vinculados, condicoes, cor, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `, [
        titulo, 
        descricao || '', 
        tipo || 'promocao', 
        operacoes || [], 
        todas_operacoes || false,
        data_inicio, 
        data_fim,
        hora_inicio || null,
        hora_fim || null,
        valor || '', 
        valor_incentivo || null,
        clientes_vinculados || [],
        condicoes || '', 
        cor || '#0d9488',
        created_by
      ]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar incentivo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Atualizar incentivo
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        titulo, descricao, tipo, operacoes, todas_operacoes,
        data_inicio, data_fim, hora_inicio, hora_fim,
        valor, valor_incentivo, clientes_vinculados,
        condicoes, status, cor 
      } = req.body;
      
      const result = await pool.query(`
        UPDATE incentivos_operacionais 
        SET titulo = $1, descricao = $2, tipo = $3, operacoes = $4, todas_operacoes = $5,
            data_inicio = $6, data_fim = $7, hora_inicio = $8, hora_fim = $9,
            valor = $10, valor_incentivo = $11, clientes_vinculados = $12,
            condicoes = $13, status = $14, cor = $15, updated_at = NOW()
        WHERE id = $16
        RETURNING *
      `, [
        titulo, descricao, tipo, operacoes, todas_operacoes,
        data_inicio, data_fim, hora_inicio, hora_fim,
        valor, valor_incentivo, clientes_vinculados,
        condicoes, status, cor, id
      ]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar incentivo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Deletar incentivo
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM incentivos_operacionais WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar incentivo:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function createOperacoesRouter(pool) {
  const router = express.Router();

  // GET - Listar todas as operações
  router.get('/', async (req, res) => {
    try {
      const { status, regiao } = req.query;
      
      let query = `
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE 1=1
      `;
      const params = [];
      
      if (status) {
        params.push(status);
        query += ` AND o.status = $${params.length}`;
      }
      
      if (regiao) {
        params.push(regiao);
        query += ` AND o.regiao = $${params.length}`;
      }
      
      query += ` ORDER BY o.criado_em DESC`;
      
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao listar operações:', error);
      res.status(500).json({ error: 'Erro ao listar operações' });
    }
  });

  // GET - Listar regiões das operações
  router.get('/regioes', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT regiao FROM operacoes WHERE regiao IS NOT NULL ORDER BY regiao
      `);
      res.json(result.rows.map(r => r.regiao));
    } catch (error) {
      console.error('Erro ao listar regiões:', error);
      res.status(500).json({ error: 'Erro ao listar regiões' });
    }
  });

  // GET - Buscar operação por ID
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const operacao = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [id]);
      
      if (operacao.rows.length === 0) {
        return res.status(404).json({ error: 'Operação não encontrada' });
      }
      
      res.json(operacao.rows[0]);
    } catch (error) {
      console.error('Erro ao buscar operação:', error);
      res.status(500).json({ error: 'Erro ao buscar operação' });
    }
  });

  // POST - Criar nova operação
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, faixas_km, criado_por
      } = req.body;
      
      const operacaoResult = await client.query(`
        INSERT INTO operacoes (
          regiao, nome_cliente, endereco, modelo, quantidade_motos,
          obrigatoriedade_bau, possui_garantido, valor_garantido,
          data_inicio, observacoes, criado_por
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [
        regiao, nome_cliente, endereco, modelo, quantidade_motos || 1,
        obrigatoriedade_bau || false, possui_garantido || false, valor_garantido || 0,
        data_inicio, observacoes, criado_por
      ]);
      
      const operacaoId = operacaoResult.rows[0].id;
      
      if (faixas_km && faixas_km.length > 0) {
        for (const faixa of faixas_km) {
          if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
            await client.query(`
              INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
              VALUES ($1, $2, $3, $4)
            `, [operacaoId, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
          }
        }
      }
      
      await client.query('COMMIT');
      
      const operacaoCompleta = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [operacaoId]);
      
      res.status(201).json(operacaoCompleta.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar operação:', error);
      res.status(500).json({ error: 'Erro ao criar operação' });
    } finally {
      client.release();
    }
  });

  // PUT - Atualizar operação
  router.put('/:id', async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const {
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, status, faixas_km
      } = req.body;
      
      await client.query(`
        UPDATE operacoes SET
          regiao = COALESCE($1, regiao),
          nome_cliente = COALESCE($2, nome_cliente),
          endereco = COALESCE($3, endereco),
          modelo = COALESCE($4, modelo),
          quantidade_motos = COALESCE($5, quantidade_motos),
          obrigatoriedade_bau = COALESCE($6, obrigatoriedade_bau),
          possui_garantido = COALESCE($7, possui_garantido),
          valor_garantido = COALESCE($8, valor_garantido),
          data_inicio = COALESCE($9, data_inicio),
          observacoes = COALESCE($10, observacoes),
          status = COALESCE($11, status),
          atualizado_em = NOW()
        WHERE id = $12
      `, [
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, status, id
      ]);
      
      if (faixas_km) {
        await client.query('DELETE FROM operacoes_faixas_km WHERE operacao_id = $1', [id]);
        
        for (const faixa of faixas_km) {
          if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
            await client.query(`
              INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
              VALUES ($1, $2, $3, $4)
            `, [id, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
          }
        }
      }
      
      await client.query('COMMIT');
      
      const operacaoAtualizada = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [id]);
      
      res.json(operacaoAtualizada.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atualizar operação:', error);
      res.status(500).json({ error: 'Erro ao atualizar operação' });
    } finally {
      client.release();
    }
  });

  // DELETE - Excluir operação
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query('DELETE FROM operacoes WHERE id = $1 RETURNING *', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Operação não encontrada' });
      }
      
      res.json({ message: 'Operação excluída com sucesso', operacao: result.rows[0] });
    } catch (error) {
      console.error('Erro ao excluir operação:', error);
      res.status(500).json({ error: 'Erro ao excluir operação' });
    }
  });

  return router;
}

module.exports = { createAvisosRouter, createIncentivosRouter, createOperacoesRouter };
