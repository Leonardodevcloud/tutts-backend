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

    // Índices
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_cliente ON solicitacoes_corrida(cliente_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_status ON solicitacoes_corrida(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_corrida_os ON solicitacoes_corrida(tutts_os_numero)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_pontos_corrida ON solicitacoes_pontos(solicitacao_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_favoritos_cliente ON solicitacao_favoritos(cliente_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_solic_webhook_os ON solicitacao_webhooks_log(tutts_os_numero)`).catch(() => {});
    console.log('✅ Índices solicitação criados');
}

module.exports = { initSolicitacaoTables };
