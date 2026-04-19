/**
 * MÓDULO COLETA DE ENDEREÇOS - Migration
 *
 * Base colaborativa de endereços alimentada por motoboys.
 * Cada motoboy vinculado a uma ou mais regiões pode cadastrar endereços
 * (nome do cliente + GPS + foto opcional). Se a validação IA (Gemini + Google
 * Places) devolver ≥90% de confiança, aprova automaticamente e grava em
 * `solicitacao_favoritos` com o `grupo_enderecos_id` da região. Caso contrário,
 * fica numa fila pra admin revisar. Cada aprovação gera R$ 1,00 ao motoboy,
 * contabilizado em ledger (pagamento real decidido depois).
 *
 * 4 tabelas:
 *  - coleta_regioes                       → regiões (ex: Salvador → Grupo Bahia)
 *  - coleta_motoboy_regioes               → pivô motoboy × região
 *  - coleta_enderecos_pendentes           → cadastros aguardando aprovação
 *  - coleta_motoboy_ganhos                → ledger de créditos (R$ 1,00 por endereço)
 */

async function initColetaEnderecosTables(pool) {
  // Regiões definidas pelo admin.
  // Cada região aponta pra um grupo de endereços compartilhados já existente
  // (criado no módulo solicitação) — os aprovados caem nesse grupo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coleta_regioes (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      uf VARCHAR(2),
      cidade VARCHAR(255),
      grupo_enderecos_id INT REFERENCES grupos_enderecos(id) ON DELETE SET NULL,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela coleta_regioes verificada');

  // Vínculo motoboy × região (1 motoboy pode atuar em N regiões).
  // cod_profissional é o identificador do motoboy em `users`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coleta_motoboy_regioes (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) NOT NULL,
      regiao_id INT NOT NULL REFERENCES coleta_regioes(id) ON DELETE CASCADE,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cod_profissional, regiao_id)
    )
  `);
  console.log('✅ Tabela coleta_motoboy_regioes verificada');

  // Fila de endereços em análise.
  // - status='aprovado': já virou registro em solicitacao_favoritos (endereco_gerado_id)
  // - status='rejeitado': admin (ou IA p/ foto claramente inválida) rejeitou, motivo_rejeicao preenchido
  // - status='validacao_manual': IA devolveu <90% confiança, aguarda admin
  // - status='pendente_analise': ainda em processamento (estado transiente, raro)
  // foto_base64 fica armazenada aqui até o item sair da fila; depois é descartada (transitório).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coleta_enderecos_pendentes (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) NOT NULL,
      regiao_id INT NOT NULL REFERENCES coleta_regioes(id) ON DELETE CASCADE,
      nome_cliente VARCHAR(255) NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      foto_base64 TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pendente_analise',
      confianca_ia INT DEFAULT 0,
      match_google JSONB,
      endereco_formatado TEXT,
      motivo_rejeicao TEXT,
      endereco_gerado_id INT REFERENCES solicitacao_favoritos(id) ON DELETE SET NULL,
      analisado_em TIMESTAMP,
      finalizado_em TIMESTAMP,
      finalizado_por_admin VARCHAR(50),
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela coleta_enderecos_pendentes verificada');

  // Ledger de créditos por endereço validado.
  // status='previsto': item está em validacao_manual, valor ainda não confirmado
  // status='confirmado': item foi aprovado (auto ou manual), crédito garantido
  // status='pago': flag reservada pra quando integrar pagamento real (Plific, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coleta_motoboy_ganhos (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) NOT NULL,
      endereco_pendente_id INT NOT NULL REFERENCES coleta_enderecos_pendentes(id) ON DELETE CASCADE,
      valor DECIMAL(10,2) NOT NULL DEFAULT 1.00,
      status VARCHAR(20) NOT NULL DEFAULT 'previsto',
      descricao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(endereco_pendente_id)
    )
  `);
  console.log('✅ Tabela coleta_motoboy_ganhos verificada');

  // Índices
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_motoboy_regioes_cod ON coleta_motoboy_regioes(cod_profissional)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_motoboy_regioes_regiao ON coleta_motoboy_regioes(regiao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_cod ON coleta_enderecos_pendentes(cod_profissional)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_regiao ON coleta_enderecos_pendentes(regiao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_status ON coleta_enderecos_pendentes(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_ganhos_cod ON coleta_motoboy_ganhos(cod_profissional)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_ganhos_status ON coleta_motoboy_ganhos(status)`).catch(() => {});
  console.log('✅ Índices coletaEnderecos criados');
}

module.exports = { initColetaEnderecosTables };
