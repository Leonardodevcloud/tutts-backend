/**
 * cruzar-validacoes.js (2026-07 v11 — VALIDACAO_B_UNICA_V1 + GPS_ACC_BACKEND_V1)
 *
 * GPS_ACC_BACKEND_V1: a precisao do GPS entrou na decisao, e entrou AQUI de
 * proposito. Ela chegou a viver no celular (o front travava o botao quando a
 * accuracy passava de 60m) — ideia ruim por dois motivos: bloqueio no celular
 * nao deixa rastro nenhum no banco (o dono do sistema descobre pelo WhatsApp do
 * suporte, nao pelo painel), e mexer no numero exigia deploy da Vercel. Regra
 * que barra gente mora onde grava e onde se ajusta.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UMA validação. Uma só:
 *
 *     O motoboy está, ou não está, no endereço que a Receita tem pra o CNPJ
 *     que ele digitou.  ->  distância <= DIST_LIBERA_METROS
 *
 * Não tem "ou". Não tem desempate. Não tem Google.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * COMO CHEGAMOS AQUI (a história inteira, pra ninguém reconstruir por engano):
 *
 * v6 tinha 7 caminhos (A..K) e aprovava se QUALQUER um batesse 80%. Quatro
 * deles liam a FOTO da fachada via Gemini Vision. Dois eram cegos sem saber:
 *
 *   E (endereco_receita_vs_motoboy) comparava o TEXTO do endereço da Receita
 *     com `localizacao_raw` — que nunca foi endereço, é a coordenada crua do
 *     GPS ("-16.6799, -49.2553"), montada pelo botão "Enviar minha localização
 *     atual". Ele dava 8% no mesmo registro em que o B dava 90% sobre a MESMA
 *     loja, a 7 metros. Os dois mediam a mesma coisa: o B em metros, acertando;
 *     o E comparando letra com letra, sendo que um dos lados nunca foi letra.
 *   K (numero_receita_vs_motoboy) morria pelo mesmo motivo.
 *
 * v7 tirou a foto (e com ela A, D, G e o Gemini). Sobraram B, C e E.
 * v8 descobriu o E morto e rebaixou o C a "resgate" na faixa 100-300m.
 * v9 separou "CNPJ não existe" de "a consulta caiu".
 * v10 (esta) tira o C também.
 *
 * POR QUE O C SAIU:
 * Ele nunca protegeu de nada. O medo era "o motoboy digita um CNPJ qualquer
 * registrado perto de onde quer botar o ponto" — mas se o Google conhece esse
 * CNPJ ali (o MEI dele, o do vizinho), o C aprova junto. NADA aqui confere que
 * o CNPJ é o cliente da OS. Quem limita esse abuso é outra coisa, que já existe
 * e não depende deste arquivo: o agente barra correção que jogue o ponto a mais
 * de RAIO_MAXIMO_KM (2 km) do endereço original da OS — agent-correcao.agent.js.
 *
 * O que se perde: o C resgatava quem o geocoder jogou longe (endereço da Receita
 * caindo no centroide do CEP erra 200m e barra quem está na porta). Sem ele não
 * há rede: o único botão passa a ser DIST_LIBERA_METROS. Se aparecer barrada de
 * gente honesta, é esse número que sobe — e é uma linha.
 *
 * O que se ganha: o Google Places sai do fluxo. Zero chamada paga, zero latência,
 * zero dependência de terceiro pra liberar uma corrida.
 *
 * POR QUE O CORTE É EM METROS E NÃO EM "80%":
 * scoreDistancia() tem teto 90 e cauda longa de propósito (drift de GPS +
 * geocoding de telhado). Nessa curva, "B >= 80" seria 35 METROS — 35m não existe
 * em galeria nem em rua com prédio alto. O score continua sendo calculado, mas só
 * pra aparecer no painel; quem decide são os metros.
 */

'use strict';

// ───────── Parâmetro da decisão ─────────

/** A única régua: metros entre o GPS do motoboy e o endereço da Receita. */
const DIST_LIBERA_METROS = 100;

