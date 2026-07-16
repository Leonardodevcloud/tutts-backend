/**
 * cruzar-validacoes.js (2026-07 v8 — REGRA_B_RESGATE_V1)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ESTA VERSAO EXISTE: o Path E nunca passou. Nem aqui, nem na v6.
 *
 * O E comparava `receita.endereco` com `localizacao_raw`. Acontece que
 * localizacao_raw NAO e um endereco digitado — e a coordenada crua do GPS,
 * montada no modulo-agente.js pelo botao "Enviar minha localização atual":
 *
 *     const coordStr = `${gps.lat}, ${gps.lng}`;
 *     setForm(f => ({ ...f, localizacao_raw: coordStr }));
 *
 * Entao o E media a similaridade entre
 *     "CHILE, 703, RECREIO IPITANGA, LAURO DE FREITAS, BA"
 *     "-12.962936, -38.469274"
 * Resultado: 7%. Sempre. Nao existe CNPJ que faca isso chegar a 80.
 *
 * Consequencias, todas silenciosas:
 *   - a regra `B E (C OU E)` era, na pratica, `B E C`: o Google TINHA que
 *     conhecer a loja, senao barrava motoboy honesto (galeria, predio, loja
 *     sem cadastro no Places);
 *   - o gate de custo nunca economizava — ele so pulava o Places quando
 *     E >= 80, que nao acontecia nunca. Pagava sempre;
 *   - o mesmo valia pro antigo Path K (numero do logradouro).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A REGRA AGORA — o C deixa de restringir e passa a RESGATAR:
 *
 *     dist <= DIST_LIBERA_METROS   -> LIBERA (nao consulta o Google)
 *     dist <= DIST_RESGATE_METROS  -> libera SE o Google confirmar a loja ali
 *     dist  > DIST_RESGATE_METROS  -> BARRA
 *     dist indisponivel            -> BARRA como 'indisponivel' (nao e erro dele)
 *
 * POR QUE O B SOZINHO BASTA DENTRO DE 100m:
 * B >= significa que o motoboy esta a <=100m do endereco que a RECEITA tem pra
 * o CNPJ que ele digitou, e o ponto e gravado com a coordenada DELE. Se o CNPJ
 * e o da nota, isso E a correcao certa — nao ha o que confirmar depois.
 *
 * O que o B nao pega: ele digitar um CNPJ qualquer registrado perto de onde
 * quer botar o ponto (o MEI dele, o do vizinho). Mas o C tambem nao pegava
 * isso — se o Google conhece o MEI dele ali, o C passa. NADA aqui confere que o
 * CNPJ e o cliente da OS. Quem limita esse abuso e outra coisa, que ja existe:
 * o agente barra correcao que jogue o ponto a mais de RAIO_MAXIMO_KM (2 km) do
 * endereco original da OS — agent-correcao.agent.js:176.
 *
 * POR QUE EXISTE A FAIXA DE RESGATE (100–300m):
 * Geocoding de endereco da Receita no Brasil cai no centroide do CEP com
 * frequencia. Erra 200m e barra quem esta na porta da loja. Na faixa cinza, se
 * o Google enxerga a empresa naquele ponto, a duvida e do geocoder, nao do
 * motoboy. E o unico lugar onde vale pagar o Places: e o unico lugar onde a
 * resposta dele muda a decisao.
 *
 * Pra voltar ao "B e ponto": DIST_RESGATE_METROS = DIST_LIBERA_METROS. A faixa
 * some, o Places nunca e consultado e nada mais precisa mudar.
 *
 * POR QUE O CORTE E EM METROS E NAO EM "80%":
 * scoreDistancia() tem teto 90 e cauda longa de proposito (drift de GPS +
 * geocoding de telhado). Nessa curva, "B >= 80" seria 35 METROS — 35m nao
 * existe em galeria nem em rua com predio alto. O score continua sendo
 * calculado, mas so pra exibir no painel; quem decide sao os metros.
 */

'use strict';

// ───────── Parâmetros da decisão ─────────

/** Dentro disso, a presença física basta. */
const DIST_LIBERA_METROS = 100;

/** Até aqui, ainda dá pra ser erro do geocoder — o Google desempata. */
const DIST_RESGATE_METROS = 300;

/** Corte de similaridade de texto (0-100) do Path C. */
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
 * Compara dois endereços livres. Tira CEP e ruído antes.
 *
 * REGRA_B_RESGATE_V1: não é mais usada pela decisão (o Path E morreu — ver o
 * cabeçalho). Fica exportada porque clientes-bloqueados.service.js e o módulo
 * Coleta comparam endereços de verdade, digitados por gente.
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
 * Distância em metros → score 0-90 (teto 90: nunca é certeza).
 *  <=15m → 90 | 15-200m → degrade linear | >=200m → 0
 * Não decide nada — é número de painel.
 */
function scoreDistancia(metros) {
  if (metros === null || metros === undefined) return 0;
  if (metros <= 15) return 90;
  if (metros >= 200) return 0;
  return Math.round(90 * (200 - metros) / 185);
}

