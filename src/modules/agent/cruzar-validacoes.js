/**
 * cruzar-validacoes.js (2026-07 v7 — AGENTE_BCE_V1: sem foto, 3 conferências)
 *
 * O QUE MUDOU DA v6.2 (e por quê)
 *
 * A foto da fachada saiu do fluxo. Com ela foram embora o Gemini e TODOS os
 * paths que liam a imagem:
 *   A  Fachada ↔ Google Places        (era a rota de aprovação visual)
 *   D  Nome Receita ↔ Nome na fachada
 *   G  Nome Receita ↔ textos da fachada
 *   —  CNPJ nos textos da fachada
 * Foram junto, por decisão de produto, dois que não usavam foto:
 *   F  CEP Receita ↔ CEP do GPS
 *   K  Número do logradouro ↔ endereço digitado
 *
 * SOBRARAM TRÊS, e é só isso que decide:
 *   B — Endereço oficial (CNPJ na Receita) ≈ GPS do motoboy
 *   C — Nome oficial (Receita) ↔ o que o Google Places vê naquele ponto
 *   E — Endereço oficial (Receita) ↔ endereço que o motoboy digitou
 *
 * A REGRA:
 *   libera = (distância <= DIST_MAX_METROS) E (C >= 80 OU E >= 80)
 *   barra  = qualquer outra coisa (fail-CLOSED)
 *
 * POR QUE O B É OBRIGATÓRIO E NÃO ENTRA NO "OU":
 * Sem a foto, o B é o ÚNICO sinal com prova física. O C o motoboy escolhe (ele
 * digita o CNPJ) e o E ele escolhe DOS DOIS LADOS (digita o CNPJ e digita o
 * endereço). Se o E aprovasse sozinho, bastava copiar o endereço da Receita no
 * campo do endereço novo pra liberar uma correção de casa, sem sair da cama. O
 * B amarra a correção a um lugar no mundo; C e E confirmam QUAL lugar é.
 *
 * POR QUE O B É EM METROS E NÃO EM "80%":
 * scoreDistancia() tem teto 90 e cauda longa de propósito (drift de GPS +
 * geocoding de telhado). Nessa curva, "B >= 80" significaria 35 metros — e 35m
 * não existe em galeria, centro comercial ou rua com prédio alto: barraria
 * motoboy honesto em massa. O corte é uma DISTÂNCIA explícita; o score continua
 * existindo, mas só pra exibir no painel.
 *
 * C e E seguem em 80 porque são similaridade de texto numa escala 0-100 — ali o
 * 80 quer dizer alguma coisa.
 */

'use strict';

// ───────── Parâmetros da decisão ─────────

/** Distância máxima (metros) entre o GPS do motoboy e o endereço da Receita. */
const DIST_MAX_METROS = 100;

/** Corte de similaridade de texto (0-100) pros paths C e E. */
const LIMIAR_TEXTO = 80;

// ───────── Helpers de string ─────────

function normalizar(s) {
  if (!s) return '';
  let r = String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\-/\\()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  r = r.replace(/\s+(ltda|s\/?a|eireli|me|epp|mei|cia)\.?$/g, '').trim();
  return r;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const v0 = new Array(n + 1);
  const v1 = new Array(n + 1);
  for (let i = 0; i <= n; i++) v0[i] = i;
  for (let i = 0; i < m; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= n; j++) v0[j] = v1[j];
  }
  return v1[n];
}

/**
 * Similaridade 0-100 entre dois textos. Combina Levenshtein com substring —
 * "MR PEÇAS" dentro de "MR PEÇAS E SERVIÇOS LTDA" precisa pontuar alto mesmo
 * com distância de edição grande.
 */
function scoreSimilaridade(s1, s2) {
  const a = normalizar(s1);
  const b = normalizar(s2);
  if (!a || !b) return 0;
  if (a === b) return 100;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const lev = Math.max(0, 100 - (dist / maxLen) * 100);

  let sub = 0;
  const menor = a.length <= b.length ? a : b;
  const maior = a.length <= b.length ? b : a;
  if (menor.length >= 4 && maior.includes(menor)) {
    sub = Math.round(85 + 15 * (menor.length / maior.length));
  }

  return Math.round(Math.max(lev, sub));
}

/**
 * Compara dois endereços livres. Tira CEP, UF e ruído de formatação antes —
 * senão dois endereços da mesma rua pontuam alto só por causa do "- BA, 42700".
 */
function scoreEndereco(end1, end2) {
  const limpar = (e) => String(e || '')
    .replace(/\b\d{5}-?\d{3}\b/g, ' ')
    .replace(/\b(brasil|brazil)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return scoreSimilaridade(limpar(end1), limpar(end2));
}

// ───────── Helpers de geo ─────────

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const a = parseFloat(lat1), b = parseFloat(lng1);
  const c = parseFloat(lat2), d = parseFloat(lng2);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return null;
  const R = 6371000;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const lat1r = toRad(a), lat2r = toRad(c);
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(sa)));
}