/**
 * Precisão máxima aceitável do GPS (o raio, em metros, que o próprio aparelho
 * reporta em position.coords.accuracy).
 *
 * Existe porque a régua acima é uma distância. Um aparelho que diz "estou aqui,
 * mais ou menos 96 metros" — e ±96m já apareceu em produção — não consegue
 * responder uma pergunta de 100m: a medida vira cara ou coroa. Nesse caso a
 * resposta honesta não é "ele não está lá", é "não dá pra saber daqui".
 *
 * 60m é chute educado: dentro de loja, coberto, o típico é 30-60m. Se começar a
 * barrar gente honesta, o número está aqui — mas veja o dado antes: a accuracy
 * agora é gravada em toda tentativa.
 */
const GPS_ACC_LIMITE = 60;

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

// VALIDACAO_B_UNICA_V1: nomesDaReceita() e calcularC() foram removidos junto com
// o Path C. Eram os únicos consumidores de `lugares_proximos`.

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

// VALIDACAO_B_UNICA_V1: precisaConsultarGoogle() foi removida.
//
// Ela existia pra decidir QUANDO valia pagar o Places. Sem Places no fluxo, não
// há o que decidir. A rota também não a chama mais — se alguém reintroduzir a
// chamada, vai quebrar no import, que é exatamente o aviso que se quer.

// ───────── Função principal ─────────

/**
 * @param {object}   p
 * @param {object}   p.receita                retorno de consultarReceita (pode ter .lat/.lng)
 * @param {number}   p.motoboy_lat
 * @param {number}   p.motoboy_lng
 * @param {number}  [p.distancia_receita_gps] metros, se já calculado pela rota
 * @param {number}  [p.gps_accuracy]          raio de erro do GPS, em metros
 */
