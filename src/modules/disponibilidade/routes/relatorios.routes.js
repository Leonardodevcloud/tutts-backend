/**
 * Sub-Router: Reset, Relatórios, Público
 */
const express = require('express');

function createRelatoriosRoutes(pool) {
  const router = express.Router();

router.post('/disponibilidade/resetar', async (req, res) => {
  try {
    // Pegar a data da planilha (enviada pelo frontend) ou usar hoje
    const { data_planilha } = req.body || {};
    const dataEspelho = data_planilha || new Date().toISOString().split('T')[0];
    
    // 1. Salvar espelho antes de resetar
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      data_planilha: dataEspelho,
      salvo_em: new Date().toISOString()
    };
    
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [dataEspelho]
    );
    
    let espelhoSalvo = false;
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1, created_at = CURRENT_TIMESTAMP WHERE data_registro = $2',
        [JSON.stringify(dados), dataEspelho]
      );
      espelhoSalvo = true;
    } else {
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [dataEspelho, JSON.stringify(dados)]
      );
      espelhoSalvo = true;
    }
    console.log('📸 Espelho salvo antes do reset:', dataEspelho, '- Linhas:', linhas.rows.length);
    
    // 1.5. SALVAR OBSERVAÇÕES NO HISTÓRICO antes de resetar
    const linhasComObs = linhas.rows.filter(l => l.observacao && l.observacao.trim() !== '');
    let observacoesSalvas = 0;
    
    for (const linha of linhasComObs) {
      await pool.query(
        `INSERT INTO disponibilidade_observacoes_historico 
         (linha_id, loja_id, cod_profissional, nome_profissional, observacao, criada_por, criada_em, data_reset, data_planilha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
        [
          linha.id,
          linha.loja_id,
          linha.cod_profissional,
          linha.nome_profissional,
          linha.observacao,
          linha.observacao_criada_por,
          linha.observacao_criada_em,
          dataEspelho
        ]
      );
      observacoesSalvas++;
    }
    console.log('📝 Observações salvas no histórico:', observacoesSalvas);
    
    // 2. REGISTRAR MOTOBOYS "EM LOJA" antes de resetar
    const emLojaLinhas = linhas.rows.filter(l => l.status === 'EM LOJA' && l.cod_profissional);
    for (const linha of emLojaLinhas) {
      await pool.query(
        `INSERT INTO disponibilidade_em_loja (loja_id, cod_profissional, nome_profissional, data_registro)
         VALUES ($1, $2, $3, $4)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho]
      );
    }
    console.log('🏪 Motoboys EM LOJA registrados:', emLojaLinhas.length);
    
    // 3. REGISTRAR MOTOBOYS "SEM CONTATO" e verificar dias consecutivos
    const semContatoLinhas = linhas.rows.filter(l => l.status === 'SEM CONTATO' && l.cod_profissional);
    const removidos = [];
    
    for (const linha of semContatoLinhas) {
      // Verificar se já tem registro recente (ontem ou antes)
      const ultimoRegistro = await pool.query(
        `SELECT * FROM disponibilidade_sem_contato 
         WHERE cod_profissional = $1 AND loja_id = $2
         ORDER BY data_registro DESC LIMIT 1`,
        [linha.cod_profissional, linha.loja_id]
      );
      
      let diasConsecutivos = 1;
      
      if (ultimoRegistro.rows.length > 0) {
        const ultimaData = new Date(ultimoRegistro.rows[0].data_registro);
        const dataAtual = new Date(dataEspelho);
        const diffDias = Math.floor((dataAtual - ultimaData) / (1000 * 60 * 60 * 24));
        
        // Se o último registro foi ontem (ou há 1 dia), incrementa contador
        if (diffDias === 1) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos + 1;
        }
        // Se foi no mesmo dia, mantém o mesmo contador
        else if (diffDias === 0) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos;
        }
        // Se foi há mais de 1 dia, reseta contador
      }
      
      // Inserir novo registro
      await pool.query(
        `INSERT INTO disponibilidade_sem_contato (loja_id, cod_profissional, nome_profissional, data_registro, dias_consecutivos)
         VALUES ($1, $2, $3, $4, $5)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho, diasConsecutivos]
      );
      
      // AUTO-REMOÇÃO: Se chegou a 3 dias consecutivos, remove da planilha
      if (diasConsecutivos >= 3) {
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL
           WHERE id = $1`,
          [linha.id]
        );
        removidos.push({
          cod: linha.cod_profissional,
          nome: linha.nome_profissional,
          dias: diasConsecutivos
        });
        console.log('🚫 Auto-removido por 3 dias SEM CONTATO:', linha.cod_profissional, linha.nome_profissional);
      }
    }
    console.log('📵 Motoboys SEM CONTATO registrados:', semContatoLinhas.length, '- Removidos:', removidos.length);
    
    // 4. Processar linhas de reposição
    // Regra: Se há excedente vazio disponível, migra o usuário para lá. Senão, reposição vira nova linha excedente.
    
    // Buscar todas as linhas de reposição que têm usuário preenchido
    const reposicoesPreenchidas = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND cod_profissional IS NOT NULL AND cod_profissional != ''`
    );
    
    // Buscar todas as linhas de reposição vazias
    const reposicoesVazias = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND (cod_profissional IS NULL OR cod_profissional = '')`
    );
    
    console.log('📊 Reposições preenchidas:', reposicoesPreenchidas.rows.length);
    console.log('📊 Reposições vazias:', reposicoesVazias.rows.length);
    
    // Para cada reposição preenchida, tentar migrar para excedente vazio da mesma loja
    for (const reposicao of reposicoesPreenchidas.rows) {
      // Buscar excedente vazio na mesma loja
      const excedenteVazio = await pool.query(
        `SELECT id FROM disponibilidade_linhas 
         WHERE loja_id = $1 AND is_excedente = true 
         AND (cod_profissional IS NULL OR cod_profissional = '')
         LIMIT 1`,
        [reposicao.loja_id]
      );
      
      if (excedenteVazio.rows.length > 0) {
        // Migrar usuário para o excedente vazio
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = $1, nome_profissional = $2
           WHERE id = $3`,
          [reposicao.cod_profissional, reposicao.nome_profissional, excedenteVazio.rows[0].id]
        );
        // Deletar a linha de reposição (já migrou o usuário)
        await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1', [reposicao.id]);
        console.log('✅ Usuário migrado de reposição para excedente vazio:', reposicao.cod_profissional);
      } else {
        // Não há excedente vazio, converter reposição em nova linha excedente (mantém o usuário)
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET is_excedente = true, is_reposicao = false 
           WHERE id = $1`,
          [reposicao.id]
        );
        console.log('✅ Reposição convertida em excedente adicional:', reposicao.cod_profissional);
      }
    }
    
    // Deletar reposições vazias (não precisam virar excedente)
    await pool.query(
      `DELETE FROM disponibilidade_linhas WHERE is_reposicao = true`
    );
    console.log('🗑️ Reposições vazias removidas');
    
    // 5. Resetar APENAS status (MANTER observações, cod e nome!)
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET status = 'A CONFIRMAR', 
           updated_at = CURRENT_TIMESTAMP`
    );
    
    console.log('🔄 Status resetado com sucesso (códigos e nomes mantidos)');
    res.json({ 
      success: true, 
      espelho_data: dataEspelho, 
      espelho_salvo: espelhoSalvo,
      em_loja_registrados: emLojaLinhas.length,
      sem_contato_registrados: semContatoLinhas.length,
      removidos_por_sem_contato: removidos
    });
  } catch (err) {
    console.error('❌ Erro ao resetar:', err);
    res.status(500).json({ error: 'Erro ao resetar status' });
  }
});

// ============================================
// HISTÓRICO DE OBSERVAÇÕES
// ============================================

// GET /api/disponibilidade/observacoes-historico - Listar histórico de observações com filtros
router.get('/disponibilidade/observacoes-historico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_profissional, loja_id, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM disponibilidade_observacoes_historico WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      query += ` AND data_reset >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      query += ` AND data_reset <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    if (cod_profissional) {
      query += ` AND cod_profissional = $${paramIndex}`;
      params.push(cod_profissional);
      paramIndex++;
    }
    
    if (loja_id) {
      query += ` AND loja_id = $${paramIndex}`;
      params.push(loja_id);
      paramIndex++;
    }
    
    query += ` ORDER BY data_reset DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de observações:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico de observações' });
  }
});

