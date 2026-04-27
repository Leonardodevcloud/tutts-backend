/**
 * routes/correcao.routes.js
 * POST /agent/corrigir-endereco
 * GET  /agent/status/:id
 * GET  /agent/foto/:id
 */

'use strict';

const express = require('express');
const { validarLocalizacao } = require('../validar-localizacao');
// 2026-04: validação NF + cruzamento com Receita Federal
const { validarNotaFiscal } = require('../validar-nota-fiscal');
const { cruzarValidacoes } = require('../cruzar-validacoes');
// 2026-04 v3: consulta Receita direto quando motoboy digita CNPJ
const { consultarReceita } = require('../consultar-receita');
// 2026-04 v4: pré-validação rápida da foto (camera coaching)
const { validarFotoNfPreview } = require('../validar-foto-nf-preview');

// ── Haversine: distância em km entre dois pontos ────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const RAIO_MAXIMO_KM = 2;

/**
 * Valida CNPJ brasileiro (14 dígitos + 2 dígitos verificadores).
 * Retorna true se válido, false caso contrário.
 * Não considera CNPJs com todos os dígitos iguais (ex: 00000000000000).
 */
function validarCNPJ(cnpj) {
  const c = String(cnpj || '').replace(/\D/g, '');
  if (c.length !== 14) return false;
  if (/^(\d)\1+$/.test(c)) return false; // todos iguais

  // Cálculo dos dígitos verificadores
  const calc = (base, pesos) => {
    let soma = 0;
    for (let i = 0; i < pesos.length; i++) soma += parseInt(base[i], 10) * pesos[i];
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const d1 = calc(c, pesos1);
  if (d1 !== parseInt(c[12], 10)) return false;
  const d2 = calc(c, pesos2);
  if (d2 !== parseInt(c[13], 10)) return false;

  return true;
}

// 2026-04 v3: motoboy escolhe ENTRE foto_nf OU cnpj_manual.
// foto_fachada continua sendo SEMPRE obrigatória.
function validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_nf, foto_fachada, cnpj_manual }) {
  const erros = [];

  if (!os_numero || String(os_numero).trim() === '')
    erros.push('os_numero é obrigatório.');
  if (!/^\d+$/.test(String(os_numero || '').trim()))
    erros.push('os_numero deve conter apenas dígitos.');
  else if (String(os_numero).trim().length !== 7)
    erros.push(`Número da OS deve ter exatamente 7 dígitos (recebido: ${String(os_numero).trim().length} dígito(s)).`);

  const pontoNum = parseInt(ponto, 10);
  if (isNaN(pontoNum))
    erros.push('ponto deve ser um número inteiro.');
  else if (pontoNum === 1)
    erros.push('O Ponto 1 nunca pode ser corrigido pelo agente.');
  else if (pontoNum < 2 || pontoNum > 7)
    erros.push('ponto deve ser entre 2 e 7.');

  if (!localizacao_raw || String(localizacao_raw).trim() === '')
    erros.push('localizacao_raw é obrigatório.');

  if (motoboy_lat == null || motoboy_lng == null) {
    erros.push('Localização GPS do motoboy é obrigatória. Ative o GPS e tente novamente.');
  } else {
    const lat = parseFloat(motoboy_lat);
    const lng = parseFloat(motoboy_lng);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      erros.push('Coordenadas GPS do motoboy inválidas.');
    }
  }

  // 2026-04 v3: foto_nf OU cnpj_manual obrigatório (XOR — pelo menos um)
  const temFotoNf = !!(foto_nf && String(foto_nf).trim() !== '');
  const temCnpjManual = !!(cnpj_manual && String(cnpj_manual).replace(/\D/g, '').length > 0);

  if (!temFotoNf && !temCnpjManual) {
    erros.push('Envie a foto da nota fiscal OU digite o CNPJ do cliente.');
  }

  // Se CNPJ digitado, valida dígito verificador (bloqueia inválido)
  if (temCnpjManual && !validarCNPJ(cnpj_manual)) {
    erros.push('CNPJ inválido. Confira os dígitos.');
  }

  // Foto fachada continua sempre obrigatória
  if (!foto_fachada || String(foto_fachada).trim() === '') {
    erros.push('Foto da fachada é obrigatória.');
  }

  return erros;
}

