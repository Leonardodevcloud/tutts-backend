const express = require('express');
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

module.exports = { createIncentivosRouter };