// GET /api/disponibilidade/observacoes-historico/datas - Listar datas disponíveis no histórico
router.get('/disponibilidade/observacoes-historico/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_reset, data_planilha, COUNT(*) as total_observacoes
      FROM disponibilidade_observacoes_historico
      GROUP BY data_reset, data_planilha
      ORDER BY data_reset DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar datas do histórico:', err);
    res.status(500).json({ error: 'Erro ao buscar datas do histórico' });
  }
});

// ============================================
// RELATÓRIOS E HISTÓRICO
// ============================================

// GET /api/disponibilidade/relatorios/metricas - Métricas dos últimos 7 espelhos salvos
router.get('/disponibilidade/relatorios/metricas', async (req, res) => {
  try {
    // Buscar os últimos 7 espelhos salvos (independente da data)
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Processar métricas por dia
    const metricas = [];
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      const totalTitulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let percOperacao = 0;
      if (totalTitulares > 0) {
        percOperacao = Math.min((emLoja / totalTitulares) * 100, 100);
      }
      
      metricas.push({
        data: espelho.data_registro,
        totalTitulares,
        emLoja,
        faltando,
        semContato,
        percOperacao: parseFloat(percOperacao.toFixed(1))
      });
    }
    
    res.json(metricas);
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-lojas - Ranking de lojas por % EM LOJA
router.get('/disponibilidade/relatorios/ranking-lojas', async (req, res) => {
  try {
    // Buscar últimos 7 espelhos
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Buscar lojas para ter os nomes
    const lojasResult = await pool.query(`
      SELECT l.*, r.nome as regiao_nome 
      FROM disponibilidade_lojas l
      LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
    `);
    const lojasInfo = {};
    lojasResult.rows.forEach(l => {
      lojasInfo[l.id] = { nome: l.nome, regiao: l.regiao_nome };
    });
    
    // Agrupar dados por loja
    const lojasMap = {};
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      // Agrupar linhas por loja
      const linhasPorLoja = {};
      linhas.forEach(linha => {
        if (!linha.loja_id) return;
        if (!linhasPorLoja[linha.loja_id]) {
          linhasPorLoja[linha.loja_id] = [];
        }
        linhasPorLoja[linha.loja_id].push(linha);
      });
      
      // Calcular métricas por loja neste dia
      Object.entries(linhasPorLoja).forEach(([lojaId, linhasLoja]) => {
        if (!lojasMap[lojaId]) {
          lojasMap[lojaId] = {
            loja_id: lojaId,
            loja_nome: lojasInfo[lojaId]?.nome || 'Desconhecida',
            regiao_nome: lojasInfo[lojaId]?.regiao || '',
            dias: []
          };
        }
        
        const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
        const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
        // % baseado em EM LOJA vs TITULARES, limitado a 100%
        const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
        
        lojasMap[lojaId].dias.push(perc);
      });
    }
    
    // Calcular média por loja
    const ranking = Object.values(lojasMap).map(loja => {
      const mediaPerc = loja.dias.length > 0 
        ? (loja.dias.reduce((a, b) => a + b, 0) / loja.dias.length).toFixed(1)
        : 0;
      return {
        loja_id: loja.loja_id,
        loja_nome: loja.loja_nome,
        regiao_nome: loja.regiao_nome,
        mediaPerc: parseFloat(mediaPerc),
        diasAnalisados: loja.dias.length
      };
    });
    
    // Ordenar por média (melhores primeiro)
    ranking.sort((a, b) => b.mediaPerc - a.mediaPerc);
    
    res.json(ranking);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking lojas:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-faltosos - Ranking de entregadores que mais faltam
router.get('/disponibilidade/relatorios/ranking-faltosos', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltosos do período
    const faltosos = await pool.query(`
      SELECT f.*, l.nome as loja_nome
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      ORDER BY f.data_falta DESC
    `);
    
    // Agrupar por profissional
    const profissionaisMap = {};
    faltosos.rows.forEach(falta => {
      const key = falta.cod_profissional || falta.nome_profissional;
      if (!key) return;
      
      if (!profissionaisMap[key]) {
        profissionaisMap[key] = {
          cod: falta.cod_profissional,
          nome: falta.nome_profissional,
          loja_nome: falta.loja_nome,
          totalFaltas: 0,
          motivos: [],
          ultimaFalta: falta.data_falta
        };
      }
      profissionaisMap[key].totalFaltas++;
      if (falta.motivo && !profissionaisMap[key].motivos.includes(falta.motivo)) {
        profissionaisMap[key].motivos.push(falta.motivo);
      }
    });
    
    // Converter para array e ordenar
    const ranking = Object.values(profissionaisMap);
    ranking.sort((a, b) => b.totalFaltas - a.totalFaltas);
    
    res.json(ranking.slice(0, 20)); // Top 20
  } catch (err) {
    console.error('❌ Erro ao buscar ranking faltosos:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/comparativo - Comparar últimos 3 espelhos salvos
router.get('/disponibilidade/relatorios/comparativo', async (req, res) => {
  try {
    // Buscar os 3 últimos espelhos salvos (ordenados por data_registro DESC)
    const espelhosResult = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 3
    `);
    
    // Função para calcular métricas com lógica correta de %
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const calcularMetricas = (linhas, dataRegistro) => {
      if (!linhas || linhas.length === 0) {
        return null;
      }
      
      const titulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let perc = 0;
      if (titulares > 0) {
        perc = Math.min((emLoja / titulares) * 100, 100);
      }
      
      return { 
        titulares, 
        emLoja,
        faltando, 
        semContato, 
        perc: parseFloat(perc.toFixed(1)),
        data: dataRegistro
      };
    };
    
    // Extrair linhas do espelho (campo dados é JSON)
    const extrairLinhasEspelho = (espelho) => {
      if (!espelho) return [];
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      return dados?.linhas || [];
    };
    
    // Formatar data para exibição
    const formatarData = (data) => {
      if (!data) return '';
      const d = new Date(data);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    };
    
    const espelhos = espelhosResult.rows;
    
    // Mais recente = "HOJE" (ou último salvo)
    // Segundo = "ONTEM" (ou penúltimo salvo)  
    // Terceiro = "ANTERIOR" (ou antepenúltimo salvo)
    const resultado = {
      hoje: espelhos[0] ? calcularMetricas(extrairLinhasEspelho(espelhos[0]), espelhos[0].data_registro) : null,
      ontem: espelhos[1] ? calcularMetricas(extrairLinhasEspelho(espelhos[1]), espelhos[1].data_registro) : null,
      semanaPassada: espelhos[2] ? calcularMetricas(extrairLinhasEspelho(espelhos[2]), espelhos[2].data_registro) : null,
      // Labels dinâmicos baseados nas datas reais
      labels: {
        hoje: espelhos[0] ? formatarData(espelhos[0].data_registro) : 'MAIS RECENTE',
        ontem: espelhos[1] ? formatarData(espelhos[1].data_registro) : 'ANTERIOR',
        semanaPassada: espelhos[2] ? formatarData(espelhos[2].data_registro) : '3º ANTERIOR'
      }
    };
    
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao buscar comparativo:', err);
    res.status(500).json({ error: 'Erro ao buscar comparativo' });
  }
});

// GET /api/disponibilidade/relatorios/heatmap - Heatmap de faltas por dia da semana e loja
router.get('/disponibilidade/relatorios/heatmap', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltas com dia da semana
    const faltas = await pool.query(`
      SELECT 
        f.loja_id,
        l.nome as loja_nome,
        EXTRACT(DOW FROM f.data_falta) as dia_semana,
        COUNT(*) as total_faltas
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      GROUP BY f.loja_id, l.nome, EXTRACT(DOW FROM f.data_falta)
      ORDER BY l.nome, dia_semana
    `);
    
    // Organizar em formato de heatmap
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const lojasMap = {};
    
    faltas.rows.forEach(row => {
      if (!lojasMap[row.loja_id]) {
        lojasMap[row.loja_id] = {
          loja_nome: row.loja_nome,
          dias: [0, 0, 0, 0, 0, 0, 0]
        };
      }
      lojasMap[row.loja_id].dias[parseInt(row.dia_semana)] = parseInt(row.total_faltas);
    });
    
    res.json({
      diasSemana,
      lojas: Object.values(lojasMap)
    });
  } catch (err) {
    console.error('❌ Erro ao buscar heatmap:', err);
    res.status(500).json({ error: 'Erro ao buscar heatmap' });
  }
});

// ============================================
// LINK PÚBLICO (SOMENTE LEITURA)
// ============================================

// GET /api/disponibilidade/publico - Retorna página HTML com panorama somente leitura
router.get('/disponibilidade/publico', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas');
    
    // Calcular dados de cada loja
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const lojasComDados = lojas.rows.map(loja => {
      const linhasLoja = linhas.rows.filter(l => l.loja_id === loja.id);
      const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const aCaminho = linhasLoja.filter(l => l.status === 'A CAMINHO').length;
      const confirmado = linhasLoja.filter(l => l.status === 'CONFIRMADO').length;
      const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
      const semContato = linhasLoja.filter(l => l.status === 'SEM CONTATO').length;
      const emOperacao = aCaminho + confirmado + emLoja;
      const falta = Math.max(0, titulares - emOperacao);
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
      const regiao = regioes.rows.find(r => r.id === loja.regiao_id);
      return { ...loja, titulares, aCaminho, confirmado, emLoja, semContato, emOperacao, falta, perc, regiao };
    });
    
    // Totais
    let totalGeral = { aCaminho: 0, confirmado: 0, emLoja: 0, titulares: 0, falta: 0, semContato: 0, emOperacao: 0 };
    lojasComDados.forEach(l => {
      totalGeral.aCaminho += l.aCaminho;
      totalGeral.confirmado += l.confirmado;
      totalGeral.emLoja += l.emLoja;
      totalGeral.titulares += l.titulares;
      totalGeral.falta += l.falta;
      totalGeral.semContato += l.semContato;
      totalGeral.emOperacao += l.emOperacao;
    });
    // % geral baseado em EM LOJA vs TITULARES, limitado a 100%
    const percGeral = totalGeral.titulares > 0 ? Math.min((totalGeral.emLoja / totalGeral.titulares) * 100, 100) : 0;
    
    // Gerar HTML - Design Clean
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panorama - Disponibilidade</title>
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 12px; }
    .header { background: white; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { font-size: 15px; color: #1e293b; font-weight: 600; }
    .header .info { font-size: 11px; color: #64748b; margin-top: 4px; }
    .badge { padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-yellow { background: #fef3c7; color: #a16207; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #f8fafc; color: #475569; padding: 8px 6px; text-align: center; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    th.lojas { text-align: left; }
    td { padding: 4px 6px; border: 1px solid #e2e8f0; text-align: center; }
    td.loja { text-align: left; background: #fafafa; font-weight: 500; }
    tr.regiao td { background: #e2e8f0; font-weight: 700; text-align: center; color: #1e293b; }
    tr.total td { background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1; }
    tr.critico { background: #fef2f2; }
    tr.critico td.loja { background: #fef2f2; }
    .num-zero { color: #cbd5e1; }
    .num-acaminho { color: #ea580c; }
    .num-confirmado { color: #16a34a; }
    .num-emloja { color: #2563eb; font-weight: 700; }
    .num-ideal { color: #64748b; }
    .num-falta { color: #dc2626; font-weight: 600; }
    .num-semcontato { color: #d97706; }
    .perc { font-weight: 700; }
    .perc-ok { background: #bbf7d0; color: #15803d; }
    .perc-warn { background: #fde68a; color: #a16207; }
    .perc-danger { background: #fecaca; color: #b91c1c; }
    .perc-neutral { background: #f1f5f9; color: #475569; }
    .footer { margin-top: 12px; text-align: center; font-size: 10px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📊 PANORAMA DIÁRIO OPERACIONAL</h1>
      <div class="info">Atualizado: ${new Date().toLocaleString('pt-BR')} | Auto-refresh: 2min</div>
    </div>
    <div>
      <span class="badge ${percGeral >= 100 ? 'badge-green' : percGeral >= 80 ? 'badge-yellow' : 'badge-red'}">
        ${percGeral.toFixed(0)}% GERAL
      </span>
      ${totalGeral.falta > 0 ? `<span class="badge badge-red" style="margin-left:5px">⚠️ FALTAM ${totalGeral.falta}</span>` : ''}
    </div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th class="lojas">LOJAS</th>
        <th>A CAMINHO</th>
        <th>CONFIR.</th>
        <th>EM LOJA</th>
        <th>IDEAL</th>
        <th>FALTA</th>
        <th>S/ CONTATO</th>
        <th>%</th>
      </tr>
    </thead>
    <tbody>`;
    
    // Renderizar por região
    regioes.rows.forEach(regiao => {
      const lojasReg = lojasComDados.filter(l => l.regiao_id === regiao.id);
      if (lojasReg.length === 0) return;
      
      // Header região
      html += `<tr class="regiao"><td colspan="8">${regiao.nome}${regiao.gestores ? ` (${regiao.gestores})` : ''}</td></tr>`;
      
      // Lojas
      lojasReg.forEach(loja => {
        const critico = loja.perc < 50 ? 'critico' : '';
        const percClass = loja.perc >= 100 ? 'perc-ok' : loja.perc >= 80 ? 'perc-neutral' : loja.perc >= 50 ? 'perc-warn' : 'perc-danger';
        html += `<tr class="${critico}">
          <td class="loja">${loja.perc < 50 ? '🔴 ' : ''}${loja.nome}</td>
          <td class="${loja.aCaminho > 0 ? 'num-acaminho' : 'num-zero'}">${loja.aCaminho}</td>
          <td class="${loja.confirmado > 0 ? 'num-confirmado' : 'num-zero'}">${loja.confirmado}</td>
          <td class="${loja.emLoja > 0 ? 'num-emloja' : 'num-zero'}">${loja.emLoja}</td>
          <td class="num-ideal">${loja.titulares}</td>
          <td class="${loja.falta > 0 ? 'num-falta' : 'num-zero'}">${loja.falta > 0 ? -loja.falta : 0}</td>
          <td class="${loja.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${loja.semContato}</td>
          <td class="perc ${percClass}">${loja.perc.toFixed(0)}%</td>
        </tr>`;
      });
    });
    
    // Total geral
    const totalPercClass = percGeral >= 100 ? 'perc-ok' : percGeral >= 80 ? 'perc-neutral' : percGeral >= 50 ? 'perc-warn' : 'perc-danger';
    html += `<tr class="total">
      <td style="text-align:left;color:#1e293b">TOTAL GERAL</td>
      <td class="num-acaminho">${totalGeral.aCaminho}</td>
      <td class="num-confirmado">${totalGeral.confirmado}</td>
      <td class="num-emloja">${totalGeral.emLoja}</td>
      <td class="num-ideal">${totalGeral.titulares}</td>
      <td class="${totalGeral.falta > 0 ? 'num-falta' : 'num-zero'}">${totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
      <td class="${totalGeral.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${totalGeral.semContato}</td>
      <td class="perc ${totalPercClass}" style="font-weight:800">${percGeral.toFixed(0)}%</td>
    </tr>`;
    
    html += `</tbody></table>
  <div class="footer">
    Esta página atualiza automaticamente a cada 2 minutos | Sistema Tutts
  </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('❌ Erro ao gerar página pública:', err);
    res.status(500).send('Erro ao gerar página');
  }
});

  return router;

  return router;
}

module.exports = { createRelatoriosRoutes };
