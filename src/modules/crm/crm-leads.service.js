/**
 * crm-leads.service.js
 * ─────────────────────────────────────────────────────────────────────────
 * Lógica de negócio extraída de leads-captura.routes.js pra ser reutilizável
 * pelo agente do pool. Tudo aqui é puro service (recebe pool, faz queries).
 *
 * Funções:
 *   - processarCapturaJob(pool, jobId)  — pega job, roda Playwright, salva resultados
 *   - verificarLeadAPI(celular)         — chama API Tutts pra status do profissional
 *   - notificarGrupoNovosLeads(pool)    — envia WhatsApp de novos leads
 */

'use strict';

async function verificarLeadAPI(celular) {
  const TUTTS_TOKEN = process.env.TUTTS_TOKEN_PROF_STATUS
    || process.env.TUTTS_INTEGRACAO_TOKEN
    || process.env.TUTTS_TOKEN_PROFISSIONAIS;
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

async function notificarGrupoNovosLeads(pool) {
  try {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instancia = process.env.EVOLUTION_INSTANCE;
    const grupoId = process.env.EVOLUTION_GROUP_ID_CRM || process.env.EVOLUTION_GROUP_ID;

    if (!baseUrl || !apiKey || !instancia || !grupoId) {
      console.log('⚠️ [CRM-Notif] Vars Evolution não configuradas, pulando notificação');
      return;
    }

    const { rows: leads } = await pool.query(
      `SELECT cod, nome, celular, regiao, estado
       FROM crm_leads_capturados
       WHERE notificado_grupo = FALSE
       ORDER BY regiao ASC, estado ASC, cod ASC`
    );

    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Bahia' });
    let msg;

    if (leads.length === 0) {
      msg = `📋 *Atenção time!*\n\n📅 *Captura: ${hoje}*\n\n⚠️ Nenhum cadastro novo chegou no período.\n\nSolicito atenção nas ferramentas utilizadas para captação. Vamos verificar se está tudo funcionando corretamente!`;
    } else {
      const grupos = {};
      for (const lead of leads) {
        const regiao = lead.regiao && lead.estado
          ? `${lead.regiao.toUpperCase()} - ${lead.estado.toUpperCase()}`
          : lead.regiao?.toUpperCase() || lead.estado?.toUpperCase() || 'SEM REGIÃO';
        if (!grupos[regiao]) grupos[regiao] = [];
        grupos[regiao].push(lead);
      }

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

    const response = await fetch(`${baseUrl}/message/sendText/${instancia}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: grupoId, text: msg }),
    });

    if (response.ok) {
      console.log(`✅ [CRM-Notif] Mensagem enviada: ${leads.length} leads notificados`);
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

/**
 * Processa 1 job de captura: chama Playwright, salva leads, notifica grupo.
 * Recebe o jobId e busca o restante do banco.
 */
async function processarCapturaJob(pool, jobId, log = console.log) {
  // 1. Buscar info do job
  const { rows: jobs } = await pool.query(
    `SELECT * FROM crm_captura_jobs WHERE id = $1 AND status IN ('pendente', 'executando')`,
    [jobId]
  );
  if (jobs.length === 0) {
    log(`[crm-leads.service] Job #${jobId} não encontrado ou não pendente`);
    return;
  }
  const job = jobs[0];

  // 2. Marcar executando se ainda pendente
  if (job.status === 'pendente') {
    await pool.query(
      `UPDATE crm_captura_jobs SET status = 'executando' WHERE id = $1`,
      [jobId]
    );
  }

  // 3. Rodar Playwright
  const { capturarLeadsCadastrados } = require('./playwright-crm-leads');

  try {
    log(`[crm-leads.service] Job #${jobId}: iniciando ${job.data_inicio} → ${job.data_fim}`);
    const resultado = await capturarLeadsCadastrados({
      dataInicio: job.data_inicio,
      dataFim: job.data_fim,
    });

    let novos = 0, jaExistentes = 0, ativos = 0, inativos = 0;

    for (const lead of resultado.registros) {
      try {
        // Verificar status via API Tutts (se ainda não verificou)
        if (lead.celular && !lead.status_api) {
          const { status_api } = await verificarLeadAPI(lead.celular);
          if (status_api) {
            lead.status_api = status_api;
            lead.api_verificado_em = new Date().toISOString();
          }
          await new Promise(r => setTimeout(r, 150)); // delay pra não bombardear API Tutts
        }

        const { rows: existentes } = await pool.query(
          'SELECT id FROM crm_leads_capturados WHERE cod = $1',
          [lead.cod]
        );

        if (existentes.length > 0) {
          await pool.query(
            `UPDATE crm_leads_capturados SET
              nome=COALESCE($2,nome), telefones_raw=COALESCE($3,telefones_raw), celular=COALESCE($4,celular),
              telefone_fixo=COALESCE($5,telefone_fixo), telefone_normalizado=COALESCE($6,telefone_normalizado),
              email=COALESCE($7,email), categoria=COALESCE($8,categoria), data_cadastro=COALESCE($9,data_cadastro),
              cidade=COALESCE($10,cidade), estado=COALESCE($11,estado), regiao=COALESCE($12,regiao),
              status_sistema=COALESCE($13,status_sistema), status_api=COALESCE($14,status_api),
              api_verificado_em=COALESCE($15,api_verificado_em), job_id=$16
            WHERE cod=$1`,
            [lead.cod, lead.nome, lead.telefones_raw, lead.celular, lead.telefone_fixo,
             lead.telefone_normalizado, lead.email, lead.categoria, lead.data_cadastro,
             lead.cidade, lead.estado, lead.regiao, lead.status_sistema, lead.status_api,
             lead.api_verificado_em, jobId]
          );
          jaExistentes++;
        } else {
          await pool.query(
            `INSERT INTO crm_leads_capturados
              (cod,nome,telefones_raw,celular,telefone_fixo,telefone_normalizado,email,categoria,
               data_cadastro,cidade,estado,regiao,status_sistema,status_api,api_verificado_em,job_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [lead.cod, lead.nome, lead.telefones_raw, lead.celular, lead.telefone_fixo,
             lead.telefone_normalizado, lead.email, lead.categoria, lead.data_cadastro,
             lead.cidade, lead.estado, lead.regiao, lead.status_sistema, lead.status_api,
             lead.api_verificado_em, jobId]
          );
          novos++;
        }

        if (lead.status_api === 'ativo') ativos++;
        else if (lead.status_api === 'inativo') inativos++;
      } catch (e) {
        log(`[crm-leads.service] Erro lead cod=${lead.cod}: ${e.message}`);
      }
    }

    // 4. Marcar job como concluído
    await pool.query(
      `UPDATE crm_captura_jobs SET status='concluido', total_capturados=$2, total_novos=$3,
       total_ja_existentes=$4, total_api_verificados=$5, total_ativos=$6, total_inativos=$7,
       screenshots=$8, concluido_em=NOW() WHERE id=$1`,
      [jobId, resultado.total, novos, jaExistentes,
       resultado.registros.filter(r => r.status_api && r.status_api !== 'erro').length,
       ativos, inativos, JSON.stringify(resultado.screenshots || [])]
    );

    log(`[crm-leads.service] ✅ Job #${jobId}: ${novos} novos | ${jaExistentes} atualizados | ${ativos} ativos | ${inativos} inativos`);

    // 5. Notificar grupo WhatsApp
    await notificarGrupoNovosLeads(pool);
  } catch (err) {
    log(`[crm-leads.service] ❌ Job #${jobId}: ${err.message}`);
    await pool.query(
      'UPDATE crm_captura_jobs SET status=$2, erro=$3, concluido_em=NOW() WHERE id=$1',
      [jobId, 'erro', err.message.slice(0, 500)]
    ).catch(() => {});
    throw err;
  }
}

module.exports = {
  processarCapturaJob,
  verificarLeadAPI,
  notificarGrupoNovosLeads,
};