/**
 * Distância em metros → score 0-90 (teto 90 de propósito: nunca é certeza).
 *  <=15m → 90 | 15-200m → degrade linear | >=200m → 0
 *
 * AGENTE_BCE_V1: este score NÃO decide mais nada — quem decide é
 * DIST_MAX_METROS. Ele fica pro painel e pro pode_salvar_no_banco.
 */
function scoreDistancia(metros) {
  if (metros === null || metros === undefined) return 0;
  if (metros <= 15) return 90;
  if (metros >= 200) return 0;
  return Math.round(90 * (200 - metros) / 185);
}

// ───────── Cálculo dos três sinais ─────────

/** Nomes oficiais do CNPJ: fantasia E razão (o cliente pode ser conhecido por qualquer um). */
function nomesDaReceita(receita) {
  const out = [];
  if (receita && receita.nome_fantasia) out.push(receita.nome_fantasia);
  if (receita && receita.razao_social) out.push(receita.razao_social);
  return out;
}

/**
 * Path C — nome oficial ↔ estabelecimentos que o Google vê no ponto do GPS.
 *
 * Mudou da v6.2: antes comparava com UM lugar só (o que casou com o nome lido
 * na foto pelo Gemini). Sem foto, compara com TODOS os vizinhos e fica com o
 * melhor. É mais honesto com a pergunta "o Google conhece essa empresa aqui?".
 *
 * @returns {number|undefined} undefined = não deu pra calcular (sem lugares)
 */
function calcularC(receita, lugares_proximos) {
  const nomes = nomesDaReceita(receita);
  const lugares = Array.isArray(lugares_proximos) ? lugares_proximos.filter(Boolean) : [];
  if (nomes.length === 0 || lugares.length === 0) return undefined;

  let best = 0;
  for (const lugar of lugares) {
    const nomeLugar = (lugar && (lugar.nome || lugar.displayName)) || '';
    if (!nomeLugar) continue;
    for (const n of nomes) {
      best = Math.max(best, scoreSimilaridade(n, nomeLugar));
      if (best >= 100) return 100;
    }
  }
  return best;
}

/** Path E — endereço oficial ↔ endereço digitado. undefined = não dá pra comparar. */
function calcularE(receita, localizacao_raw) {
  if (!receita || !receita.endereco || !localizacao_raw) return undefined;
  return scoreEndereco(receita.endereco, localizacao_raw);
}

/** Distância Receita↔GPS: usa a que veio pronta ou calcula do lat/lng da Receita. */
function calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps }) {
  if (distancia_receita_gps !== undefined && distancia_receita_gps !== null) {
    return distancia_receita_gps;
  }
  if (receita && Number.isFinite(parseFloat(receita.lat)) && Number.isFinite(parseFloat(receita.lng))) {
    return distanciaMetros(receita.lat, receita.lng, motoboy_lat, motoboy_lng);
  }
  return null;
}

// ───────── Gate de custo ─────────

/**
 * O Google Places é a única parte PAGA desta validação (~US$0.032 por miss de
 * cache). Esta função existe pra não pagar por resposta que não muda a decisão:
 *
 *   distância > limite  → barra de qualquer jeito       → não paga
 *   E >= 80             → já tem a confirmação que falta → não paga
 *   resto               → o C é o desempate             → paga
 *
 * Fica AQUI, e não na rota, pra regra viver num arquivo só: quem decide o que
 * aprova é quem sabe dizer de que dado a decisão precisa.
 *
 * @returns {boolean}
 */
function precisaConsultarGoogle({ receita, localizacao_raw, motoboy_lat, motoboy_lng, distancia_receita_gps }) {
  const dist = calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps });
  if (dist === null || dist > DIST_MAX_METROS) return false;

  const E = calcularE(receita, localizacao_raw);
  if (typeof E === 'number' && E >= LIMIAR_TEXTO) return false;

  return true;
}

// ───────── Função principal ─────────

/**
 * @param {object}   p
 * @param {object}   p.receita              retorno de consultarReceita (pode ter .lat/.lng)
 * @param {string}   p.localizacao_raw      endereço digitado pelo motoboy
 * @param {number}   p.motoboy_lat
 * @param {number}   p.motoboy_lng
 * @param {number}  [p.distancia_receita_gps] metros, se já calculado pela rota
 * @param {Array}   [p.lugares_proximos]     saída de buscarEstabelecimentosProximos
 */
