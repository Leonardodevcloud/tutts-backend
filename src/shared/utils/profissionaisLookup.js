/**
 * profissionaisLookup.js
 * ================================================================
 * Fonte única para consulta de dados do banco de profissionais.
 *
 * ORDEM DE RESOLUÇÃO (primeiro que retornar dados vence):
 *   1º  crm_leads_capturados          ← FONTE PRIMÁRIA (aba Cadastro do CRM)
 *   2º  Planilha Google Sheets        ← FALLBACK 1 (legado)
 *   3º  disponibilidade_linhas        ← FALLBACK 2 (só nome)
 *   4º  users                         ← FALLBACK 3 (só nome, via full_name)
 *
 * Motivação: deixar de depender da planilha como fonte de verdade,
 * mantendo-a como rede de segurança enquanto o cadastro do CRM é
 * povoado/sincronizado.
 *
 * A planilha é cacheada em memória por 5 minutos para não hammeriar
 * o Google Sheets a cada request.
 * ================================================================
 */
'use strict';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Cache em memória da planilha (processo único)
let _sheetCache = {
  rows: null,       // [{ cod, nome, telefone, cidade }]
  fetchedAt: 0,
  fetching: null,   // Promise em voo (evita race)
};

// ─────────────────────────────────────────────────────────────────
// PLANILHA (FALLBACK)
// ─────────────────────────────────────────────────────────────────

/**
 * Parser CSV com suporte a vírgulas dentro de aspas e descoberta por header.
 * Aceita cabeçalhos com ou sem acento (ex: "Código"/"Codigo").
 */
