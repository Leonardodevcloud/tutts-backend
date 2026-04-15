/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Migration
 * Tables: cs_clientes, cs_interacoes, cs_ocorrencias, cs_raio_x_historico
 *
 * Integra com: bi_entregas, bi_resumo_cliente (módulo BI)
 * Acesso: admins/gestores apenas
 */

async function initCsTables(pool) {
  // ========== FICHA DO CLIENTE ==========
  // Dados complementares ao bi_entregas (que já tem cod_cliente + nome_fantasia)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_clientes (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL UNIQUE,
      nome_fantasia VARCHAR(255),
      razao_social VARCHAR(255),
      cnpj VARCHAR(20),
      telefone VARCHAR(30),
      email VARCHAR(255),
      endereco TEXT,
      cidade VARCHAR(100),
      estado VARCHAR(10),
      responsavel_nome VARCHAR(255),
      responsavel_telefone VARCHAR(30),
      responsavel_email VARCHAR(255),
      segmento VARCHAR(100) DEFAULT 'autopeças',
      porte VARCHAR(30) DEFAULT 'médio',
      data_inicio_parceria DATE,
      observacoes TEXT,
      tags JSONB DEFAULT '[]',
      health_score INTEGER DEFAULT 50,
      status VARCHAR(30) DEFAULT 'ativo',
      created_by VARCHAR(50),
      updated_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Índices
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_cod ON cs_clientes(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_status ON cs_clientes(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_health ON cs_clientes(health_score)`).catch(() => {});

  // Migração: adicionar centro_custo para suportar múltiplos centros por cod_cliente
  console.log('🔧 CS Migration: Iniciando migração centro_custo...');
  
  // Passo 1: Adicionar coluna
  try {
    await pool.query(`ALTER TABLE cs_clientes ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(255) DEFAULT NULL`);
    console.log('✅ CS Migration: Coluna centro_custo adicionada/confirmada');
  } catch (e) {
    console.error('❌ CS Migration: Falha ao adicionar coluna centro_custo:', e.message);
  }

  // Verificar se a coluna foi criada
  const ccCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'cs_clientes' AND column_name = 'centro_custo'
  `);
  console.log(`🔧 CS Migration: Coluna centro_custo existe? ${ccCheck.rows.length > 0}`);
  
  if (ccCheck.rows.length > 0) {
    // Passo 2: Remover constraints e indexes unique antigos
    try {
      const constraints = await pool.query(`
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'cs_clientes' 
          AND con.contype = 'u'
      `);
      console.log(`🔧 CS Migration: ${constraints.rows.length} unique constraints encontradas:`, constraints.rows.map(c => c.conname));
      for (const c of constraints.rows) {
        await pool.query(`ALTER TABLE cs_clientes DROP CONSTRAINT "${c.conname}"`);
        console.log(`✅ CS Migration: Constraint ${c.conname} removida`);
      }
    } catch (e) { console.warn('⚠️ CS Migration: Limpeza constraints:', e.message); }

    try {
      const indexes = await pool.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'cs_clientes' AND indexdef LIKE '%UNIQUE%'
          AND indexname != 'idx_cs_clientes_cod_cc'
          AND indexname != 'cs_clientes_pkey'
      `);
      console.log(`🔧 CS Migration: ${indexes.rows.length} unique indexes encontrados:`, indexes.rows.map(i => i.indexname));
      for (const idx of indexes.rows) {
        await pool.query(`DROP INDEX "${idx.indexname}"`);
        console.log(`✅ CS Migration: Index ${idx.indexname} removido`);
      }
    } catch (e) { console.warn('⚠️ CS Migration: Limpeza indexes:', e.message); }

    // Passo 3: Criar novo unique index (1 registro por cod_cliente)
    try {
      await pool.query(`DROP INDEX IF EXISTS idx_cs_clientes_cod_cc`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_clientes_cod ON cs_clientes(cod_cliente)`);
      console.log('✅ CS Migration: Unique index idx_cs_clientes_cod criado');
    } catch (e) {
      console.error('❌ CS Migration: Falha ao criar index:', e.message);
    }
  }
  
  console.log('✅ Tabela cs_clientes verificada');

  // ========== INTERAÇÕES (TIMELINE) ==========
  // Visitas, reuniões, ligações, pós-venda, anotações
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_interacoes (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      tipo VARCHAR(30) NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      data_interacao TIMESTAMP NOT NULL DEFAULT NOW(),
      duracao_minutos INTEGER,
      participantes JSONB DEFAULT '[]',
      resultado VARCHAR(50),
      proxima_acao TEXT,
      data_proxima_acao DATE,
      anexos JSONB DEFAULT '[]',
      tags JSONB DEFAULT '[]',
      criado_por VARCHAR(50) NOT NULL,
      criado_por_nome VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_cliente ON cs_interacoes(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_tipo ON cs_interacoes(tipo)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_data ON cs_interacoes(data_interacao DESC)`).catch(() => {});

  // Migração: adicionar centro_custo às interações
  try {
    await pool.query(`ALTER TABLE cs_interacoes ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(255) DEFAULT NULL`);
  } catch (e) { /* já existe */ }

  console.log('✅ Tabela cs_interacoes verificada');

  // ========== OCORRÊNCIAS ==========
  // Problemas, reclamações, incidentes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_ocorrencias (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(50) NOT NULL,
      severidade VARCHAR(20) NOT NULL DEFAULT 'media',
      status VARCHAR(30) NOT NULL DEFAULT 'aberta',
      responsavel_cod VARCHAR(50),
      responsavel_nome VARCHAR(255),
      data_abertura TIMESTAMP DEFAULT NOW(),
      data_resolucao TIMESTAMP,
      resolucao TEXT,
      impacto_operacional TEXT,
      tags JSONB DEFAULT '[]',
      criado_por VARCHAR(50) NOT NULL,
      criado_por_nome VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_cliente ON cs_ocorrencias(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_status ON cs_ocorrencias(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_sev ON cs_ocorrencias(severidade)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_data ON cs_ocorrencias(data_abertura DESC)`).catch(() => {});

  // Migração: adicionar centro_custo às ocorrências
  try {
    await pool.query(`ALTER TABLE cs_ocorrencias ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(255) DEFAULT NULL`);
  } catch (e) { /* já existe */ }

  console.log('✅ Tabela cs_ocorrencias verificada');

  // ========== HISTÓRICO RAIO-X IA ==========
  // Análises inteligentes geradas pelo Gemini
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_raio_x_historico (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      nome_cliente VARCHAR(255),
      data_inicio DATE NOT NULL,
      data_fim DATE NOT NULL,
      metricas_snapshot JSONB,
      benchmark_snapshot JSONB,
      analise_texto TEXT,
      tipo_analise VARCHAR(50) DEFAULT 'completo',
      score_saude INTEGER,
      alertas JSONB DEFAULT '[]',
      recomendacoes JSONB DEFAULT '[]',
      gerado_por VARCHAR(50),
      gerado_por_nome VARCHAR(255),
      tokens_utilizados INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_raio_x_cliente ON cs_raio_x_historico(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_raio_x_data ON cs_raio_x_historico(created_at DESC)`).catch(() => {});
  console.log('✅ Tabela cs_raio_x_historico verificada');

  // ========== EMAILS ENVIADOS (rastreamento de envios) ==========
  // Cada linha = 1 envio efetivo via Resend (1 raio-x pode ser enviado várias vezes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_emails_enviados (
      id SERIAL PRIMARY KEY,
      raio_x_id INTEGER REFERENCES cs_raio_x_historico(id) ON DELETE SET NULL,
      cod_cliente INTEGER,
      nome_cliente VARCHAR(255),
      tipo VARCHAR(50) DEFAULT 'raio_x_interno',
      assunto VARCHAR(500),
      para JSONB NOT NULL DEFAULT '[]',
      cc JSONB DEFAULT '[]',
      remetente VARCHAR(255),
      data_inicio DATE,
      data_fim DATE,
      resend_email_id VARCHAR(100) UNIQUE,
      html_armazenado TEXT,
      tags JSONB DEFAULT '[]',
      status_atual VARCHAR(30) DEFAULT 'sent',
      ultima_atividade_em TIMESTAMP,
      total_aberturas INTEGER DEFAULT 0,
      total_cliques INTEGER DEFAULT 0,
      bounce_msg TEXT,
      enviado_por VARCHAR(50),
      enviado_por_nome VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_emails_cliente ON cs_emails_enviados(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_emails_status ON cs_emails_enviados(status_atual)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_emails_created ON cs_emails_enviados(created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_emails_resend ON cs_emails_enviados(resend_email_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_emails_raioX ON cs_emails_enviados(raio_x_id)`).catch(() => {});
  console.log('✅ Tabela cs_emails_enviados verificada');

  // ========== EVENTOS WEBHOOK RESEND ==========
  // Cada linha = 1 evento (sent/delivered/opened/clicked/bounced/complained...)
  // svix_id UNIQUE garante dedup mesmo com retries do Resend (at-least-once)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_email_eventos (
      id SERIAL PRIMARY KEY,
      email_enviado_id INTEGER REFERENCES cs_emails_enviados(id) ON DELETE CASCADE,
      resend_email_id VARCHAR(100),
      svix_id VARCHAR(100) UNIQUE,
      tipo VARCHAR(50) NOT NULL,
      payload JSONB,
      ip VARCHAR(50),
      user_agent TEXT,
      link_clicado TEXT,
      evento_em TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_eventos_email ON cs_email_eventos(email_enviado_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_eventos_resend ON cs_email_eventos(resend_email_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_eventos_tipo ON cs_email_eventos(tipo)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_eventos_data ON cs_email_eventos(evento_em DESC)`).catch(() => {});
  console.log('✅ Tabela cs_email_eventos verificada');

  // ========== CONFIGURAÇÕES GLOBAIS DO MÓDULO CS ==========
  // Key-value pra config global (dia da automação, etc)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_config (
      chave VARCHAR(100) PRIMARY KEY,
      valor TEXT,
      descricao TEXT,
      atualizada_em TIMESTAMP DEFAULT NOW(),
      atualizada_por VARCHAR(50)
    )
  `);
  // Bootstrap do registro de dia da automação (se não existir)
  await pool.query(`
    INSERT INTO cs_config (chave, valor, descricao)
    VALUES ('automacao_email_dia', '1', 'Dia do mês (1-28) em que a automação de envio mensal de email roda')
    ON CONFLICT (chave) DO NOTHING
  `);
  console.log('✅ Tabela cs_config verificada');

  // ========== AUTOMAÇÃO DE ENVIO MENSAL DE EMAIL ==========
  // 1 linha = 1 cliente OU (cliente + centro de custo). Quando cliente
  // tem múltiplos centros, vira N linhas — cada uma com seus próprios
  // destinatários e seu próprio toggle ativa.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_email_automacao (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      centro_custo VARCHAR(255),
      nome_cliente VARCHAR(255),
      ativa BOOLEAN DEFAULT true,
      destinatarios JSONB NOT NULL DEFAULT '[]',
      ultimo_envio_em TIMESTAMP,
      ultimo_envio_status VARCHAR(30),
      ultimo_envio_resend_id VARCHAR(100),
      ultimo_envio_erro TEXT,
      pausada_desde TIMESTAMP,
      pausada_motivo TEXT,
      criada_por VARCHAR(50),
      criada_em TIMESTAMP DEFAULT NOW(),
      atualizada_em TIMESTAMP DEFAULT NOW()
    )
  `);
  // Migração defensiva: se tabela já existia sem a coluna nome_cliente, adiciona
  try {
    await pool.query(`ALTER TABLE cs_email_automacao ADD COLUMN IF NOT EXISTS nome_cliente VARCHAR(255)`);
  } catch (e) { /* já existe */ }

  // Migração defensiva: corrige nomes salvos que estão divergentes do nome
  // canônico do BI (acontecia em versões antigas que pegavam o nome da
  // entrega mais recente em vez do mais frequente, fazendo o nome "dançar"
  // entre centros pra clientes com múltiplos centros).
  try {
    const fix = await pool.query(`
      UPDATE cs_email_automacao a
         SET nome_cliente = canonico.nome,
             atualizada_em = NOW()
        FROM (
          SELECT cod_cliente,
                 MODE() WITHIN GROUP (ORDER BY COALESCE(nome_cliente, nome_fantasia)) AS nome
            FROM bi_entregas
           WHERE COALESCE(nome_cliente, nome_fantasia) IS NOT NULL
             AND data_solicitado >= NOW() - INTERVAL '180 days'
           GROUP BY cod_cliente
        ) canonico
       WHERE a.cod_cliente = canonico.cod_cliente
         AND (a.nome_cliente IS NULL OR a.nome_cliente <> canonico.nome)
      RETURNING a.id
    `);
    if (fix.rowCount > 0) {
      console.log(`🔧 CS Migration: ${fix.rowCount} nomes de cliente corrigidos em cs_email_automacao`);
    }
  } catch (e) {
    console.warn('⚠️ CS Migration: backfill de nomes falhou (não crítico):', e.message);
  }
  // UNIQUE composto tratando NULL como '' (cliente sem CC = string vazia na key)
  // Garante 1 config por (cod_cliente, centro_custo). Sem isso, INSERTs duplicados
  // entrariam silenciosamente porque PostgreSQL trata NULL como sempre distinto.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_email_automacao_cliente_centro
    ON cs_email_automacao(cod_cliente, COALESCE(centro_custo, ''))`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_automacao_ativa ON cs_email_automacao(ativa)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_email_automacao_cod ON cs_email_automacao(cod_cliente)`).catch(() => {});
  console.log('✅ Tabela cs_email_automacao verificada');

  console.log('✅ Módulo Sucesso do Cliente — todas as tabelas verificadas');
}

module.exports = initCsTables;
