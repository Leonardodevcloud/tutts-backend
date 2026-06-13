// PonteRastreioCliente.js
// Ponte entre o Hub Logistico e o modulo rastreio-cliente (SLA capture).
//
// Em parte da operacao, nome e telefone do cliente final NAO vem em campos
// estruturados da OS — ficam soltos no CORPO. O RPA do rastreio-cliente ja raspa
// esses pontos e guarda em sla_capturas.pontos_json. Esta ponte le esse JSON pelo
// codigo da OS e reusa o MESMO extrator (extrairTelefoneDeNota), pra o Hub e o
// rastreio nunca divergirem.
//
// Prioridade no chamador: manual (modal) -> campo estruturado da OS -> esta ponte.

'use strict';

function getExtrator() {
  // require lazy: evita qualquer ordem de boot e so carrega quando usado.
  return require('../../agent/sla-capture.service').extrairTelefoneDeNota;
}

/**
 * Resolve { telefone, nome } do cliente final a partir do CORPO da OS, lido de
 * sla_capturas.pontos_json (preenchido pelo RPA do rastreio-cliente).
 * Retorna { telefone: null, nome: null } se ainda nao houver captura.
 * @param {import('pg').Pool} pool
 * @param {number|string} codigoOS
 * @returns {Promise<{telefone: string|null, nome: string|null}>}
 */
async function resolverDestinoViaPonte(pool, codigoOS) {
  const vazio = { telefone: null, nome: null };
  if (!pool || codigoOS == null) return vazio;
  try {
    const { rows } = await pool.query(
      'SELECT pontos_json FROM sla_capturas WHERE os_numero = $1 LIMIT 1',
      [String(codigoOS).trim()]
    );
    let pontos = rows[0] && rows[0].pontos_json;
    if (typeof pontos === 'string') {
      try { pontos = JSON.parse(pontos); } catch (_) { pontos = null; }
    }
    if (!Array.isArray(pontos) || pontos.length === 0) return vazio;

    // Pontos de entrega = numero >= 2 (1 = coleta). Mesma regra do envio.
    const pontosEntrega = pontos.filter((p) => Number(p && p.numero) >= 2);
    if (pontosEntrega.length === 0) return vazio;

    const extrair = getExtrator();
    let telefone = null;
    if (typeof extrair === 'function') {
      for (const ponto of pontosEntrega) {
        // textoBruto = texto integro do ponto (o telefone fica solto no meio).
        const fonte = ponto.textoBruto
          || [ponto.nota, ponto.endereco, ponto.nomeCliente].filter(Boolean).join(' ');
        const tel = extrair(fonte);
        if (tel) { telefone = tel; break; }
      }
    }

    const nome = (pontosEntrega[0] && pontosEntrega[0].nomeCliente) || null;
    return { telefone, nome };
  } catch (e) {
    console.warn(`\u26A0\uFE0F [PonteRastreioCliente] OS ${codigoOS}:`, e.message);
    return vazio;
  }
}

module.exports = { resolverDestinoViaPonte };