function _parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function _normHeader(h) {
  return String(h || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Parser CSV da planilha — lê headers da primeira linha e mapeia por nome,
 * com fallback para índice posicional (A=cod, B=nome, C=telefone, D=cidade)
 * caso os headers esperados não sejam encontrados.
 */
function _parseSheetCSV(csvText) {
  const clean = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = clean.split('\n');
  if (lines.length < 2) return [];

  const headers = _parseCSVLine(lines[0]).map(_normHeader);

  // Mapear índices pelos headers normalizados
  const findIdx = (...candidates) => {
    for (const c of candidates) {
      const idx = headers.indexOf(c);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  let idxCod = findIdx('codigo', 'cod');
  let idxNome = findIdx('nome', 'name');
  let idxTel = findIdx('telefone', 'phone', 'tel');
  let idxCidade = findIdx('cidade', 'city', 'regiao');
  let idxDataAtiv = findIdx('data ativacao', 'data_ativacao', 'dataativacao', 'data de ativacao');
  let idxQuemAtivou = findIdx('quem ativou', 'quem_ativou', 'quemativou', 'ativador');

  // Fallback posicional (comportamento legado)
  if (idxCod === -1) idxCod = 0;
  if (idxNome === -1) idxNome = 1;
  if (idxTel === -1) idxTel = 2;
  if (idxCidade === -1) idxCidade = 3;

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = _parseCSVLine(line);
    const cod = (cols[idxCod] || '').trim();
    if (!cod) continue;
    out.push({
      cod,
      nome:         (cols[idxNome]       || '').trim() || null,
      telefone:     (cols[idxTel]        || '').trim() || null,
      cidade:       (cols[idxCidade]     || '').trim() || null,
      dataAtivacao: idxDataAtiv   >= 0 ? ((cols[idxDataAtiv]   || '').trim() || null) : null,
      quemAtivou:   idxQuemAtivou >= 0 ? ((cols[idxQuemAtivou] || '').trim() || null) : null,
    });
  }
  return out;
}

/**
 * Converte data BR (DD/MM/YYYY) para ISO (YYYY-MM-DD). Null se inválida.
 */
function _parseDataBR(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) {
    // Talvez já venha em ISO
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const dia = m[1].padStart(2, '0');
  const mes = m[2].padStart(2, '0');
  let ano = m[3];
  if (ano.length === 2) ano = '20' + ano;
  const nA = parseInt(ano, 10), nM = parseInt(mes, 10), nD = parseInt(dia, 10);
  if (nA < 2000 || nM < 1 || nM > 12 || nD < 1 || nD > 31) return null;
  return `${ano}-${mes}-${dia}`;
}

/**
 * Retorna linhas da planilha respeitando TTL de cache.
 * Nunca lança — em caso de falha retorna array vazio e loga.
 */
async function _getPlanilhaRows() {
  const now = Date.now();
  if (_sheetCache.rows && (now - _sheetCache.fetchedAt) < CACHE_TTL_MS) {
    return _sheetCache.rows;
  }
  if (_sheetCache.fetching) {
    return _sheetCache.fetching;
  }
  _sheetCache.fetching = (async () => {
    try {
      const resp = await fetch(SHEET_URL, { headers: { 'Accept': 'text/csv' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const rows = _parseSheetCSV(text);
      _sheetCache = { rows, fetchedAt: Date.now(), fetching: null };
      return rows;
    } catch (err) {
      console.warn('[profissionaisLookup] Falha ao buscar planilha:', err.message);
      _sheetCache.fetching = null;
      // Se já tínhamos cache antigo, devolve ele mesmo vencido (stale-while-error)
      return _sheetCache.rows || [];
    }
  })();
  return _sheetCache.fetching;
}

/** Força refresh do cache da planilha (útil para endpoints admin). */
function invalidarCachePlanilha() {
  _sheetCache = { rows: null, fetchedAt: 0, fetching: null };
}

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
 *                    origem:'crm'|'planilha'|'disponibilidade'|'users'}|null>}
 */
async function buscarProfissional(pool, cod) {
  if (cod === undefined || cod === null || cod === '') return null;
  const codStr = String(cod).trim();
  if (!codStr) return null;

  // 1º — CRM (fonte primária)
  try {
    const { rows } = await pool.query(
      `SELECT cod, nome, cidade, regiao, celular
         FROM crm_leads_capturados
        WHERE cod = $1
        LIMIT 1`,
      [codStr]
    );
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
    console.warn('[profissionaisLookup] Erro CRM:', err.message);
  }

  // 2º — Planilha (fallback legado)
  try {
    const rows = await _getPlanilhaRows();
    const hit = rows.find(r => r.cod === codStr);
    if (hit && (hit.nome || hit.cidade)) {
      return {
        cod:      hit.cod,
        nome:     hit.nome,
        cidade:   hit.cidade,
        regiao:   hit.cidade, // na planilha "região" == coluna cidade
        telefone: hit.telefone,
        origem:   'planilha',
      };
    }
  } catch (err) {
    console.warn('[profissionaisLookup] Erro planilha:', err.message);
  }

  // 3º — disponibilidade_linhas (só nome)
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT nome_profissional
         FROM disponibilidade_linhas
        WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
        LIMIT 1`,
      [codStr]
    );
    if (rows.length > 0 && rows[0].nome_profissional) {
      return {
        cod:      codStr,
        nome:     rows[0].nome_profissional,
        cidade:   null,
        regiao:   null,
        telefone: null,
        origem:   'disponibilidade',
      };
    }
  } catch (err) {
    console.warn('[profissionaisLookup] Erro disponibilidade:', err.message);
  }

  // 4º — users (só nome)
  try {
    const { rows } = await pool.query(
      `SELECT full_name
         FROM users
        WHERE cod_profissional = $1
        LIMIT 1`,
      [codStr]
    );
    if (rows.length > 0 && rows[0].full_name) {
      return {
        cod:      codStr,
        nome:     rows[0].full_name,
        cidade:   null,
        regiao:   null,
        telefone: null,
        origem:   'users',
      };
    }
  } catch (err) {
    console.warn('[profissionaisLookup] Erro users:', err.message);
  }

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
 * Estratégia: UNION do CRM com a planilha (deduplicado, case-insensitive),
 * ordenado alfabeticamente. Se ambos falharem → [].
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

  // Planilha (merge)
  try {
    const rows = await _getPlanilhaRows();
    for (const row of rows) {
      if (row.cidade) {
        const key = row.cidade.toUpperCase();
        if (!set.has(key)) set.set(key, row.cidade);
      }
    }
  } catch (err) {
    console.warn('[profissionaisLookup] listarRegioes planilha falhou:', err.message);
  }

  return Array.from(set.values()).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/**
 * Lista completa de profissionais — usada pela aba "Cadastro" do CRM
 * e por relatórios. Merge CRM + planilha, CRM tem prioridade.
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

  // Planilha (só preenche quem faltar)
  try {
    const rows = await _getPlanilhaRows();
    for (const r of rows) {
      if (!r.cod || map.has(r.cod)) continue;
      map.set(r.cod, {
        codigo:       r.cod,
        nome:         r.nome || '',
        telefone:     r.telefone || '',
        regiao:       (r.cidade || '').toUpperCase(),
        cidade:       r.cidade || '',
        dataAtivacao: _parseDataBR(r.dataAtivacao) || '',
        quemAtivou:   r.quemAtivou ? r.quemAtivou.toUpperCase() : '',
        origem:       'planilha',
      });
    }
  } catch (err) {
    console.warn('[profissionaisLookup] listarProfissionais planilha falhou:', err.message);
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