function cruzarValidacoes({
  receita,
  localizacao_raw,
  motoboy_lat,
  motoboy_lng,
  distancia_receita_gps,
  lugares_proximos,
}) {
  const scores = {};

  // ── B: endereço da Receita ≈ GPS ──
  const distancia = calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps });
  if (distancia !== null && distancia !== undefined) {
    scores.endereco_receita_vs_gps = scoreDistancia(distancia);
  }

  // ── C: nome da Receita ↔ Google Places ──
  const C = calcularC(receita, lugares_proximos);
  if (C !== undefined) scores.nome_receita_vs_google = C;

  // ── E: endereço da Receita ↔ endereço digitado ──
  const E = calcularE(receita, localizacao_raw);
  if (E !== undefined) scores.endereco_receita_vs_motoboy = E;

  // ── Decisão ──
  const temDistancia = distancia !== null && distancia !== undefined;
  const presencaOk = temDistancia && distancia <= DIST_MAX_METROS;
  const confirmaC = typeof C === 'number' && C >= LIMIAR_TEXTO;
  const confirmaE = typeof E === 'number' && E >= LIMIAR_TEXTO;
  const liberado = presencaOk && (confirmaC || confirmaE);
  const barrar = !liberado;

  // indisponivel: barrou por FALTA DE DADO, não por culpa do motoboy.
  // Só o B entra aqui: sem distância não há como checar presença, e não existe
  // nada que ele possa digitar diferente pra resolver. C e E ausentes ainda
  // deixam ele agir (conferir o CNPJ, corrigir o endereço).
  const indisponivel = barrar && !temDistancia;

  // ── Status por conferência (é o que a tela do motoboy desenha) ──
  const st = (ok, calculavel) => (!calculavel ? 'nd' : (ok ? 'ok' : 'falhou'));
  const checks = [
    {
      id: 'B',
      chave: 'endereco_receita_vs_gps',
      label: 'Você está no endereço desse CNPJ',
      status: st(presencaOk, temDistancia),
    },
    {
      id: 'C',
      chave: 'nome_receita_vs_google',
      label: 'O Google conhece essa empresa aqui',
      status: st(confirmaC, typeof C === 'number'),
    },
    {
      id: 'E',
      chave: 'endereco_receita_vs_motoboy',
      label: 'O endereço que você digitou é o desse CNPJ',
      status: st(confirmaE, typeof E === 'number'),
    },
  ];

  // ── Compat: campos que o resto do módulo já lê ──
  const valores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = valores.length > 0 ? Math.max(...valores) : 0;
  const receita_max = score_max;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);
  const pode_salvar_no_banco = pelo_menos_um_90;

  const labels = {
    endereco_receita_vs_gps:     'Endereço Receita↔GPS',
    nome_receita_vs_google:      'Nome Receita↔Google',
    endereco_receita_vs_motoboy: 'Endereço Receita↔Motoboy',
  };

  let caminho_aprovacao = null;
  if (liberado) {
    caminho_aprovacao = confirmaC ? labels.nome_receita_vs_google : labels.endereco_receita_vs_motoboy;
  }

  // ── Motivo do bloqueio: uma frase, e ela tem que dizer o que FAZER ──
  let motivo_bloqueio = null;
  if (indisponivel) {
    motivo_bloqueio =
      'Não conseguimos consultar os dados agora. Não é erro seu — tente de novo em um minuto.';
  } else if (barrar && !presencaOk) {
    motivo_bloqueio =
      'Você não está no endereço desse CNPJ. Confira se o CNPJ é o da loja onde você está agora.';
  } else if (barrar) {
    motivo_bloqueio =
      'Não confirmamos que esse CNPJ é o dessa loja. Confira o CNPJ e o endereço que você digitou.';
  }

  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (liberado) {
      mensagem_motoboy = `✅ ${nome} confirmado (${caminho_aprovacao || 'validação cruzada'})`;
    } else {
      mensagem_motoboy = `ℹ️ ${nome} encontrado na Receita`;
    }
  } else if (receita) {
    mensagem_motoboy = `⚠️ Não consultamos a Receita: ${receita.motivo || 'erro desconhecido'}`;
  }

  const resumoPartes = Object.entries(scores).map(([k, v]) => `${labels[k] || k}: ${v}%`);
  if (temDistancia) resumoPartes.push(`distância: ${distancia}m`);

  return {
    scores,
    checks,
    score_max,
    receita_max,
    pelo_menos_um_90,
    receita_ativa,
    pode_salvar_no_banco,
    liberado,
    barrar,
    indisponivel,
    motivo_bloqueio,
    caminho_aprovacao,
    mensagem_motoboy,
    resumo: resumoPartes.join(' • '),
    distancia_metros: temDistancia ? distancia : null,
    limite_metros: DIST_MAX_METROS,
  };
}

module.exports = {
  cruzarValidacoes,
  precisaConsultarGoogle,
  scoreSimilaridade,
  scoreEndereco,
  scoreDistancia,
  distanciaMetros,
  normalizar,
  DIST_MAX_METROS,
  LIMIAR_TEXTO,
};
