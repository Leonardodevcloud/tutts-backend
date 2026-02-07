/**
 * BI Sub-Router: Configuração de Prazos (cliente, profissional, padrão)
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createPrazosRoutes(pool) {
  const router = express.Router();

router.get('/bi/prazos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.*, 
        COALESCE(json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
          ORDER BY fp.km_min
        ) FILTER (WHERE fp.id IS NOT NULL), '[]') as faixas
      FROM bi_prazos_cliente pc
      LEFT JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar prazos:', err);
    res.status(500).json({ error: 'Erro ao listar prazos' });
  }
});

// Buscar prazo padrão
router.get('/bi/prazo-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo padrão' });
  }
});

// Salvar prazo padrão
router.post('/bi/prazo-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo padrão' });
  }
});

// Criar/Atualizar configuração de prazo para cliente/centro
router.post('/bi/prazos', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_cliente (tipo, codigo, nome, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3, updated_at = NOW()
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo WHERE prazo_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo (prazo_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo' });
  }
});

// Remover configuração de prazo
router.delete('/bi/prazos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo:', err);
    res.status(500).json({ error: 'Erro ao remover prazo' });
  }
});

// ========== ROTAS DE PRAZO PROFISSIONAL ==========

// Listar prazos profissionais
router.get('/bi/prazos-prof', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.id, pc.tipo, pc.codigo, pc.nome,
        json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
        ) as faixas
      FROM bi_prazos_prof_cliente pc
      LEFT JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json({ success: true, prazos: result.rows });
  } catch (err) {
    console.error('❌ Erro ao listar prazos profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar prazos profissionais' });
  }
});

// Buscar prazo profissional padrão
router.get('/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo prof padrão' });
  }
});

// Salvar prazo profissional padrão
router.post('/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_prof_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_prof_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo prof padrão' });
  }
});

// Criar/Atualizar configuração de prazo profissional para cliente/centro
router.post('/bi/prazos-prof', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_prof_cliente (tipo, codigo, nome)
      VALUES ($1, $2, $3)
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo_prof WHERE prazo_prof_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo_prof (prazo_prof_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo profissional' });
  }
});

// Remover configuração de prazo profissional
router.delete('/bi/prazos-prof/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_prof_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao remover prazo profissional' });
  }
});

// Recalcular prazos profissionais de todas as entregas
router.post('/bi/entregas/recalcular-prazo-prof', async (req, res) => {
  try {
    // Buscar configurações de prazo profissional
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_prof_cliente pc
      JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando Prazo Prof - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    
    // Buscar todas as entregas com data_hora_alocado
    const entregas = await pool.query(`
      SELECT id, cod_cliente, centro_custo, distancia, data_hora_alocado, finalizado 
      FROM bi_entregas 
      WHERE data_hora_alocado IS NOT NULL
    `);
    console.log(`🔄 Total de entregas com alocação: ${entregas.rows.length}`);
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Usa prazo padrão profissional
      if (prazoPadrao.rows.length > 0) {
        for (const faixa of prazoPadrao.rows) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Fallback: 60 minutos para qualquer distância
      return 60;
    };
    
    // Calcular tempo de execução profissional (alocado -> finalizado)
    const calcularTempoExecucaoProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = new Date(dataHoraAlocado);
      const fim = new Date(finalizado);
      if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    let atualizados = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let semPrazoCount = 0;
    
    for (const e of entregas.rows) {
      const distancia = parseFloat(e.distancia) || 0;
      const prazoMinutos = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucaoProf(e.data_hora_alocado, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, alocado=${e.data_hora_alocado}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo_prof = $1, prazo_prof_minutos = $2, tempo_execucao_prof_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Prazo Prof Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular prazo prof:', err);
    res.status(500).json({ error: 'Erro ao recalcular prazo profissional' });
  }
});

// DIAGNÓSTICO - verificar dados do BI
// Endpoint para inicializar prazos com valores do DAX
router.post('/bi/inicializar-prazos-dax', async (req, res) => {
  try {
    // Tabela de prazos baseada no DAX_Prazo_Cliente
    const faixasPadrao = [
      { km_min: 0, km_max: 10, prazo_segundos: 3600 },
      { km_min: 10, km_max: 15, prazo_segundos: 4500 },
      { km_min: 15, km_max: 20, prazo_segundos: 5400 },
      { km_min: 20, km_max: 25, prazo_segundos: 6300 },
      { km_min: 25, km_max: 30, prazo_segundos: 7200 },
      { km_min: 30, km_max: 35, prazo_segundos: 8100 },
      { km_min: 35, km_max: 40, prazo_segundos: 9000 },
      { km_min: 40, km_max: 45, prazo_segundos: 9900 },
      { km_min: 45, km_max: 50, prazo_segundos: 10800 },
      { km_min: 50, km_max: 55, prazo_segundos: 11700 },
      { km_min: 55, km_max: 60, prazo_segundos: 12600 },
      { km_min: 60, km_max: 65, prazo_segundos: 13500 },
      { km_min: 65, km_max: 70, prazo_segundos: 14400 },
      { km_min: 70, km_max: 75, prazo_segundos: 15300 },
      { km_min: 75, km_max: 80, prazo_segundos: 16200 },
      { km_min: 80, km_max: 85, prazo_segundos: 17100 },
      { km_min: 85, km_max: 90, prazo_segundos: 18000 },
      { km_min: 90, km_max: 95, prazo_segundos: 18900 },
      { km_min: 95, km_max: 100, prazo_segundos: 19800 },
      // Acima de 100km = Fora do Prazo (prazo impossível de cumprir)
      { km_min: 100, km_max: null, prazo_segundos: 0 }
    ];
    
    // Limpar tabela de prazo padrão
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir faixas padrão (convertendo segundos para minutos)
    for (const faixa of faixasPadrao) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_segundos / 60]
      );
    }
    
    // Recalcular prazo para todos os registros
    const totalAtualizados = await pool.query(`
      WITH prazo_calc AS (
        SELECT 
          e.id,
          CASE 
            -- Faixas padrão baseadas na distância
            WHEN e.distancia <= 10 THEN 60
            WHEN e.distancia <= 15 THEN 75
            WHEN e.distancia <= 20 THEN 90
            WHEN e.distancia <= 25 THEN 105
            WHEN e.distancia <= 30 THEN 120
            WHEN e.distancia <= 35 THEN 135
            WHEN e.distancia <= 40 THEN 150
            WHEN e.distancia <= 45 THEN 165
            WHEN e.distancia <= 50 THEN 180
            WHEN e.distancia <= 55 THEN 195
            WHEN e.distancia <= 60 THEN 210
            WHEN e.distancia <= 65 THEN 225
            WHEN e.distancia <= 70 THEN 240
            WHEN e.distancia <= 75 THEN 255
            WHEN e.distancia <= 80 THEN 270
            WHEN e.distancia <= 85 THEN 285
            WHEN e.distancia <= 90 THEN 300
            WHEN e.distancia <= 95 THEN 315
            WHEN e.distancia <= 100 THEN 330
            ELSE 0 -- Acima de 100km = sempre fora do prazo
          END as prazo_calculado
        FROM bi_entregas e
        WHERE e.distancia IS NOT NULL
      )
      UPDATE bi_entregas e
      SET prazo_minutos = pc.prazo_calculado,
          dentro_prazo = CASE 
            WHEN pc.prazo_calculado = 0 THEN false
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos <= pc.prazo_calculado THEN true
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos > pc.prazo_calculado THEN false
            ELSE NULL
          END
      FROM prazo_calc pc
      WHERE e.id = pc.id
    `);
    
    res.json({
      success: true,
      message: 'Prazos inicializados com valores do DAX',
      faixasPadrao: faixasPadrao.length,
      registrosAtualizados: totalAtualizados.rowCount
    });
  } catch (error) {
    console.error('Erro ao inicializar prazos DAX:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint para preencher hora_solicitado a partir de data_hora (para dados antigos)
router.post('/bi/preencher-hora-solicitado', async (req, res) => {
  try {
    console.log('🕐 Preenchendo hora_solicitado a partir de data_hora...');
    
    // Atualizar hora_solicitado extraindo a hora de data_hora onde está null
    const result = await pool.query(`
      UPDATE bi_entregas 
      SET hora_solicitado = data_hora::time 
      WHERE hora_solicitado IS NULL AND data_hora IS NOT NULL
    `);
    
    console.log(`✅ ${result.rowCount} registros atualizados com hora_solicitado`);
    
    res.json({ 
      success: true, 
      message: `${result.rowCount} registros atualizados com hora_solicitado`,
      atualizados: result.rowCount 
    });
  } catch (error) {
    console.error('❌ Erro ao preencher hora_solicitado:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.get('/bi/diagnostico', async (req, res) => {
  try {
    // Versão do código para verificar deploy
    const versao = '2025-12-27-v11-fix-coleta-ponto';
    
    // Verificar prazo padrão
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    // Verificar entregas
    const entregas = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas`);
    const amostra = await pool.query(`SELECT id, os, ponto, cod_cliente, centro_custo, distancia, data_hora, data_hora_alocado, finalizado, execucao_comp, dentro_prazo, prazo_minutos, tempo_execucao_minutos FROM bi_entregas LIMIT 5`);
    
    // Verificar quantos têm prazo calculado
    const comPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo IS NOT NULL`);
    const dentroPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = true`);
    const foraPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = false`);
    
    // === NOVO: Diagnóstico de Alocação e Pontos ===
    const distribuicaoPontos = await pool.query(`
      SELECT COALESCE(ponto, 1) as ponto, COUNT(*) as total 
      FROM bi_entregas 
      GROUP BY COALESCE(ponto, 1) 
      ORDER BY ponto
    `);
    
    const comAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE data_hora_alocado IS NOT NULL`);
    const comFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE finalizado IS NOT NULL`);
    const ponto1ComAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL`);
    const ponto2PlusComFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL`);
    
    // Amostra de cálculo de tempo
    const amostraTempos = await pool.query(`
      SELECT 
        os, ponto, cod_cliente,
        data_hora,
        data_hora_alocado,
        finalizado,
        CASE WHEN COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora)) / 60
          ELSE NULL
        END as tempo_alocacao_min,
        CASE WHEN COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (finalizado - data_hora)) / 60
          ELSE NULL
        END as tempo_entrega_min
      FROM bi_entregas
      WHERE data_hora IS NOT NULL
      LIMIT 10
    `);
    
    // Verificar centros de custo
    const comCentroCusto = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != ''`);
    const centrosUnicos = await pool.query(`SELECT DISTINCT centro_custo, cod_cliente FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' LIMIT 20`);
    
    // Verificar motivos (retornos)
    const comMotivo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != ''`);
    const motivosErro = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%'`);
    const motivosUnicos = await pool.query(`SELECT DISTINCT motivo, COUNT(*) as qtd FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != '' GROUP BY motivo ORDER BY qtd DESC LIMIT 20`);
    const amostraErros = await pool.query(`SELECT os, ponto, cod_cliente, motivo FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%' LIMIT 10`);
    
    // Verificar ocorrências (nova regra de retornos)
    const comOcorrencia = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != ''`);
    const ocorrenciasRetorno = await pool.query(`
      SELECT COUNT(*) as total FROM bi_entregas 
      WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' 
         OR LOWER(ocorrencia) LIKE '%clienteaus%'
         OR LOWER(ocorrencia) LIKE '%cliente ausente%'
         OR LOWER(ocorrencia) LIKE '%loja fechada%'
         OR LOWER(ocorrencia) LIKE '%produto incorreto%'
    `);
    const ocorrenciasUnicas = await pool.query(`SELECT DISTINCT ocorrencia, COUNT(*) as qtd FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != '' GROUP BY ocorrencia ORDER BY qtd DESC LIMIT 30`);
    
    res.json({
      versao: versao,
      totalEntregas: entregas.rows[0].total,
      // Diagnóstico de tempos
      diagnosticoTempos: {
        distribuicaoPontos: distribuicaoPontos.rows,
        comDataHoraAlocado: comAlocado.rows[0].total,
        comFinalizado: comFinalizado.rows[0].total,
        ponto1ComAlocado: ponto1ComAlocado.rows[0].total,
        ponto2PlusComFinalizado: ponto2PlusComFinalizado.rows[0].total,
        amostraTempos: amostraTempos.rows
      },
      // Prazo
      comPrazoCalculado: comPrazo.rows[0].total,
      dentroPrazo: dentroPrazo.rows[0].total,
      foraPrazo: foraPrazo.rows[0].total,
      prazoPadrao: prazoPadrao.rows,
      // Centro de custo
      comCentroCusto: comCentroCusto.rows[0].total,
      centrosUnicos: centrosUnicos.rows,
      // Motivos e Ocorrências
      comMotivo: comMotivo.rows[0].total,
      motivosComErro: motivosErro.rows[0].total,
      motivosUnicos: motivosUnicos.rows,
      amostraErros: amostraErros.rows,
      comOcorrencia: comOcorrencia.rows[0].total,
      ocorrenciasRetorno: ocorrenciasRetorno.rows[0].total,
      ocorrenciasUnicas: ocorrenciasUnicas.rows,
      amostraEntregas: amostra.rows
    });
  } catch (err) {
    console.error('❌ Erro no diagnóstico:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

  return router;
}

module.exports = { createPrazosRoutes };
