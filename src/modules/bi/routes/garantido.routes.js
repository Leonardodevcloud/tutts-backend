/**
 * BI Sub-Router: Análise de Mínimo Garantido
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createGarantidoRoutes(pool) {
  const router = express.Router();

router.get('/bi/garantido', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, cod_prof, filtro_status } = req.query;
    
    console.log('📊 Garantido - Filtros recebidos:', { data_inicio, data_fim, cod_cliente, cod_prof, filtro_status });
    
    // 1. Buscar dados da planilha de garantido
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente (lida com campos entre aspas)
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) {
            lines.push(currentLine.replace(/\r/g, ''));
          }
          currentLine = '';
          // Pular \r\n como uma única quebra
          if (char === '\r' && text[i + 1] === '\n') {
            i++;
          }
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) {
        lines.push(currentLine.replace(/\r/g, ''));
      }
      
      return lines;
    };
    
    // Parsear CSV corretamente (lidar com campos multiline)
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1); // pular header
    
    console.log(`📊 Garantido: ${sheetLines.length} linhas na planilha (sem header)`);
    
    // Parsear dados da planilha
    const garantidoPlanilha = [];
    const chavesProcessadas = new Set();
    let valorTotalNaoRodouPlanilha = 0; // Para o card - soma dos status "Não rodou" da planilha
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      
      const cols = parseCSVLine(line);
      const codClientePlan = cols[0];
      const dataStr = cols[1];
      const profissional = cols[2] || '(Vazio)';
      const codProfPlan = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      const statusPlanilha = (cols[5] || '').trim().toLowerCase();
      
      // Aceitar linhas mesmo sem cod_prof (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      // Converter data DD/MM/YYYY para YYYY-MM-DD
      let dataFormatada = null;
      if (dataStr && dataStr.includes('/')) {
        const partes = dataStr.split('/');
        if (partes.length === 3) {
          dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
      }
      
      if (!dataFormatada) continue;
      
      // Aplicar filtros de data
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Verificar se é "Não rodou" para somar no card separado
      const isNaoRodou = statusPlanilha.includes('rodou') && (statusPlanilha.includes('não') || statusPlanilha.includes('nao'));
      if (isNaoRodou) {
        valorTotalNaoRodouPlanilha += valorNegociado;
      }
      
      // Chave única: cod_prof + data + cod_cliente (ou profissional se cod_prof vazio)
      const chaveUnica = `${codProfPlan || profissional}_${dataFormatada}_${codClientePlan}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      garantidoPlanilha.push({
        cod_cliente: codClientePlan,
        data: dataFormatada,
        profissional: profissional,
        cod_prof: codProfPlan,
        valor_negociado: valorNegociado
      });
    }
    
    console.log(`📊 Garantido: ${garantidoPlanilha.length} registros únicos na planilha`);
    if (garantidoPlanilha.length > 0) {
      console.log(`📊 Exemplo primeiro registro:`, garantidoPlanilha[0]);
    }
    
    // 2. Buscar nome do cliente da planilha (onde tem garantido)
    const clientesGarantido = {};
    try {
      const clientesResult = await pool.query(`
        SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
        FROM bi_entregas 
        WHERE cod_cliente IS NOT NULL
      `);
      clientesResult.rows.forEach(c => {
        clientesGarantido[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
      });
    } catch (e) {
      console.log('Erro ao buscar nomes de clientes:', e.message);
    }
    
    // 2.1 Buscar máscaras configuradas
    const mascaras = {};
    try {
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
      mascarasResult.rows.forEach(m => {
        mascaras[String(m.cod_cliente)] = m.mascara;
      });
    } catch (e) {
      console.log('Erro ao buscar máscaras:', e.message);
    }
    
    // 3. Para cada registro da planilha, buscar TODA produção do profissional no dia
    const resultados = [];
    
    for (const g of garantidoPlanilha) {
      // Aplicar filtros
      if (data_inicio && g.data < data_inicio) continue;
      if (data_fim && g.data > data_fim) continue;
      if (cod_cliente && g.cod_cliente !== cod_cliente) continue;
      if (cod_prof && g.cod_prof !== cod_prof) continue;
      
      // Buscar TODA produção do profissional nessa data (soma de TODOS os clientes/centros)
      // IMPORTANTE: valor_prof é por OS, não por ponto. Cada OS tem várias linhas com o mesmo valor_prof.
      // Precisamos somar apenas uma vez por OS (usar MAX para pegar o valor da OS).
      
      let prod = { total_os: 0, total_entregas: 0, distancia_total: 0, valor_produzido: 0, tempo_medio_entrega: null, locais_rodou: null, cod_cliente_rodou: null, centro_custo_rodou: null };
      
      // Se tem cod_prof, buscar produção
      if (g.cod_prof) {
        const codProfNum = parseInt(g.cod_prof);
        
        const producaoResult = await pool.query(`
        WITH os_dados AS (
          SELECT 
            os,
            MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
            MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END) as distancia_os,
            MAX(cod_cliente) as cod_cliente_os,
            MAX(centro_custo) as centro_custo_os,
            COUNT(*) FILTER (WHERE COALESCE(ponto, 1) >= 2) as entregas_os,
            AVG(CASE 
              WHEN COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL AND data_hora IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 
            END) as tempo_os
          FROM bi_entregas
          WHERE cod_prof = $1 AND data_solicitado::date = $2::date
          GROUP BY os
        )
        SELECT 
          COUNT(os) as total_os,
          COALESCE(SUM(entregas_os), 0) as total_entregas,
          COALESCE(SUM(distancia_os), 0) as distancia_total,
          COALESCE(SUM(valor_os), 0) as valor_produzido,
          AVG(tempo_os) as tempo_medio_entrega,
          STRING_AGG(DISTINCT cod_cliente_os::text, ', ') as cod_clientes_rodou,
          STRING_AGG(DISTINCT centro_custo_os, ', ') as centros_custo_rodou
        FROM os_dados
      `, [codProfNum, g.data]);
        
        prod = producaoResult.rows[0] || prod;
      }
      // Se não tem cod_prof, prod fica zerado (linha vazia/não rodou)
      
      const valorProduzido = parseFloat(prod?.valor_produzido) || 0;
      const totalEntregas = parseInt(prod?.total_entregas) || 0;
      const distanciaTotal = parseFloat(prod?.distancia_total) || 0;
      
      // Calcular complemento
      const complemento = Math.max(0, g.valor_negociado - valorProduzido);
      
      // Determinar status
      let status;
      if (totalEntregas === 0) {
        status = 'nao_rodou';
      } else if (valorProduzido < g.valor_negociado) {
        status = 'abaixo';
      } else {
        status = 'acima';
      }
      
      // Aplicar filtro de status
      if (filtro_status === 'nao_rodou' && status !== 'nao_rodou') continue;
      if (filtro_status === 'abaixo' && status !== 'abaixo') continue;
      if (filtro_status === 'acima' && status !== 'acima') continue;
      if (filtro_status === 'rodou' && status === 'nao_rodou') continue;
      
      // Formatar tempo de entrega
      let tempoEntregaFormatado = null;
      if (prod?.tempo_medio_entrega) {
        const minutos = Math.round(prod.tempo_medio_entrega);
        const horas = Math.floor(minutos / 60);
        const mins = minutos % 60;
        const segs = 0;
        tempoEntregaFormatado = `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(segs).padStart(2, '0')}`;
      }
      
      // "Onde Rodou" - Formato: cod_cliente + nome (com máscara) + centro de custo
      // Exceção: cliente 949 não mostra centro de custo
      let ondeRodou = '- NÃO RODOU';
      if (totalEntregas > 0 && prod?.cod_clientes_rodou) {
        const codClienteRodou = prod.cod_clientes_rodou.split(',')[0]?.trim(); // Pega o primeiro se houver vários
        const centroCusto = prod.centros_custo_rodou?.split(',')[0]?.trim() || '';
        
        // Buscar nome do cliente (máscara tem prioridade)
        const nomeCliente = mascaras[codClienteRodou] || clientesGarantido[codClienteRodou] || `Cliente ${codClienteRodou}`;
        
        // Cliente 949: apenas cod + nome
        // Outros clientes: cod + nome + centro de custo
        if (codClienteRodou === '949') {
          ondeRodou = `${codClienteRodou} - ${nomeCliente}`;
        } else {
          ondeRodou = centroCusto 
            ? `${codClienteRodou} - ${nomeCliente} / ${centroCusto}`
            : `${codClienteRodou} - ${nomeCliente}`;
        }
      }
      
      resultados.push({
        data: g.data,
        cod_prof: g.cod_prof,
        profissional: g.profissional,
        cod_cliente_garantido: g.cod_cliente,
        onde_rodou: ondeRodou,
        entregas: totalEntregas,
        tempo_entrega: tempoEntregaFormatado,
        distancia: distanciaTotal,
        valor_negociado: g.valor_negociado,
        valor_produzido: valorProduzido,
        complemento: complemento,
        status: status
      });
    }
    
    console.log(`📊 Garantido: ${resultados.length} resultados após filtros`);
    
    // Ordenar por data desc, depois por profissional
    resultados.sort((a, b) => {
      if (b.data !== a.data) return b.data.localeCompare(a.data);
      return a.profissional.localeCompare(b.profissional);
    });
    
    // Calcular totais
    const totais = {
      total_registros: resultados.length,
      total_entregas: resultados.reduce((sum, r) => sum + r.entregas, 0),
      total_negociado: resultados.reduce((sum, r) => sum + r.valor_negociado, 0),
      total_produzido: resultados.reduce((sum, r) => sum + r.valor_produzido, 0),
      total_complemento: resultados.reduce((sum, r) => sum + r.complemento, 0),
      total_distancia: resultados.reduce((sum, r) => sum + r.distancia, 0),
      qtd_abaixo: resultados.filter(r => r.status === 'abaixo').length,
      qtd_acima: resultados.filter(r => r.status === 'acima').length,
      qtd_nao_rodou: resultados.filter(r => r.status === 'nao_rodou').length,
      qtd_rodou: resultados.filter(r => r.status !== 'nao_rodou').length,
      // Valor total dos profissionais com status "Não rodou" NA PLANILHA
      valor_nao_rodou: valorTotalNaoRodouPlanilha
    };
    
    // Calcular tempo médio geral (formatado)
    const temposValidos = resultados.filter(r => r.tempo_entrega).map(r => {
      const [h, m, s] = r.tempo_entrega.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    });
    let tempoMedioGeral = null;
    if (temposValidos.length > 0) {
      const mediaSegs = temposValidos.reduce((a, b) => a + b, 0) / temposValidos.length;
      const h = Math.floor(mediaSegs / 3600);
      const m = Math.floor((mediaSegs % 3600) / 60);
      const s = Math.floor(mediaSegs % 60);
      tempoMedioGeral = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    totais.tempo_medio_geral = tempoMedioGeral;
    
    res.json({ dados: resultados, totais });
  } catch (error) {
    console.error('Erro ao buscar dados garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar dados de garantido'})   ;
  }
});

// GET /api/bi/garantido/semanal - Análise semanal por cliente do garantido
router.get('/bi/garantido/semanal', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    // Buscar dados da planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else { current += char; }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
          currentLine = '';
          if (char === '\r' && text[i + 1] === '\n') i++;
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
      return lines;
    };
    
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1);
    
    // Buscar nomes de clientes
    const clientesResult = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
      FROM bi_entregas WHERE cod_cliente IS NOT NULL
    `);
    const clientesNomes = {};
    clientesResult.rows.forEach(c => {
      clientesNomes[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
    });
    
    // Buscar máscaras configuradas
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Agrupar por cliente do garantido + semana
    const porClienteSemana = {};
    const chavesProcessadas = new Set();
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const codCliente = cols[0];
      const dataStr = cols[1];
      const codProf = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      
      // Aceitar linhas mesmo sem codProf (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      const partes = dataStr.split('/');
      if (partes.length !== 3) continue;
      const dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
      
      // Verificar duplicata
      const chaveUnica = `${codProf || cols[2] || 'vazio'}_${dataFormatada}_${codCliente}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Calcular início e fim da semana (segunda a domingo)
      const dataObj = new Date(dataFormatada + 'T12:00:00');
      const diaSemana = dataObj.getDay(); // 0 = domingo, 1 = segunda...
      
      // Calcular segunda-feira da semana
      const inicioSemana = new Date(dataObj);
      const offsetSegunda = diaSemana === 0 ? -6 : 1 - diaSemana; // Se domingo, volta 6 dias
      inicioSemana.setDate(dataObj.getDate() + offsetSegunda);
      
      // Calcular domingo da semana
      const fimSemana = new Date(inicioSemana);
      fimSemana.setDate(inicioSemana.getDate() + 6);
      
      // Formato da chave: "01 a 07/11"
      const diaInicio = inicioSemana.getDate().toString().padStart(2, '0');
      const diaFim = fimSemana.getDate().toString().padStart(2, '0');
      const mesFim = (fimSemana.getMonth() + 1).toString().padStart(2, '0');
      const semanaKey = `${diaInicio} a ${diaFim}/${mesFim}`;
      const semanaSort = inicioSemana.toISOString().split('T')[0]; // Para ordenação
      
      // Buscar produção TOTAL do profissional no dia
      // E também o centro de custo onde rodou (para cliente 767)
      let valorProduzido = 0;
      let centroCusto = null;
      
      if (codProf) {
        const producaoResult = await pool.query(`
          SELECT 
            COALESCE(SUM(valor_os), 0) as valor_produzido,
            MAX(centro_custo) as centro_custo
          FROM (
            SELECT 
              os, 
              MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
              MAX(centro_custo) as centro_custo
            FROM bi_entregas
            WHERE cod_prof = $1 AND data_solicitado::date = $2::date
            GROUP BY os
          ) os_dados
        `, [parseInt(codProf), dataFormatada]);
        valorProduzido = parseFloat(producaoResult.rows[0]?.valor_produzido) || 0;
        centroCusto = producaoResult.rows[0]?.centro_custo;
      }
      
      const complemento = Math.max(0, valorNegociado - valorProduzido);
      
      // Determinar a chave de agrupamento
      // Cliente 949: agrupa apenas pelo cliente (exceção)
      // Todos os outros: cod_cliente - nome_cliente (ou máscara) - centro_custo
      let clienteKey;
      const nomeCliente = mascaras[codCliente] || clientesNomes[codCliente] || `Cliente ${codCliente}`;
      
      if (codCliente === '949') {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      } else if (centroCusto) {
        clienteKey = `${codCliente} - ${nomeCliente} - ${centroCusto}`;
      } else {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      }
      
      if (!porClienteSemana[clienteKey]) {
        porClienteSemana[clienteKey] = {};
      }
      if (!porClienteSemana[clienteKey][semanaKey]) {
        porClienteSemana[clienteKey][semanaKey] = { negociado: 0, produzido: 0, complemento: 0, sort: semanaSort };
      }
      
      porClienteSemana[clienteKey][semanaKey].negociado += valorNegociado;
      porClienteSemana[clienteKey][semanaKey].produzido += valorProduzido;
      porClienteSemana[clienteKey][semanaKey].complemento += complemento;
    }
    
    // Formatar resultado - normalizar semanas para todos os clientes terem as mesmas
    const todasSemanas = new Map(); // Map para guardar semanaKey -> sort
    Object.values(porClienteSemana).forEach(semanas => {
      Object.entries(semanas).forEach(([semanaKey, dados]) => {
        if (!todasSemanas.has(semanaKey)) {
          todasSemanas.set(semanaKey, dados.sort);
        }
      });
    });
    
    // Ordenar semanas por data
    const semanasOrdenadas = Array.from(todasSemanas.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([key]) => key);
    
    // Formatar resultado garantindo que todos tenham todas as semanas
    const resultado = Object.entries(porClienteSemana).map(([cliente, semanas]) => ({
      onde_rodou: cliente,
      semanas: semanasOrdenadas.map(semanaKey => ({
        semana: semanaKey,
        negociado: semanas[semanaKey]?.negociado || 0,
        produzido: semanas[semanaKey]?.produzido || 0,
        complemento: semanas[semanaKey]?.complemento || 0
      }))
    })).sort((a, b) => a.onde_rodou.localeCompare(b.onde_rodou));
    
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao buscar análise semanal garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar análise semanal' });
  }
});

// GET /api/bi/garantido/por-cliente - Resumo por cliente do garantido
router.get('/bi/garantido/por-cliente', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    // Buscar dados da planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else { current += char; }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
          currentLine = '';
          if (char === '\r' && text[i + 1] === '\n') i++;
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
      return lines;
    };
    
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1);
    
    // Buscar nomes de clientes
    const clientesResult = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
      FROM bi_entregas WHERE cod_cliente IS NOT NULL
    `);
    const clientesNomes = {};
    clientesResult.rows.forEach(c => {
      clientesNomes[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
    });
    
    // Buscar máscaras configuradas
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Agrupar por cliente do garantido
    const porCliente = {};
    const chavesProcessadas = new Set();
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const codCliente = cols[0];
      const dataStr = cols[1];
      const codProf = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      const statusPlanilha = (cols[5] || '').trim().toLowerCase();
      
      // Na aba "Por Cliente" ignorar status "Não rodou" - mostrar apenas quem rodou
      if (statusPlanilha.includes('rodou') && (statusPlanilha.includes('não') || statusPlanilha.includes('nao'))) continue;
      
      // Aceitar linhas mesmo sem codProf (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      const partes = dataStr.split('/');
      if (partes.length !== 3) continue;
      const dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
      
      // Verificar duplicata
      const chaveUnica = `${codProf || cols[2] || 'vazio'}_${dataFormatada}_${codCliente}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Buscar produção TOTAL do profissional no dia
      // E também o centro de custo onde rodou (para cliente 767)
      let valorProduzido = 0;
      let centroCusto = null;
      
      if (codProf) {
        const producaoResult = await pool.query(`
          SELECT 
            COALESCE(SUM(valor_os), 0) as valor_produzido,
            MAX(centro_custo) as centro_custo
          FROM (
            SELECT 
              os, 
              MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
              MAX(centro_custo) as centro_custo
            FROM bi_entregas
            WHERE cod_prof = $1 AND data_solicitado::date = $2::date
            GROUP BY os
          ) os_dados
        `, [parseInt(codProf), dataFormatada]);
        valorProduzido = parseFloat(producaoResult.rows[0]?.valor_produzido) || 0;
        centroCusto = producaoResult.rows[0]?.centro_custo;
      }
      
      const complemento = Math.max(0, valorNegociado - valorProduzido);
      
      // Determinar a chave de agrupamento
      // Cliente 949: agrupa apenas pelo cliente (exceção)
      // Todos os outros: cod_cliente - nome_cliente (ou máscara) - centro_custo
      let clienteKey;
      const nomeCliente = mascaras[codCliente] || clientesNomes[codCliente] || `Cliente ${codCliente}`;
      
      if (codCliente === '949') {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      } else if (centroCusto) {
        clienteKey = `${codCliente} - ${nomeCliente} - ${centroCusto}`;
      } else {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      }
      
      if (!porCliente[clienteKey]) {
        porCliente[clienteKey] = { negociado: 0, produzido: 0, complemento: 0 };
      }
      
      porCliente[clienteKey].negociado += valorNegociado;
      porCliente[clienteKey].produzido += valorProduzido;
      porCliente[clienteKey].complemento += complemento;
    }
    
    // Formatar e calcular totais
    const resultado = Object.entries(porCliente)
      .map(([cliente, valores]) => ({
        onde_rodou: cliente,
        ...valores
      }))
      .sort((a, b) => b.complemento - a.complemento);
    
    const totais = {
      total_negociado: resultado.reduce((sum, r) => sum + r.negociado, 0),
      total_produzido: resultado.reduce((sum, r) => sum + r.produzido, 0),
      total_complemento: resultado.reduce((sum, r) => sum + r.complemento, 0)
    };
    
    res.json({ dados: resultado, totais });
  } catch (error) {
    console.error('Erro ao buscar garantido por cliente:', error);
    res.status(500).json({ error: 'Erro ao buscar dados por cliente' });
  }
});

// GET /api/bi/garantido/meta - Retorna metadados do garantido (última data, etc)
router.get('/bi/garantido/meta', async (req, res) => {
  try {
    // Buscar última data disponível na tabela bi_entregas
    const result = await pool.query(`
      SELECT MAX(data_solicitado::date) as ultima_data,
             MIN(data_solicitado::date) as primeira_data
      FROM bi_entregas
    `);
    
    res.json({
      ultima_data: result.rows[0]?.ultima_data,
      primeira_data: result.rows[0]?.primeira_data
    });
  } catch (error) {
    console.error('Erro ao buscar meta garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar metadados' });
  }
});

// PUT /api/bi/garantido/status - Atualizar status de um registro de garantido
router.put('/bi/garantido/status', async (req, res) => {
  try {
    const { cod_prof, data, cod_cliente, status, motivo_reprovado, alterado_por } = req.body;
    
    if (!cod_prof || !data || !cod_cliente || !status) {
      return res.status(400).json({ error: 'Campos obrigatórios: cod_prof, data, cod_cliente, status' });
    }
    
    if (status === 'reprovado' && !motivo_reprovado) {
      return res.status(400).json({ error: 'Motivo é obrigatório quando status é reprovado' });
    }
    
    // Upsert - inserir ou atualizar
    const result = await pool.query(`
      INSERT INTO garantido_status (cod_prof, data, cod_cliente, status, motivo_reprovado, alterado_por, alterado_em)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (cod_prof, data, cod_cliente)
      DO UPDATE SET 
        status = $4,
        motivo_reprovado = $5,
        alterado_por = $6,
        alterado_em = CURRENT_TIMESTAMP
      RETURNING *
    `, [cod_prof, data, cod_cliente, status, status === 'reprovado' ? motivo_reprovado : null, alterado_por]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar status garantido:', error);
    res.status(500).json({ error: 'Erro ao atualizar status'})   ;
  }
});

// GET /api/bi/garantido/status - Buscar todos os status salvos
router.get('/bi/garantido/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cod_prof, data::text, cod_cliente, status, motivo_reprovado, alterado_por, alterado_em
      FROM garantido_status
    `);
    
    // Criar um mapa para fácil acesso: cod_prof_data_cod_cliente -> status
    const statusMap = {};
    result.rows.forEach(row => {
      const key = `${row.cod_prof}_${row.data}_${row.cod_cliente}`;
      statusMap[key] = row;
    });
    
    res.json(statusMap);
  } catch (error) {
    console.error('Erro ao buscar status garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

// ===== REGIÕES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regioes (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    clientes JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regioes já existe ou erro:', err.message));

// Listar regiões

  return router;
}

module.exports = { createGarantidoRoutes };
