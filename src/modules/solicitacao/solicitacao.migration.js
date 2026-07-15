/**
 * MÓDULO SOLICITAÇÃO - Migration
 * 5 tabelas: clientes_solicitacao, solicitacoes_corrida, solicitacoes_pontos,
 *            solicitacao_favoritos, solicitacao_webhooks_log
 */

async function initSolicitacaoTables(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes_solicitacao (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        telefone VARCHAR(50),
        empresa VARCHAR(255),
        observacoes TEXT,
        tutts_token_api TEXT,
        tutts_id_cliente VARCHAR(100),
        forma_pagamento_padrao VARCHAR(10) DEFAULT 'F',
        ativo BOOLEAN DEFAULT true,
        ultimo_acesso TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela clientes_solicitacao verificada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacoes_corrida (
        id SERIAL PRIMARY KEY,
        cliente_id INT REFERENCES clientes_solicitacao(id),
        numero_pedido VARCHAR(100),
        centro_custo VARCHAR(200),
        usuario_solicitante VARCHAR(255),
        data_retirada TIMESTAMP,
        forma_pagamento VARCHAR(10) DEFAULT 'F',
        ponto_receber INT,
        retorno BOOLEAN DEFAULT false,
        obs_retorno TEXT,
        ordenar BOOLEAN DEFAULT false,
        codigo_profissional VARCHAR(50),
        valor_rota_profissional DECIMAL(10,2),
        valor_rota_servico DECIMAL(10,2),
        tutts_os_numero VARCHAR(100),
        tutts_distancia VARCHAR(50),
        tutts_duracao VARCHAR(50),
        tutts_valor DECIMAL(10,2),
        tutts_url_rastreamento TEXT,
        status VARCHAR(50) DEFAULT 'pendente',
        erro_mensagem TEXT,
        profissional_nome VARCHAR(255),
        profissional_email VARCHAR(255),
        profissional_foto TEXT,
        profissional_telefone VARCHAR(50),
        profissional_placa VARCHAR(20),
        profissional_veiculo VARCHAR(100),
        profissional_cor_veiculo VARCHAR(50),
        cancelado_em TIMESTAMP,
        cancelado_por VARCHAR(255),
        motivo_cancelamento TEXT,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela solicitacoes_corrida verificada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacoes_pontos (
        id SERIAL PRIMARY KEY,
        solicitacao_id INT REFERENCES solicitacoes_corrida(id) ON DELETE CASCADE,
        ordem INT NOT NULL,
        rua VARCHAR(500),
        numero VARCHAR(50),
        complemento VARCHAR(255),
        bairro VARCHAR(255),
        cidade VARCHAR(255),
        uf VARCHAR(2),
        cep VARCHAR(10),
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        observacao TEXT,
        telefone VARCHAR(50),
        procurar_por VARCHAR(255),
        numero_nota VARCHAR(100),
        codigo_finalizar VARCHAR(100),
        endereco_completo TEXT,
        status VARCHAR(50) DEFAULT 'pendente',
        status_atualizado_em TIMESTAMP,
        data_chegada TIMESTAMP,
        data_coletado TIMESTAMP,
        data_finalizado TIMESTAMP,
        motivo_finalizacao VARCHAR(100),
        motivo_descricao TEXT,
        tempo_espera VARCHAR(50),
        fotos JSONB,
        assinatura JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela solicitacoes_pontos verificada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacao_favoritos (
        id SERIAL PRIMARY KEY,
        cliente_id INT REFERENCES clientes_solicitacao(id) ON DELETE CASCADE,
        apelido VARCHAR(255),
        endereco_completo TEXT,
        rua VARCHAR(500),
        numero VARCHAR(50),
        complemento VARCHAR(255),
        bairro VARCHAR(255),
        cidade VARCHAR(255),
        uf VARCHAR(2),
        cep VARCHAR(10),
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        telefone_padrao VARCHAR(50),
        procurar_por_padrao VARCHAR(255),
        observacao_padrao TEXT,
        vezes_usado INT DEFAULT 0,
        ultimo_uso TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela solicitacao_favoritos verificada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitacao_webhooks_log (
        id SERIAL PRIMARY KEY,
        tutts_os_numero VARCHAR(100),
        payload JSONB,
        processado BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela solicitacao_webhooks_log verificada');

    // === GRUPOS DE ENDEREÇOS COMPARTILHADOS ===
    // Permite que múltiplos clientes_solicitacao compartilhem o mesmo pool de endereços salvos.
    // Cliente sem grupo = silo individual (comportamento original). Cliente com grupo = compartilha
    // tudo (visualiza, edita e exclui endereços de qualquer membro do mesmo grupo).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS grupos_enderecos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        descricao TEXT,
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela grupos_enderecos verificada');

    // Adicionar coluna grupo_enderecos_id em clientes_solicitacao (idempotente)
    await pool.query(`
      ALTER TABLE clientes_solicitacao 
      ADD COLUMN IF NOT EXISTS grupo_enderecos_id INT REFERENCES grupos_enderecos(id) ON DELETE SET NULL
    `).catch(e => console.log('⚠️ grupo_enderecos_id em clientes_solicitacao:', e.message));

    // Adicionar coluna grupo_enderecos_id em solicitacao_favoritos (idempotente)
    await pool.query(`
      ALTER TABLE solicitacao_favoritos 
      ADD COLUMN IF NOT EXISTS grupo_enderecos_id INT REFERENCES grupos_enderecos(id) ON DELETE SET NULL
    `).catch(e => console.log('⚠️ grupo_enderecos_id em solicitacao_favoritos:', e.message));

    // Índices
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_cliente ON solicitacoes_corrida(cliente_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_status ON solicitacoes_corrida(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_os ON solicitacoes_corrida(tutts_os_numero)`).catch(() => {});
    // RELATORIO_PERF_V1 — indice FUNCIONAL em trim(tutts_os_numero).
    //
    // O indice acima (na coluna crua) NAO serve pra `WHERE trim(col) = x`:
    // um b-tree em `col` nao casa com um predicado em `trim(col)`, entao o
    // Postgres ignora ele e varre a tabela inteira. Era isso que fazia o
    // relatorio de corridas girar sem responder.
    //
    // Este indice e sobre a EXPRESSAO, entao o planner consegue usar.
    // Mantemos os dois: o cru serve pras buscas exatas que ja existiam.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_os_trim ON solicitacoes_corrida ((trim(tutts_os_numero)))`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_pontos_corrida ON solicitacoes_pontos(solicitacao_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_favoritos_cliente ON solicitacao_favoritos(cliente_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_favoritos_grupo ON solicitacao_favoritos(grupo_enderecos_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_solic_grupo ON clientes_solicitacao(grupo_enderecos_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_webhook_os ON solicitacao_webhooks_log(tutts_os_numero)`).catch(() => {});
    console.log('✅ Índices solicitação criados');

    // Migration: razão social / nome fantasia em solicitacoes_pontos (novo campo obrigatório no form)
    // Corridas antigas permanecem com procurar_por preenchido e razao_social nula — fallback é tratado no frontend.
    await pool.query(`ALTER TABLE solicitacoes_pontos ADD COLUMN IF NOT EXISTS razao_social VARCHAR(500)`).catch(e => console.log('⚠️ razao_social em solicitacoes_pontos:', e.message));
    console.log('✅ Coluna razao_social em solicitacoes_pontos verificada');

    // Migration 2026-04: separação razao_social vs nome_fantasia (eram um campo só, viraram dois)
    // - nome_fantasia (NOVO, obrigatório no form): nome popular do estabelecimento (ex: "Auto Peças do João")
    // - razao_social (já existia, agora opcional): razão social fiscal (ex: "JOÃO MOREIRA AUTO PEÇAS LTDA")
    // Migração one-time: copia razao_social → nome_fantasia onde nome_fantasia ainda for NULL.
    await pool.query(`ALTER TABLE solicitacoes_pontos ADD COLUMN IF NOT EXISTS nome_fantasia VARCHAR(500)`).catch(e => console.log('⚠️ nome_fantasia em solicitacoes_pontos:', e.message));
    await pool.query(`UPDATE solicitacoes_pontos SET nome_fantasia = razao_social WHERE nome_fantasia IS NULL AND razao_social IS NOT NULL`).catch(e => console.log('⚠️ migração nome_fantasia em pontos:', e.message));
    console.log('✅ Coluna nome_fantasia em solicitacoes_pontos verificada e migrada');

    await pool.query(`ALTER TABLE solicitacao_favoritos ADD COLUMN IF NOT EXISTS nome_fantasia VARCHAR(500)`).catch(e => console.log('⚠️ nome_fantasia em solicitacao_favoritos:', e.message));
    await pool.query(`UPDATE solicitacao_favoritos SET nome_fantasia = razao_social WHERE nome_fantasia IS NULL AND razao_social IS NOT NULL`).catch(e => console.log('⚠️ migração nome_fantasia em favoritos:', e.message));
    console.log('✅ Coluna nome_fantasia em solicitacao_favoritos verificada e migrada');

    // Migration: colunas usadas pelo webhook handler que faltam na tabela original
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS dados_pontos JSONB`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS status_codigo DECIMAL(5,2)`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS status_atualizado_em TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS profissional_cpf VARCHAR(20)`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS profissional_codigo VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS rota_profissional JSONB`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS cor_veiculo VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS modelo_veiculo VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE solicitacoes_corrida ADD COLUMN IF NOT EXISTS ultima_atualizacao TIMESTAMP`).catch(() => {});
    console.log('✅ Colunas webhook solicitacoes_corrida verificadas');

    // Perfil de mensagem pro entregador (99) POR CLIENTE API. Vazio = usa global.
    await pool.query(`ALTER TABLE clientes_solicitacao ADD COLUMN IF NOT EXISTS nome_remetente   VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE clientes_solicitacao ADD COLUMN IF NOT EXISTS package_type     VARCHAR(20)`).catch(() => {});
    await pool.query(`ALTER TABLE clientes_solicitacao ADD COLUMN IF NOT EXISTS package_weight   VARCHAR(10)`).catch(() => {});
    await pool.query(`ALTER TABLE clientes_solicitacao ADD COLUMN IF NOT EXISTS aviso_entregador VARCHAR(127)`).catch(() => {});
    await pool.query(`ALTER TABLE clientes_solicitacao ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
    console.log('✅ Colunas perfil-mensagem clientes_solicitacao verificadas');

    // Tabela de logs detalhados do webhook (handler /api/webhook/tutts)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_tutts_logs (
        id SERIAL PRIMARY KEY,
        os_numero VARCHAR(100),
        solicitacao_id INT,
        status_id DECIMAL(5,2),
        status_descricao TEXT,
        profissional_nome VARCHAR(255),
        ponto_numero INT,
        ponto_status VARCHAR(50),
        payload_completo JSONB,
        criado_em TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_os ON webhook_tutts_logs(os_numero)`).catch(() => {});
    console.log('✅ Tabela webhook_tutts_logs verificada');

    // 2026-07: a FK webhook_tutts_logs.solicitacao_id existia sem ON DELETE CASCADE,
    // bloqueando a exclusao de cliente (cascade cliente -> solicitacoes_corrida ->
    // webhook_tutts_logs). Recria com CASCADE apenas se ainda nao estiver assim.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.referential_constraints
          WHERE constraint_name = 'webhook_tutts_logs_solicitacao_id_fkey'
            AND delete_rule = 'CASCADE'
        ) THEN
          ALTER TABLE webhook_tutts_logs
            DROP CONSTRAINT IF EXISTS webhook_tutts_logs_solicitacao_id_fkey;
          ALTER TABLE webhook_tutts_logs
            ADD CONSTRAINT webhook_tutts_logs_solicitacao_id_fkey
            FOREIGN KEY (solicitacao_id) REFERENCES solicitacoes_corrida(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `).catch(e => console.log('⚠️ FK webhook_tutts_logs CASCADE:', e.message));
    console.log('✅ FK webhook_tutts_logs -> ON DELETE CASCADE verificada');

    // 🚀 2026-05: rastreamento de envio do link pro cliente (WhatsApp)
    await pool.query(`
      ALTER TABLE solicitacoes_corrida
      ADD COLUMN IF NOT EXISTS rastreio_enviado BOOLEAN DEFAULT false
    `).catch(e => console.log('⚠️ rastreio_enviado:', e.message));
    await pool.query(`
      ALTER TABLE solicitacoes_corrida
      ADD COLUMN IF NOT EXISTS rastreio_enviado_em TIMESTAMP
    `).catch(e => console.log('⚠️ rastreio_enviado_em:', e.message));
    // 2026-05: agendamento do envio automático (delay de 10 min após criar a OS).
    // O worker processa as linhas com rastreio_agendado_para <= NOW() e rastreio_enviado = false.
    await pool.query(`
      ALTER TABLE solicitacoes_corrida
      ADD COLUMN IF NOT EXISTS rastreio_agendado_para TIMESTAMP
    `).catch(e => console.log('⚠️ rastreio_agendado_para:', e.message));
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_corrida_rastreio_pendente
      ON solicitacoes_corrida (rastreio_agendado_para)
      WHERE rastreio_enviado = false AND rastreio_agendado_para IS NOT NULL
    `).catch(e => console.log('⚠️ idx_corrida_rastreio_pendente:', e.message));
    console.log('✅ Colunas rastreio_enviado verificadas');

    // 2026-05: categorias de frete configuráveis por cliente (integração Mapp "Cliente informa")
    // categorias_disponiveis: JSONB array de { sigla, nome } ex: [{"sigla":"M","nome":"Motofrete"}]
    // Vazio = não exibe dropdown no frontend (categoria não configurada para o cliente)
    await pool.query(`
      ALTER TABLE clientes_solicitacao
      ADD COLUMN IF NOT EXISTS categorias_disponiveis JSONB DEFAULT '[]'
    `).catch(e => console.log('⚠️ categorias_disponiveis:', e.message));
    // categoria_usada: sigla enviada na OS (ex: "M", "UC") — para auditoria
    await pool.query(`
      ALTER TABLE solicitacoes_corrida
      ADD COLUMN IF NOT EXISTS categoria_usada VARCHAR(20)
    `).catch(e => console.log('⚠️ categoria_usada:', e.message));
    console.log('✅ Colunas categorias_disponiveis / categoria_usada verificadas');

    // 2026-05: provedores logísticos habilitados por cliente
    // JSONB array de códigos: ["tutts","uber","99"]  (tutts sempre presente)
    await pool.query(`
      ALTER TABLE clientes_solicitacao
      ADD COLUMN IF NOT EXISTS provedores_habilitados JSONB DEFAULT '["tutts"]'
    `).catch(e => console.log('⚠️ provedores_habilitados:', e.message));
    // provider_usado: código do provedor que atendeu a OS (para auditoria)
    await pool.query(`
      ALTER TABLE solicitacoes_corrida
      ADD COLUMN IF NOT EXISTS provider_usado VARCHAR(20) DEFAULT 'tutts'
    `).catch(e => console.log('⚠️ provider_usado:', e.message));
    console.log('✅ Colunas provedores_habilitados / provider_usado verificadas');

    // 2026-07: tabela de preco do Hub POR CLIENTE (precedencia: cliente sempre manda)
    // JSONB { ativo, valor_fixo, km_base, valor_km_adicional }. NULL = herda global.
    await pool.query(`
      ALTER TABLE clientes_solicitacao
      ADD COLUMN IF NOT EXISTS preco_hub JSONB
    `).catch(e => console.log('⚠️ preco_hub:', e.message));
    console.log('✅ Coluna preco_hub verificada');
}

module.exports = { initSolicitacaoTables };
