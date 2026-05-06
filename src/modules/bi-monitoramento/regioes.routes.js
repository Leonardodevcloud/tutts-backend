/**
 * BI Monitoramento - Aba "Por Região"
 *
 * Reaproveita a tabela bi_regioes (mesma do BI principal).
 * Cada região mapeia uma lista de {cod_cliente, centro_custo}.
 *
 * Cruza com bi_entregas filtradas e devolve KPIs operacionais por região.
 * Entrega que não bate com nenhuma região vai pra "Sem Região".
 */
const express = require('express');
const { montarWhere, RETORNO_FILTRO } = require('./dashboard.routes');

function createRegioesRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/bi-monitoramento/regioes
   * Filtros aplicáveis: data_inicio, data_fim, cod_cliente, centro_custo, etc.
   */
  router.get('/bi-monitoramento/regioes', async (req, res) => {
    try {
      // 1. Carrega o mapeamento de regiões (cliente/centro -> nome_regiao)
      const regioesMap = await pool.query('SELECT id, nome, clientes FROM bi_regioes ORDER BY nome');

      // Constrói lookup: chave "cod_cliente:centro_custo" -> [nomes_regiao]
      // Uma entrega pode bater em + de 1 região? Sim, no formato atual.
      // Pra evitar dupla contagem, escolhemos a PRIMEIRA região que casa.
      const lookup = new Map(); // chave -> nome_regiao
      const lookupClientesAll = new Map(); // cod_cliente -> nome_regiao (quando centro_custo é null)

      for (const r of regioesMap.rows) {
        let itens = r.clientes;
        if (typeof itens === 'string') {
          try { itens = JSON.parse(itens); } catch { itens = []; }
        }
        if (!Array.isArray(itens)) continue;

        for (const item of itens) {
          let cod, cc;
          if (typeof item === 'object' && item !== null) {
            cod = item.cod_cliente;
            cc = item.centro_custo;
          } else {
            // Formato legado: array de cod_cliente
            cod = item;
            cc = null;
          }
          if (cod === undefined || cod === null) continue;

          if (cc === null || cc === undefined || cc === '') {
            // Região cobre TODOS os centros de custo desse cliente
            if (!lookupClientesAll.has(String(cod))) {
              lookupClientesAll.set(String(cod), r.nome);
            }
          } else {
            const chave = `${cod}:${cc}`;
            if (!lookup.has(chave)) {
              lookup.set(chave, r.nome);
            }
          }
        }
      }

      // 2. Busca todas as entregas filtradas (com cod_cliente + centro_custo)
      const { where, params } = montarWhere(req.query);

      const dadosQuery = await pool.query(`
        SELECT
          cod_cliente,
          centro_custo,
          os,
          dentro_prazo,
          tempo_execucao_minutos,
          distancia,
          cod_prof,
          ocorrencia
        FROM bi_entregas ${where}
      `, params);

      // 3. Agrega em memória por região (mais simples e flexível que SQL aqui)
      const agregado = new Map(); // nome_regiao -> { ...kpis }

      function getBucket(nomeRegiao) {
        if (!agregado.has(nomeRegiao)) {
          agregado.set(nomeRegiao, {
            regiao: nomeRegiao,
            total_entregas: 0,
            os_set: new Set(),
            dentro_prazo: 0,
            fora_prazo: 0,
            sem_prazo: 0,
            soma_tempo: 0,
            qtd_tempo: 0,
            soma_distancia: 0,
            prof_set: new Set(),
            cliente_set: new Set(),
            retornos: 0
          });
        }
        return agregado.get(nomeRegiao);
      }

      // Mesma string-match do RETORNO_FILTRO, agora em JS
      const PADROES_RETORNO = [
        'cliente fechado', 'clienteaus', 'cliente ausente',
        'loja fechada', 'produto incorreto', 'retorno'
      ];
      function ehRetorno(ocorrencia) {
        if (!ocorrencia) return false;
        const s = String(ocorrencia).toLowerCase();
        return PADROES_RETORNO.some(p => s.includes(p));
      }

      for (const row of dadosQuery.rows) {
        const codStr = String(row.cod_cliente || '');
        const cc = row.centro_custo;
        let nomeRegiao = null;

        if (cc !== null && cc !== undefined && cc !== '') {
          nomeRegiao = lookup.get(`${codStr}:${cc}`) || null;
        }
        if (!nomeRegiao) {
          // Tenta cair no "todos os centros desse cliente"
          nomeRegiao = lookupClientesAll.get(codStr) || null;
        }
        if (!nomeRegiao) nomeRegiao = 'Sem Região';

        const b = getBucket(nomeRegiao);
        b.total_entregas++;
        if (row.os) b.os_set.add(row.os);
        if (row.dentro_prazo === true) b.dentro_prazo++;
        else if (row.dentro_prazo === false) b.fora_prazo++;
        else b.sem_prazo++;
        if (row.tempo_execucao_minutos != null) {
          b.soma_tempo += Number(row.tempo_execucao_minutos);
          b.qtd_tempo++;
        }
        if (row.distancia != null) b.soma_distancia += Number(row.distancia);
        if (row.cod_prof) b.prof_set.add(row.cod_prof);
        if (row.cod_cliente) b.cliente_set.add(row.cod_cliente);
        if (ehRetorno(row.ocorrencia)) b.retornos++;
      }

      // 4. Converte pro formato final
      const regioes = Array.from(agregado.values()).map(b => {
        const comPrazo = b.dentro_prazo + b.fora_prazo;
        const taxaPrazo = comPrazo > 0
          ? Math.round((100 * b.dentro_prazo / comPrazo) * 10) / 10
          : null;
        const tempoMedio = b.qtd_tempo > 0
          ? Math.round((b.soma_tempo / b.qtd_tempo) * 10) / 10
          : null;
        return {
          regiao: b.regiao,
          total_os: b.os_set.size,
          total_entregas: b.total_entregas,
          dentro_prazo: b.dentro_prazo,
          fora_prazo: b.fora_prazo,
          sem_prazo: b.sem_prazo,
          taxa_prazo: taxaPrazo,
          tempo_medio: tempoMedio,
          km_total: Math.round(b.soma_distancia * 100) / 100,
          total_profissionais: b.prof_set.size,
          total_clientes: b.cliente_set.size,
          retornos: b.retornos
        };
      }).sort((a, b) => b.total_entregas - a.total_entregas);

      res.json({ regioes });
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro regioes:', err);
      res.status(500).json({ error: 'Erro ao carregar regiões' });
    }
  });

  return router;
}

module.exports = { createRegioesRoutes };
