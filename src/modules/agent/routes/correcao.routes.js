/**
 * routes/correcao.routes.js
 * POST /agent/corrigir-endereco
 * GET  /agent/status/:id
 * GET  /agent/foto/:id
 */

'use strict';

const express = require('express');
// AGENTE_BCE_V1 (import) — a foto saiu do fluxo.
// validarLocalizacao (Gemini Vision) NAO e mais chamada aqui. Do modulo de
// localizacao sobra so a busca de estabelecimentos proximos, que alimenta o
// Path C e nao depende de foto nenhuma. O arquivo continua existindo porque o
// modulo coletaEnderecos ainda usa o caminho com foto.
const { buscarEstabelecimentosProximos } = require('../validar-localizacao');
// 2026-04: cruzamento com Receita Federal
// AGENTE_BCE_V1: precisaConsultarGoogle e o gate de custo do Places.
const { cruzarValidacoes, precisaConsultarGoogle } = require('../cruzar-validacoes');
// 2026-04 v3: consulta Receita direto quando motoboy digita CNPJ
const { consultarReceita } = require('../consultar-receita');

// ── 2026-05: Geocoding helpers para Path B (distância Receita↔GPS) e Path F (CEP) ──
// 🔄 2026-05-23: Migrado pro helper compartilhado que usa cache enderecos_geocodificados.
// Antes: chamava maps.googleapis.com direto, ignorando cache → desperdício de US$.
// Agora: passa pelo geocodeHelper centralizado.
// AGENTE_BCE_V1 (geocode): so o forward. O geocodeReverse era usado unicamente
// pela reverseGeocodeCep, que saiu junto com o Path F.
const { geocodeForward } = require('../../../shared/geocodeHelper');

async function geocodarEndereco(pool, enderecoTexto) {
  const r = await geocodeForward(pool, enderecoTexto, { source: 'agent-correcao-forward' });
  return r ? { lat: r.latitude, lng: r.longitude } : null;
}

// AGENTE_BCE_V1 (cep morto) — reverseGeocodeCep() foi removida.
//
// Ela existia por dois motivos, e os dois morreram junto com a reforma:
//   1. alimentar o Path F (CEP Receita == CEP do GPS), que saiu da regra;
//   2. servir de gate de custo do Google Places, papel que agora e do
//      precisaConsultarGoogle() em cruzar-validacoes.js.
//
// Ficar no arquivo sem caller nao e neutro: e uma funcao que bate no Google com
// a API key na mao, esperando o proximo a achar que ela ainda serve pra alguma
// coisa. Some tambem a chamada de reverse geocoding por correcao.

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

