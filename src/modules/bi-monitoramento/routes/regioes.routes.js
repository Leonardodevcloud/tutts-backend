/**
 * BI Monitoramento - Aba "Por Região"
 *
 * v2: usa fórmula CASE WHEN pra tempo médio (em JS aqui, espelhando o SQL).
 * Importante: na ABA de regiões, NÃO aplicamos o filtro 'regiao' do query
 * (a aba mostra TODAS as regiões; quem filtra é o usuário visualmente).
 */
const express = require('express');
const { montarWhere, RETORNO_FILTRO } = require('./dashboard.routes');

function createRegioesRoutes(pool) {
  const router = express.Router();

  router.get('/bi-monitoramento/regioes', async (req, res) => {
    try {
      // 1. Carrega o mapeamento de regiões
      const regioesMap = await pool.query('SELECT id, nome, clientes FROM bi_regioes ORDER BY nome');

      const lookup = new Map();          // "cod:cc" -> nome_regiao
      const lookupClientesAll = new Map(); // cod_cliente -> nome_regiao (todos centros)

      for (const r of regioesMap.rows) {
        let itens = r.clientes;
        if (typeof itens === 'string') {
          try { itens = JSON.parse(itens); } catch { itens = []; }
        }
        if (!Array.isArray(itens)) continue;

        for (const item of itens) {
          let cod, cc;
          if (typeof item === 'object' && item !== null) {
            cod = item.cod_cliente; cc = item.centro_custo;
          } else {
            cod = item; cc = null;
          }
          if (cod === undefined || cod === null) continue;
          if (cc === null || cc === undefined || cc === '') {
            if (!lookupClientesAll.has(String(cod))) {
              lookupClientesAll.set(String(cod), r.nome);
            }
          } else {
            const chave = `${cod}:${cc}`;
            if (!lookup.has(chave)) lookup.set(chave, r.nome);
          }
        }
      }

      // 2. Filtro: ignora 'regiao' aqui (a aba mostra todas)
      const queryFiltros = { ...req.query };
      delete queryFiltros.regiao;
      const { where, params } = await montarWhere(pool, queryFiltros);

      // 3. Busca entregas com colunas necessárias pro tempo
      const dadosQuery = await pool.query(`
        SELECT
          cod_cliente, centro_custo, os, dentro_prazo, distancia,
          cod_prof, ocorrencia,
          data_hora, data_chegada, hora_chegada, finalizado, ponto
        FROM bi_entregas ${where}
      `, params);

      const PADROES_RETORNO = [
        'cliente fechado', 'clienteaus', 'cliente ausente',
        'loja fechada', 'produto incorreto', 'retorno'
      ];
      function ehRetorno(ocorrencia) {
        if (!ocorrencia) return false;
        const s = String(ocorrencia).toLowerCase();
        return PADROES_RETORNO.some(p => s.includes(p));
      }

      // Calcula tempo de entrega no JS (mesma fórmula do SQL TEMPO_ENTREGA_EXPR)
      function calcularTempoMin(row) {
        const ponto = row.ponto == null ? 1 : Number(row.ponto);
        if (ponto < 2) return null;
        if (!row.data_hora) return null;
        const dt = new Date(row.data_hora);
        if (isNaN(dt.getTime())) return null;

        // Caminho 1: data_chegada + hora_chegada
        if (row.data_chegada && row.hora_chegada) {
          const datChegStr = (row.data_chegada instanceof Date)
            ? row.data_chegada.toISOString().slice(0, 10)
            : String(row.data_chegada).slice(0, 10);
          const hrStr = String(row.hora_chegada);
          const chegada = new Date(`${datChegStr}T${hrStr}`);
          if (!isNaN(chegada.getTime()) && chegada >= dt) {
            // Se chegou em outro dia, conta a partir de 08:00 do dia da chegada
            const dtSolicitadoDia = dt.toISOString().slice(0, 10);
            let inicio = dt;
            if (datChegStr !== dtSolicitadoDia) {
              inicio = new Date(`${datChegStr}T08:00:00`);
            }
            return (chegada.getTime() - inicio.getTime()) / 60000;
          }
        }
        // Caminho 2: finalizado
        if (row.finalizado) {
          const fim = new Date(row.finalizado);
          if (!isNaN(fim.getTime()) && fim >= dt) {
            const dtSolDia = dt.toISOString().slice(0, 10);
            const fimDia = fim.toISOString().slice(0, 10);
            let inicio = dt;
            if (fimDia !== dtSolDia) {
              inicio = new Date(`${fimDia}T08:00:00`);
            }
            return (fim.getTime() - inicio.getTime()) / 60000;
          }
        }
        return null;
      }

      const agregado = new Map();
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

      for (const row of dadosQuery.rows) {
        const codStr = String(row.cod_cliente || '');
        const cc = row.centro_custo;
        let nomeRegiao = null;
        if (cc !== null && cc !== undefined && cc !== '') {
          nomeRegiao = lookup.get(`${codStr}:${cc}`) || null;
        }
        if (!nomeRegiao) {
          nomeRegiao = lookupClientesAll.get(codStr) || null;
        }
        if (!nomeRegiao) nomeRegiao = 'Sem Região';

        const b = getBucket(nomeRegiao);
        b.total_entregas++;
        if (row.os) b.os_set.add(row.os);
        if (row.dentro_prazo === true) b.dentro_prazo++;
        else if (row.dentro_prazo === false) b.fora_prazo++;
        else b.sem_prazo++;

        const tempo = calcularTempoMin(row);
        if (tempo !== null && !isNaN(tempo) && tempo >= 0) {
          b.soma_tempo += tempo;
          b.qtd_tempo++;
        }

        if (row.distancia != null) b.soma_distancia += Number(row.distancia);
        if (row.cod_prof) b.prof_set.add(row.cod_prof);
        if (row.cod_cliente) b.cliente_set.add(row.cod_cliente);
        if (ehRetorno(row.ocorrencia)) b.retornos++;
      }

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
      res.status(500).json({ error: 'Erro ao carregar regiões', detail: err.message });
    }
  });

  return router;
}

module.exports = { createRegioesRoutes };
