/**
 * Config Sub-Router: Validação IA de Fotos + Respostas Prontas
 * v2 — Com subcategorias para "Ajuste de Retorno"
 */
const express = require('express');
const crypto = require('crypto');

function createValidacaoIaRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  const SYSTEM_PROMPT = `Você é o assistente de validação visual da Central Tutts, uma plataforma de gestão logística de entregas em Salvador/BA.

Seu papel tem DUAS funções:

FUNÇÃO 1 — FILTRO DE QUALIDADE:
Verificar se a foto enviada pelo motoboy atende o mínimo necessário para ser analisada por um administrador humano. Fotos que não servem (borrada, screenshot, sem relação com o motivo) devem ser rejeitadas com feedback claro para o motoboy enviar uma nova.

FUNÇÃO 2 — RESUMO PARA O ADMIN:
Quando a foto passa no filtro, gerar um resumo objetivo da sua análise para que o administrador consiga decidir rapidamente se aprova ou rejeita a solicitação.

REGRAS ABSOLUTAS:
1. Responda EXCLUSIVAMENTE com JSON válido — sem texto antes, sem texto depois, sem markdown fences
2. Nunca invente informações que não estão visíveis na foto
3. Seu campo "resumo_admin" deve ser direto e útil
4. O campo "feedback_motoboy" só é usado quando a foto é rejeitada
5. O campo "confianca" (0-100) representa o quão certo você está

CRITÉRIOS UNIVERSAIS DE REJEIÇÃO:
- Foto completamente preta / escura sem conteúdo distinguível
- Foto extremamente borrada onde nada é identificável
- Screenshot / foto de tela de celular
- Selfie do motoboy sem contexto relevante
- Foto claramente sem relação com o motivo da solicitação
- Imagem com conteúdo inapropriado`;

  // ==================== PROMPTS ====================
  const PROMPTS = {

    'Ajuste de Retorno::Cliente fechado / ausente': {
      threshold: 75,
      prompt: `TAREFA: Validar foto de ESTABELECIMENTO FECHADO / CLIENTE AUSENTE

A foto deveria mostrar a fachada do estabelecimento com portas fechadas, grades abaixadas ou sinais claros de que não está em funcionamento.

SINAIS DE FECHAMENTO:
- Portas de aço/metal abaixadas, grades fechadas
- Portas trancadas com cadeado visível
- Luzes internas apagadas, ambiente escuro
- Placas de "fechado"

MOTIVOS PARA REJEITAR:
- Não é foto de uma fachada de estabelecimento
- Foto genérica de rua sem foco em um estabelecimento
- Foto de documento/nota fiscal (não é o que se pede aqui)
- Foto muito escura para distinguir qualquer coisa

Responda com JSON:
{
  "foto_valida": boolean,
  "confianca": number (0-100),
  "analise": {
    "e_fachada": boolean,
    "tipo_estabelecimento": "comercial|residencial|industrial|nao_identificado",
    "portas_fechadas": boolean,
    "sinais_fechamento": ["lista do que observa"],
    "sinais_funcionamento": ["sinais de que está aberto, se houver"]
  },
  "resumo_admin": "Frase objetiva para o admin.",
  "alertas_admin": ["pontos de atenção"],
  "feedback_motoboy": "mensagem SE foto_valida=false, senão null"
}`
    },

    'Ajuste de Retorno::Produto incorreto / avariado': {
      threshold: 70,
      prompt: `TAREFA: Validar foto de RESSALVA MANUSCRITA no verso da Nota Fiscal

A foto deveria mostrar o VERSO de uma nota fiscal contendo uma RESSALVA escrita À MÃO pelo cliente, indicando problemas com a mercadoria (itens faltantes, avaria, divergência, produto errado).

O QUE PROCURAR:
- Papel que aparenta ser nota fiscal (NF-e DANFE, cupom fiscal, romaneio)
- VERSO do documento (parte de trás — mais limpa, sem dados impressos principais)
- Texto MANUSCRITO (escrito à mão com caneta)
- Conteúdo: observação, reclamação (ex: "faltou 2 peças", "caixa avariada")
- Assinatura ou rubrica do cliente
- Data manuscrita

MOTIVOS PARA REJEITAR:
- Foto mostrando apenas a FRENTE da NF (dados impressos sem manuscrito)
- Documento sem NENHUMA escrita à mão
- Foto que não é de documento/papel
- Texto manuscrito completamente ilegível
- Foto de fachada, rua, comprovante de pedágio

IMPORTANTE: Se a foto mostra verso da NF com escrita à mão visível, mesmo com caligrafia difícil, ACEITE. Rejeite apenas se não houver manuscrito ou não for um documento.

Responda com JSON:
{
  "foto_valida": boolean,
  "confianca": number (0-100),
  "analise": {
    "e_documento": boolean,
    "tipo_documento": "nota_fiscal|cupom_fiscal|romaneio|outro|nao_identificado",
    "e_verso": boolean,
    "tem_manuscrito": boolean,
    "manuscrito_legivel": boolean,
    "transcricao_manuscrito": "transcrição do que consegue ler, ou null",
    "tem_assinatura": boolean,
    "tem_data": boolean
  },
  "resumo_admin": "Ex: 'Verso de NF com ressalva: \"faltou 2 parafusos\". Assinatura presente.'",
  "alertas_admin": ["pontos de atenção"],
  "feedback_motoboy": "mensagem SE foto_valida=false, senão null"
}`
    },

    'Ajuste de Retorno::Endereço não encontrado': {
      threshold: 70,
      prompt: `TAREFA: Validar foto de ENDEREÇO NÃO ENCONTRADO

A foto deveria mostrar evidência de que o endereço de entrega não foi localizado.

O QUE PROCURAR:
- Placa de rua mostrando o nome da via
- Numeração das casas/estabelecimentos próximos (gap na numeração)
- Terreno baldio / lote vazio
- Construção abandonada / inacabada
- Vista panorâmica mostrando a rua sem o número esperado

MOTIVOS PARA REJEITAR:
- Foto genérica de rua sem referência identificável
- Foto de dentro do veículo sem mostrar o local
- Foto que mostra um estabelecimento funcionando
- Foto de documento, nota fiscal ou comprovante
- Foto muito distante para ler qualquer referência

Responda com JSON:
{
  "foto_valida": boolean,
  "confianca": number (0-100),
  "analise": {
    "mostra_via_publica": boolean,
    "placa_rua_visivel": boolean,
    "nome_rua_legivel": "nome que consegue ler, ou null",
    "numeracao_visivel": boolean,
    "numeros_visiveis": ["lista de números legíveis"],
    "evidencia": "terreno_baldio|gap_numeracao|imovel_abandonado|rua_sem_numero|outro|nenhuma",
    "descricao_local": "breve descrição"
  },
  "resumo_admin": "Frase objetiva para o admin.",
  "alertas_admin": ["pontos de atenção"],
  "feedback_motoboy": "mensagem SE foto_valida=false, senão null"
}`
    },

    'Ajuste de Pedágio': {
      threshold: 70,
      prompt: `TAREFA: Validar foto de COMPROVANTE DE PAGAMENTO DE PEDÁGIO

A foto deveria mostrar um comprovante/recibo de pagamento de pedágio.

TIPOS ACEITOS:
1. RECIBO DE PEDÁGIO — ticket impresso pelo terminal (valor, data, hora, praça)
2. COMPROVANTE ELETRÔNICO — tela de app (Sem Parar, ConectCar, Veloe, Move Mais)
3. CUPOM FISCAL — pagamento manual no guichê
4. EXTRATO DE TAG — passagem específica no extrato

O QUE PROCURAR:
- Valor do pedágio visível
- Data e hora da passagem
- Nome da praça/concessionária
- Aparência de comprovante real (papel térmico, tela de app)

MOTIVOS PARA REJEITAR:
- Foto sem nenhum tipo de comprovante de pedágio
- Comprovante completamente ilegível
- Foto de praça/cancela SEM comprovante de pagamento
- Comprovante de outro serviço (combustível, estacionamento)
- Foto de fachada, rua, nota fiscal de mercadoria

IMPORTANTE: Se parecer um recibo/comprovante de pedágio (papel de terminal, tela de app), ACEITE mesmo com dados parcialmente cortados. Rejeite apenas se claramente não for comprovante de pedágio.

Responda com JSON:
{
  "foto_valida": boolean,
  "confianca": number (0-100),
  "analise": {
    "tipo_comprovante": "recibo_pedagio|comprovante_eletronico|cupom_fiscal|extrato_tag|nao_identificado",
    "valor_visivel": boolean,
    "valor_lido": "valor ou null",
    "data_visivel": boolean,
    "data_lida": "data ou null",
    "praca_pedagio": "nome ou null",
    "placa_visivel": boolean,
    "placa_lida": "placa ou null"
  },
  "resumo_admin": "Ex: 'Recibo de pedágio Via Bahia, R$5,60, data 28/03.'",
  "alertas_admin": ["pontos de atenção"],
  "feedback_motoboy": "mensagem SE foto_valida=false, senão null"
}`
    },

    'Ajustes Simões Filho e Camaçari': {
      threshold: 70,
      prompt: `TAREFA: Validar foto de COMPROVANTE para ajuste de rota Simões Filho/Camaçari

A foto pode ser comprovante de entrega, foto da mercadoria no local, ou evidência de que esteve no destino.

TIPOS ACEITOS:
1. Canhoto/protocolo assinado
2. Foto da mercadoria no local
3. Foto da fachada com identificação
4. Comprovante com carimbo

MOTIVOS PARA REJEITAR:
- Foto sem relação com entrega
- Selfie sem contexto
- Foto muito borrada ou escura
- Screenshot

Responda com JSON:
{
  "foto_valida": boolean,
  "confianca": number (0-100),
  "analise": {
    "tipo_comprovante": "canhoto_assinado|protocolo|foto_mercadoria|foto_fachada|carimbo|nao_identificado",
    "tem_assinatura": boolean,
    "tem_carimbo": boolean,
    "descricao_cena": "breve descrição"
  },
  "resumo_admin": "Resumo objetivo.",
  "alertas_admin": ["pontos de atenção"],
  "feedback_motoboy": "mensagem SE foto_valida=false, senão null"
}`
    }
  };

  const PROMPT_GENERICO = {
    threshold: 75,
    prompt: `TAREFA: Validar foto para solicitação de entrega\nTIPO: {{motivo}} {{subcategoria}}\nAvalie compatibilidade.\nResponda com JSON:\n{"foto_valida": boolean, "confianca": number, "analise": {"conteudo_foto": "descrição", "compativel_com_solicitacao": boolean, "relevancia": "alta|media|baixa|nenhuma"}, "resumo_admin": "resumo", "alertas_admin": [], "feedback_motoboy": "mensagem SE false, senão null"}`
  };

  function resolverPrompt(motivo, subcategoria) {
    if (subcategoria) {
      const chave = `${motivo}::${subcategoria}`;
      if (PROMPTS[chave]) return PROMPTS[chave];
    }
    if (PROMPTS[motivo]) return PROMPTS[motivo];
    return PROMPT_GENERICO;
  }

  // ==================== VALIDAR FOTO ====================
  router.post('/submissions/validar-foto', verificarToken, async (req, res) => {
    const inicio = Date.now();
    try {
      const { foto, motivo, subcategoria, ordemServico } = req.body;
      const userCod = req.user.codProfissional;

      if (!foto || typeof foto !== 'string') return res.status(400).json({ error: 'Foto obrigatória' });
      if (!motivo) return res.status(400).json({ error: 'Motivo obrigatório' });

      const base64Puro = foto.replace(/^data:image\/\w+;base64,/, '');
      const fotoHash = crypto.createHash('sha256').update(base64Puro.substring(0, 5000)).digest('hex');
      const motivoLog = subcategoria ? `${motivo}::${subcategoria}` : motivo;

      if (!GEMINI_API_KEY) {
        console.log('⚠️ [VALIDAÇÃO IA] GEMINI_API_KEY não configurada');
        return res.json({ foto_valida: true, confianca: 0, resumo_admin: 'IA indisponível', feedback_motoboy: null, alertas_admin: [], sem_ia: true });
      }

      const cenario = resolverPrompt(motivo, subcategoria);
      const threshold = cenario.threshold;
      let promptTexto = cenario.prompt.replace('{{motivo}}', motivo || '').replace('{{subcategoria}}', subcategoria || '');

      console.log(`🤖 [VALIDAÇÃO IA] ${motivoLog} | User: ${userCod} | Threshold: ${threshold}`);

      const geminiResponse = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: SYSTEM_PROMPT + '\n\n' + promptTexto },
            { inlineData: { mimeType: 'image/jpeg', data: base64Puro } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        }),
        signal: AbortSignal.timeout(15000)
      });

      const geminiData = await geminiResponse.json();
      const tempoMs = Date.now() - inicio;

      if (geminiData.error) {
        console.error('❌ [VALIDAÇÃO IA] Erro Gemini:', geminiData.error.message);
        await pool.query('INSERT INTO submissions_validacao_ia (user_cod, motivo, foto_base64_hash, erro, tempo_ms) VALUES ($1,$2,$3,$4,$5)',
          [userCod, motivoLog, fotoHash, geminiData.error.message, tempoMs]).catch(() => {});
        return res.json({ foto_valida: true, confianca: 0, resumo_admin: 'Erro IA — foto aceita', feedback_motoboy: null, alertas_admin: ['Erro: ' + geminiData.error.message], sem_ia: true });
      }

      const textoResposta = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let resultado;
      try {
        resultado = JSON.parse(textoResposta.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
      } catch (parseErr) {
        console.error('❌ [VALIDAÇÃO IA] JSON parse error | Raw:', textoResposta.substring(0, 300));
        await pool.query('INSERT INTO submissions_validacao_ia (user_cod, motivo, foto_base64_hash, erro, resultado_ia, tempo_ms) VALUES ($1,$2,$3,$4,$5,$6)',
          [userCod, motivoLog, fotoHash, 'JSON parse', JSON.stringify({ raw: textoResposta.substring(0, 1000) }), tempoMs]).catch(() => {});
        return res.json({ foto_valida: true, confianca: 0, resumo_admin: 'Erro IA — foto aceita', feedback_motoboy: null, alertas_admin: ['Erro parse'], sem_ia: true });
      }

      const confianca = parseInt(resultado.confianca) || 0;
      const fotoValidaPelaIA = resultado.foto_valida === true && confianca >= threshold;

      await pool.query('INSERT INTO submissions_validacao_ia (user_cod, motivo, foto_base64_hash, resultado_ia, foto_valida, confianca, tempo_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [userCod, motivoLog, fotoHash, JSON.stringify(resultado), fotoValidaPelaIA, confianca, tempoMs]).catch(() => {});

      console.log(`${fotoValidaPelaIA ? '✅' : '❌'} [VALIDAÇÃO IA] válida=${fotoValidaPelaIA} confiança=${confianca}/${threshold} tempo=${tempoMs}ms`);

      res.json({
        foto_valida: fotoValidaPelaIA, confianca, threshold,
        resumo_admin: resultado.resumo_admin || null,
        feedback_motoboy: fotoValidaPelaIA ? null : (resultado.feedback_motoboy || 'Foto não atende os critérios. Tire uma nova.'),
        alertas_admin: resultado.alertas_admin || [],
        analise: resultado.analise || null,
        sem_ia: false
      });
    } catch (err) {
      console.error('❌ [VALIDAÇÃO IA] Erro:', err.message);
      return res.json({ foto_valida: true, confianca: 0, resumo_admin: 'Timeout/erro IA — foto aceita', feedback_motoboy: null, alertas_admin: ['IA indisponível'], sem_ia: true });
    }
  });

  // ==================== RESPOSTAS PRONTAS ====================
  router.get('/submissions/respostas-prontas', verificarToken, async (req, res) => {
    try {
      const { motivo } = req.query;
      let q = 'SELECT id, titulo, mensagem, motivo, ativo, ordem FROM submissions_respostas_prontas WHERE ativo = true';
      const p = [];
      if (motivo) { q += ' AND (motivo = $1 OR motivo IS NULL)'; p.push(motivo); }
      q += ' ORDER BY ordem ASC, criado_em ASC';
      res.json((await pool.query(q, p)).rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  });

  router.post('/submissions/respostas-prontas', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { titulo, mensagem, motivo, ordem } = req.body;
      if (!titulo || !mensagem) return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
      const r = await pool.query('INSERT INTO submissions_respostas_prontas (titulo, mensagem, motivo, ordem, criado_por) VALUES ($1,$2,$3,$4,$5) RETURNING id, titulo, mensagem, motivo, ordem',
        [titulo.trim().substring(0, 100), mensagem.trim(), motivo || null, parseInt(ordem) || 0, req.user.id]);
      await registrarAuditoria(req, 'RESPOSTA_PRONTA_CREATE', AUDIT_CATEGORIES.DATA, 'submissions_respostas_prontas', r.rows[0].id, { titulo });
      res.json({ sucesso: true, resposta: r.rows[0] });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  });

  router.put('/submissions/respostas-prontas/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { titulo, mensagem, motivo, ordem, ativo } = req.body;
      const r = await pool.query(
        'UPDATE submissions_respostas_prontas SET titulo=COALESCE($1,titulo), mensagem=COALESCE($2,mensagem), motivo=$3, ordem=COALESCE($4,ordem), ativo=COALESCE($5,ativo), atualizado_em=NOW() WHERE id=$6 RETURNING *',
        [titulo?.trim()?.substring(0,100), mensagem?.trim(), motivo !== undefined ? (motivo||null) : undefined, ordem != null ? parseInt(ordem) : undefined, ativo, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Não encontrada' });
      await registrarAuditoria(req, 'RESPOSTA_PRONTA_UPDATE', AUDIT_CATEGORIES.DATA, 'submissions_respostas_prontas', req.params.id, { titulo });
      res.json({ sucesso: true, resposta: r.rows[0] });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  });

  router.delete('/submissions/respostas-prontas/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const r = await pool.query('DELETE FROM submissions_respostas_prontas WHERE id=$1 RETURNING titulo', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Não encontrada' });
      await registrarAuditoria(req, 'RESPOSTA_PRONTA_DELETE', AUDIT_CATEGORIES.DATA, 'submissions_respostas_prontas', req.params.id, { titulo: r.rows[0].titulo });
      res.json({ sucesso: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  });

  router.get('/submissions/respostas-prontas/todas', verificarToken, verificarAdmin, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM submissions_respostas_prontas ORDER BY ordem ASC, criado_em ASC')).rows); }
    catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  });

  return router;
}

module.exports = { createValidacaoIaRoutes };
