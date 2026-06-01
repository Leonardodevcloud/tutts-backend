/**
 * src/shared/utils/tzBahia.js
 * Fonte única de verdade para "hoje/agora em America/Bahia".
 *
 * CONTEXTO: as colunas created_at são TIMESTAMP (sem timezone) e a sessão do
 * Postgres roda em UTC (default do Neon) — ou seja, guardam hora-de-parede em UTC.
 * Para classificar "hoje em Bahia" SEM depender do timezone da sessão, todo o
 * cálculo de fronteira de dia deve passar por estes helpers.
 *
 * - No Node: derivamos hora/data de Bahia via toLocaleString (independente do TZ do servidor).
 * - No SQL: convertemos a coluna explicitamente UTC -> Bahia antes de extrair a data,
 *   em vez de usar CURRENT_DATE (que é a data UTC) ou comparações implícitas.
 */
'use strict';

const TZ = 'America/Bahia';

/** Date com a HORA-DE-PAREDE de Bahia (use getHours/getMinutes; NÃO use .toISOString()). */
function agoraBahia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** Data-calendário de Bahia no formato 'YYYY-MM-DD' (robusto a qualquer TZ do servidor). */
function dataRefBahia(d) {
  const base = d || agoraBahia();
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Expressão SQL que testa se uma coluna TIMESTAMP (UTC wall-clock) cai no MESMO
 * dia-calendário de Bahia que agora. Independente do timezone da sessão.
 * Ex.: mesmoDiaBahiaSQL('h.created_at')
 */
function mesmoDiaBahiaSQL(coluna) {
  return `((${coluna}) AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`;
}

/** Início do PRÓXIMO dia de Bahia, como timestamptz (ex.: para bloqueio "até amanhã 00:00 Bahia"). */
function inicioProximoDiaBahiaSQL() {
  return `(((now() AT TIME ZONE '${TZ}')::date + 1)::timestamp AT TIME ZONE '${TZ}')`;
}

module.exports = { TZ, agoraBahia, dataRefBahia, mesmoDiaBahiaSQL, inicioProximoDiaBahiaSQL };
