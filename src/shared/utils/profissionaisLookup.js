/**
 * profissionaisLookup.js
 * ================================================================
 * Fonte única para consulta de dados do banco de profissionais.
 *
 * ORDEM DE RESOLUÇÃO (primeiro que retornar dados vence):
 *   1º  crm_leads_capturados          ← FONTE PRIMÁRIA (aba Cadastro do CRM)
 *   2º  disponibilidade_linhas        ← FALLBACK 1 (só nome)
 *   3º  users                         ← FALLBACK 2 (só nome, via full_name)
 *
 * 2026-07: a planilha Google Sheets legada foi REMOVIDA (deixou de existir).
 * O CRM é a fonte de verdade; disponibilidade e users cobrem o resto.
 * ================================================================
 */
'use strict';

// ─────────────────────────────────────────────────────────────────
// PLANILHA (REMOVIDA em 2026-07)
// ─────────────────────────────────────────────────────────────────
// A planilha Google Sheets legada deixou de existir. As fontes ativas
// agora sao: CRM (primaria), disponibilidade_linhas e users (fallbacks).
// invalidarCachePlanilha() vira no-op para nao quebrar os call-sites
// externos (crm.routes.js e coletaEnderecos/admin.routes.js) que a importam.

/** No-op (planilha removida). Mantido por compatibilidade de import. */
function invalidarCachePlanilha() {}

// ─────────────────────────────────────────────────────────────────
// BUSCA POR CÓDIGO
// ─────────────────────────────────────────────────────────────────

/**
 * Busca os dados de um profissional pelo código.
 *
 * @param {Pool}           pool  - Pool do pg
 * @param {string|number}  cod   - Código do profissional
 * @returns {Promise<{cod:string, nome:string|null, cidade:string|null,
 *                    regiao:string|null, telefone:string|null,
 *                    origem:'crm'|'disponibilidade'|'users'}|null>}
 */
async function buscarProfissional(pool, cod) {
  if (cod === undefined || cod === null || cod === '') return null;
  const codStr = String(cod).trim();
  if (!codStr) return null;

  // 🔧 v3 (2026-05-24): todas as fontes agora fazem lookup case-insensitive +
  // resilientes a whitespace (LOWER(TRIM(...))). Alinhado com o resto do sistema
  // (auth usa LOWER em todas as queries de cod_profissional).
  // Evita falsos negativos quando o cod está cadastrado mas com case/whitespace
  // diferente do digitado.
  const codNorm = codStr.toLowerCase();
  const tentativas = [];

  // 1º — CRM (fonte primária)
  try {
    const { rows } = await pool.query(
      `SELECT cod, nome, cidade, regiao, celular
         FROM crm_leads_capturados
        WHERE LOWER(TRIM(cod)) = $1
        LIMIT 1`,
      [codNorm]
    );
    tentativas.push(`crm:${rows.length}`);
    if (rows.length > 0 && (rows[0].nome || rows[0].cidade || rows[0].regiao)) {
      const r = rows[0];
      return {
        cod:      r.cod,
        nome:     r.nome || null,
        // Prioriza regiao; se não houver, usa cidade
        cidade:   r.cidade || null,
        regiao:   r.regiao || r.cidade || null,
        telefone: r.celular || null,
        origem:   'crm',
      };
    }
  } catch (err) {
    tentativas.push(`crm:erro`);
    console.warn('[profissionaisLookup] Erro CRM:', err.message);
  }

  // 2º — disponibilidade_linhas (só nome)
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT nome_profissional, cod_profissional
         FROM disponibilidade_linhas
        WHERE LOWER(TRIM(cod_profissional)) = $1 AND nome_profissional IS NOT NULL
        LIMIT 1`,
      [codNorm]
    );
    tentativas.push(`disp:${rows.length}`);
    if (rows.length > 0 && rows[0].nome_profissional) {
      return {
        cod:      rows[0].cod_profissional || codStr,
        nome:     rows[0].nome_profissional,
        cidade:   null,
        regiao:   null,
        telefone: null,
        origem:   'disponibilidade',
      };
    }
  } catch (err) {
    tentativas.push(`disp:erro`);
    console.warn('[profissionaisLookup] Erro disponibilidade:', err.message);
  }

  // 3º — users (só nome)
  try {
    const { rows } = await pool.query(
      `SELECT full_name, cod_profissional
         FROM users
        WHERE LOWER(TRIM(cod_profissional)) = $1
        LIMIT 1`,
      [codNorm]
    );
    tentativas.push(`users:${rows.length}`);
    if (rows.length > 0 && rows[0].full_name) {
      return {
        cod:      rows[0].cod_profissional || codStr,
        nome:     rows[0].full_name,
        cidade:   null,
        regiao:   null,
        telefone: null,
        origem:   'users',
      };
    }
  } catch (err) {
    tentativas.push(`users:erro`);
    console.warn('[profissionaisLookup] Erro users:', err.message);
  }

  // 🔧 v3: log diagnóstico quando NÃO acha — ajuda a entender por qual fonte
  // o cod passou. Cada tentativa mostra quantos hits teve (0 = não achou).
  console.warn(
    `[profissionaisLookup] cod="${codStr}" (norm="${codNorm}") NÃO encontrado em nenhuma fonte. ` +
    `Tentativas: ${tentativas.join(' | ')}`
  );

  return null;
}

/**
 * Versão "só nome" — conveniência para call-sites que só precisam do nome.
 * Retorna string ou null.
 */
async function buscarNomeProfissional(pool, cod) {
  const p = await buscarProfissional(pool, cod);
  return p ? (p.nome || null) : null;
}

/**
 * Versão "só região" — conveniência para call-sites que só precisam
 * da cidade/região (promoções novatos, avisos).
 */
async function buscarRegiaoProfissional(pool, cod) {
  const p = await buscarProfissional(pool, cod);
  return p ? (p.regiao || p.cidade || null) : null;
}

// ─────────────────────────────────────────────────────────────────
// LISTAGENS
// ─────────────────────────────────────────────────────────────────

/**
 * Lista todas as regiões distintas (para preencher dropdowns de
 * criação de promoções, avisos, etc).
 *
 * Estratégia: distintas do CRM (case-insensitive), ordenado
 * alfabeticamente. Se falhar → [].
 */
async function listarRegioes(pool) {
  const set = new Map(); // key = upper, value = display original

  // CRM
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(regiao), ''), NULLIF(TRIM(cidade), '')) AS r
         FROM crm_leads_capturados
        WHERE COALESCE(regiao, cidade) IS NOT NULL`
    );
    for (const row of rows) {
      const r = (row.r || '').trim();
      if (r) {
        const key = r.toUpperCase();
        if (!set.has(key)) set.set(key, r);
      }
    }
  } catch (err) {
    console.warn('[profissionaisLookup] listarRegioes CRM falhou:', err.message);
  }

  return Array.from(set.values()).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/**
 * Lista completa de profissionais — usada pela aba "Cadastro" do CRM
 * e por relatórios. Merge CRM + users, CRM tem prioridade.
 *
 * @returns {Promise<Array<{codigo, nome, telefone, regiao, cidade,
 *                          dataAtivacao, quemAtivou, origem}>>}
 */
