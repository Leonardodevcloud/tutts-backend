/**
 * BI Sub-Router: Upload, Recálculo e Gestão de Entregas
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createEntregasRoutes(pool, atualizarResumos) {
  const router = express.Router();

router.post('/bi/entregas/upload', async (req, res) => {
  try {
    const { entregas, data_referencia, usuario_id, usuario_nome, nome_arquivo } = req.body;
    
    console.log(`📤 Upload BI: Recebendo ${entregas?.length || 0} entregas`);
    console.log(`👤 Usuário: ${usuario_nome || 'não informado'} (${usuario_id || 'sem id'})`);
    console.log(`📁 Arquivo: ${nome_arquivo || 'não informado'}`);
    
    if (!entregas || entregas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma entrega recebida' });
    }
    
    // ============================================
    // PASSO 1: Extrair todas as OS únicas do Excel
    // ============================================
    const osDoExcel = [...new Set(entregas.map(e => parseInt(e.os)).filter(os => os && !isNaN(os)))];
    console.log(`📋 Total de OS únicas no Excel: ${osDoExcel.length}`);
    
    if (osDoExcel.length === 0) {
      return res.status(400).json({ error: 'Nenhuma OS válida encontrada no arquivo' });
    }
    
    // ============================================
    // PASSO 2: Verificar quais OS já existem no banco
    // ============================================
    const osExistentesQuery = await pool.query(`
      SELECT DISTINCT os FROM bi_entregas WHERE os = ANY($1::int[])
    `, [osDoExcel]);
    
    const osExistentes = new Set(osExistentesQuery.rows.map(r => r.os));
    console.log(`🔍 OS que já existem no banco: ${osExistentes.size}`);
    
    // ============================================
    // PASSO 3: Filtrar apenas entregas com OS novas
    // ============================================
    const entregasNovas = entregas.filter(e => {
      const os = parseInt(e.os);
      return os && !isNaN(os) && !osExistentes.has(os);
    });
    
    const osIgnoradas = osDoExcel.filter(os => osExistentes.has(os));
    console.log(`✅ Entregas novas para inserir: ${entregasNovas.length}`);
    console.log(`⏭️ Linhas ignoradas (OS já existe): ${entregas.length - entregasNovas.length}`);
    
    // ============================================
    // PASSO 3.5: CRIAR REGISTRO NO HISTÓRICO ANTES (para ter o upload_id)
    // ============================================
    const linhasIgnoradasTotal = entregas.length - entregasNovas.length;
    
    const historicoResult = await pool.query(`
      INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, os_novas, os_ignoradas, data_upload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `, [
      usuario_id, 
      usuario_nome, 
      nome_arquivo, 
      entregas.length, 
      0, // Será atualizado depois
      linhasIgnoradasTotal,
      osDoExcel.length - osIgnoradas.length,
      osIgnoradas.length
    ]);
    
    const uploadId = historicoResult.rows[0].id;
    console.log(`📝 Upload registrado com ID: ${uploadId}`);
    
    if (entregasNovas.length === 0) {
      // Histórico já foi criado acima, apenas retorna
      return res.json({ 
        success: true, 
        inseridos: 0, 
        ignorados: entregas.length,
        os_ignoradas: osIgnoradas.length,
        message: 'Todas as OS já existem no banco de dados',
        upload_id: uploadId
      });
    }
    
    // ============================================
    // PASSO 4: Buscar configurações de prazo
    // ============================================
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `).catch(() => ({ rows: [] }));
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`).catch(() => ({ rows: [] }));
    
    // Função para encontrar prazo baseado na distância - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Se não tem configuração personalizada, usa regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo (prazo 0)
      return 0;
    };
    
    // Funções auxiliares de parsing
    const parseDataHora = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        return new Date(excelEpoch.getTime() + valor * 86400000);
      }
      if (typeof valor === 'string') {
        const regex = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
        const match = valor.match(regex);
        if (match) {
          const [_, dia, mes, ano, hora, min, seg] = match;
          return new Date(ano, mes - 1, dia, hora, min, seg || 0);
        }
        const d = new Date(valor);
        if (!isNaN(d.getTime())) return d;
      }
      return null;
    };
    
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      if (execucaoComp !== null && execucaoComp !== undefined && execucaoComp !== '') {
        if (typeof execucaoComp === 'number') {
          return Math.round(execucaoComp * 24 * 60);
        }
        if (typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
          const partes = execucaoComp.split(':');
          if (partes.length >= 2) {
            return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
          }
        }
      }
      if (dataHora && finalizado && typeof dataHora === 'number' && typeof finalizado === 'number') {
        const diff = finalizado - dataHora;
        if (diff >= 0) {
          return Math.round(diff * 24 * 60);
        }
      }
      return null;
    };
    
    // Função para calcular T. Entrega Prof a partir de Data/Hora Alocado até Finalizado
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = parseDataHora(dataHoraAlocado);
      const fim = parseDataHora(finalizado);
      if (!inicio || !fim) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    // Buscar configurações de prazo profissional
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProf = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProf.rows;
      
      const prazoProfPadraoResult = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoResult.rows;
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback');
    }
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
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
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
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
    
    const parseData = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        const date = new Date(excelEpoch.getTime() + valor * 86400000);
        return date.toISOString().split('T')[0];
      }
      if (typeof valor === 'string' && valor.includes('/')) {
        const partes = valor.split(/[\s\/]/);
        if (partes.length >= 3) {
          return `${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`;
        }
      }
      return valor;
    };
    
    const parseTimestamp = (valor) => {
      const d = parseDataHora(valor);
      return d ? d.toISOString() : null;
    };
    
    const parseNum = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') return valor;
      const str = String(valor).replace(',', '.').replace(/[^\d.-]/g, '');
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    };
    
    // Função para parsear hora (HH:MM:SS ou HH:MM)
    const parseHora = (valor) => {
      if (!valor) return null;
      try {
        // Se for string no formato HH:MM:SS ou HH:MM
        if (typeof valor === 'string') {
          const match = valor.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          if (match) {
            const h = match[1].padStart(2, '0');
            const m = match[2].padStart(2, '0');
            const s = match[3] ? match[3].padStart(2, '0') : '00';
            return `${h}:${m}:${s}`;
          }
        }
        // Se for número decimal do Excel (fração do dia)
        if (typeof valor === 'number' && valor < 1) {
          const totalSeconds = Math.round(valor * 24 * 60 * 60);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    const truncar = (str, max) => str ? String(str).substring(0, max) : null;
    
    // ============================================
    // PASSO 5: Processar e inserir entregas novas
    // ============================================
    let inseridos = 0;
    let erros = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(entregasNovas.length / BATCH_SIZE);
    
    console.log(`📦 Processando ${entregasNovas.length} linhas novas em ${totalBatches} lotes`);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, entregasNovas.length);
      const batch = entregasNovas.slice(start, end);
      
      const dadosLote = [];
      
      for (const e of batch) {
        try {
          const os = parseInt(e.os);
          if (!os) continue;
          
          const distancia = parseNum(e.distancia) || 0;
          const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
          const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
          const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
          
          // Calcular Prazo Profissional: Data/Hora Alocado → Finalizado
          const prazoMinutosProf = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
          const tempoEntregaProf = calcularTempoEntregaProf(e.data_hora_alocado, e.finalizado);
          const dentroPrazoProf = (prazoMinutosProf !== null && tempoEntregaProf !== null) ? tempoEntregaProf <= prazoMinutosProf : null;
          
          if (dentroPrazo === true) dentroPrazoCount++;
          if (dentroPrazo === false) foraPrazoCount++;
          
          // Extrair ponto - primeiro tenta campo direto, depois extrai do endereço
          let ponto = parseInt(e.ponto || e.Ponto || e.seq || e.Seq || e.sequencia || e.Sequencia || e.pt || e.Pt || 0) || 0;
          const enderecoStr = e.endereco || e['Endereço'] || e.Endereco || '';
          if (ponto === 0 && enderecoStr) {
            const matchPonto = String(enderecoStr).match(/^Ponto\s*(\d+)/i);
            if (matchPonto) ponto = parseInt(matchPonto[1]) || 1;
          }
          if (ponto === 0) ponto = 1;
          
          dadosLote.push({
            os,
            ponto,
            num_pedido: truncar(e.num_pedido || e['Num Pedido'] || e['Num pedido'] || e['num pedido'], 100),
            cod_cliente: parseInt(e.cod_cliente || e['Cod Cliente'] || e['Cod cliente'] || e['cod cliente'] || e['Cód Cliente'] || e['Cód. cliente']) || null,
            nome_cliente: truncar(e.nome_cliente || e['Nome cliente'] || e['Nome Cliente'], 255),
            empresa: truncar(e.empresa || e.Empresa, 255),
            nome_fantasia: truncar(e.nome_fantasia || e['Nome Fantasia'] || e['Nome fantasia'], 255),
            centro_custo: truncar(e.centro_custo || e['Centro Custo'] || e['Centro custo'] || e['centro custo'] || e['Centro de Custo'] || e['Centro de custo'] || e.CentroCusto, 255),
            cidade_p1: truncar(e.cidade_p1 || e['Cidade P1'] || e['Cidade p1'], 100),
            endereco: enderecoStr || null,
            bairro: truncar(e.bairro, 100),
            cidade: truncar(e.cidade, 100),
            estado: truncar(e.estado, 50),
            cod_prof: parseInt(e.cod_prof) || null,
            nome_prof: truncar(e.nome_prof, 255),
            data_hora: parseTimestamp(e.data_hora),
            data_hora_alocado: parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado'] || e['Data Hora Alocado'] || e['DataHoraAlocado']),
            finalizado: parseTimestamp(e.finalizado),
            data_solicitado: parseData(e.data_solicitado) || parseData(e.data_hora),
            hora_solicitado: parseHora(e.hora_solicitado || e['H. Solicitação'] || e['H.Solicitação'] || e['H. Solicitacao'] || e['H.Solicitacao'] || e['Hora Solicitação'] || e['Hora Solicitacao'] || e['hora_solicitacao'] || e['HSolicitacao'] || e['h_solicitacao']),
            data_chegada: parseData(e.data_chegada || e['Data Chegada'] || e['Data chegada']),
            hora_chegada: parseHora(e.hora_chegada || e['Hora Chegada'] || e['Hora chegada']),
            data_saida: parseData(e.data_saida || e['Data Saida'] || e['Data Saída'] || e['Data saida']),
            hora_saida: parseHora(e.hora_saida || e['Hora Saida'] || e['Hora Saída'] || e['Hora saida']),
            categoria: truncar(e.categoria, 100),
            valor: parseNum(e.valor),
            distancia: distancia,
            valor_prof: parseNum(e.valor_prof),
            execucao_comp: truncar(e.execucao_comp ? String(e.execucao_comp) : null, 50),
            execucao_espera: truncar(e.execucao_espera ? String(e.execucao_espera) : null, 50),
            status: truncar(e.status, 100),
            motivo: truncar(e.motivo, 255),
            ocorrencia: truncar(e.ocorrencia, 255),
            velocidade_media: parseNum(e.velocidade_media),
            dentro_prazo: dentroPrazo,
            prazo_minutos: prazoMinutos,
            tempo_execucao_minutos: tempoExecucao,
            tempo_entrega_prof_minutos: tempoEntregaProf,
            dentro_prazo_prof: dentroPrazoProf,
            data_upload: data_referencia || new Date().toISOString().split('T')[0],
            latitude: parseNum(e.latitude || e.Latitude || e.lat || e.Lat || e.LAT || e.LATITUDE),
            longitude: parseNum(e.longitude || e.Longitude || e.lng || e.Lng || e.LNG || e.LONGITUDE || e.long || e.Long),
            upload_id: uploadId
          });
        } catch (err) {
          erros++;
        }
      }
      
      // Inserir lote
      if (dadosLote.length > 0) {
        for (const d of dadosLote) {
          try {
            await pool.query(`
              INSERT INTO bi_entregas (
                os, ponto, num_pedido, cod_cliente, nome_cliente, empresa,
                nome_fantasia, centro_custo, cidade_p1, endereco,
                bairro, cidade, estado, cod_prof, nome_prof,
                data_hora, data_hora_alocado, finalizado, data_solicitado, hora_solicitado,
                data_chegada, hora_chegada, data_saida, hora_saida,
                categoria, valor, distancia, valor_prof,
                execucao_comp, execucao_espera, status, motivo, ocorrencia, velocidade_media,
                dentro_prazo, prazo_minutos, tempo_execucao_minutos, 
                tempo_entrega_prof_minutos, dentro_prazo_prof,
                data_upload, latitude, longitude, upload_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
            `, [
              d.os, d.ponto, d.num_pedido, d.cod_cliente, d.nome_cliente, d.empresa,
              d.nome_fantasia, d.centro_custo, d.cidade_p1, d.endereco,
              d.bairro, d.cidade, d.estado, d.cod_prof, d.nome_prof,
              d.data_hora, d.data_hora_alocado, d.finalizado, d.data_solicitado, d.hora_solicitado,
              d.data_chegada, d.hora_chegada, d.data_saida, d.hora_saida,
              d.categoria, d.valor, d.distancia, d.valor_prof,
              d.execucao_comp, d.execucao_espera, d.status, d.motivo, d.ocorrencia, d.velocidade_media,
              d.dentro_prazo, d.prazo_minutos, d.tempo_execucao_minutos,
              d.tempo_entrega_prof_minutos, d.dentro_prazo_prof,
              d.data_upload, d.latitude, d.longitude, d.upload_id
            ]);
            inseridos++;
          } catch (singleErr) {
            erros++;
          }
        }
      }
    }
    
    // ============================================
    // PASSO 6: Atualizar histórico com total inserido
    // ============================================
    await pool.query(`
      UPDATE bi_upload_historico 
      SET linhas_inseridas = $1
      WHERE id = $2
    `, [inseridos, uploadId]);
    
    console.log(`✅ Upload concluído: ${inseridos} inseridos, ${linhasIgnoradasTotal} ignorados (OS duplicada), ${erros} erros`);
    console.log(`📊 Dentro do prazo: ${dentroPrazoCount}, Fora do prazo: ${foraPrazoCount}`);
    
    // ============================================
    // PASSO 7: Atualizar resumos pré-calculados
    // ============================================
    // Extrair datas únicas das entregas inseridas para atualizar apenas essas datas
    const datasAfetadas = [...new Set(entregasNovas.map(e => e.data_solicitado).filter(d => d))];
    console.log(`📊 Atualizando resumos para ${datasAfetadas.length} data(s)...`);
    
    // Atualizar resumos em background (não bloqueia a resposta)
    atualizarResumos(datasAfetadas).then(resultado => {
      console.log('📊 Resumos atualizados:', resultado);
    }).catch(err => {
      console.error('❌ Erro ao atualizar resumos:', err);
    });
    
    res.json({
      success: true,
      inseridos,
      ignorados: linhasIgnoradasTotal,
      erros,
      os_novas: osDoExcel.length - osIgnoradas.length,
      os_ignoradas: osIgnoradas.length,
      dentro_prazo: dentroPrazoCount,
      fora_prazo: foraPrazoCount,
      upload_id: uploadId
    });
  } catch (err) {
    console.error('❌ Erro no upload:', err);
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

// Recalcular prazos de todas as entregas
router.post('/bi/entregas/recalcular', async (req, res) => {
  try {
    // Buscar configurações de prazo
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    if (prazoPadrao.rows.length > 0) {
      console.log(`🔄 Faixas padrão:`, prazoPadrao.rows.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', '));
    } else {
      console.log(`⚠️ ATENÇÃO: Nenhum prazo padrão configurado! Configure na aba Prazos.`);
    }
    
    // Buscar todas as entregas
    const entregas = await pool.query(`SELECT id, cod_cliente, centro_custo, distancia, data_hora, finalizado, execucao_comp FROM bi_entregas`);
    console.log(`🔄 Total de entregas: ${entregas.rows.length}`);
    
    // Função para encontrar prazo - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo
      return 0;
    };
    
    // Calcular tempo em minutos
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      // Se tiver execucao_comp como string HH:MM:SS
      if (execucaoComp && typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
        const partes = execucaoComp.split(':');
        if (partes.length >= 2) {
          return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
        }
      }
      
      // Calcular a partir dos timestamps
      if (!dataHora || !finalizado) return null;
      const inicio = new Date(dataHora);
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
      const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, execComp="${e.execucao_comp}", data_hora=${e.data_hora}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo = $1, prazo_minutos = $2, tempo_execucao_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular:', err);
    res.status(500).json({ error: 'Erro ao recalcular' });
  }
});

// Atualizar resumos pré-calculados (forçar recálculo)
router.post('/bi/atualizar-resumos', async (req, res) => {
  try {
    console.log('📊 Forçando atualização de resumos...');
    const resultado = await atualizarResumos();
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao atualizar resumos:', err);
    res.status(500).json({ error: 'Erro ao atualizar resumos' });
  }
});

// Obter métricas do dashboard usando resumos pré-calculados (OTIMIZADO)
router.post('/bi/entregas/atualizar-alocado', async (req, res) => {
  try {
    const { entregas } = req.body;
    
    if (!entregas || !Array.isArray(entregas)) {
      return res.status(400).json({ error: 'Array de entregas é obrigatório' });
    }
    
    console.log(`📊 Atualizando data_hora_alocado para ${entregas.length} registros...`);
    
    // Função para parsear timestamp
    const parseTimestamp = (val) => {
      if (!val) return null;
      try {
        // Tenta diferentes formatos
        if (typeof val === 'string') {
          // Formato DD/MM/YYYY HH:MM:SS
          const match = val.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):?(\d{2})?/);
          if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4], match[5], match[6] || 0);
          }
          // Formato ISO
          const d = new Date(val);
          if (!isNaN(d.getTime())) return d;
        }
        // Excel serial number
        if (typeof val === 'number') {
          const excelDate = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(excelDate.getTime())) return excelDate;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    let atualizados = 0;
    let erros = 0;
    
    for (const e of entregas) {
      const os = parseInt(e.os);
      const ponto = parseInt(e.ponto) || 1;
      const dataHoraAlocado = parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado']);
      
      if (!os || !dataHoraAlocado) {
        erros++;
        continue;
      }
      
      try {
        const result = await pool.query(`
          UPDATE bi_entregas 
          SET data_hora_alocado = $1 
          WHERE os = $2 AND COALESCE(ponto, 1) = $3 AND data_hora_alocado IS NULL
        `, [dataHoraAlocado, os, ponto]);
        
        if (result.rowCount > 0) atualizados++;
      } catch (err) {
        erros++;
      }
    }
    
    console.log(`✅ Atualização concluída: ${atualizados} atualizados, ${erros} erros`);
    res.json({ success: true, atualizados, erros });
  } catch (err) {
    console.error('❌ Erro ao atualizar data_hora_alocado:', err);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// Dashboard BI - Métricas gerais COMPLETO
router.get('/bi/uploads', async (req, res) => {
  try {
    // Primeiro tenta buscar do histórico novo
    const historico = await pool.query(`
      SELECT 
        id,
        usuario_id,
        usuario_nome,
        nome_arquivo,
        total_linhas,
        linhas_inseridas,
        linhas_ignoradas,
        os_novas,
        os_ignoradas,
        data_upload
      FROM bi_upload_historico
      ORDER BY data_upload DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    
    if (historico.rows.length > 0) {
      res.json(historico.rows);
    } else {
      // Fallback para o método antigo (agregado por data_upload)
      const result = await pool.query(`
        SELECT data_upload, COUNT(*) as total_registros, 
               MIN(data_solicitado) as data_inicial,
               MAX(data_solicitado) as data_final
        FROM bi_entregas 
        WHERE data_upload IS NOT NULL
        GROUP BY data_upload
        ORDER BY data_upload DESC
      `);
      res.json(result.rows);
    }
  } catch (err) {
    console.error('❌ Erro ao listar uploads:', err);
    res.status(500).json({ error: 'Erro ao listar uploads' });
  }
});

// Excluir upload por data
// Excluir upload por data (FALLBACK para dados antigos sem upload_id)
router.delete('/bi/uploads/:data', async (req, res) => {
  try {
    const { data } = req.params;
    
    // Para dados antigos (sem upload_id), ainda permite deletar por data
    // MAS só deleta registros SEM upload_id (dados antigos)
    console.log(`⚠️ Exclusão por data (legado): ${data}`);
    
    const result = await pool.query(`DELETE FROM bi_entregas WHERE data_upload = $1 AND upload_id IS NULL`, [data]);
    
    // Também remove do histórico onde a data coincide
    await pool.query(`DELETE FROM bi_upload_historico WHERE DATE(data_upload) = $1`, [data]).catch(() => {});
    
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao excluir upload:', err);
    res.status(500).json({ error: 'Erro ao excluir upload' });
  }
});

// Excluir upload por ID do histórico
router.delete('/bi/uploads/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // ✅ CORRIGIDO: Deletar APENAS entregas vinculadas a este upload_id específico
    const deleteResult = await pool.query(`DELETE FROM bi_entregas WHERE upload_id = $1`, [id]);
    console.log(`🗑️ Deletadas ${deleteResult.rowCount} entregas do upload ID ${id}`);
    
    // Deletar do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE id = $1`, [id]);
    
    res.json({ success: true, deletados: deleteResult.rowCount });
  } catch (err) {
    console.error('❌ Erro ao excluir histórico:', err);
    res.status(500).json({ error: 'Erro ao excluir histórico' });
  }
});

// Limpar entregas por período
router.delete('/bi/entregas', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    let query = 'DELETE FROM bi_entregas WHERE 1=1';
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND data_solicitado >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND data_solicitado <= $${params.length}`;
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao limpar entregas:', err);
    res.status(500).json({ error: 'Erro ao limpar entregas' });
  }
});


// ============================================
// ROTAS DE RECRUTAMENTO
// ============================================

// ============================================
// ROTAS DO MÓDULO GARANTIDO (BI)
// ============================================

// Criar tabela de status do garantido (se não existir)
pool.query(`
  CREATE TABLE IF NOT EXISTS garantido_status (
    id SERIAL PRIMARY KEY,
    cod_prof VARCHAR(20) NOT NULL,
    data DATE NOT NULL,
    cod_cliente VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'analise',
    motivo_reprovado TEXT,
    alterado_por VARCHAR(100),
    alterado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cod_prof, data, cod_cliente)
  )
`).then(() => console.log('✅ Tabela garantido_status verificada'))
  .catch(err => console.log('Erro ao criar tabela garantido_status:', err.message));

// GET /api/bi/garantido - Análise de mínimo garantido

  return router;
}

module.exports = { createEntregasRoutes };
