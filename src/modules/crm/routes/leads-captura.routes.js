/**
 * leads-captura.routes.js
 * Sub-router: endpoints para captura de leads via Playwright
 *
 * Endpoints:
 *   POST /executar           - Disparar captura manual
 *   POST /re-verificar       - Re-verificar status API de leads existentes
 *   GET  /                   - Listar leads capturados (com filtros)
 *   GET  /jobs               - Listar execuções (jobs)
 *   GET  /jobs/:id           - Detalhe de um job
 *   GET  /estatisticas       - KPIs e contadores
 *   DELETE /:id              - Remover um lead
 */

'use strict';

const express = require('express');

// ── Lock para evitar execuções simultâneas ──
let capturaEmAndamento = false;

function createLeadsCapturaRoutes(pool) {
  const router = express.Router();

  // ═══ Migration: coluna notificado_grupo ═══
  (async () => {
    try {
      // Verifica se coluna já existe
      const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='crm_leads_capturados' AND column_name='notificado_grupo'`);
      if (rows.length === 0) {
        // Primeira vez: criar coluna e marcar todos existentes como já notificados
        await pool.query('ALTER TABLE crm_leads_capturados ADD COLUMN notificado_grupo BOOLEAN DEFAULT FALSE');
        await pool.query('UPDATE crm_leads_capturados SET notificado_grupo = TRUE');
        console.log('  ✅ Coluna notificado_grupo criada (existentes marcados como TRUE)');
      }
    } catch (e) {}
  })();

  // ═══ HELPER: Notificar grupo WhatsApp com novos leads ═══
  async function notificarGrupoNovosLeads() {
    try {
      const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
      const apiKey = process.env.EVOLUTION_API_KEY;
      const instancia = process.env.EVOLUTION_INSTANCE;
      const grupoId = process.env.EVOLUTION_GROUP_ID_CRM || process.env.EVOLUTION_GROUP_ID;

      if (!baseUrl || !apiKey || !instancia || !grupoId) {
        console.log('⚠️ [CRM-Notif] Vars Evolution não configuradas, pulando notificação');
        return;
      }

      // Buscar leads não notificados
      const { rows: leads } = await pool.query(
        `SELECT cod, nome, celular, regiao, estado
         FROM crm_leads_capturados
         WHERE notificado_grupo = FALSE
         ORDER BY regiao ASC, estado ASC, cod ASC`
      );

      const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Bahia' });
      let msg;

      if (leads.length === 0) {
        // Nenhum lead novo — avisar
        msg = `📋 *Atenção time!*\n\n📅 *Captura: ${hoje}*\n\n⚠️ Nenhum cadastro novo chegou no período.\n\nSolicito atenção nas ferramentas utilizadas para captação. Vamos verificar se está tudo funcionando corretamente!`;
      } else {
        // Agrupar por região
        const grupos = {};
        for (const lead of leads) {
          const regiao = lead.regiao && lead.estado
            ? `${lead.regiao.toUpperCase()} - ${lead.estado.toUpperCase()}`
            : lead.regiao?.toUpperCase() || lead.estado?.toUpperCase() || 'SEM REGIÃO';
          if (!grupos[regiao]) grupos[regiao] = [];
          grupos[regiao].push(lead);
        }

        // Ordenar regiões por quantidade (maior primeiro)
        const regioesOrdenadas = Object.entries(grupos).sort((a, b) => b[1].length - a[1].length);

        msg = `📋 *Atenção time, chegaram novos cadastros na MAPP!*\nPrecisamos fazer contato com todos ainda hoje!\n\n📅 *Captura: ${hoje}*\n`;

        for (const [regiao, leadsRegiao] of regioesOrdenadas) {
          msg += `\n📍 *${regiao} (${leadsRegiao.length})*\n`;
          for (const l of leadsRegiao) {
            msg += `${l.cod} - ${l.nome || 'Sem nome'} - ${l.celular || 'Sem telefone'}\n`;
          }
        }

        msg += `\n✅ *Total: ${leads.length} novos leads*`;
      }

      // Enviar
      const response = await fetch(`${baseUrl}/message/sendText/${instancia}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
        body: JSON.stringify({ number: grupoId, text: msg }),
      });

      if (response.ok) {
        console.log(`✅ [CRM-Notif] Mensagem enviada: ${leads.length} leads notificados`);
        // Marcar como notificados
        if (leads.length > 0) {
          const ids = leads.map(l => l.cod);
          await pool.query(
            `UPDATE crm_leads_capturados SET notificado_grupo = TRUE WHERE cod = ANY($1::text[])`,
            [ids]
          );
        }
      } else {
        const err = await response.text();
        console.error(`❌ [CRM-Notif] Erro ${response.status}: ${err}`);
      }
    } catch (err) {
      console.error('❌ [CRM-Notif] Exceção:', err.message);
    }
  }

  // ═══ HELPER: Gerar e enviar resumo diário (imagem + texto) ═══
  async function enviarResumoDiario() {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instancia = process.env.EVOLUTION_INSTANCE;
    const grupoId = process.env.EVOLUTION_GROUP_ID_CRM || process.env.EVOLUTION_GROUP_ID;

    if (!baseUrl || !apiKey || !instancia || !grupoId) {
      console.log('⚠️ [CRM-Resumo] Vars Evolution não configuradas');
      return { enviado: false, motivo: 'config_incompleta' };
    }

    try {
      const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Bahia' });

      // 🔧 BUGFIX TIMEZONE: Postgres roda em UTC, então CURRENT_DATE retorna
      // a data UTC (3h adiantada em relação a Bahia). Isso fazia o resumo
      // contar errado: leads ativados após 21h Bahia caíam num CURRENT_DATE
      // diferente do esperado e ficavam fora do resumo do dia operacional.
      // Solução: passar a data Bahia explícita como parâmetro e comparar
      // contra (data_ativacao OU created_at convertido pra timezone Bahia).
      const hojeBahiaISO = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bahia',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date()); // formato YYYY-MM-DD

      // 1. Ativações do dia (referência: data_ativacao DATE = hoje em Bahia)
      // data_ativacao é DATE puro, então comparação direta funciona desde
      // que a gravação também use data Bahia (corrigido em outro fix neste arquivo).
      const { rows: ativacoes } = await pool.query(
        `SELECT cod, nome, celular, regiao, estado, quem_ativou
         FROM crm_leads_capturados
         WHERE data_ativacao = $1::date AND quem_ativou IS NOT NULL AND quem_ativou != ''`,
        [hojeBahiaISO]
      );

      const ativPorResponsavel = {};
      const ativPorRegiao = {};
      for (const a of ativacoes) {
        const resp = a.quem_ativou || 'N/I';
        ativPorResponsavel[resp] = (ativPorResponsavel[resp] || 0) + 1;
        const reg = a.regiao && a.estado ? `${a.regiao} - ${a.estado}` : a.regiao || a.estado || 'Sem região';
        ativPorRegiao[reg] = (ativPorRegiao[reg] || 0) + 1;
      }

      // 2. Alocações do dia (created_at é TIMESTAMP, então converte pra data Bahia)
      // 🔧 BUGFIX: filtro `(importado IS NULL OR importado = FALSE)` removido —
      // alocações importadas (CSV/Sheet) agora contam no total, conforme decisão
      // do Tutts. O resumo deve refletir TODAS as alocações do dia, independente
      // de origem.
      const { rows: alocacoes } = await pool.query(
        `SELECT nome_cliente, quem_alocou FROM crm_alocacoes
         WHERE (created_at AT TIME ZONE 'America/Bahia')::date = $1::date
           AND ativo = true`,
        [hojeBahiaISO]
      );

      const alocPorResponsavel = {};
      const alocPorCliente = {};
      for (const al of alocacoes) {
        const resp = al.quem_alocou || 'N/I';
        alocPorResponsavel[resp] = (alocPorResponsavel[resp] || 0) + 1;
        const cli = al.nome_cliente || 'Sem cliente';
        alocPorCliente[cli] = (alocPorCliente[cli] || 0) + 1;
      }

      const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

      // 3. HTML template
      const renderItems = (items) => items.map(([k, v], i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${i % 2 === 0 ? '#f8f8f8' : '#fff'};border-radius:6px;margin-bottom:4px">
          <span style="font-size:12px;color:#333">${k}</span>
          <span style="font-size:12px;font-weight:600;color:#7C3AED">${v}</span>
        </div>
      `).join('');

      const renderItemsAmber = (items) => items.map(([k, v], i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${i % 2 === 0 ? '#f8f8f8' : '#fff'};border-radius:6px;margin-bottom:4px">
          <span style="font-size:12px;color:#333">${k}</span>
          <span style="font-size:12px;font-weight:600;color:#B45309">${v}</span>
        </div>
      `).join('');

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;width:520px;background:#fff}
      </style></head><body>
      <div style="width:520px;overflow:hidden;border-radius:16px;border:1px solid #e5e5e5">
        <div style="background:linear-gradient(135deg,#7C3AED,#5B21B6);padding:20px 24px;color:#fff">
          <div style="font-size:11px;opacity:0.7;letter-spacing:1px;text-transform:uppercase">Central Tutts</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px">Resumo diário</div>
          <div style="font-size:13px;opacity:0.8;margin-top:2px">${hoje}</div>
        </div>
        <div style="padding:20px 24px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
            <div style="width:8px;height:8px;border-radius:50%;background:#10B981"></div>
            <span style="font-size:14px;font-weight:600;color:#1a1a1a">Ativações do dia</span>
          </div>
          <div style="display:flex;gap:12px;margin-bottom:16px">
            <div style="flex:1;background:#F0FDF4;border-radius:10px;padding:14px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#16A34A">${ativacoes.length}</div>
              <div style="font-size:11px;color:#15803D;margin-top:2px">Total ativados</div>
            </div>
            <div style="flex:1;background:#EEF2FF;border-radius:10px;padding:14px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#7C3AED">${Object.keys(ativPorResponsavel).length}</div>
              <div style="font-size:11px;color:#6D28D9;margin-top:2px">Ativadores</div>
            </div>
            <div style="flex:1;background:#FFF7ED;border-radius:10px;padding:14px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#EA580C">${Object.keys(ativPorRegiao).length}</div>
              <div style="font-size:11px;color:#C2410C;margin-top:2px">Regiões</div>
            </div>
          </div>
          <div style="display:flex;gap:16px;margin-bottom:20px">
            <div style="flex:1">
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Por ativador</div>
              ${renderItems(sortDesc(ativPorResponsavel))}
              ${ativacoes.length === 0 ? '<div style="font-size:12px;color:#aaa;padding:6px 10px">Nenhuma ativação hoje</div>' : ''}
            </div>
            <div style="flex:1">
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Por região</div>
              ${renderItems(sortDesc(ativPorRegiao))}
            </div>
          </div>

          <div style="border-top:1px solid #eee;padding-top:20px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
              <div style="width:8px;height:8px;border-radius:50%;background:#7C3AED"></div>
              <span style="font-size:14px;font-weight:600;color:#1a1a1a">Alocações realizadas</span>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:16px">
              <div style="flex:1;background:#F5F3FF;border-radius:10px;padding:14px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#7C3AED">${alocacoes.length}</div>
                <div style="font-size:11px;color:#6D28D9;margin-top:2px">Total alocados</div>
              </div>
              <div style="flex:1;background:#EEF2FF;border-radius:10px;padding:14px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#4F46E5">${Object.keys(alocPorResponsavel).length}</div>
                <div style="font-size:11px;color:#4338CA;margin-top:2px">Responsáveis</div>
              </div>
              <div style="flex:1;background:#FEF3C7;border-radius:10px;padding:14px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#B45309">${Object.keys(alocPorCliente).length}</div>
                <div style="font-size:11px;color:#92400E;margin-top:2px">Clientes</div>
              </div>
            </div>
            <div style="display:flex;gap:16px">
              <div style="flex:1">
                <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Por responsável</div>
                ${renderItems(sortDesc(alocPorResponsavel))}
                ${alocacoes.length === 0 ? '<div style="font-size:12px;color:#aaa;padding:6px 10px">Nenhuma alocação hoje</div>' : ''}
              </div>
              <div style="flex:1">
                <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Por cliente</div>
                ${renderItemsAmber(sortDesc(alocPorCliente))}
              </div>
            </div>
          </div>
        </div>
        <div style="background:#f9f9f9;padding:10px 24px;text-align:center;font-size:11px;color:#aaa">
          centraltutts.online
        </div>
      </div>
      </body></html>`;

      // 4. Playwright screenshot
      console.log('[CRM-Resumo] Gerando imagem do resumo diário...');
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage({ viewport: { width: 540, height: 800 } });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const element = await page.$('body > div');
      const screenshotBuffer = await element.screenshot({ type: 'png' });
      await browser.close();

      const imageBase64 = screenshotBuffer.toString('base64');
      console.log(`[CRM-Resumo] Imagem gerada (${(screenshotBuffer.length / 1024).toFixed(0)}KB)`);

      // 5. Enviar imagem + caption
      const caption = `*Segue o resumo da operação de hoje (${hoje})*\n\nAtenciosamente,\n\nArgos, o seu melhor agente operacional.`;

      const response = await fetch(`${baseUrl}/message/sendMedia/${instancia}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
        body: JSON.stringify({
          number: grupoId,
          mediatype: 'image',
          mimetype: 'image/png',
          caption: caption,
          media: imageBase64,
          fileName: 'resumo-diario.png',
        }),
      });

      if (response.ok) {
        console.log(`✅ [CRM-Resumo] Resumo diário enviado! (${ativacoes.length} ativações, ${alocacoes.length} alocações)`);
        return { enviado: true, ativacoes: ativacoes.length, alocacoes: alocacoes.length };
      } else {
        const err = await response.text();
        console.error(`❌ [CRM-Resumo] Erro ${response.status}: ${err}`);
        return { enviado: false, motivo: err };
      }
    } catch (err) {
      console.error('❌ [CRM-Resumo] Exceção:', err.message);
      return { enviado: false, motivo: err.message };
    }
  }
  async function verificarLeadAPI(celular) {
    const TUTTS_TOKEN = process.env.TUTTS_TOKEN_PROF_STATUS || process.env.TUTTS_INTEGRACAO_TOKEN || process.env.TUTTS_TOKEN_PROFISSIONAIS;
    if (!TUTTS_TOKEN) return { status_api: null, erro: 'Token não configurado' };

    try {
      const numeros = celular.replace(/\D/g, '');
      let celularFormatado = numeros;
      if (numeros.length === 11) {
        celularFormatado = `(${numeros.slice(0, 2)}) ${numeros.slice(2, 7)}-${numeros.slice(7)}`;
      } else if (numeros.length === 10) {
        celularFormatado = `(${numeros.slice(0, 2)}) ${numeros.slice(2, 6)}-${numeros.slice(6)}`;
      }

      const response = await fetch('https://tutts.com.br/integracao', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TUTTS_TOKEN}`,
          'identificador': 'prof-status',
        },
        body: JSON.stringify({ celular: celularFormatado }),
      });

      if (!response.ok) return { status_api: 'erro', erro: `HTTP ${response.status}` };

      const data = await response.json();

      if (data.Sucesso && data.Sucesso.length > 0) {
        return { status_api: data.Sucesso[0].ativo === 'S' ? 'ativo' : 'inativo' };
      }
      if (data.Erro && data.Erro.includes('Nenhum profissional')) {
        return { status_api: 'nao_encontrado' };
      }
      return { status_api: 'nao_encontrado' };
    } catch (err) {
      return { status_api: 'erro', erro: err.message };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // POST /executar — Disparar captura manual
  // ══════════════════════════════════════════════════════════════
  router.post('/executar', async (req, res) => {
    if (capturaEmAndamento) {
      return res.status(409).json({ success: false, error: 'Já existe uma captura em andamento.' });
    }

    // ⚠️ REFACTOR 2026-04: Esta rota agora apenas ENFILEIRA o job.
    // O processamento real é feito pelo agente crm-leads.agent.js no tutts-agents.
    // Frontend deve fazer polling em GET /jobs/:id pra saber quando termina.

    const { data_inicio, data_fim, tipo = 'manual', iniciado_por = 'admin' } = req.body || {};

    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);

    const dataInicio = data_inicio || formatDate(ontem);
    const dataFim    = data_fim    || formatDate(hoje);

    let jobId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO crm_captura_jobs (tipo, status, data_inicio, data_fim, iniciado_por)
         VALUES ($1, 'pendente', $2, $3, $4) RETURNING id`,
        [tipo, dataInicio, dataFim, iniciado_por]
      );
      jobId = rows[0].id;
    } catch (err) {
      return res.status(500).json({ success: false, error: `Erro ao criar job: ${err.message}` });
    }

    return res.json({
      success: true,
      message: 'Captura enfileirada. Acompanhe via GET /jobs/' + jobId,
      job_id: jobId,
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
    });
  });

  // ══════════════════════════════════════════════════════════════
  // POST /re-verificar — Re-verificar status de leads existentes
  // ══════════════════════════════════════════════════════════════
  // ── Estado da verificação ──
  let verificacaoEmAndamento = false;
  let ultimoResultado = { verificados: 0, ativos: 0, inativos: 0, mudaram: 0, message: '' };

  router.post('/re-verificar', async (req, res) => {
    const TUTTS_TOKEN = process.env.TUTTS_TOKEN_PROF_STATUS || process.env.TUTTS_INTEGRACAO_TOKEN || process.env.TUTTS_TOKEN_PROFISSIONAIS;
    if (!TUTTS_TOKEN) {
      return res.status(503).json({ success: false, error: 'Token API Tutts não configurado no servidor' });
    }

    if (verificacaoEmAndamento) {
      return res.json({ success: true, em_andamento: true, message: 'Verificação já em andamento' });
    }

    // Contar quantos vão ser verificados
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) as count FROM crm_leads_capturados
       WHERE celular IS NOT NULL AND celular != '' AND quem_ativou IS NOT NULL AND quem_ativou != ''
         AND (api_verificado_em IS NULL OR api_verificado_em < CURRENT_DATE)`
    );

    if (parseInt(count) === 0) {
      return res.json({ success: true, em_andamento: false, verificados: 0, message: 'Todos os leads já foram verificados hoje' });
    }

    verificacaoEmAndamento = true;
    ultimoResultado = { verificados: 0, ativos: 0, inativos: 0, mudaram: 0, message: '' };

    // Responder imediatamente
    res.json({ success: true, em_andamento: true, total: parseInt(count), message: `Verificação iniciada: ${count} leads com ativador preenchido` });

    // ── Background ──────────────────────────────────────────
    (async () => {
      try {
        const { rows: leads } = await pool.query(
          `SELECT id, cod, celular, status_api FROM crm_leads_capturados
           WHERE celular IS NOT NULL AND celular != ''
             AND quem_ativou IS NOT NULL AND quem_ativou != ''
             AND (api_verificado_em IS NULL OR api_verificado_em < CURRENT_DATE)
           ORDER BY api_verificado_em ASC NULLS FIRST`
        );

        console.log(`[CRM-ReVerificar] Verificando ${leads.length} leads com quem_ativou preenchido...`);

        let ativos = 0, inativos = 0, mudaram = 0;

        for (const lead of leads) {
          const { status_api } = await verificarLeadAPI(lead.celular);

          if (status_api && status_api !== 'erro') {
            if (lead.status_api && lead.status_api !== status_api) {
              mudaram++;
              console.log(`[CRM-ReVerificar] 🔄 ${lead.cod}: ${lead.status_api} → ${status_api}`);
            }
            await pool.query(
              `UPDATE crm_leads_capturados SET status_api = $1, api_verificado_em = NOW() WHERE id = $2`,
              [status_api, lead.id]
            );
            if (status_api === 'ativo') ativos++;
            else if (status_api === 'inativo') inativos++;
          }

          ultimoResultado.verificados++;
          await new Promise(r => setTimeout(r, 120));
        }

        ultimoResultado = { verificados: leads.length, ativos, inativos, mudaram, message: `${leads.length} verificados: ${ativos} ativos, ${inativos} inativos${mudaram > 0 ? ` (${mudaram} mudaram!)` : ''}` };
        console.log(`[CRM-ReVerificar] ✅ ${ultimoResultado.message}`);
      } catch (err) {
        console.error('[CRM-ReVerificar] ❌ Erro:', err.message);
        ultimoResultado.message = 'Erro: ' + err.message;
      } finally {
        verificacaoEmAndamento = false;
      }
    })();
  });

  // GET - Status da verificação
  router.get('/re-verificar/status', async (req, res) => {
    res.json({ success: true, em_andamento: verificacaoEmAndamento, ...ultimoResultado });
  });

  // ══════════════════════════════════════════════════════════════
  // GET / — Listar leads capturados
  // ══════════════════════════════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const { regiao, status_api, data_inicio, data_fim, ativacao_inicio, ativacao_fim, search, page = 1, limit = 50, order = 'data_cadastro', dir = 'DESC' } = req.query;

      const where = ['1=1'];
      const params = [];
      let paramIdx = 1;

      if (regiao)      { where.push(`regiao = $${paramIdx++}`);      params.push(regiao); }
      if (status_api)  { where.push(`status_api = $${paramIdx++}`);  params.push(status_api); }
      if (data_inicio) { where.push(`data_cadastro >= $${paramIdx++}`); params.push(data_inicio); }
      if (data_fim)    { where.push(`data_cadastro <= $${paramIdx++}`); params.push(data_fim); }
      if (ativacao_inicio) { where.push(`data_ativacao >= $${paramIdx++}`); params.push(ativacao_inicio); }
      if (ativacao_fim)    { where.push(`data_ativacao <= $${paramIdx++}`); params.push(ativacao_fim); }

      // Debug: confirmar filtros
      console.log(`[CRM-Captura] GET / filtros: data_inicio=${data_inicio} data_fim=${data_fim} regiao=${regiao} where=${where.join(' AND ')} params=${JSON.stringify(params)}`);
      if (search) {
        where.push(`(nome ILIKE $${paramIdx} OR cod ILIKE $${paramIdx} OR celular ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }

      const validOrders = ['data_cadastro', 'cod', 'nome', 'regiao', 'status_api', 'capturado_em'];
      const orderCol = validOrders.includes(order) ? order : 'data_cadastro';
      const orderDir = dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const countResult = await pool.query(`SELECT COUNT(*) as total FROM crm_leads_capturados WHERE ${where.join(' AND ')}`, params);
      const total = parseInt(countResult.rows[0].total);

      const { rows } = await pool.query(
        `SELECT * FROM crm_leads_capturados WHERE ${where.join(' AND ')} ORDER BY ${orderCol} ${orderDir} NULLS LAST LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, parseInt(limit), offset]
      );

      const { rows: regioesRows } = await pool.query(
        `SELECT DISTINCT regiao FROM crm_leads_capturados WHERE regiao IS NOT NULL AND regiao != '' ORDER BY regiao`
      );

      // ── KPIs embutidos (MESMOS filtros da query principal) ──
      const { rows: [kpis] } = await pool.query(
        `SELECT
          COUNT(*) as total_geral,
          COUNT(*) FILTER (WHERE status_api = 'ativo') as ativos,
          COUNT(*) FILTER (WHERE status_api = 'inativo') as inativos,
          COUNT(*) FILTER (WHERE status_api = 'nao_encontrado') as nao_encontrados,
          COUNT(*) FILTER (WHERE status_api IS NULL OR status_api = 'erro') as sem_verificacao,
          COUNT(DISTINCT regiao) as total_regioes
        FROM crm_leads_capturados WHERE ${where.join(' AND ')}`,
        params
      );

      const { rows: porRegiaoRows } = await pool.query(
        `SELECT regiao, COUNT(*) as quantidade FROM crm_leads_capturados
         WHERE ${where.join(' AND ')} AND regiao IS NOT NULL AND regiao != ''
         GROUP BY regiao ORDER BY quantidade DESC`,
        params
      );

      const { rows: [ultimoJob] } = await pool.query(
        `SELECT * FROM crm_captura_jobs ORDER BY iniciado_em DESC LIMIT 1`
      );

      res.json({
        success: true,
        data: rows,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
        regioes: regioesRows.map(r => r.regiao),
        captura_em_andamento: capturaEmAndamento,
        stats: {
          total: parseInt(kpis.total_geral) || 0,
          ativos: parseInt(kpis.ativos) || 0,
          inativos: parseInt(kpis.inativos) || 0,
          nao_encontrados: parseInt(kpis.nao_encontrados) || 0,
          sem_verificacao: parseInt(kpis.sem_verificacao) || 0,
          total_regioes: parseInt(kpis.total_regioes) || 0,
          porRegiao: porRegiaoRows,
          ultimoJob: ultimoJob || null,
        },
      });
    } catch (err) {
      console.error('[CRM-Captura] Erro ao listar:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /jobs — Listar execuções
  // ══════════════════════════════════════════════════════════════
  router.get('/jobs', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM crm_captura_jobs ORDER BY iniciado_em DESC LIMIT 20`);
      res.json({ success: true, data: rows, em_andamento: capturaEmAndamento });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /jobs/:id
  // ══════════════════════════════════════════════════════════════
  router.get('/jobs/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM crm_captura_jobs WHERE id = $1`, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ success: false, error: 'Job não encontrado' });
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /estatisticas
  // ══════════════════════════════════════════════════════════════
  router.get('/estatisticas', async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;
      const where = ['1=1'];
      const params = [];
      let idx = 1;

      if (data_inicio) { where.push(`data_cadastro >= $${idx++}`); params.push(data_inicio); }
      if (data_fim)    { where.push(`data_cadastro <= $${idx++}`); params.push(data_fim); }

      const whereStr = where.join(' AND ');

      const { rows: [stats] } = await pool.query(
        `SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status_api = 'ativo') as ativos,
          COUNT(*) FILTER (WHERE status_api = 'inativo') as inativos,
          COUNT(*) FILTER (WHERE status_api = 'nao_encontrado') as nao_encontrados,
          COUNT(*) FILTER (WHERE status_api IS NULL OR status_api = 'erro') as sem_verificacao,
          COUNT(DISTINCT regiao) as total_regioes
        FROM crm_leads_capturados WHERE ${whereStr}`,
        params
      );

      const { rows: porRegiao } = await pool.query(
        `SELECT regiao, COUNT(*) as quantidade FROM crm_leads_capturados WHERE ${whereStr} GROUP BY regiao ORDER BY quantidade DESC`,
        params
      );

      const { rows: [ultimoJob] } = await pool.query(
        `SELECT * FROM crm_captura_jobs ORDER BY iniciado_em DESC LIMIT 1`
      );

      res.json({
        success: true,
        data: {
          total: parseInt(stats.total) || 0,
          ativos: parseInt(stats.ativos) || 0,
          inativos: parseInt(stats.inativos) || 0,
          nao_encontrados: parseInt(stats.nao_encontrados) || 0,
          sem_verificacao: parseInt(stats.sem_verificacao) || 0,
          total_regioes: parseInt(stats.total_regioes) || 0,
          porRegiao,
          ultimoJob: ultimoJob || null,
          captura_em_andamento: capturaEmAndamento,
        },
      });
    } catch (err) {
      console.error('[CRM-Captura] Erro estatisticas:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /ativadores — Lista de nomes para dropdown
  // ══════════════════════════════════════════════════════════════
  router.get('/ativadores', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT nome FROM crm_ativadores ORDER BY nome ASC`);
      res.json({ success: true, data: rows.map(r => r.nome) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // PATCH /:id — Atualizar quem_ativou e/ou observacao
  // ══════════════════════════════════════════════════════════════
  router.patch('/:id', async (req, res) => {
    try {
      const { quem_ativou, observacao, data_ativacao } = req.body;
      const sets = [];
      const params = [];
      let idx = 1;
      let notificarAtivacao = false;
      let deveReconciliarStatus = false;

      if (quem_ativou !== undefined) {
        const nomeUpper = (quem_ativou || '').toUpperCase().trim();
        sets.push(`quem_ativou = $${idx++}`);
        params.push(nomeUpper || null);

        // Auto-preencher data_ativacao = hoje se quem_ativou preenchido e data_ativacao não veio no body
        if (nomeUpper && data_ativacao === undefined) {
          // 🔧 BUGFIX TIMEZONE: usa data de Bahia (UTC-3), não UTC.
          // ANTES: new Date().toISOString().split('T')[0] retornava data UTC,
          // o que fazia leads ativados após 21h Bahia caírem como "amanhã".
          // Resultado: resumo diário do dia certo subcontava esses leads.
          const hoje = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Bahia',
            year: 'numeric', month: '2-digit', day: '2-digit'
          }).format(new Date()); // formato YYYY-MM-DD
          sets.push(`data_ativacao = COALESCE(data_ativacao, $${idx++})`);
          params.push(hoje);
        }

        // 🆕 AUTO-ATIVO: Quando operador preenche "Quem Ativou", marcar como ativo
        // imediatamente (UX otimista). Reconciliação contra API MAP roda em background
        // após a response e corrige se divergir.
        if (nomeUpper) {
          sets.push(`status_api = $${idx++}`);
          params.push('ativo');
          sets.push(`api_verificado_em = NOW()`);
          deveReconciliarStatus = true;
        }

        // Salvar nome no dropdown (se não vazio)
        if (nomeUpper) {
          await pool.query(
            `INSERT INTO crm_ativadores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING`,
            [nomeUpper]
          );
          // Verificar se é primeira ativação (quem_ativou era null antes)
          const { rows: [antes] } = await pool.query(
            'SELECT quem_ativou FROM crm_leads_capturados WHERE id = $1', [req.params.id]
          );
          if (!antes?.quem_ativou) notificarAtivacao = true;
        }
      }

      if (observacao !== undefined) {
        sets.push(`observacao = $${idx++}`);
        params.push(observacao || null);
      }

      if (data_ativacao !== undefined) {
        sets.push(`data_ativacao = $${idx++}`);
        params.push(data_ativacao || null);
      }

      if (sets.length === 0) {
        return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
      }

      params.push(req.params.id);
      await pool.query(
        `UPDATE crm_leads_capturados SET ${sets.join(', ')} WHERE id = $${idx}`,
        params
      );

      // 📱 Notificar grupo WhatsApp na primeira ativação
      if (notificarAtivacao) {
        try {
          const { rows: [lead] } = await pool.query(
            'SELECT cod, nome, celular, regiao, estado, quem_ativou FROM crm_leads_capturados WHERE id = $1',
            [req.params.id]
          );
          if (lead) {
            const msg = `🚀 *Ativação realizada!* 🚀\n\n${lead.cod} ${lead.nome || ''}\n*Região:* ${lead.regiao || ''}${lead.estado ? ' - ' + lead.estado : ''}\n*Contato:* ${lead.celular || 'Não informado'}\n\n*Responsável:* ${lead.quem_ativou}`;

            const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
            const apiKey = process.env.EVOLUTION_API_KEY;
            const instancia = process.env.EVOLUTION_INSTANCE;
            const grupoId = process.env.EVOLUTION_GROUP_ID_CRM || process.env.EVOLUTION_GROUP_ID;

            if (baseUrl && apiKey && instancia && grupoId) {
              const whatsRes = await fetch(`${baseUrl}/message/sendText/${instancia}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
                body: JSON.stringify({ number: grupoId, text: msg }),
              });
              const whatsData = await whatsRes.json();
              if (whatsRes.ok) {
                console.log(`✅ [CRM-WhatsApp] Ativação enviada: ${lead.cod} ${lead.nome} por ${lead.quem_ativou}`);
              } else {
                console.error(`❌ [CRM-WhatsApp] Erro ${whatsRes.status}:`, whatsData);
              }
            } else {
              console.log('⚠️ [CRM-WhatsApp] Vars Evolution não configuradas para CRM');
            }
          }
        } catch (whatsErr) {
          console.error('⚠️ [CRM-WhatsApp] Erro ao notificar:', whatsErr.message);
        }
      }

      res.json({ success: true });

      // 🔄 RECONCILIAÇÃO EM BACKGROUND: consulta API MAP apenas para
      // registrar divergências (logging + timestamp). A verdade é do operador:
      // o status_api permanece 'ativo' mesmo se a API MAP discordar.
      // Fire-and-forget — não bloqueia a response.
      if (deveReconciliarStatus) {
        setImmediate(async () => {
          try {
            const { rows: [lead] } = await pool.query(
              'SELECT celular FROM crm_leads_capturados WHERE id = $1',
              [req.params.id]
            );
            if (!lead?.celular) {
              console.log(`[CRM-Reconcile] Lead ${req.params.id} sem celular, pulando`);
              return;
            }

            const { status_api: statusReal, erro } = await verificarLeadAPI(lead.celular);

            if (!statusReal || statusReal === 'erro') {
              console.log(`[CRM-Reconcile] Lead ${req.params.id}: API indisponível (${erro || 'sem status'})`);
              return;
            }

            // Sempre atualiza o timestamp de verificação (status NÃO é alterado)
            await pool.query(
              'UPDATE crm_leads_capturados SET api_verificado_em = NOW() WHERE id = $1',
              [req.params.id]
            );

            if (statusReal === 'ativo') {
              console.log(`[CRM-Reconcile] Lead ${req.params.id}: ✅ API confirmou ATIVO`);
            } else {
              console.log(`[CRM-Reconcile] Lead ${req.params.id}: ℹ️  API diz '${statusReal}', mas operador marcou ativo — mantendo decisão do operador`);
            }
          } catch (reconcileErr) {
            console.error(`[CRM-Reconcile] Erro lead ${req.params.id}:`, reconcileErr.message);
          }
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /enriquecer — Recebe dados já processados do CRM proxy
  // Body: { mapaPorCod: {cod: {quem_ativou, data_ativacao}}, mapaPorTel: {...}, observacoes: {cod: texto} }
  // Planilha é lida pelo CRM (Vercel), backend só faz UPDATE
  // ══════════════════════════════════════════════════════════════
  router.post('/enriquecer', async (req, res) => {
    try {
      const { mapaPorCod = {}, mapaPorTel = {}, observacoes = {} } = req.body || {};

      console.log('[CRM-Enriquecer] Recebido: ' + Object.keys(mapaPorCod).length + ' por cod | ' + Object.keys(mapaPorTel).length + ' por tel | ' + Object.keys(observacoes).length + ' obs');

      const { rows: leads } = await pool.query(
        'SELECT id, cod, celular, telefone_normalizado, quem_ativou, observacao, data_ativacao FROM crm_leads_capturados'
      );

      let atualizados = 0, matchCount = 0, semMatch = 0;

      for (const lead of leads) {
        let match = mapaPorCod[lead.cod] || null;
        if (!match && lead.telefone_normalizado) {
          match = mapaPorTel[lead.telefone_normalizado] || null;
        }

        const sets = [];
        const params = [];
        let idx = 1;

        if (match) {
          matchCount++;
          if (match.quem_ativou) {
            sets.push('quem_ativou = $' + (idx++));
            params.push(String(match.quem_ativou).toUpperCase());
          }
          if (match.data_ativacao) {
            sets.push('data_ativacao = $' + (idx++));
            params.push(match.data_ativacao);
          }
        }

        const obs = observacoes[lead.cod];
        if (obs && !lead.observacao) {
          sets.push('observacao = $' + (idx++));
          params.push(obs);
        }

        if (sets.length > 0) {
          params.push(lead.id);
          await pool.query(
            'UPDATE crm_leads_capturados SET ' + sets.join(', ') + ' WHERE id = $' + idx,
            params
          );
          atualizados++;

          if (match && match.quem_ativou) {
            await pool.query(
              'INSERT INTO crm_ativadores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING',
              [String(match.quem_ativou).toUpperCase()]
            ).catch(() => {});
          }
        } else {
          semMatch++;
        }
      }

      console.log('[CRM-Enriquecer] Done: ' + atualizados + ' atualizados | ' + matchCount + ' matches | ' + semMatch + ' sem dados');

      res.json({
        success: true,
        message: atualizados + ' leads enriquecidos (' + matchCount + ' na planilha)',
        atualizados,
        matches: matchCount,
        total_leads: leads.length,
      });
    } catch (err) {
      console.error('[CRM-Enriquecer] Erro:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // ══════════════════════════════════════════════════════════════
  // DELETE /:id
  // ══════════════════════════════════════════════════════════════
  router.delete('/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM crm_leads_capturados WHERE id = $1`, [req.params.id]);
      res.json({ success: true, removido: rowCount > 0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /resumo-diario — Enviar resumo diário manualmente
  // ══════════════════════════════════════════════════════════════
  // ═══ POST /notificar-novos — Envia notificação WhatsApp com leads não notificados ═══
  router.post('/notificar-novos', async (req, res) => {
    try {
      await notificarGrupoNovosLeads();
      res.json({ success: true, enviado: true });
    } catch (err) {
      console.error('[CRM-Notif] Erro endpoint:', err.message);
      res.json({ success: true, enviado: false, motivo: err.message });
    }
  });

  router.post('/resumo-diario', async (req, res) => {
    try {
      const resultado = await enviarResumoDiario();
      res.json({ success: true, ...resultado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { createLeadsCapturaRoutes };