// 2026-06 v6: gate agora eh SO cnpj_manual (fluxo foto NF aposentado).
// foto_fachada continua sendo SEMPRE obrigatoria.
function validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada, cnpj_manual }) {
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

  // 2026-06 v6: CNPJ obrigatorio sempre (gate SO cnpj_manual).
  const cnpjDigitos = String(cnpj_manual || '').replace(/\D/g, '');
  if (cnpjDigitos.length === 0) {
    erros.push('Digite o CNPJ do cliente.');
  } else if (!validarCNPJ(cnpj_manual)) {
    erros.push('CNPJ inválido. Confira os dígitos.');
  }

  // AGENTE_BCE_V1 (entrada) — foto da fachada NAO e mais exigida nem usada.
  // O parametro continua na assinatura porque o app antigo ainda manda o campo
  // ate o deploy do front; ele e ignorado e nao e gravado.

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
    const { os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada, cnpj_manual } = req.body || {};

    const erros = validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada, cnpj_manual });
    if (erros.length > 0) {
      return res.status(400).json({ sucesso: false, erros });
    }

    try {
      // AGENTE_BCE_V1 (tamanho) — a checagem de tamanho da foto saiu junto com a
      // foto. Nada mais le foto_fachada: recusar por tamanho um campo ignorado
      // so barraria motoboy por um dado que nao usamos.

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

      // ── 1. Obter dados do cliente via CNPJ digitado (consulta Receita) ──
      // 2026-06 v6: caminho foto NF removido; motoboy sempre digita o CNPJ.
      let validacaoNF = null;

      if (cnpj_manual) {
        // CNPJ digitado pelo motoboy → consulta Receita direto, sem Gemini.
        // A consulta Receita traz razão_social, nome_fantasia, endereco etc. oficialmente.
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

      // AGENTE_BCE_V1 (fluxo) — o miolo da validacao, sem foto.
      //
      // O QUE SAIU DAQUI:
      //   - o GATE DE CUSTO por CEP: ele existia pra decidir se valia pagar o
      //     Google Places na validacao da FACHADA. Sem fachada, quem decide isso
      //     e o precisaConsultarGoogle(), que olha a propria regra de aprovacao.
      //     O reverseGeocodeCep saiu junto — era uma chamada de geocoding por
      //     correcao alimentando o Path F, que morreu.
      //   - validarLocalizacao() (Gemini Vision) e o 400 de foto_rejeitada.
      //
      // validacaoLoc fica declarada e SEMPRE null de proposito: meia duzia de
      // trechos abaixo (JSON da coluna, payload do WS, resposta 201) leem
      // `validacaoLoc ? {...} : null` e continuam corretos sem alteracao.
      const validacaoLoc = null;

      // ── 3. Cruzar: Receita + GPS + endereco digitado → 3 conferencias (B/C/E) ──
      // Motoboy DIGITA o CNPJ; a Receita e a fonte da verdade. B mede presenca
      // fisica, C e E confirmam de quem e o lugar.
      let cruzamento = null;
      if (validacaoNF && !validacaoNF.nf_rejeitada) {
        const receita = validacaoNF.receita;
        let distanciaReceitaGps;

        // 3a. Geocoda o endereco da Receita pra medir a distancia ate o GPS (Path B).
        //     Sem isso nao ha B, e sem B nada libera — por isso o resultado null
        //     vira "nao deu pra checar" na tela do motoboy, nao "voce errou".
        if (receita && receita.ok && receita.endereco && Number.isFinite(parseFloat(motoboy_lat)) && Number.isFinite(parseFloat(motoboy_lng))) {
          try {
            const geoReceita = await geocodarEndereco(pool, receita.endereco);
            if (geoReceita) {
              const { distanciaMetros } = require('../cruzar-validacoes');
              distanciaReceitaGps = distanciaMetros(geoReceita.lat, geoReceita.lng, motoboy_lat, motoboy_lng);
              // Anota lat/lng da Receita pra exibir/auditar depois
              receita.lat = geoReceita.lat;
              receita.lng = geoReceita.lng;
              console.log(`[agent] 📍 Receita geocodada: ${geoReceita.lat.toFixed(6)},${geoReceita.lng.toFixed(6)} | distância até GPS: ${distanciaReceitaGps}m`);
            } else {
              console.log(`[agent] ⚠️ Não conseguimos geocodar endereço da Receita`);
            }
          } catch (geoErr) {
            console.error(`[agent] ⚠️ Erro geocoding Receita (não-bloqueante):`, geoErr.message);
          }
        }

        // 3b. Google Places (Path C) — SO quando a resposta muda a decisao.
        //     Longe demais → barra de qualquer jeito. E ja confirmando → nao
        //     precisa. O resto paga. E a unica chamada paga desta rota.
        let lugaresProximos = [];
        // REGRA_B_RESGATE_V1: localizacao_raw saiu da chamada. Ela NAO e um
        // endereco — e a coordenada crua do GPS ("-12.962936, -38.469274"), montada
        // no front pelo botao "Enviar minha localização atual". Passar isso pra uma
        // comparacao de endereco so produzia 7% e a ilusao de um sinal.
        const precisaGoogle = precisaConsultarGoogle({
          receita,
          motoboy_lat: parseFloat(motoboy_lat),
          motoboy_lng: parseFloat(motoboy_lng),
          distancia_receita_gps: distanciaReceitaGps,
        });
        if (precisaGoogle) {
          try {
            lugaresProximos = await buscarEstabelecimentosProximos(
              parseFloat(motoboy_lat), parseFloat(motoboy_lng), 500
            );
            console.log(`[agent] 🔎 Places: ${lugaresProximos.length} estabelecimento(s) no ponto do motoboy`);
          } catch (placesErr) {
            console.error('[agent] ⚠️ Places falhou (não-bloqueante):', placesErr.message);
          }
        } else {
          console.log('[agent] 💰 Places dispensado — a resposta dele não mudaria a decisão');
        }

        // REGRA_B_RESGATE_V1: idem — sem localizacao_raw. O que decide e a
        // distancia (B) e, na faixa de resgate, o Google (C).
        cruzamento = cruzarValidacoes({
          receita,
          motoboy_lat: parseFloat(motoboy_lat),
          motoboy_lng: parseFloat(motoboy_lng),
          distancia_receita_gps: distanciaReceitaGps,
          lugares_proximos: lugaresProximos,
        });
        console.log(`[agent] 🧮 Cruzamento: ${cruzamento.resumo} | score_max=${cruzamento.score_max}% | caminho=${cruzamento.caminho_aprovacao || 'nenhum'} | salvar=${cruzamento.pode_salvar_no_banco}`);

        // 2026-06 v6: BLOQUEIO REAL — barra o envio quando nenhuma rota validou.
        if (cruzamento.barrar) {
          console.log(`[agent] 🚫 Correção BARRADA (OS ${os_numero} P${ponto}): ${cruzamento.motivo_bloqueio}`);

          // ══════════════════════════════════════════════════════════════════
          // BARRADO_HISTORICO_V1 — a tentativa barrada vira LINHA no banco.
          //
          // Antes ela morria aqui: o 400 sai no passo 3 e o INSERT so acontece no
          // passo 4. Resultado: a aba "Solicitacoes Barradas" so mostrava correcao
          // que ENTROU e quebrou depois no Playwright — justamente as que a regra
          // reprovou, que sao as que interessam, nunca apareciam. Quem barrou mais
          // e por que era pergunta sem resposta possivel.
          //
          // status='barrado' e um estado TERMINAL e NAO e job: nao entra em
          // ('pendente','processando'), entao nao trava o motoboy de tentar de novo
          // — cada tentativa vira uma linha, que e exatamente o historico.
          //
          // Guardamos o cruzamento inteiro no validacao_nf (scores + checks +
          // distancia + Receita). O painel admin ve o numero; o motoboy nao.
          //
          // Best-effort de proposito: se o INSERT falhar, o motoboy TEM que receber
          // o 400 do mesmo jeito. Falha de auditoria nao pode virar corrida
          // liberada.
          try {
            const { rows: rowsBarrado } = await pool.query(
              `INSERT INTO ajustes_automaticos (
                 os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng,
                 status, detalhe_erro, erro,
                 usuario_id, usuario_nome, cod_profissional,
                 validacao_nf, finalizado_em
               ) VALUES ($1, $2, $3, $4, $5, 'barrado', $6, $7, $8, $9, $10, $11, NOW())
               RETURNING id`,
              [
                String(os_numero).trim(),
                pontoNum,
                String(localizacao_raw).trim(),
                parseFloat(motoboy_lat),
                parseFloat(motoboy_lng),
                cruzamento.motivo_bloqueio,
                cruzamento.indisponivel ? 'validacao_indisponivel' : 'validacao_reprovou',
                usuarioId,
                usuarioNome,
                codProfissional,
                JSON.stringify({
                  origem: validacaoNF.origem || 'cnpj_manual',
                  dados: validacaoNF.dados,
                  receita: validacaoNF.receita,
                  cruzamento,
                }),
              ]
            );
            console.log(`[agent] 📝 Barrada registrada (id=${rowsBarrado[0].id})`);
          } catch (barrErr) {
            console.error('[agent] ⚠️ Falha ao registrar a barrada (não-bloqueante):', barrErr.message);
          }
          // ══════════════════════════════════════════════════════════════════
          // AGENTE_BCE_V1 (resposta) — a tela do motoboy desenha `checks`.
          //
          // Antes ia so `scores`, e o front nao sabia o que fazer com numero: caia
          // no ecra generico de "Foto Invalida" ate quando o problema era o CNPJ.
          // `checks` ja vem com o texto e o status (ok|falhou|nd) de cada
          // conferencia — o front so pinta.
          //
          // `indisponivel` separa "nao deu pra checar" (geocoding fora) de "voce
          // errou". Sem a foto como rede, um apagao de infra barra o motoboy; ele
          // merece ler que nao e culpa dele, e um botao de tentar de novo.
          //
          // De proposito NAO mandamos distancia_metros nem os scores crus pro
          // motoboy: numero na tela vira jogo (ele anda ate o score subir) e
          // ensina onde fica o endereco da Receita. O painel admin ve tudo.
          return res.status(400).json({
            sucesso: false,
            validacao_rejeitada: true,
            indisponivel: cruzamento.indisponivel,
            // CNPJ_CODIGO_V1: 'presenca' | 'cnpj_nao_encontrado' | 'indisponivel'.
            // A tela escolhe titulo/icone/instrucao por ESTE campo. `indisponivel`
            // continua indo pra nao quebrar app que ainda nao atualizou.
            codigo_bloqueio: cruzamento.codigo_bloqueio,
            motivo_rejeicao: cruzamento.motivo_bloqueio,
            checks: cruzamento.checks,
            // BARRADO_CNPJ_V1 — o CNPJ e a razao social vao pra tela.
            //
            // O CNPJ sai do validacaoNF.dados, nao do receita: `dados.cnpj` e o que
            // ELE DIGITOU (so limpo de pontuacao), e existe sempre. O receita.cnpj so
            // existe quando a consulta deu certo — ou seja, na tela 'indisponivel'
            // (Receita fora do ar) o card ficaria vazio justamente na hora em que o
            // motoboy mais precisa conferir o que digitou.
            //
            // A razao social e o unico jeito de ele descobrir sozinho que digitou o
            // CNPJ da loja errada — hoje isso vira ligacao pro suporte. Nao vaza nada:
            // o CNPJ e dele e o nome e publico na Receita. O ENDERECO da Receita
            // continua fora da resposta, que era o que nao podiamos entregar.
            cnpj: (validacaoNF.dados && validacaoNF.dados.cnpj)
              || (validacaoNF.receita && validacaoNF.receita.cnpj)
              || null,
            razao_social: (validacaoNF.receita && validacaoNF.receita.ok)
              ? (validacaoNF.receita.razao_social || validacaoNF.receita.nome_fantasia || null)
              : null,
            erros: [cruzamento.motivo_bloqueio],
          });
        }
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
      // 2026-06 v6: foto_nf sempre null (fluxo foto NF aposentado). Coluna mantida
      // no banco apenas para exibir registros legados no historico admin.
      const fotoNfParaInsert = null;

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
          // AGENTE_BCE_V1 (insert) — foto_fachada sempre null: ela saiu do fluxo.
          // A coluna fica no banco pra exibir registro antigo no historico admin,
          // igual ja tinha sido feito com foto_nf. Gravar base64 de uma foto que
          // ninguem le seria pagar armazenamento por enfeite.
          null,
          fotoNfParaInsert,
          usuarioId,
          usuarioNome,
          codProfissional,
          validacaoLocJson,
          validacaoNfJson,
        ]
      );

      const reg = rows[0];

      // AGENTE_BCE_V1 (debug) — o SELECT de debug do foto_nf saiu. Ele rodava uma
      // query por correcao so pra logar que a coluna estava null, o que agora e a
      // regra e nao mais uma duvida. O proprio comentario pedia "remover depois".

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


  // GET /agent/status/:id
  router.get('/status/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status, detalhe_erro, criado_em, processado_em, valores_antes, valores_depois, etapa_atual, progresso, bloqueio_loja
         FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      const out = rows[0];
      // 2026-07: se bloqueado por cliente, anexa o numero de suporte pro botao WhatsApp
      if (out.status === 'bloqueado_cliente') {
        try {
          const cfg = await pool.query(`SELECT numero_suporte FROM ajuste_bloqueio_config WHERE id = 1`);
          out.numero_suporte = cfg.rows[0]?.numero_suporte || null;
        } catch (_) {}
      }
      return res.json(out);
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
