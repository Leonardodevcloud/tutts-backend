/**
 * routes/historico.routes.js
 * GET   /agent/historico           (admin)
 * GET   /agent/historico/:id/detalhes (admin - dados completos p/ mapa)
 * PATCH /agent/validar/:id         (admin)
 * DELETE /agent/historico/:id       (admin - excluir solicitacao)
 * GET   /agent/historico/csv       (admin)
 */

'use strict';

const express = require('express');

function createHistoricoRoutes(pool, verificarAdmin) {
  const router = express.Router();

  // GET /agent/meu-historico (autenticado - motoboy ve so suas solicitacoes)
  router.get('/meu-historico', async (req, res) => {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ erro: 'Nao autenticado.' });

    const { page = 1, per_page = 20 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(per_page, 10);

    try {
      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, os_numero, ponto, localizacao_raw, latitude, longitude,
                  endereco_corrigido, status, detalhe_erro, criado_em, processado_em
           FROM ajustes_automaticos
           WHERE usuario_id = $1
           ORDER BY criado_em DESC
           LIMIT $2 OFFSET $3`,
          [usuarioId, parseInt(per_page, 10), offset]
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM ajustes_automaticos WHERE usuario_id = $1`,
          [usuarioId]
        ),
      ]);

      return res.json({
        registros: dataRes.rows,
        total:     parseInt(countRes.rows[0].total, 10),
        page:      parseInt(page, 10),
        per_page:  parseInt(per_page, 10),
      });
    } catch (err) {
      console.error('[agent/meu-historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar historico.' });
    }
  });

  // GET /agent/meu-historico/:id/foto
  router.get('/meu-historico/:id/foto', async (req, res) => {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ erro: 'Nao autenticado.' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_fachada FROM ajustes_automaticos WHERE id = $1 AND usuario_id = $2`,
        [id, usuarioId]
      );
      if (rows.length === 0 || !rows[0].foto_fachada) {
        return res.status(404).json({ erro: 'Foto nao encontrada.' });
      }
      return res.json({ foto: rows[0].foto_fachada });
    } catch (err) {
      console.error('[agent/meu-historico/foto]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto.' });
    }
  });

  // GET /agent/foto/:id (admin)
  router.get('/foto/:id', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_fachada FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0 || !rows[0].foto_fachada) {
        return res.status(404).json({ erro: 'Foto nao encontrada.' });
      }
      return res.json({ foto: rows[0].foto_fachada });
    } catch (err) {
      console.error('[agent/foto]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto.' });
    }
  });

  // 2026-04: GET /agent/foto-nf/:id (admin) — foto da nota fiscal
  router.get('/foto-nf/:id', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_nf, validacao_nf FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ erro: 'Solicitacao nao encontrada.', sem_foto: true });
      }
      if (!rows[0].foto_nf) {
        // Solicitacao existe mas nao tem foto da NF — pode ser que tenha sido
        // enviada via CNPJ digitado, ou que a foto nao foi salva por algum motivo.
        const temValidacao = !!rows[0].validacao_nf;
        const origem = rows[0].validacao_nf?.origem || rows[0].validacao_nf?.dados?.origem;
        let motivo = 'Esta solicitacao nao tem foto da NF salva.';
        if (origem === 'cnpj_manual') {
          motivo = 'O motoboy enviou apenas o CNPJ digitado (sem foto da NF).';
        } else if (temValidacao) {
          motivo = 'A foto da NF foi processada pela IA mas nao foi salva no banco. Possivel falha no envio.';
        }
        return res.status(404).json({ erro: motivo, sem_foto: true });
      }
      return res.json({ foto: rows[0].foto_nf });
    } catch (err) {
      console.error('[agent/foto-nf]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto da NF.' });
    }
  });

  // GET /agent/historico (admin) — agora retorna coords para o mapa
  router.get('/historico', verificarAdmin, async (req, res) => {
    const { status, os_numero, de, ate, motoboy, grupo, page = 1, per_page = 30 } = req.query;

    // 2026-07 auto-liberacao: grupo dedicado "Falha/Liberacao IA" — junta o ajuste
    // (que falhou + IA validou) com o registro de liberacao gerado. Query isolada
    // (aliases a./l.) pra nao mexer no fluxo dos outros grupos.
    if (grupo === 'liberacao_ia') {
      const condL = ['a.liberacao_auto_id IS NOT NULL'];
      const parL  = [];
      let   pl    = 1;
      if (os_numero) { condL.push(`a.os_numero ILIKE $${pl++}`); parL.push(`%${os_numero}%`); }
      if (motoboy)   {
        condL.push(`(a.usuario_nome ILIKE $${pl} OR a.cod_profissional::text ILIKE $${pl})`);
        parL.push(`%${motoboy}%`); pl++;
      }
      if (de)  { condL.push(`a.criado_em >= ($${pl++}::date AT TIME ZONE 'America/Bahia')`); parL.push(de); }
      if (ate) { condL.push(`a.criado_em < (($${pl++}::date + INTERVAL '1 day') AT TIME ZONE 'America/Bahia')`); parL.push(ate); }
      const whereL  = `WHERE ${condL.join(' AND ')}`;
      const offsetL = (parseInt(page, 10) - 1) * parseInt(per_page, 10);
      try {
        const [dataL, countL] = await Promise.all([
          pool.query(
            `SELECT a.id, a.os_numero, a.ponto, a.status, a.erro, a.detalhe_erro,
                    a.criado_em, a.finalizado_em, a.etapa_atual, a.progresso,
                    a.usuario_id, a.usuario_nome, a.cod_profissional,
                    a.endereco_antigo, a.endereco_corrigido,
                    a.latitude, a.longitude, a.motoboy_lat, a.motoboy_lng,
                    a.endereco_antigo_lat, a.endereco_antigo_lng,
                    a.validacao_localizacao, a.validacao_nf,
                    (a.foto_nf IS NOT NULL) AS tem_foto_nf,
                    (a.foto_fachada IS NOT NULL) AS tem_foto_fachada,
                    l.id            AS liberacao_id,
                    l.status        AS liberacao_status,
                    l.ponto         AS liberacao_ponto,
                    l.origem        AS liberacao_origem,
                    l.finalizado_em AS liberacao_finalizado_em,
                    l.mensagem_retorno AS liberacao_mensagem,
                    l.erro          AS liberacao_erro,
                    l.etapa_atual   AS liberacao_etapa,
                    l.progresso     AS liberacao_progresso
             FROM ajustes_automaticos a
             LEFT JOIN liberacoes_pontos l ON l.id = a.liberacao_auto_id
             ${whereL}
             ORDER BY a.criado_em DESC
             LIMIT $${pl} OFFSET $${pl + 1}`,
            [...parL, parseInt(per_page, 10), offsetL]
          ),
          pool.query(`SELECT COUNT(*) AS total FROM ajustes_automaticos a ${whereL}`, parL),
        ]);
        return res.json({
          registros: dataL.rows,
          total:     parseInt(countL.rows[0].total, 10),
          page:      parseInt(page, 10),
          per_page:  parseInt(per_page, 10),
        });
      } catch (err) {
        console.error('[agent/historico liberacao_ia]', err.message);
        return res.status(500).json({ erro: 'Erro ao carregar liberacoes.' });
      }
    }

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (status)    { conditions.push(`status = $${p++}`);        params.push(status); }
    if (os_numero) { conditions.push(`os_numero ILIKE $${p++}`); params.push(`%${os_numero}%`); }
    // 2026-07: busca por motoboy (nome OU codigo profissional)
    if (motoboy)   {
      conditions.push(`(usuario_nome ILIKE $${p} OR cod_profissional::text ILIKE $${p})`);
      params.push(`%${motoboy}%`);
      p++;
    }
    // 2026-07: grupo aprovados x barradas
    if (grupo === 'aprovados')     { conditions.push(`status = 'sucesso'`); }
    // BARRADO_HISTORICO_V1: 'barrado' = reprovada pela regra B/C/E (nunca virou job).
    // Os outros tres sao correcoes que ENTRARAM e quebraram depois, no Playwright.
    else if (grupo === 'barradas') { conditions.push(`status IN ('barrado','erro','falhou','bloqueado_cliente')`); }
    // 2026-07 FIX datas: BRT + 'ate' inclusivo. Antes 'criado_em <= AAAA-MM-DD'
    // era lido como meia-noite, excluindo o dia inteiro do "ate" e fazendo a
    // busca de um unico dia (de=ate) nao retornar nada.
    if (de)        { conditions.push(`criado_em >= ($${p++}::date AT TIME ZONE 'America/Bahia')`); params.push(de); }
    if (ate)       { conditions.push(`criado_em < (($${p++}::date + INTERVAL '1 day') AT TIME ZONE 'America/Bahia')`); params.push(ate); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page, 10) - 1) * parseInt(per_page, 10);

    try {
      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, os_numero, ponto, status, detalhe_erro, erro,
                  finalizado_em, etapa_atual, progresso, screenshot_path,
                  criado_em, processado_em, validado_por, validado_em,
                  usuario_id, usuario_nome, endereco_antigo, endereco_corrigido,
                  cod_profissional, frete_recalculado,
                  latitude, longitude, motoboy_lat, motoboy_lng,
                  ponto1_lat, ponto1_lng, ponto1_endereco,
                  endereco_antigo_lat, endereco_antigo_lng,
                  validacao_localizacao, validacao_nf, valores_antes, valores_depois,
                  (foto_nf IS NOT NULL) AS tem_foto_nf,
                  (foto_fachada IS NOT NULL) AS tem_foto_fachada
           FROM ajustes_automaticos ${where}
           ORDER BY criado_em DESC
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, parseInt(per_page, 10), offset]
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM ajustes_automaticos ${where}`,
          params
        ),
      ]);

      return res.json({
        registros: dataRes.rows,
        total:     parseInt(countRes.rows[0].total, 10),
        page:      parseInt(page, 10),
        per_page:  parseInt(per_page, 10),
      });
    } catch (err) {
      console.error('[agent/historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar historico.' });
    }
  });

  // GET /agent/historico/:id/detalhes (admin — dados completos p/ mapa)
  router.get('/historico/:id/detalhes', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status,
                endereco_antigo, endereco_corrigido,
                latitude, longitude,
                motoboy_lat, motoboy_lng,
                localizacao_raw, detalhe_erro, erro,
                finalizado_em, etapa_atual, progresso, screenshot_path,
                criado_em, processado_em,
                validado_por, validado_em,
                usuario_nome, cod_profissional,
                frete_recalculado,
                ponto1_lat, ponto1_lng, ponto1_endereco,
                endereco_antigo_lat, endereco_antigo_lng,
                validacao_localizacao, validacao_nf, valores_antes, valores_depois
         FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ erro: 'Registro nao encontrado.' });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error('[agent/historico/detalhes]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar detalhes.' });
    }
  });

  // PATCH /agent/validar/:id
  router.patch('/validar/:id', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    const usuarioNome = req.user?.nome || req.user?.email || req.user?.name || 'Admin';

    try {
      const { rows } = await pool.query(
        `UPDATE ajustes_automaticos
         SET validado_por = $1, validado_em = NOW()
         WHERE id = $2
         RETURNING id, validado_por, validado_em`,
        [usuarioNome, id]
      );
      if (rows.length === 0) return res.status(404).json({ erro: 'Nao encontrado.' });
      return res.json({ sucesso: true, ...rows[0] });
    } catch (err) {
      console.error('[agent/validar]', err.message);
      return res.status(500).json({ erro: 'Erro ao validar.' });
    }
  });

  // DELETE /agent/historico/:id (admin — excluir solicitacao)
  router.delete('/historico/:id', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID invalido.' });

    try {
      const { rows } = await pool.query(
        `DELETE FROM ajustes_automaticos WHERE id = $1 RETURNING id, os_numero`,
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ erro: 'Registro nao encontrado.' });
      }

      const admin = req.user?.nome || req.user?.email || 'Admin';
      console.log(`[agent] Solicitacao excluida: ID ${rows[0].id} OS ${rows[0].os_numero} por ${admin}`);
      return res.json({ sucesso: true, mensagem: 'Solicitacao excluida com sucesso.' });
    } catch (err) {
      console.error('[agent/historico/delete]', err.message);
      return res.status(500).json({ erro: 'Erro ao excluir registro.' });
    }
  });

  // GET /agent/historico/csv
  router.get('/historico/csv', verificarAdmin, async (req, res) => {
    const { status, os_numero, de, ate } = req.query;
    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (status)    { conditions.push(`status = $${p++}`);        params.push(status); }
    if (os_numero) { conditions.push(`os_numero ILIKE $${p++}`); params.push(`%${os_numero}%`); }
    if (de)        { conditions.push(`criado_em >= $${p++}`);    params.push(de); }
    if (ate)       { conditions.push(`criado_em <= $${p++}`);    params.push(ate); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status, detalhe_erro,
                criado_em, processado_em, validado_por, validado_em
         FROM ajustes_automaticos ${where}
         ORDER BY criado_em DESC`,
        params
      );

      const header = 'ID,OS,Ponto,Status,Detalhe Erro,Criado Em,Processado Em,Validado Por,Validado Em';
      const lines  = rows.map(r => [
        r.id, r.os_numero, r.ponto, r.status,
        `"${(r.detalhe_erro || '').replace(/"/g, '""')}"`,
        r.criado_em     ? new Date(r.criado_em).toLocaleString('pt-BR')     : '',
        r.processado_em ? new Date(r.processado_em).toLocaleString('pt-BR') : '',
        r.validado_por  || '',
        r.validado_em   ? new Date(r.validado_em).toLocaleString('pt-BR')   : '',
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ajustes_automaticos.csv"');
      return res.send('\uFEFF' + [header, ...lines].join('\n'));
    } catch (err) {
      console.error('[agent/historico/csv]', err.message);
      return res.status(500).json({ erro: 'Erro ao exportar CSV.' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /agent/analytics (admin) — ANALYTICS_V2
  //
  // Reescrito inteiro. O que estava errado no anterior:
  //
  // 1. SO CONTAVA 'sucesso' E 'erro'. A tabela tem seis estados possiveis
  //    (pendente, processando, sucesso, erro, falhou, barrado, bloqueado_cliente)
  //    e o SQL conhecia dois. Na producao isso dava:
  //
  //        5777 total - 4652 sucesso - 576 erro - 6 pendentes = 543 SUMIDAS
  //
  //    543 correcoes (9,4%) que nao apareciam em lugar nenhum da tela. E as
  //    barradas, que a gente comecou a gravar agora, cairiam no mesmo buraco.
  //
  // 2. QUATRO JANELAS NA MESMA TELA. O card "Total" era de SEMPRE (sem filtro de
  //    data), o grafico de mes era 6 meses, o de semana 8 semanas, o de dia 7
  //    dias. Quatro numeros que nao conversam, um do lado do outro.
  //
  // 3. NAO ACEITAVA PERIODO. Nao dava pra olhar "a semana passada" nem "depois do
  //    deploy X" — que e a pergunta que se faz quando se muda uma regra.
  //
  // Agora: ?de=YYYY-MM-DD&ate=YYYY-MM-DD (ou ?dias=N), e TODA consulta usa a
  // mesma janela. O front manda um periodo, a tela inteira responde por ele.
  //
  // Novidades que o dado novo permite:
  //   - por_fase: agrupa fase_falha (COALESCE com etapa_atual, pra falha de RPA)
  //   - gps: histograma de gps_accuracy — responde "o limite de 60m esta apertado?"
  //   - anterior: os mesmos totais da janela imediatamente anterior, do mesmo
  //     tamanho, pro delta "vs. periodo anterior"
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/analytics', verificarAdmin, async (req, res) => {
    try {
      // ── Janela ──
      //
      // TUDO aqui trabalha com DATA (YYYY-MM-DD), nunca com timestamp, e os
      // parametros vao pro Postgres como STRING. Dois motivos:
      //
      // 1. Se eu montasse a janela a partir do AGORA (18:32), o `dias=30` daria
      //    "de 17/06 as 18:32". Mas o generate_series($1::date) do grafico corta
      //    em meia-noite — o grafico contaria o dia 17 inteiro e o KPI so a partir
      //    das 18:32. Dois numeros diferentes na mesma tela, que e exatamente o
      //    problema que este arquivo esta consertando.
      //
      // 2. node-postgres serializa objeto Date COM fuso; a coluna criado_em e
      //    TIMESTAMP sem fuso. A conversao acontece calada e desloca tudo em 3h.
      //    String 'YYYY-MM-DD' o Postgres faz cast pra meia-noite e pronto.
      //
      // `ate` e inclusivo pro usuario (quem digita 16/07 quer o dia 16 inteiro),
      // entao as queries comparam com < ateExc, que e o dia seguinte.
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const parseData = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return isNaN(d.getTime()) ? null : d;
      };

      let de  = parseData(req.query.de);
      let ate = parseData(req.query.ate);

      if (!de || !ate) {
        const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 730);
        const hoje = new Date();
        ate = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()); // meia-noite de hoje
        de  = new Date(ate);
        de.setDate(de.getDate() - (dias - 1)); // inclusivo: dias=1 -> so hoje
      }
      if (de > ate) { const t = de; de = ate; ate = t; }

      const MS_DIA     = 86400000;
      const diasJanela = Math.max(1, Math.round((ate - de) / MS_DIA) + 1);

      const ateExc = new Date(ate);  ateExc.setDate(ateExc.getDate() + 1);
      // Janela anterior do MESMO tamanho, colada na atual (sem sobrepor nem pular).
      const dePrev = new Date(de);   dePrev.setDate(dePrev.getDate() - diasJanela);

      const P_DE = fmt(de), P_ATE = fmt(ate), P_ATE_EXC = fmt(ateExc), P_DE_PREV = fmt(dePrev);

      // Um SELECT de totais serve pra janela atual e pra anterior — o mesmo texto
      // com parametros diferentes. Se um dia mudar o que e "corrigida", muda aqui
      // e os dois lados mudam juntos.
      const SQL_TOTAIS = `
        SELECT
          COUNT(*)                                                          AS total,
          COUNT(*) FILTER (WHERE status = 'sucesso')                        AS corrigidas,
          COUNT(*) FILTER (WHERE status = 'barrado')                        AS barradas,
          COUNT(*) FILTER (WHERE status IN ('erro', 'falhou'))              AS falhas,
          COUNT(*) FILTER (WHERE status = 'bloqueado_cliente')              AS bloqueadas,
          COUNT(*) FILTER (WHERE status IN ('pendente', 'processando'))     AS na_fila,
          COUNT(*) FILTER (WHERE validado_por IS NOT NULL)                  AS validados
        FROM ajustes_automaticos
        WHERE criado_em >= $1 AND criado_em < $2
      `;

      const [
        totaisRes,
        anteriorRes,
        porDiaRes,
        porFaseRes,
        gpsRes,
        profissionaisRes,
      ] = await Promise.all([
        pool.query(SQL_TOTAIS, [P_DE, P_ATE_EXC]),
        pool.query(SQL_TOTAIS, [P_DE_PREV, P_DE]),

        // Serie diaria. generate_series preenche o dia que teve ZERO tentativa —
        // sem isso o grafico "pula" o buraco e some com a informacao mais
        // interessante que existe: o dia em que ninguem conseguiu corrigir nada.
        pool.query(`
          SELECT
            TO_CHAR(d.dia, 'YYYY-MM-DD')                                       AS dia,
            COALESCE(COUNT(a.id), 0)                                           AS total,
            COALESCE(COUNT(a.id) FILTER (WHERE a.status = 'sucesso'), 0)       AS corrigidas,
            COALESCE(COUNT(a.id) FILTER (WHERE a.status = 'barrado'), 0)       AS barradas,
            COALESCE(COUNT(a.id) FILTER (WHERE a.status IN ('erro','falhou')), 0) AS falhas
          FROM generate_series($1::date, $2::date, '1 day') AS d(dia)
          LEFT JOIN ajustes_automaticos a
            ON a.criado_em >= d.dia AND a.criado_em < d.dia + INTERVAL '1 day'
          GROUP BY d.dia
          ORDER BY d.dia ASC
        `, [P_DE, P_ATE]),

        // Onde as tentativas morrem.
        //
        // COALESCE(fase_falha, etapa_atual): fase_falha e escrita pela rota quando
        // ela recusa; falha do RPA (que ja entrou na fila) nao tem fase_falha, mas
        // tem etapa_atual dizendo onde o Playwright quebrou. Os dois respondem a
        // mesma pergunta — "onde morreu" — entao vao na mesma lista.
        pool.query(`
          SELECT
            COALESCE(fase_falha, etapa_atual, 'sem_fase') AS fase,
            COUNT(*) AS total
          FROM ajustes_automaticos
          WHERE criado_em >= $1 AND criado_em < $2
            AND status NOT IN ('sucesso', 'pendente', 'processando')
          GROUP BY 1
          ORDER BY total DESC
        `, [P_DE, P_ATE_EXC]),

        // Histograma da precisao do GPS. Responde direto: "o limite de 60m esta
        // apertado demais?". As faixas espelham as do cruzar-validacoes
        // (GPS_ACC_BOM=30, GPS_ACC_LIMITE=60) pra leitura ser imediata.
        pool.query(`
          SELECT
            CASE
              WHEN gps_accuracy <= 15  THEN '0-15'
              WHEN gps_accuracy <= 30  THEN '16-30'
              WHEN gps_accuracy <= 60  THEN '31-60'
              WHEN gps_accuracy <= 100 THEN '61-100'
              ELSE '100+'
            END AS faixa,
            COUNT(*) AS total
          FROM ajustes_automaticos
          WHERE criado_em >= $1 AND criado_em < $2
            AND gps_accuracy IS NOT NULL
          GROUP BY 1
        `, [P_DE, P_ATE_EXC]),

        // Profissionais. O "red_flags" separado morreu: era a MESMA tabela,
        // filtrada por volume, num bloco vermelho proprio. Agora e uma coluna
        // (aproveitamento) na lista unica — quem esta fora da curva o front marca.
        // Volume alto com aproveitamento bom nao e red flag, e um cara que
        // trabalha muito; o bloco antigo acusava os dois igual.
        pool.query(`
          SELECT
            usuario_nome,
            cod_profissional,
            COUNT(*)                                                   AS total,
            COUNT(*) FILTER (WHERE status = 'sucesso')                 AS corrigidas,
            COUNT(*) FILTER (WHERE status = 'barrado')                 AS barradas,
            COUNT(*) FILTER (WHERE status IN ('erro','falhou'))        AS falhas
          FROM ajustes_automaticos
          WHERE criado_em >= $1 AND criado_em < $2
            AND usuario_nome IS NOT NULL
          GROUP BY usuario_nome, cod_profissional
          ORDER BY total DESC
          LIMIT 50
        `, [P_DE, P_ATE_EXC]),
      ]);

      // Mediana da accuracy. Vai separado porque percentile_cont em cima de um
      // GROUP BY de faixa nao devolve a mediana da amostra, e a mediana e o numero
      // que a gente lê primeiro.
      const medRes = await pool.query(`
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gps_accuracy) AS mediana
        FROM ajustes_automaticos
        WHERE criado_em >= $1 AND criado_em < $2 AND gps_accuracy IS NOT NULL
      `, [P_DE, P_ATE_EXC]);

      const num = (o) => Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, v === null ? 0 : Number(v)])
      );

      return res.json({
        periodo: {
          de:   P_DE,
          ate:  P_ATE,
          dias: diasJanela,
          anterior: { de: P_DE_PREV, ate: P_DE },
        },
        totais:   num(totaisRes.rows[0]),
        anterior: num(anteriorRes.rows[0]),
        por_dia:  porDiaRes.rows.map(num_dia),
        por_fase: porFaseRes.rows.map(r => ({ fase: r.fase, total: Number(r.total) })),
        gps: {
          faixas:  Object.fromEntries(gpsRes.rows.map(r => [r.faixa, Number(r.total)])),
          mediana: medRes.rows[0].mediana === null ? null : Math.round(Number(medRes.rows[0].mediana)),
        },
        profissionais: profissionaisRes.rows.map(r => ({
          usuario_nome:     r.usuario_nome,
          cod_profissional: r.cod_profissional,
          total:            Number(r.total),
          corrigidas:       Number(r.corrigidas),
          barradas:         Number(r.barradas),
          falhas:           Number(r.falhas),
        })),
      });

      function num_dia(r) {
        return {
          dia:        r.dia,
          total:      Number(r.total),
          corrigidas: Number(r.corrigidas),
          barradas:   Number(r.barradas),
          falhas:     Number(r.falhas),
        };
      }
    } catch (err) {
      console.error('[agent/analytics]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar analytics.' });
    }
  });


  // GET /agent/historico/ponto1/:os_numero (admin - buscar Ponto 1)
  // Tenta 1: da propria tabela ajustes_automaticos (capturado pelo playwright)
  // Tenta 2: da tabela solicitacoes_corrida -> solicitacoes_pontos
  router.get('/historico/ponto1/:os_numero', verificarAdmin, async (req, res) => {
    const osNumero = req.params.os_numero;
    if (!osNumero) return res.status(400).json({ erro: 'OS obrigatoria.' });

    try {
      // Tentativa 1: ponto1 salvo na propria tabela ajustes_automaticos
      const ajuste = await pool.query(
        `SELECT ponto1_lat, ponto1_lng, ponto1_endereco FROM ajustes_automaticos WHERE os_numero = $1 AND ponto1_lat IS NOT NULL LIMIT 1`,
        [osNumero]
      );
      if (ajuste.rows.length > 0 && ajuste.rows[0].ponto1_lat) {
        return res.json({
          encontrado: true,
          fonte: 'ajustes_automaticos',
          ponto1: {
            latitude: parseFloat(ajuste.rows[0].ponto1_lat),
            longitude: parseFloat(ajuste.rows[0].ponto1_lng),
            endereco: ajuste.rows[0].ponto1_endereco || '',
          }
        });
      }

      // Tentativa 2: tabela solicitacoes_corrida -> solicitacoes_pontos
      const sol = await pool.query(
        `SELECT id FROM solicitacoes_corrida WHERE tutts_os_numero = $1 LIMIT 1`,
        [osNumero]
      );
      if (sol.rows.length > 0) {
        const ponto = await pool.query(
          `SELECT endereco_completo, rua, numero, bairro, cidade, uf, latitude, longitude
           FROM solicitacoes_pontos WHERE solicitacao_id = $1 AND ordem = 1 LIMIT 1`,
          [sol.rows[0].id]
        );
        if (ponto.rows.length > 0 && ponto.rows[0].latitude) {
          const p = ponto.rows[0];
          return res.json({
            encontrado: true,
            fonte: 'solicitacoes_pontos',
            ponto1: {
              latitude: parseFloat(p.latitude),
              longitude: parseFloat(p.longitude),
              endereco: p.endereco_completo || [p.rua, p.numero, p.bairro, p.cidade, p.uf].filter(Boolean).join(', '),
            }
          });
        }
      }

      return res.json({ encontrado: false, motivo: 'Ponto 1 sem coordenadas em nenhuma fonte' });
    } catch (err) {
      console.error('[agent/historico/ponto1]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar ponto 1.' });
    }
  });

  // POST /agent/geocodificar-antigos — Geocodifica endereços antigos sem coordenadas (retroativo, admin)
  router.post('/geocodificar-antigos', verificarAdmin, async (req, res) => {
    try {
      const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
      if (!GOOGLE_API_KEY) return res.status(400).json({ erro: 'GOOGLE_GEOCODING_API_KEY não configurada.' });

      const { rows } = await pool.query(
        `SELECT id, endereco_antigo FROM ajustes_automaticos
         WHERE endereco_antigo IS NOT NULL AND endereco_antigo != ''
         AND (endereco_antigo_lat IS NULL OR endereco_antigo_lat = 0)
         ORDER BY id DESC LIMIT 50`
      );

      if (rows.length === 0) return res.json({ processados: 0, mensagem: 'Nenhum registro pendente.' });

      let processados = 0;
      let erros = 0;

      for (const row of rows) {
        try {
          // 🔄 2026-05-23: usa helper com cache (era fetch direto)
          const { geocodeForward } = require('../../../shared/geocodeHelper');
          const geo = await geocodeForward(pool, row.endereco_antigo, { source: 'agent-historico' });
          if (geo) {
            await pool.query(
              `UPDATE ajustes_automaticos SET endereco_antigo_lat = $1, endereco_antigo_lng = $2 WHERE id = $3`,
              [geo.latitude, geo.longitude, row.id]
            );
            processados++;
          } else {
            erros++;
          }
          // Delay pra não estourar rate limit do Google (cache hit não tem delay)
          if (geo && geo.fonte === 'google') await new Promise(r => setTimeout(r, 200));
        } catch {
          erros++;
        }
      }

      return res.json({ total: rows.length, processados, erros });
    } catch (err) {
      console.error('[agent/geocodificar-antigos]', err.message);
      return res.status(500).json({ erro: 'Erro ao processar.' });
    }
  });

  return router;
}

module.exports = { createHistoricoRoutes };