async function listarProfissionais(pool) {
  const map = new Map(); // key = cod

  // CRM primeiro (prioridade)
  try {
    const { rows } = await pool.query(
      `SELECT cod, nome, celular, cidade, regiao, data_ativacao, quem_ativou
         FROM crm_leads_capturados
        WHERE cod IS NOT NULL
        ORDER BY cod`
    );
    for (const r of rows) {
      if (!r.cod) continue;
      map.set(String(r.cod), {
        codigo:       String(r.cod),
        nome:         r.nome || '',
        telefone:     r.celular || '',
        regiao:       (r.regiao || r.cidade || '').toUpperCase(),
        cidade:       r.cidade || '',
        dataAtivacao: r.data_ativacao ? new Date(r.data_ativacao).toISOString().slice(0, 10) : '',
        quemAtivou:   r.quem_ativou || '',
        origem:       'crm',
      });
    }
  } catch (err) {
    console.warn('[profissionaisLookup] listarProfissionais CRM falhou:', err.message);
  }

  // users (motoboys com login, role='user') — SEMPRE incluidos (so preenche quem
  // faltar; CRM e planilha tem prioridade). Garante que qualquer motoboy que
  // exista no banco atual apareca pra vinculacao (ex: fila), mesmo quando a
  // planilha esta fora do ar (HTTP 401) ou ele nunca passou pelo CRM/planilha.
  try {
    const { rows } = await pool.query(
      `SELECT cod_profissional, full_name
         FROM users
        WHERE role = 'user'
          AND cod_profissional IS NOT NULL
          AND TRIM(cod_profissional) <> ''`
    );
    for (const r of rows) {
      const _cod = String(r.cod_profissional).trim();
      if (!_cod || map.has(_cod)) continue;
      map.set(_cod, {
        codigo:       _cod,
        nome:         r.full_name || `#${_cod}`,
        telefone:     '',
        regiao:       '',
        cidade:       '',
        dataAtivacao: '',
        quemAtivou:   '',
        origem:       'users',
      });
    }
  } catch (err) {
    console.warn('[profissionaisLookup] listarProfissionais users falhou:', err.message);
  }

  return Array.from(map.values());
}

module.exports = {
  buscarProfissional,
  buscarNomeProfissional,
  buscarRegiaoProfissional,
  listarRegioes,
  listarProfissionais,
  invalidarCachePlanilha,
};
