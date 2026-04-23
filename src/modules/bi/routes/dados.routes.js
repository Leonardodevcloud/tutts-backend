/**
 * BI Sub-Router: Dados de Referência e Filtros
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createDadosRoutes(pool) {
  const router = express.Router();

router.get('/bi/cidades', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cidade, COUNT(*) as total
      FROM bi_entregas
      WHERE cidade IS NOT NULL AND cidade != ''
      GROUP BY cidade
      ORDER BY total DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar cidades:', err);
    res.json([]);
  }
});

// Relação Cliente -> Centros de Custo
router.get('/bi/cliente-centros', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cod_cliente, centro_custo
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, centro_custo
    `);
    // Agrupa por cliente
    const mapa = {};
    result.rows.forEach(r => {
      const cod = String(r.cod_cliente);
      if (!mapa[cod]) mapa[cod] = [];
      mapa[cod].push(r.centro_custo);
    });
    res.json(mapa);
  } catch (err) {
    console.error('❌ Erro ao listar cliente-centros:', err);
    res.json({});
  }
});

// ===== MÁSCARAS DE CLIENTES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_mascaras (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    mascara VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_mascaras já existe ou erro:', err.message));

// Listar máscaras
router.get('/bi/mascaras', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_mascaras ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar máscaras:', err);
    res.json([]);
  }
});

// Criar/Atualizar máscara
router.post('/bi/mascaras', async (req, res) => {
  try {
    const { cod_cliente, mascara } = req.body;
    if (!cod_cliente || !mascara) {
      return res.status(400).json({ error: 'cod_cliente e mascara são obrigatórios' });
    }
    
    // Upsert - atualiza se existir, insere se não
    const result = await pool.query(`
      INSERT INTO bi_mascaras (cod_cliente, mascara) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO UPDATE SET mascara = $2
      RETURNING *
    `, [cod_cliente, mascara]);
    
    res.json({ success: true, mascara: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar máscara:', err);
    res.status(500).json({ error: 'Erro ao salvar máscara' });
  }
});

// Excluir máscara
router.delete('/bi/mascaras/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_mascaras WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir máscara:', err);
    res.status(500).json({ error: 'Erro ao excluir máscara' });
  }
});

// ===== LOCALIZAÇÃO DE CLIENTES (Ponto 1) =====
// Endpoint para listar clientes com seus endereços de coleta (Ponto 1) e coordenadas
router.get('/bi/localizacao-clientes', async (req, res) => {
  try {
    // Clientes que devem ter endereços separados por centro de custo
    const clientesSeparadosPorCC = ['767', '1046', '713'];
    
    // Query para clientes NORMAIS - retorna apenas o endereço com mais entregas
    const resultNormal = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text NOT IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente
      cliente_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente)
          cod_cliente,
          nome_cliente,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        NULL as centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', NULL
          )
        ) as enderecos
      FROM cliente_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Query para clientes ESPECIAIS (767, 1046, 713) - separados por centro de custo, 1 endereço por CC
    const resultEspecial = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          centro_custo,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, centro_custo, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente + centro de custo
      cliente_cc_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente, centro_custo)
          cod_cliente,
          nome_cliente,
          centro_custo,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, centro_custo, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        ce.centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', ce.centro_custo
          )
        ) as enderecos
      FROM cliente_cc_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Combina os resultados e ordena
    const todosClientes = [...resultNormal.rows, ...resultEspecial.rows]
      .sort((a, b) => parseInt(a.cod_cliente) - parseInt(b.cod_cliente));
    
    res.json(todosClientes);
  } catch (err) {
    console.error('❌ Erro ao buscar localização clientes:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});


// ===== REGRAS DE CONTAGEM DE ENTREGAS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regras_contagem (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    nome_cliente VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regras_contagem já existe ou erro:', err.message));

// Listar regras de contagem
router.get('/bi/regras-contagem', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regras_contagem ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regras de contagem:', err);
    res.json([]);
  }
});

// Criar regra de contagem
router.post('/bi/regras-contagem', async (req, res) => {
  try {
    const { cod_cliente, nome_cliente } = req.body;
    if (!cod_cliente) {
      return res.status(400).json({ error: 'cod_cliente é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regras_contagem (cod_cliente, nome_cliente) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO NOTHING
      RETURNING *
    `, [cod_cliente, nome_cliente || null]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Cliente já possui regra de contagem' });
    }
    
    res.json({ success: true, regra: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar regra de contagem:', err);
    res.status(500).json({ error: 'Erro ao salvar regra' });
  }
});

// Excluir regra de contagem
router.delete('/bi/regras-contagem/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regras_contagem WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir regra:', err);
    res.status(500).json({ error: 'Erro ao excluir regra' });
  }
});

// Resumo por Cliente (tabela detalhada)
router.get('/bi/resumo-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_cliente,
        nome_cliente,
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_prof,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento
      FROM bi_entregas ${where}
      GROUP BY cod_cliente, nome_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo clientes:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por cliente' });
  }
});

// Resumo por Profissional (tabela detalhada)
router.get('/bi/resumo-profissionais', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_entrega,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_total,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo profissionais:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por profissional' });
  }
});

// Análise por OS (detalhamento)
router.get('/bi/analise-os', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, os } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (os) { where += ` AND os = $${paramIndex++}`; params.push(os); }
    
    const result = await pool.query(`
      SELECT 
        os, nome_prof, endereco, cidade, 
        data_solicitado, hora_solicitado,
        hora_chegada, hora_saida,
        tempo_execucao_minutos, distancia, 
        dentro_prazo, prazo_minutos,
        finalizado, status, ocorrencia, categoria
      FROM bi_entregas ${where}
      ORDER BY data_solicitado DESC, os DESC
      LIMIT 500
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro análise OS:', err);
    res.status(500).json({ error: 'Erro ao carregar análise por OS' });
  }
});

// Gráficos - Faixas de tempo e KM
router.get('/bi/graficos', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    // Faixas de tempo
    const faixasTempo = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE tempo_execucao_minutos IS NULL) as nao_atribuida,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 45) as ate_45,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 45 AND tempo_execucao_minutos <= 60) as ate_60,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 60 AND tempo_execucao_minutos <= 75) as ate_75,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 75 AND tempo_execucao_minutos <= 90) as ate_90,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 90 AND tempo_execucao_minutos <= 120) as ate_120,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 120) as mais_120
      FROM bi_entregas ${where}
    `, params);
    
    // Faixas de KM
    const faixasKm = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE distancia > 100) as mais_100,
        COUNT(*) FILTER (WHERE distancia >= 0 AND distancia <= 10) as km_0_10,
        COUNT(*) FILTER (WHERE distancia > 10 AND distancia <= 15) as km_11_15,
        COUNT(*) FILTER (WHERE distancia > 15 AND distancia <= 20) as km_16_20,
        COUNT(*) FILTER (WHERE distancia > 20 AND distancia <= 25) as km_21_25,
        COUNT(*) FILTER (WHERE distancia > 25 AND distancia <= 30) as km_26_30,
        COUNT(*) FILTER (WHERE distancia > 30 AND distancia <= 35) as km_31_35,
        COUNT(*) FILTER (WHERE distancia > 35 AND distancia <= 40) as km_36_40,
        COUNT(*) FILTER (WHERE distancia > 40 AND distancia <= 50) as km_41_50,
        COUNT(*) FILTER (WHERE distancia > 50 AND distancia <= 60) as km_51_60,
        COUNT(*) FILTER (WHERE distancia > 60 AND distancia <= 70) as km_61_70,
        COUNT(*) FILTER (WHERE distancia > 70 AND distancia <= 80) as km_71_80,
        COUNT(*) FILTER (WHERE distancia > 80 AND distancia <= 90) as km_81_90,
        COUNT(*) FILTER (WHERE distancia > 90 AND distancia <= 100) as km_91_100
      FROM bi_entregas ${where}
    `, params);
    
    res.json({
      faixasTempo: faixasTempo.rows[0] || {},
      faixasKm: faixasKm.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ Erro gráficos:', err);
    res.status(500).json({ error: 'Erro ao carregar gráficos' });
  }
});

// Listar clientes únicos (para dropdown)
router.get('/bi/clientes', async (req, res) => {
  try {
    // Deduplica por cod_cliente pegando o nome_cliente do registro MAIS RECENTE.
    // Antes: SELECT DISTINCT cod_cliente, nome_cliente retornava duplicatas quando
    // o mesmo código aparece com nomes diferentes (cadastro mudou ao longo do tempo).
    // Agora: DISTINCT ON pega um único registro por cliente, ordenado por data desc.
    const result = await pool.query(`
      SELECT cod_cliente, nome_cliente FROM (
        SELECT DISTINCT ON (cod_cliente)
          cod_cliente,
          nome_cliente
        FROM bi_entregas
        WHERE cod_cliente IS NOT NULL
        ORDER BY cod_cliente, data_hora DESC NULLS LAST
      ) c
      ORDER BY nome_cliente
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Listar clientes por região com máscaras (para promoções novatos)
router.get('/bi/clientes-por-regiao', async (req, res) => {
  try {
    // Buscar máscaras
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Buscar clientes agrupados por cod_cliente (evita duplicatas por centro de custo)
    const result = await pool.query(`
      SELECT 
        cod_cliente,
        MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text)) as nome_cliente,
        COUNT(*) as total_entregas
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL
      GROUP BY cod_cliente
      ORDER BY MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text))
    `);
    
    // Adicionar máscaras aos resultados
    const clientesComMascara = result.rows.map(c => ({
      cod_cliente: c.cod_cliente,
      nome_original: c.nome_cliente,
      mascara: mascaras[String(c.cod_cliente)] || null,
      nome_display: mascaras[String(c.cod_cliente)] || c.nome_cliente,
      total_entregas: parseInt(c.total_entregas)
    }));
    
    console.log(`📋 Clientes carregados: ${clientesComMascara.length}`);
    res.json(clientesComMascara);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Listar centros de custo únicos (para dropdown)
router.get('/bi/centros-custo', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros:', err);
    res.status(500).json({ error: 'Erro ao listar centros' });
  }
});

// Listar centros de custo de um cliente específico
router.get('/bi/centros-custo/:cod_cliente', async (req, res) => {
  try {
    const { cod_cliente } = req.params;
    const result = await pool.query(`
      SELECT DISTINCT centro_custo, COUNT(*) as total_entregas
      FROM bi_entregas 
      WHERE cod_cliente = $1 AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY centro_custo
      ORDER BY centro_custo
    `, [cod_cliente]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros do cliente:', err);
    res.status(500).json({ error: 'Erro ao listar centros do cliente' });
  }
});

// Listar profissionais únicos (para dropdown)
router.get('/bi/profissionais', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_prof, nome_prof 
      FROM bi_entregas 
      WHERE cod_prof IS NOT NULL
      ORDER BY nome_prof
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar profissionais' });
  }
});

// Listar datas disponíveis (apenas datas com dados)
router.get('/bi/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_solicitado as data, COUNT(*) as total
      FROM bi_entregas 
      WHERE data_solicitado IS NOT NULL
      GROUP BY data_solicitado
      ORDER BY data_solicitado DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar datas:', err);
    res.status(500).json({ error: 'Erro ao listar datas' });
  }
});

// Listar uploads realizados
// Listar histórico de uploads

// ============================================
// ENDPOINT COMBINADO: Todos os filtros em 1 request
// Substitui 11 fetches separados por 1 único com queries paralelas
// ============================================
router.get('/bi/filtros-iniciais', async (req, res) => {
  try {
    const t0 = Date.now();
    
    // Executar TODAS as queries em paralelo (1 round-trip)
    const [
      clientesR, centrosCustoR, profissionaisR, datasR, uploadsR,
      cidadesR, clienteCentrosR, categoriasR, regioesR, dadosFiltroR, mascarasR
    ] = await Promise.all([
      pool.query(`SELECT DISTINCT cod_cliente, nome_cliente FROM bi_entregas WHERE cod_cliente IS NOT NULL ORDER BY nome_cliente`),
      pool.query(`SELECT DISTINCT centro_custo FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`),
      pool.query(`SELECT DISTINCT cod_prof, nome_prof FROM bi_entregas WHERE cod_prof IS NOT NULL ORDER BY nome_prof`),
      pool.query(`SELECT DISTINCT data_solicitado as data, COUNT(*) as total FROM bi_entregas WHERE data_solicitado IS NOT NULL GROUP BY data_solicitado ORDER BY data_solicitado DESC`),
      pool.query(`SELECT id, usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, os_novas, os_ignoradas, data_upload FROM bi_upload_historico ORDER BY data_upload DESC LIMIT 50`).catch(() => ({ rows: [] })),
      pool.query(`SELECT DISTINCT cidade, COUNT(*) as total FROM bi_entregas WHERE cidade IS NOT NULL AND cidade != '' GROUP BY cidade ORDER BY total DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT cod_cliente, centro_custo FROM bi_entregas WHERE cod_cliente IS NOT NULL AND centro_custo IS NOT NULL AND centro_custo != '' GROUP BY cod_cliente, centro_custo ORDER BY cod_cliente, centro_custo`),
      pool.query(`SELECT DISTINCT categoria FROM bi_entregas WHERE categoria IS NOT NULL AND categoria != '' ORDER BY categoria`).catch(() => ({ rows: [] })),
      pool.query(`SELECT * FROM bi_regioes ORDER BY nome`).catch(() => ({ rows: [] })),
      pool.query(`SELECT DISTINCT cod_cliente, centro_custo, categoria FROM bi_entregas WHERE cod_cliente IS NOT NULL`).catch(() => ({ rows: [] })),
      pool.query(`SELECT * FROM bi_mascaras ORDER BY cod_cliente`).catch(() => ({ rows: [] }))
    ]);
    
    // Montar mapa cliente-centros
    const clienteCentrosMapa = {};
    clienteCentrosR.rows.forEach(r => {
      const cod = String(r.cod_cliente);
      if (!clienteCentrosMapa[cod]) clienteCentrosMapa[cod] = [];
      clienteCentrosMapa[cod].push(r.centro_custo);
    });
    
    const elapsed = Date.now() - t0;
    console.log(`📊 /bi/filtros-iniciais: ${elapsed}ms (11 queries paralelas)`);
    
    res.json({
      clientes: (clientesR.rows || []).sort((a, b) => (parseInt(a.cod_cliente) || 0) - (parseInt(b.cod_cliente) || 0)),
      centros_custo: centrosCustoR.rows || [],
      profissionais: profissionaisR.rows || [],
      datas: datasR.rows || [],
      uploads: uploadsR.rows || [],
      cidades: cidadesR.rows || [],
      cliente_centros: clienteCentrosMapa,
      categorias: (categoriasR.rows || []).map(r => r.categoria),
      regioes: regioesR.rows || [],
      dados_filtro: dadosFiltroR.rows || [],
      mascaras: mascarasR.rows || []
    });
  } catch (err) {
    console.error('❌ Erro em /bi/filtros-iniciais:', err);
    res.status(500).json({ error: 'Erro ao carregar filtros' });
  }
});

  return router;
}

module.exports = { createDadosRoutes };