function cruzarValidacoes({
  receita,
  motoboy_lat,
  motoboy_lng,
  distancia_receita_gps,
  gps_accuracy,
}) {
  const scores = {};

  // ── A única conferência: endereço da Receita ≈ GPS ──
  const distancia = calcularDistancia({ receita, motoboy_lat, motoboy_lng, distancia_receita_gps });
  const temDistancia = distancia !== null && distancia !== undefined;
  if (temDistancia) scores.endereco_receita_vs_gps = scoreDistancia(distancia);

  // ── Decisão ──
  //
  // GPS_ACC_BACKEND_V1: a precisão só atrapalha quando ela MUDA A RESPOSTA.
  //
  // `accuracy` é o raio de um círculo de 95% de confiança: "estou aqui, mais ou
  // menos X metros". Então a distância real está em [medida - acc, medida + acc].
  //
  // O erro que quase foi pra produção: barrar por 'gps_impreciso' sempre que
  // acc > 60. Alguém a 500m com ±96 estaria, no mínimo, a 404m — dá pra afirmar
  // com folga que ele não está na loja. Dizer "seu GPS está impreciso" nesse caso
  // esconde o problema real dele e ainda sugere que é só tentar de novo.
  //
  // Então: se o PIOR CASO a favor dele ainda está fora do limite, é presença
  // mesmo, e o motivo tem que dizer isso. A imprecisão só vira bloqueio quando o
  // círculo de erro cruza a linha dos 100m — aí, honestamente, não dá pra saber.
  const acc = (typeof gps_accuracy === 'number' && Number.isFinite(gps_accuracy))
    ? Math.round(gps_accuracy) : null;

  // Melhor caso pra ele: assume que ele está na borda do círculo, do lado da loja.
  const distanciaMinima = temDistancia ? Math.max(0, distancia - (acc || 0)) : null;
  const claramenteLonge = temDistancia && distanciaMinima > DIST_LIBERA_METROS;

  // Só é "impreciso" quando ainda poderia estar dentro — ou seja, quando a medida
  // não decide.
  const gpsImpreciso = acc !== null && acc > GPS_ACC_LIMITE && !claramenteLonge;

  const liberado = temDistancia && !gpsImpreciso && distancia <= DIST_LIBERA_METROS;
  const barrar = !liberado;

  // A Receita respondeu que esse CNPJ não existe (as duas bases concordaram) ou o
  // número é inválido. Isso é erro DELE e tem conserto: digitar certo. Não pode
  // virar 'indisponivel' — "tente de novo em um minuto" faria ele repetir o mesmo
  // CNPJ pra sempre.
  const cnpjNaoEncontrado = !!receita && receita.ok === false
    && (receita.codigo === 'nao_encontrado' || receita.codigo === 'invalido');

  // indisponivel: barrou por FALTA DE DADO, não por culpa do motoboy. Sem
  // distância não há como checar presença, e não existe nada que ele possa
  // digitar diferente pra resolver.
  const indisponivel = barrar && !temDistancia && !cnpjNaoEncontrado && !gpsImpreciso;

  // codigo_bloqueio: contrato pra tela. O front escolhe título/ícone/instrução por
  // este campo — nunca farejando o texto do motivo, que é copy e muda.
  let codigo_bloqueio = null;
  if (barrar) {
    codigo_bloqueio = cnpjNaoEncontrado ? 'cnpj_nao_encontrado'
      : gpsImpreciso ? 'gps_impreciso'
      : (indisponivel ? 'indisponivel' : 'presenca');
  }

  // ── O que o motoboy vê ──
  // Uma linha, e é a única coisa que ele controla: onde está e qual CNPJ digitou.
  const checks = [
    {
      id: 'B',
      chave: 'endereco_receita_vs_gps',
      label: 'Você está no endereço desse CNPJ',
      status: !temDistancia ? 'nd' : (liberado ? 'ok' : 'falhou'),
    },
  ];

  // ── Compat: campos que o resto do módulo já lê ──
  const score_max = temDistancia ? scores.endereco_receita_vs_gps : 0;
  const receita_max = score_max;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);
  // Salva o endereço nos favoritos só com prova forte: score 90 = <=15m.
  const pode_salvar_no_banco = pelo_menos_um_90;

  const labels = {
    endereco_receita_vs_gps: 'Endereço Receita↔GPS',
  };

  const caminho_aprovacao = liberado
    ? `Presença confirmada (${distancia}m, limite ${DIST_LIBERA_METROS}m)`
    : null;

  // ── Motivo do bloqueio: uma frase, e ela tem que dizer o que FAZER ──
  let motivo_bloqueio = null;
  if (codigo_bloqueio === 'gps_impreciso') {
    motivo_bloqueio =
      `Seu GPS está impreciso (±${acc}m) e não dá pra confirmar o local. ` +
      'Chegue perto da porta da loja ou saia de baixo da cobertura e tente de novo.';
  } else if (codigo_bloqueio === 'cnpj_nao_encontrado') {
    motivo_bloqueio =
      'Não achamos esse CNPJ na Receita Federal. Confira os dígitos na nota fiscal.';
  } else if (codigo_bloqueio === 'indisponivel') {
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
    codigo_bloqueio,
    cnpj_nao_encontrado: cnpjNaoEncontrado,
    motivo_bloqueio,
    caminho_aprovacao,
    mensagem_motoboy,
    resumo: resumoPartes.join(' • '),
    distancia_metros: temDistancia ? distancia : null,
    limite_metros: DIST_LIBERA_METROS,
    // GPS_ACC_BACKEND_V1: a precisão vai pro JSON de TODA tentativa. É o dado que
    // responde "a massa barrada é GPS ruim ou motoboy longe?" — sem ele, a próxima
    // discussão sobre o limite seria chute de novo.
    gps_accuracy: acc,
    gps_impreciso: gpsImpreciso,
    limite_accuracy: GPS_ACC_LIMITE,
    // O piso da distância dado o erro do GPS. É o que separa "não dá pra saber"
    // de "dá pra saber que não". Vai pro painel junto do resto.
    distancia_minima: distanciaMinima,
  };
}

module.exports = {
  cruzarValidacoes,
  // scoreSimilaridade / scoreEndereco / normalizar NAO sao mais usados pela
  // decisao — ficam exportados porque clientes-bloqueados.service.js e o modulo
  // Coleta comparam endereco de verdade, escrito por gente.
  scoreSimilaridade,
  scoreEndereco,
  scoreDistancia,
  distanciaMetros,
  normalizar,
  DIST_LIBERA_METROS,
  GPS_ACC_LIMITE,
};
