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
  // ROTA_CEP_V1_SIG — a segunda perna. Ver o bloco da decisão lá embaixo.
  cep_receita,
  cep_gps,
  nomes_gps, // ROTA_NOME_V1_SIG — terceira perna. Ver o bloco da decisão.
  // ROTA_ENDERECO_V1_SIG — quarta perna. Campos, não blob.
  receita_logradouro,
  receita_numero,
  endereco_gps,
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

  // ══════════════════════════════════════════════════════════════════════════
  // ROTA_CEP_V1_DECISAO — a segunda perna.
  //
  // A distância continua sendo a regra. Isto aqui é rede, e ela só é acionada
  // quando a régua principal não existe.
  //
  //   temDistancia  -> a distância decide, sozinha, como sempre decidiu.
  //   !temDistancia -> NOSSO geocode falhou. O motoboy não tem culpa disso e não
  //                    tem o que digitar diferente. Antes ele era barrado; agora
  //                    o CEP responde, se conseguir.
  //
  // O CEP NUNCA sobrepõe uma medição boa. Se a distância diz 5km, o cara está a
  // 5km — um CEP igual não desmente isso, e nem deveria. Por isso o
  // `!temDistancia` na condição, e não um `||` solto.
  //
  // 8 DÍGITOS EXATOS. Nada de comparar os 5 primeiros: o prefixo é a sub-região
  // (bairro inteiro, às vezes meia cidade). Isso não é evidência de presença, é
  // evidência de estar na mesma zona — e transformaria a rede num buraco.
  //
  // O QUE ISTO CUSTA EM SEGURANÇA, dito na cara porque a decisão é sua:
  //
  //   Um CEP urbano cobre tipicamente uma rua ou um trecho dela — 100 a 300m.
  //   Comparável ao DIST_LIBERA_METROS de 100m, um pouco mais frouxo.
  //
  //   MAS em cidade pequena um único CEP cobre o município inteiro (os que
  //   terminam em -000 costumam ser assim). Nesses lugares, esta rota aprova
  //   qualquer um que esteja na cidade.
  //
  //   Ela só roda quando o geocode falhou, então a exposição é pequena. E a
  //   alternativa hoje é barrar 100% dessa fatia — gente honesta, que não tem o
  //   que fazer pra resolver.
  //
  //   Se aparecer fraude, o log `📮 rota do CEP` no correcao.routes.js lista
  //   cada uma. Dá pra medir antes de decidir.
  // ══════════════════════════════════════════════════════════════════════════
  const cepR = String(cep_receita || '').replace(/\D/g, '');
  const cepG = String(cep_gps || '').replace(/\D/g, '');
  const cepComparavel = cepR.length === 8 && cepG.length === 8;
  //
  // O  aqui é deliberado e foi acrescentado depois de rodar a
  // tabela-verdade: sem ele, um GPS com +-96m de erro liberava pelo CEP. Com essa
  // imprecisão o reverse-geocode pode cair num CEP vizinho ou no certo por sorte —
  // cara ou coroa, que é precisamente o que o gpsImpreciso existe pra impedir na
  // rota da distância. Se ele bloqueia uma perna, bloqueia as duas.
  //
  // Esse cara leva 'gps_impreciso', que tem ação própria e funciona: chegar perto
  // da porta. Bem melhor que um sim/não sorteado.
  const cepConfirma = !temDistancia && !gpsImpreciso && cepComparavel && cepR === cepG;
  if (cepComparavel) scores.cep_receita_vs_gps = cepR === cepG ? 90 : 0;

  // ══════════════════════════════════════════════════════════════════════════
  // ROTA_NOME_V1_DECISAO — a terceira perna.
  //
  // A pergunta: existe um estabelecimento com o nome desta empresa em 100m do
  // motoboy? Se existe, ele está lá. É a evidência mais direta das três — o CEP
  // diz "mesmo quarteirão", isto diz "esta loja, aqui".
  //
  // Compara os DOIS nomes da Receita (razão social e nome fantasia) contra TODOS
  // os estabelecimentos que o Places achou. Basta um par bater.
  //
  //   "DULTRA CAMINHOES PECAS E SERVICOS LTDA"  (razão social)
  //   "DULTRA CAMINHOES"                        (nome fantasia)
  //   vs
  //   "Dultra Caminhões" no Google              -> 100 no fantasia
  //
  // O CORTE É 85, e ele é alto de propósito.
  //
  // O scoreSimilaridade é Levenshtein + substring. Num raio de 100m numa rua
  // comercial há dezenas de lojas, e quanto mais lojas, maior a chance de uma
  // bater por acaso. Com corte baixo, "AUTO PECAS SILVA" casaria com "AUTO PECAS
  // SANTOS" — e aí a rota vira gerador de falso positivo, que é pior que rota
  // nenhuma: libera errado E ninguém percebe.
  //
  // 85 exige praticamente o mesmo nome, com folga só pra acento, LTDA, ME e
  // afins — que é o que o normalizar() já tira.
  //
  // Mesmas travas das outras pernas:
  //   - só quando NÃO há distância (o nome não desmente uma medição boa)
  //   - só quando o CEP não resolveu (não paga Places à toa)
  //   - !gpsImpreciso: com GPS de +-96m o Places busca em volta do lugar errado
  // ══════════════════════════════════════════════════════════════════════════
  const _nomesReceita = [];
  if (receita && receita.nome_fantasia) _nomesReceita.push(receita.nome_fantasia);
  if (receita && receita.razao_social) _nomesReceita.push(receita.razao_social);
  const _nomesGps = Array.isArray(nomes_gps) ? nomes_gps.filter(Boolean) : [];

  let nomeScore = 0;
  let nomeVencedor = null;
  if (_nomesReceita.length > 0 && _nomesGps.length > 0) {
    for (const nR of _nomesReceita) {
      for (const nG of _nomesGps) {
        const s = scoreSimilaridade(nR, nG);
        if (s > nomeScore) { nomeScore = s; nomeVencedor = nG; }
      }
    }
    scores.nome_receita_vs_google = nomeScore;
  }
  const NOME_CORTE = 85; // ROTA_ENDERECO_V1_DECISAO abaixo
  const nomeConfirma = !temDistancia && !gpsImpreciso && !cepConfirma && nomeScore >= NOME_CORTE;

  // ══════════════════════════════════════════════════════════════════════════
  // ROTA_ENDERECO_V1_DECISAO — quarta perna: rua E número.
  //
  // Os dois lados vêm do GPS. O da Receita, da BrasilAPI; o do motoboy, do Google
  // revertendo as coordenadas DELE, no servidor. Nada é digitado — pra passar
  // aqui ele precisa estar no lugar.
  //
  // ═══ POR QUE CAMPO A CAMPO, E NÃO SIMILARIDADE DE TEXTO ═══
  //
  // A primeira versão disto comparava as strings inteiras com scoreEndereco().
  // Reprovou no teste, e feio:
  //
  //   "Alvaro Santos, 74, Brotas"  x  "Alvaro Santana, 74 - Brotas"    -> 87%
  //        ruas DIFERENTES, podem estar a 2km. Liberava.
  //
  //   "CAPELA, VINHEDO, SP"  x  "R. Juliana Von Zuben Degelo, 42 - Capela"  -> 90%
  //        o CNPJ só tem o BAIRRO. Qualquer GPS dentro da Capela reverte pra uma
  //        string que contém "Capela, Vinhedo". Liberava o bairro inteiro.
  //
  // E a segunda é pior do que parece: endereço curto na Receita é EXATAMENTE o
  // motivo do geocode ter falhado, que é exatamente quando esta rota é chamada.
  // A rota era pior justamente quando era mais necessária.
  //
  // Nenhum corte separava: o caso bom ("Av. T-63, 1296") dava 88%, os falsos
  // positivos davam 87% e 90%. Se cruzam. Não é ajuste de constante — é a
  // ferramenta errada.
  //
  // ═══ AS TRÊS TRAVAS DESTA VERSÃO ═══
  //
  // 1. SEM LOGRADOURO NA RECEITA, A ROTA NEM RODA.
  //    Mata o caso "CAPELA, VINHEDO, SP" na raiz: não há rua pra comparar, então
  //    não há o que afirmar. Silêncio é a resposta honesta.
  //
  // 2. O NÚMERO É ELIMINATÓRIO, e comparado como NÚMERO.
  //    74 != 740. 74 != 76. Não existe "quase o mesmo número" — é outra porta.
  //    Isto sozinho derruba o "Álvaro Santana": mesmo que a rua passasse por
  //    parecida, o número teria que bater exato.
  //
  // 3. A RUA PRECISA DE 90, não 85.
  //    "Alvaro Santos" x "Alvaro Santana" = 87. O corte fica acima disso, de
  //    propósito, e o número ainda tem que bater junto.
  //
  // Comparo só o nome da rua — não o blob com bairro/cidade/CEP, que era o que
  // inflava o score com palavras que todo endereço da região tem em comum.
  // ══════════════════════════════════════════════════════════════════════════
  // ROTA_ENDERECO_V1_NORM — "AVENIDA T 63" e "Av. T-63" são a mesma avenida.
  //
  // O normalizar() do scoreSimilaridade não sabe disso: sem isto, esse par dava
  // 58% e a rota barrava um motoboy que estava na porta. Falso negativo é menos
  // grave que falso positivo (ele ainda cai na rota do nome), mas é burrice
  // deixar passar quando o conserto é uma tabela.
  //
  // CANONIZA o tipo, não remove. Remover faria "RUA CENTRAL" casar 100% com
  // "AVENIDA CENTRAL" — ruas diferentes, e o número poderia bater por acaso.
  const _canonRua = (r) => String(r || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.\-]/g, ' ')
    .replace(/\b(AVENIDA|AVE|AV)\b/g, 'AVENIDA')
    .replace(/\b(RUA|R)\b/g, 'RUA')
    .replace(/\b(PRACA|PCA|PC)\b/g, 'PRACA')
    .replace(/\b(TRAVESSA|TRV|TV)\b/g, 'TRAVESSA')
    .replace(/\b(ALAMEDA|ALA|AL)\b/g, 'ALAMEDA')
    .replace(/\b(RODOVIA|ROD)\b/g, 'RODOVIA')
    .replace(/\b(ESTRADA|EST)\b/g, 'ESTRADA')
    .replace(/\s+/g, ' ')
    .trim();

  const _ruaReceita = String(receita_logradouro || '').trim();
  const _numReceita = String(receita_numero || '').replace(/\D/g, '');
  let endScore = 0;
  let endNumBate = false;
  let endRuaGps = null;

  if (_ruaReceita && _numReceita && endereco_gps) {
    // O Google formata "R. Álvaro Santos, 74 - Brotas, Salvador - BA, 40280-120".
    // A primeira vírgula separa rua do resto; o número vem logo depois dela.
    const _partes = String(endereco_gps).split(',');
    endRuaGps = (_partes[0] || '').trim();
    const _mNum = (_partes[1] || '').match(/\d+/);
    const _numGps = _mNum ? _mNum[0] : null;

    endScore = scoreSimilaridade(_canonRua(_ruaReceita), _canonRua(endRuaGps));
    endNumBate = !!_numGps && parseInt(_numGps, 10) === parseInt(_numReceita, 10);
    scores.rua_receita_vs_gps = endScore;
  }

  const RUA_CORTE = 90;
  const enderecoConfirma =
    !temDistancia && !gpsImpreciso &&
    endScore >= RUA_CORTE && endNumBate;

  const liberadoPorDistancia = temDistancia && !gpsImpreciso && distancia <= DIST_LIBERA_METROS;
  // ROTA_ENDERECO_V1_LIBERADO — quatro pernas.
  const liberado = liberadoPorDistancia || cepConfirma || enderecoConfirma || nomeConfirma;
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
  // ROTA_CEP_V1_INDISP — `!cepComparavel` entra na conta.
  //
  // "indisponivel" quer dizer "não consegui medir nada". Com a rota do CEP, isso
  // deixa de ser verdade automática quando falta a distância: se o CEP era
  // comparável e NÃO bateu, a gente mediu, sim — e a medida diz que ele não está
  // lá. Isso é 'presenca', não indisponibilidade.
  //
  // Sem esta linha, o cara levaria "Não conseguimos consultar os dados agora,
  // tente de novo em um minuto" quando na verdade a gente conseguiu conferir e
  // reprovou. Ele tentaria pra sempre.
  // ROTA_NOME_V1_INDISP — `!nomeAvaliavel` entra na conta.
  //
  // Se o Places achou lojas em volta dele e nenhuma tem o nome da empresa, isso é
  // MEDIÇÃO, não indisponibilidade: a gente conseguiu olhar e não achou. Vira
  // 'presenca'. Só é 'indisponivel' quando nenhuma das três pernas conseguiu
  // sequer produzir um número.
  // ROTA_ENDERECO_V1_INDISP: se deu pra comparar os textos, a gente MEDIU.
  // Reprovar depois de medir é 'presenca', não indisponibilidade.
  const nomeAvaliavel = _nomesReceita.length > 0 && _nomesGps.length > 0;
  const enderecoAvaliavel = !!(_ruaReceita && _numReceita && endereco_gps);
  const indisponivel = barrar && !temDistancia && !cepComparavel && !enderecoAvaliavel && !nomeAvaliavel && !cnpjNaoEncontrado && !gpsImpreciso;

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
      // ROTA_CEP_V1_CHECK: aprovado pelo CEP é 'ok', não 'nd'. O `nd` (não
      // disponível) diria pro motoboy que a conferência não rodou — e ela rodou,
      // e ele passou. Mostrar 'nd' numa tela de sucesso é confuso e faz o suporte
      // achar que tem bug.
      // ROTA_NOME_V1_CHECK: aprovado por qualquer perna é 'ok'.
      // ROTA_ENDERECO_V1_CHECK
      status: (cepConfirma || enderecoConfirma || nomeConfirma) ? 'ok' : (!temDistancia ? 'nd' : (liberado ? 'ok' : 'falhou')),
    },
  ];

  // ── Compat: campos que o resto do módulo já lê ──
  // ══════════════════════════════════════════════════════════════════════════
  // SCORE_MAX_V1_CALC — o score_max só sabia da distância.
  //
  // Era:  const score_max = temDistancia ? scores.endereco_receita_vs_gps : 0;
  //
  // Correto quando existia UMA rota. Com a cascata (distância → CEP → nome) ele
  // virou mentira: uma correção aprovada pelo nome com 100% mostrava "Máx: 0%"
  // no painel — visto em produção na OS 1262730, aprovada com
  // "Presença confirmada pelo nome (100%)" e exibindo Máx: 0%.
  //
  // Pior que o display: `pelo_menos_um_90` sai daqui, e ele controla o
  // `pode_salvar_no_banco` — se o endereço corrigido vira favorito. Com score_max
  // travado em 0, TODA correção aprovada pelo CEP ou pelo nome parava de
  // alimentar a base de favoritos. Calado.
  //
  // Agora é o maior de todos os scores calculados. Honesto com o que a tela mostra.
  const _todosScores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = _todosScores.length ? Math.max(..._todosScores) : 0;
  const receita_max = score_max;

  // `pelo_menos_um_90` NÃO pode ser `score_max >= 90` — e essa distinção é o
  // ponto todo deste patch.
  //
  // Ele decide se o endereço vira FAVORITO, ou seja, se a gente passa a confiar
  // nele pra próximas entregas. Isso pede evidência forte, e as três pernas não
  // são igualmente fortes:
  //
  //   distância >= 90  ->  <= 15m. É a porta. Confia.
  //   nome >= 90       ->  o nome exato da empresa, a menos de 100m. Confia.
  //   CEP = 90         ->  MESMO CEP. Isso é 100-300m numa cidade, e o município
  //                        inteiro numa cidade pequena. Serve pra liberar o cara
  //                        (é melhor que barrar quem está certo), mas NÃO serve
  //                        pra gravar coordenada como verdade permanente.
  //
  // Um favorito errado envenena as entregas seguintes, e ninguém vai saber de
  // onde veio. Liberar errado custa uma corrida; gravar errado custa um endereço.
  const _forteDistancia = temDistancia && (scores.endereco_receita_vs_gps || 0) >= 90;
  const _forteNome = (scores.nome_receita_vs_google || 0) >= 90;
  // ROTA_ENDERECO_V1_FORTE — endereço >= 90 é evidência forte e VIRA FAVORITO.
  //
  // Diferente do CEP, que fica de fora: o CEP só diz "mesma faixa" (100-300m, ou
  // a cidade inteira em município pequeno). O endereço batendo a 90% quer dizer
  // mesma rua E mesmo número. Isso é a porta, e é gravável.
  const _forteEndereco = (scores.rua_receita_vs_gps || 0) >= 90 && enderecoConfirma;
  const pelo_menos_um_90 = _forteDistancia || _forteNome || _forteEndereco;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);
  // Salva o endereço nos favoritos só com prova forte: score 90 = <=15m.
  const pode_salvar_no_banco = pelo_menos_um_90;

  const labels = {
    endereco_receita_vs_gps: 'Endereço Receita↔GPS',
  };

  // ROTA_CEP_V1_CAMINHO — sem isto, aprovar pelo CEP escreveria
  // "Presença confirmada (nullm, limite 100m)" no log e no painel, porque não
  // existe distância nesse caminho. O admin leria "null" e desconfiaria do
  // registro inteiro — com razão.
  // ROTA_NOME_V1_CAMINHO
  // ROTA_ENDERECO_V1_CAMINHO
  const caminho_aprovacao = enderecoConfirma
    ? `Presença confirmada pelo endereço (${endScore}%) — sem geocode do CNPJ`
    : nomeConfirma
    ? `Presença confirmada pelo nome (${nomeScore}%: "${nomeVencedor}") — sem geocode nem CEP`
    : (!liberadoPorDistancia && cepConfirma)
    ? `Presença confirmada pelo CEP (${cepR}) — sem geocode do endereço`
    : liberado
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