function createCorrecaoRoutes(pool) {
  const router = express.Router();

  // 2026-04: REMOVIDO router.use(express.json({ limit: '10mb' })).
  // Body parser global no server.js já aceita até 50mb, e essa duplicação
  // só servia pra ESTREITAR o limite aqui (10mb), o que pode quebrar
  // requests legítimos com foto fachada (5mb) + foto NF (5mb) + overhead
  // de outros campos. Express body parser global é suficiente.

  // POST /agent/corrigir-endereco
  router.post('/corrigir-endereco', async (req, res) => {
    const { os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada, foto_nf, cnpj_manual } = req.body || {};

    // 🔍 DEBUG (remover depois): identificar por que foto_nf chega NULL no banco
    console.log(`[agent/DEBUG] 📥 BODY OS=${os_numero} | foto_nf: tipo=${typeof foto_nf} truthy=${!!foto_nf} len=${foto_nf ? foto_nf.length : 0} | foto_fachada: len=${foto_fachada ? foto_fachada.length : 0} | cnpj_manual=${cnpj_manual || 'nada'}`);

    const erros = validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_nf, foto_fachada, cnpj_manual });
    if (erros.length > 0) {
      return res.status(400).json({ sucesso: false, erros });
    }

    try {
      // Foto da fachada agora é OPCIONAL — só valida tamanho se enviada
      if (foto_fachada && foto_fachada.length > 7_000_000) {
        return res.status(400).json({ sucesso: false, erros: ['Foto da fachada muito grande. Máximo 5MB.'] });
      }
      if (foto_nf && foto_nf.length > 7_000_000) {
        return res.status(400).json({ sucesso: false, erros: ['Foto da NF muito grande. Máximo 5MB.'] });
      }

      const usuarioId       = req.user?.id   || null;
      const usuarioNome     = req.user?.nome || req.user?.name || req.user?.email || null;
      const codProfissional = req.user?.codProfissional || req.user?.cod_profissional || null;

      // Validar OS+Ponto duplicada
      const pontoNum = parseInt(ponto, 10);
      
      // 1. Já corrigida com sucesso neste ponto?
      const jaCorrigida = await pool.query(
        `SELECT id FROM ajustes_automaticos WHERE os_numero = $1 AND ponto = $2 AND status = 'sucesso' LIMIT 1`,
        [String(os_numero).trim(), pontoNum]
      );
      if (jaCorrigida.rows.length > 0) {
        return res.status(409).json({
          sucesso: false,
          erros: [`O Ponto ${pontoNum} da OS ${os_numero} já foi corrigido com sucesso anteriormente. Entre em contato com o suporte caso precise de outra correção.`],
        });
      }

      // 2. Já tem pendente/processando neste ponto?
      const emAndamento = await pool.query(
        `SELECT id, status FROM ajustes_automaticos WHERE os_numero = $1 AND ponto = $2 AND status IN ('pendente', 'processando') LIMIT 1`,
        [String(os_numero).trim(), pontoNum]
      );
      if (emAndamento.rows.length > 0) {
        return res.status(409).json({
          sucesso: false,
          erros: [`O Ponto ${pontoNum} da OS ${os_numero} já está sendo processado. Aguarde a conclusão antes de enviar novamente.`],
        });
      }

      // ── 1. Obter dados do cliente: por foto da NF (Gemini) OU por CNPJ digitado ──
      // 2026-04 v3: motoboy escolhe um dos dois caminhos.
      let validacaoNF = null;

      if (foto_nf) {
        // Caminho A: foto NF → Gemini extrai dados → consulta Receita (já dentro do validar)
        try {
          validacaoNF = await validarNotaFiscal(foto_nf, {
            latitude: parseFloat(motoboy_lat),
            longitude: parseFloat(motoboy_lng),
          });

          // Se NF não passou validação básica (não é NF, ilegível, CNPJ inválido) → BLOQUEAR
          if (validacaoNF && validacaoNF.nf_rejeitada) {
            console.log(`[agent] ❌ NF rejeitada: ${validacaoNF.motivo}`);
            return res.status(400).json({
              sucesso: false,
              nf_rejeitada: true,
              motivo_rejeicao: validacaoNF.motivo,
              erros: [validacaoNF.motivo],
            });
          }

          if (validacaoNF) {
            console.log(`[agent] ✅ NF analisada: CNPJ=${validacaoNF.dados?.cnpj_formatado} confianca=${validacaoNF.confianca}%`);
          }
        } catch (nfErr) {
          console.error('[agent] ⚠️ Erro validação NF (não-bloqueante):', nfErr.message);
        }
      } else if (cnpj_manual) {
        // Caminho B: CNPJ digitado pelo motoboy → consulta Receita direto, sem Gemini.
        // Não temos dados extraídos da NF (razão_social, nome_fantasia, endereco_nf etc),
        // mas a consulta Receita ainda traz tudo isso oficialmente.
        const cnpjLimpo = String(cnpj_manual).replace(/\D/g, '');
        try {
          const receita = await consultarReceita(cnpjLimpo);
          // Estrutura compatível com o que validarNotaFiscal retornaria
          validacaoNF = {
            nf_rejeitada: false,
            motivo: null,
            confianca: null,         // não temos confiança IA porque não rodou Gemini
            origem: 'cnpj_manual',   // marcador pra log/auditoria
            dados: {
              cnpj: cnpjLimpo,
              cnpj_formatado: cnpjLimpo.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
              // Demais campos vão ficar null — Gemini não rodou. Cruzamento usa só o que tiver.
              razao_social: null,
              nome_fantasia: null,
              endereco_nf: null,
              telefone_nf: null,
            },
            match_cidade: null,
            receita,
          };
          console.log(`[agent] ✅ CNPJ manual ${cnpjLimpo} → Receita: ${receita.ok ? receita.razao_social : receita.motivo}`);
        } catch (cnpjErr) {
          console.error('[agent] ⚠️ Erro consultando CNPJ manual (não-bloqueante):', cnpjErr.message);
          validacaoNF = {
            nf_rejeitada: false,
            origem: 'cnpj_manual',
            dados: { cnpj: cnpjLimpo, cnpj_formatado: cnpjLimpo },
            receita: { ok: false, motivo: cnpjErr.message },
          };
        }
      }

      // ── 2. Validar fachada (obrigatória) — foto + Google Places ──
      let validacaoLoc = null;
      if (foto_fachada) {
        try {
          validacaoLoc = await validarLocalizacao(
            foto_fachada,
            parseFloat(motoboy_lat),
            parseFloat(motoboy_lng)
          );

          if (validacaoLoc && validacaoLoc.foto_rejeitada) {
            // Fachada inválida — BLOQUEAR (motoboy enviou fachada errada)
            console.log(`[agent] ❌ Foto fachada rejeitada: ${validacaoLoc.motivo}`);
            return res.status(400).json({
              sucesso: false,
              foto_rejeitada: true,
              motivo_rejeicao: validacaoLoc.motivo,
              erros: [validacaoLoc.motivo],
            });
          }

          if (validacaoLoc && validacaoLoc.valido) {
            console.log(`[agent] ✅ Fachada validada: "${validacaoLoc.nome_foto}" → "${validacaoLoc.match_google?.nome || 'N/A'}" (${validacaoLoc.confianca}%)`);
          } else if (validacaoLoc) {
            console.log(`[agent] ⚠️ Fachada não validada: ${validacaoLoc.motivo} — prosseguindo com aviso`);
          }
        } catch (valErr) {
          console.error('[agent] ⚠️ Erro validação fachada (não-bloqueante):', valErr.message);
        }
      }

      // ── 3. Cruzar tudo: NF + Receita + Fachada → score combinado ──
      let cruzamento = null;
      if (validacaoNF && !validacaoNF.nf_rejeitada) {
        cruzamento = cruzarValidacoes({
          nf: validacaoNF.dados,
          receita: validacaoNF.receita,
          fachada: validacaoLoc,
          localizacao_raw: String(localizacao_raw || '').trim(),  // 2026-04 v2: regra 6 (endereço NF ↔ digitado)
        });
        console.log(`[agent] 🧮 Cruzamento: ${cruzamento.resumo} | score_max=${cruzamento.score_max}% | salvar=${cruzamento.pode_salvar_no_banco}`);
      }

      // JSON pra coluna validacao_localizacao
      const validacaoLocJson = validacaoLoc ? JSON.stringify({
        valido: validacaoLoc.valido,
        nome_foto: validacaoLoc.nome_foto,
        match: validacaoLoc.match_google,
        confianca: validacaoLoc.confianca,
        motivo: validacaoLoc.motivo,
        lugares_proximos: validacaoLoc.lugares_proximos,
      }) : null;

      // JSON pra coluna validacao_nf — inclui dados NF + Receita + cruzamento + origem
      // 2026-04 v4: incluído `origem` para que o admin diferencie "foto enviada" (Gemini)
      // de "CNPJ digitado pelo motoboy" — antes ficava sempre como "EXTRAÍDO DA NF (IA)"
      // pois o JSON não persistia esse campo, só a variável em memória.
      const validacaoNfJson = validacaoNF ? JSON.stringify({
        origem: validacaoNF.origem || 'foto_nf',
        confianca: validacaoNF.confianca,
        match_cidade: validacaoNF.match_cidade,
        dados: validacaoNF.dados,
        receita: validacaoNF.receita,
        cruzamento,
      }) : null;

      // ── 4. Insere job na fila (Playwright vai processar a correção igual) ──
      // 🔍 DEBUG (remover depois): conferir foto_nf imediatamente antes do INSERT
      console.log(`[agent/DEBUG] 💾 PRE-INSERT OS=${os_numero} | foto_nf: tipo=${typeof foto_nf} truthy=${!!foto_nf} len=${foto_nf ? foto_nf.length : 0}`);

      // 2026-04: ALERT diagnóstico — Gemini processou OK mas foto sumiu antes do INSERT.
      // Cenário-alvo: Tela admin mostra dados extraídos mas "Sem foto da NF".
      // Causa mais provável: foto chegou cortada (rede 4G fraco) e o
      // foto_nf virou null/undefined em algum middleware. Loga DETALHADO pra
      // permitir investigar nos logs do Railway sem mudar comportamento.
      if (validacaoNF && validacaoNF.dados && validacaoNF.dados.cnpj && (!foto_nf || foto_nf.length < 100)) {
        console.error(
          `[agent/ALERT] ⚠️ FOTO_NF VAZIA APÓS GEMINI! ` +
          `OS=${os_numero} CNPJ=${validacaoNF.dados.cnpj_formatado} ` +
          `tipo=${typeof foto_nf} len=${foto_nf ? foto_nf.length : 0} ` +
          `origem=${validacaoNF.origem || 'foto_nf'} ` +
          `usuario=${usuarioNome}. ` +
          `IA extraiu mas foto não foi salva — verificar payload do request.`
        );
      }

      // Garante que foto_nf vai como null explícito (não undefined/string vazia) pro INSERT
      const fotoNfParaInsert = (foto_nf && typeof foto_nf === 'string' && foto_nf.length > 100) ? foto_nf : null;

      const { rows } = await pool.query(
        `INSERT INTO ajustes_automaticos (
           os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng,
           foto_fachada, foto_nf, status, usuario_id, usuario_nome, cod_profissional,
           validacao_localizacao, validacao_nf
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', $8, $9, $10, $11, $12)
         RETURNING id, status, criado_em`,
        [
          String(os_numero).trim(),
          parseInt(ponto, 10),
          String(localizacao_raw).trim(),
          parseFloat(motoboy_lat),
          parseFloat(motoboy_lng),
          foto_fachada || null,
          fotoNfParaInsert,
          usuarioId,
          usuarioNome,
          codProfissional,
          validacaoLocJson,
          validacaoNfJson,
        ]
      );

      const reg = rows[0];

      // 🔍 DEBUG (remover depois): confirmar gravação
      try {
        const c = await pool.query('SELECT (foto_nf IS NOT NULL) AS tem, LENGTH(foto_nf) AS tam FROM ajustes_automaticos WHERE id = $1', [reg.id]);
        console.log(`[agent/DEBUG] ✅ POS-INSERT id=${reg.id} OS=${os_numero} | foto_nf no banco: tem=${c.rows[0]?.tem} tam=${c.rows[0]?.tam}`);
      } catch(_) {}

      // ── 5. Se cruzamento confirmou (Receita ATIVA + score≥90), grava endereço no banco de consulta ──
      // Tabela alvo: solicitacao_favoritos (consultada pelo módulo Coleta).
      // É async/best-effort: se falhar, NÃO bloqueia a correção.
      // 2026-04 v2: critério de salvar mudou — agora é APENAS score≥90% das 6 regras.
      // Receita não é mais pré-requisito (pode ser null/baixada que ainda salva).
      // Dados oficiais (Receita) são usados quando disponíveis; senão, fallback pros dados da NF.
      let gravadoFavorito = false;
      try {
        if (cruzamento && cruzamento.pode_salvar_no_banco) {
          const r = (validacaoNF?.receita && validacaoNF.receita.ok) ? validacaoNF.receita : null;
          const nfDados = validacaoNF?.dados || {};
          // CNPJ: prioriza Receita; cai pra NF se não houver
          const cnpj = ((r && r.cnpj) || nfDados.cnpj || '').replace(/\D/g, '');

          if (cnpj.length === 14) {
            // grupo_enderecos_id: tenta achar pela região do motoboy (se ele tiver) — opcional, fica null se não houver
            let grupoId = null;
            if (codProfissional) {
              try {
                const grpQ = await pool.query(`
                  SELECT cr.grupo_enderecos_id
                    FROM coleta_regioes cr
                    JOIN crm_profissionais_regiao crm ON UPPER(crm.regiao) = UPPER(cr.nome) AND UPPER(crm.estado) = UPPER(cr.uf)
                   WHERE crm.cod_profissional = $1 AND cr.grupo_enderecos_id IS NOT NULL
                   LIMIT 1
                `, [codProfissional]).catch(() => ({ rows: [] }));
                grupoId = grpQ.rows[0]?.grupo_enderecos_id || null;
              } catch (_) { /* tabela CRM pode não existir, ignora */ }
            }

            // Dados pra gravar — Receita tem prioridade onde possível
            const razaoSocial    = (r && r.razao_social) || nfDados.razao_social || null;
            const nomeFantasia   = (r && r.nome_fantasia) || nfDados.nome_fantasia || null;
            const apelido        = nomeFantasia || razaoSocial || 'Estabelecimento';
            const enderecoCompleto = (r && r.endereco) || nfDados.endereco_nf || null;
            const logradouro     = (r && r.logradouro) || null;  // NF não separa, só Receita
            const numero         = (r && r.numero) || null;
            const complemento    = (r && r.complemento) || null;
            const bairro         = (r && r.bairro) || nfDados.bairro || null;
            const cidade         = (r && r.municipio) || nfDados.cidade_nf || null;
            const uf             = (r && r.uf) || nfDados.uf_nf || null;
            const cep            = (r && r.cep) || nfDados.cep_nf || null;
            // Telefone NF tem prioridade (mais específico do cliente naquela entrega)
            const telefone       = nfDados.telefone_nf || (r && r.telefone) || null;

            // UPSERT: se CNPJ + grupo já existe, ignora (UNIQUE constraint cuida disso)
            await pool.query(`
              INSERT INTO solicitacao_favoritos (
                grupo_enderecos_id, apelido, endereco_completo,
                rua, numero, complemento, bairro, cidade, uf, cep,
                latitude, longitude, telefone_padrao, procurar_por_padrao,
                cnpj, razao_social, nome_fantasia
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17
              )
              ON CONFLICT DO NOTHING
            `, [
              grupoId, apelido, enderecoCompleto,
              logradouro, numero, complemento, bairro, cidade, uf, cep,
              parseFloat(motoboy_lat), parseFloat(motoboy_lng),
              telefone, apelido,
              cnpj, razaoSocial, nomeFantasia
            ]);
            gravadoFavorito = true;
            console.log(`[agent] 💾 Endereço ${apelido} (CNPJ ${cnpj}) salvo em solicitacao_favoritos (score=${cruzamento.score_max}%)`);
          } else {
            console.log(`[agent] ⚠️ score≥90% mas CNPJ inválido — não gravado em solicitacao_favoritos`);
          }
        }
      } catch (favErr) {
        console.error('[agent] ⚠️ Erro gravando favorito (não-bloqueante):', favErr.message);
      }

      // 🔔 Notificar admin via WebSocket
      if (typeof global.broadcastToAdmins === 'function') {
        const wsPayload = {
          id: reg.id,
          os_numero: String(os_numero).trim(),
          cod_profissional: codProfissional,
          usuario_nome: usuarioNome,
          validacao: validacaoLoc ? {
            valido: validacaoLoc.valido,
            nome_foto: validacaoLoc.nome_foto,
            match: validacaoLoc.match_google,
            confianca: validacaoLoc.confianca,
            motivo: validacaoLoc.motivo,
          } : null,
          // 2026-04: dados da Receita + cruzamento na notificação admin
          nf: validacaoNF ? {
            cnpj: validacaoNF.dados?.cnpj_formatado,
            confianca: validacaoNF.confianca,
          } : null,
          receita: validacaoNF?.receita?.ok ? {
            razao_social: validacaoNF.receita.razao_social,
            nome_fantasia: validacaoNF.receita.nome_fantasia,
            situacao: validacaoNF.receita.situacao,
            ativa: validacaoNF.receita.ativa,
          } : null,
          cruzamento: cruzamento ? {
            score_max: cruzamento.score_max,
            scores: cruzamento.scores,
            salvo_no_banco: gravadoFavorito,
          } : null,
        };
        global.broadcastToAdmins('AGENT_VALIDACAO', wsPayload);
      }

      return res.status(201).json({
        id: reg.id,
        status: reg.status,
        mensagem: 'Solicitação recebida, processando...',
        validacao_localizacao: validacaoLoc ? {
          valido: validacaoLoc.valido,
          nome_foto: validacaoLoc.nome_foto,
          match_google: validacaoLoc.match_google,
          confianca: validacaoLoc.confianca,
          motivo: validacaoLoc.motivo,
          alerta: !validacaoLoc.valido,
        } : null,
        // 2026-04: confirmação Receita Federal pro motoboy
        nota_fiscal: validacaoNF && !validacaoNF.nf_rejeitada ? {
          cnpj: validacaoNF.dados?.cnpj_formatado,
          confianca: validacaoNF.confianca,
        } : null,
        receita: validacaoNF?.receita?.ok ? {
          razao_social: validacaoNF.receita.razao_social,
          nome_fantasia: validacaoNF.receita.nome_fantasia,
          situacao: validacaoNF.receita.situacao,
          ativa: validacaoNF.receita.ativa,
          endereco: validacaoNF.receita.endereco,
          telefone: validacaoNF.receita.telefone,
        } : null,
        cruzamento: cruzamento ? {
          score_max: cruzamento.score_max,
          scores: cruzamento.scores,
          mensagem: cruzamento.mensagem_motoboy,
          salvo_no_banco: gravadoFavorito,
        } : null,
      });
    } catch (err) {
      console.error('[agent/corrigir-endereco]', err.message);
      return res.status(500).json({ sucesso: false, erro: 'Erro interno ao enfileirar.' });
    }
  });

  // 2026-04 v4: POST /agent/validar-foto-nf-preview
  // Pré-validação RÁPIDA da foto da NF antes do submit final.
  // Usado pelo camera coaching no frontend pra guiar o motoboy.
  // NÃO grava nada no banco — só roda Gemini Flash Lite e retorna feedback.
  router.post('/validar-foto-nf-preview', async (req, res) => {
    const { foto } = req.body || {};

    if (!foto || typeof foto !== 'string') {
      return res.status(400).json({
        ok: false,
        erro: 'Campo "foto" obrigatório (base64 da imagem).'
      });
    }

    if (foto.length > 7_000_000) {
      return res.status(400).json({
        ok: false,
        erro: 'Foto muito grande. Máximo 5MB.'
      });
    }

    try {
      const resultado = await validarFotoNfPreview(foto);
      return res.json(resultado);
    } catch (err) {
      console.error('[agent/validar-foto-nf-preview]', err.message);
      // Em caso de erro, falha ABERTA (motoboy pode tentar enviar mesmo assim)
      return res.json({
        ok: true,
        qualidade: 'media',
        eh_nota_fiscal: true,
        cnpj_legivel: false,
        cnpj_lido: null,
        problemas: [],
        dica: null,
        erro: 'erro_interno_preview',
      });
    }
  });

  // GET /agent/status/:id
  router.get('/status/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status, detalhe_erro, criado_em, processado_em, valores_antes, valores_depois, etapa_atual, progresso
         FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('[agent/status]', err.message);
      return res.status(500).json({ erro: 'Erro ao consultar status.' });
    }
  });

  // GET /agent/foto/:id
  router.get('/foto/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_fachada FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0 || !rows[0].foto_fachada) {
        return res.status(404).json({ erro: 'Foto não encontrada.' });
      }
      return res.json({ foto: rows[0].foto_fachada });
    } catch (err) {
      console.error('[agent/foto]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto.' });
    }
  });


  // Screenshots debug (temporario - acesso via chave)
  const SDIR = '/tmp/screenshots';
  const SKEY = process.env.SCREENSHOT_KEY || 'tutts-debug-2025';

  router.get('/screenshots', async (req, res) => {
    if (req.query.key !== SKEY) return res.status(403).json({ erro: 'Use ?key=CHAVE' });
    try {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(SDIR)) return res.json({ total: 0, files: [] });
      const files = fs.readdirSync(SDIR).filter(f => f.endsWith('.png')).sort((a, b) => b.localeCompare(a));
      const k = SKEY;
      const html = '<html><head><title>Screenshots</title><style>body{font-family:sans-serif;padding:20px;background:#111;color:#eee}img{max-width:100%;border:1px solid #333;border-radius:8px;margin:8px 0}.c{background:#1a1a2e;padding:12px;border-radius:8px;margin:12px 0}h2{color:#a78bfa;font-size:13px}</style></head><body><h1>Screenshots (' + files.length + ')</h1>' + files.map(function(f){return '<div class=c><h2>' + f + '</h2><img src=/api/agent/screenshots/' + encodeURIComponent(f) + '?key=' + k + ' loading=lazy></div>'}).join('') + '</body></html>';
      res.type('html').send(html);
    } catch(e) { res.status(500).json({erro:e.message}); }
  });

  router.get('/screenshots/:filename', async (req, res) => {
    if (req.query.key !== SKEY) return res.status(403).json({ erro: 'Acesso negado' });
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(SDIR, req.params.filename);
      if (!fs.existsSync(file)) return res.status(404).json({ erro: 'Nao encontrada' });
      res.type('image/png').sendFile(file);
    } catch(e) { res.status(500).json({erro:e.message}); }
  });

  return router;
}

module.exports = { createCorrecaoRoutes, haversineKm, RAIO_MAXIMO_KM };
