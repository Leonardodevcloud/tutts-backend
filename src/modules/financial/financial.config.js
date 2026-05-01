/**
 * MÓDULO FINANCIAL - Helper de configuração (financial_config)
 *
 * Cache TTL de 30s pra evitar query a cada solicitação de saque.
 * Cache é invalidado imediatamente após qualquer escrita.
 *
 * Uso:
 *   const cfg = createFinancialConfig(pool);
 *   const habilitados = await cfg.getBool('saques_habilitados');     // true/false
 *   await cfg.set('saques_automaticos', 'true', 'admin nome');       // atualiza + invalida cache
 *   const tudo = await cfg.getAll();                                 // { chave: {valor, updated_by, updated_at} }
 */

function createFinancialConfig(pool) {
  // Cache: chave → { valor: string, expiraEm: ms }
  const cache = new Map();
  const TTL_MS = 30 * 1000; // 30 segundos

  function _cacheLer(chave) {
    const entry = cache.get(chave);
    if (!entry) return null;
    if (Date.now() > entry.expiraEm) {
      cache.delete(chave);
      return null;
    }
    return entry.valor;
  }

  function _cacheGravar(chave, valor) {
    cache.set(chave, { valor, expiraEm: Date.now() + TTL_MS });
  }

  function invalidar() {
    cache.clear();
  }

  /**
   * Lê valor bruto (string) de uma chave. Retorna null se não existe.
   */
  async function get(chave) {
    const cached = _cacheLer(chave);
    if (cached !== null) return cached;

    const r = await pool.query(
      'SELECT valor FROM financial_config WHERE chave = $1',
      [chave]
    );
    if (r.rows.length === 0) return null;
    const valor = r.rows[0].valor;
    _cacheGravar(chave, valor);
    return valor;
  }

  /**
   * Lê valor como boolean. Default fallback se chave não existir.
   * Trata 'true'/'1'/'yes' como true (case-insensitive).
   */
  async function getBool(chave, defaultVal = false) {
    const v = await get(chave);
    if (v === null) return defaultVal;
    const norm = String(v).trim().toLowerCase();
    return norm === 'true' || norm === '1' || norm === 'yes';
  }

  /**
   * Atualiza valor de uma chave. Cria se não existir.
   * Invalida cache imediatamente.
   */
  async function set(chave, valor, updatedBy = null) {
    await pool.query(`
      INSERT INTO financial_config (chave, valor, updated_by, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (chave) DO UPDATE
        SET valor = EXCLUDED.valor,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
    `, [chave, String(valor), updatedBy]);
    invalidar();
  }

  /**
   * Retorna todas as chaves conhecidas como objeto:
   *   { chave: {valor, descricao, updated_by, updated_at} }
   */
  async function getAll() {
    const r = await pool.query(
      'SELECT chave, valor, descricao, updated_by, updated_at FROM financial_config ORDER BY chave'
    );
    const map = {};
    for (const row of r.rows) {
      map[row.chave] = {
        valor: row.valor,
        descricao: row.descricao,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
      };
      _cacheGravar(row.chave, row.valor);
    }
    return map;
  }

  return {
    get,
    getBool,
    set,
    getAll,
    invalidar,
  };
}

module.exports = { createFinancialConfig };