// ───────── Cálculo dos sinais ─────────

/** Nomes oficiais do CNPJ: fantasia E razão. */
function nomesDaReceita(receita) {
  const out = [];
  if (receita && receita.nome_fantasia) out.push(receita.nome_fantasia);
  if (receita && receita.razao_social) out.push(receita.razao_social);
  return out;
}

/**
 * Path C — nome oficial ↔ estabelecimentos que o Google vê no ponto do GPS.
 * Compara com TODOS os vizinhos e fica com o melhor: a pergunta é "o Google
 * conhece essa empresa AQUI?", não "qual das lojas é ela".
 *
 * @returns {number|undefined} undefined = não deu pra calcular
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
 * cache). Só pagamos onde a resposta MUDA a decisão: a faixa de resgate.
 *
 *   dist <= 100m  -> ja libera        -> nao paga
 *   dist  > 300m  -> barra de qualquer jeito -> nao paga
 *   100–300m      -> o C decide       -> paga
 *
 * Na v7 este gate era letra morta: ele dependia do Path E, que nunca passava.
 *
 * @returns {boolean}
 */
function precisaConsultarGoogle({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps }) {
  const dist = calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps });
  if (dist === null) return false;
  return dist > DIST_LIBERA_METROS && dist <= DIST_RESGATE_METROS;
}

// ───────── Função principal ─────────

/**
 * @param {object}   p
 * @param {object}   p.receita                retorno de consultarReceita (pode ter .lat/.lng)
 * @param {number}   p.motoboy_lat
 * @param {number}   p.motoboy_lng
 * @param {number}  [p.distancia_receita_gps] metros, se já calculado pela rota
 * @param {Array}   [p.lugares_proximos]      saída de buscarEstabelecimentosProximos
 */
function cruzarValidacoes({
  receita,
  motoboy_lat,
  motoboy_lng,
  distancia_receita_gps,
  lugares_proximos,
}) {
  const scores = {};

  // ── B: endereço da Receita ≈ GPS ──
  const distancia = calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps });
  const temDistancia = distancia !== null && distancia !== undefined;
  if (temDistancia) scores.endereco_receita_vs_gps = scoreDistancia(distancia);

  // ── C: nome da Receita ↔ Google Places (só existe na faixa de resgate) ──
  const C = calcularC(receita, lugares_proximos);
  if (C !== undefined) scores.nome_receita_vs_google = C;

  // ── Decisão ──
  const confirmaC = typeof C === 'number' && C >= LIMIAR_TEXTO;
  const presencaOk = temDistancia && distancia <= DIST_LIBERA_METROS;
  const resgatado = temDistancia
    && distancia > DIST_LIBERA_METROS
    && distancia <= DIST_RESGATE_METROS
    && confirmaC;

  const liberado = presencaOk || resgatado;
  const barrar = !liberado;

  // indisponivel: barrou por FALTA DE DADO, não por culpa do motoboy. Sem
  // distância não há como checar presença, e não existe nada que ele possa
  // digitar diferente pra resolver.
  const indisponivel = barrar && !temDistancia;

  // ── O que o motoboy vê ──
  // Uma linha só, e é a única coisa que ele controla: onde está e qual CNPJ
  // digitou. O C é um resgate que roda por baixo — ele não precisa saber que
  // existe, e mostrar "o Google não conhece essa empresa" só ensinaria a
  // discutir com o Google.
  const checks = [
    {
      id: 'B',
      chave: 'endereco_receita_vs_gps',
      label: 'Você está no endereço desse CNPJ',
      status: !temDistancia ? 'nd' : (liberado ? 'ok' : 'falhou'),
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
    endereco_receita_vs_gps: 'Endereço Receita↔GPS',
    nome_receita_vs_google:  'Nome Receita↔Google',
  };

  let caminho_aprovacao = null;
  if (presencaOk) caminho_aprovacao = `Presença confirmada (<=${DIST_LIBERA_METROS}m)`;
  else if (resgatado) caminho_aprovacao = `Resgate pelo Google (${distancia}m, geocoder impreciso)`;

  // ── Motivo do bloqueio: uma frase, e ela tem que dizer o que FAZER ──
  let motivo_bloqueio = null;
  if (indisponivel) {
    motivo_bloqueio =
      'Não conseguimos consultar os dados agora. Não é erro seu — tente de novo em um minuto.';
  } else if (barrar) {
    motivo_bloqueio =
      'Você não está no endereço desse CNPJ. Confira se o CNPJ é o da loja onde você está agora.';
  }

  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (liberado) {
      mensagem_motoboy = `✅ ${nome} confirmado`;
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
    resgatado,
    motivo_bloqueio,
    caminho_aprovacao,
    mensagem_motoboy,
    resumo: resumoPartes.join(' • '),
    distancia_metros: temDistancia ? distancia : null,
    limite_metros: DIST_LIBERA_METROS,
    limite_resgate_metros: DIST_RESGATE_METROS,
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
  DIST_LIBERA_METROS,
  DIST_RESGATE_METROS,
  LIMIAR_TEXTO,
};
