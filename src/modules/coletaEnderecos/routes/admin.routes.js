/**
 * MÓDULO COLETA DE ENDEREÇOS - Migration
 *
 * Base colaborativa de endereços alimentada por motoboys.
 *
 * VÍNCULO MOTOBOY × REGIÃO: automático por match de nome.
 * O campo `regiao` (ou `cidade`) do motoboy no CRM é comparado com o campo
 * `nome` das regiões cadastradas aqui (case-insensitive, via
 * buscarRegiaoProfissional do profissionaisLookup). Não há tabela de vínculo
 * manual — se o motoboy é de "Salvador" no CRM e existe uma região "Salvador"
 * ativa, ele automaticamente enxerga e pode cadastrar nela.
 *
 * 3 tabelas:
 *  - coleta_regioes                       → regiões (ex: Salvador → Grupo Bahia)
 *  - coleta_enderecos_pendentes           → cadastros aguardando aprovação
 *  - coleta_motoboy_ganhos                → ledger de créditos (R$ 1,00 por endereço)
 */

async function initColetaEnderecosTables(pool) {
  // Regiões definidas pelo admin. O `nome` DEVE bater com a região do motoboy
  // no CRM (coluna `regiao` ou fallback `cidade` de crm_leads_capturados).
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

  // Cleanup: se houver a antiga tabela de vínculo manual de versões anteriores,
  // ela pode ser descartada (o vínculo agora é automático por match de nome).
  await pool.query(`DROP TABLE IF EXISTS coleta_motoboy_regioes CASCADE`).catch(() => {});

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_cod ON coleta_enderecos_pendentes(cod_profissional)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_regiao ON coleta_enderecos_pendentes(regiao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_pendentes_status ON coleta_enderecos_pendentes(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_ganhos_cod ON coleta_motoboy_ganhos(cod_profissional)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_ganhos_status ON coleta_motoboy_ganhos(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coleta_regioes_nome_upper ON coleta_regioes(UPPER(nome))`).catch(() => {});
  console.log('✅ Índices coletaEnderecos criados');

  // ALTER em solicitacao_favoritos.cliente_id pra aceitar NULL.
  // Originalmente cliente_id era NOT NULL (favorito sempre pertencia a um cliente).
  // Com o módulo de Coleta colaborativa, endereços aprovados são compartilhados
  // por grupo (sem dono), então cliente_id deve permitir NULL.
  // Idempotente — se já permite NULL, ALTER é no-op.
  await pool.query(`
    ALTER TABLE solicitacao_favoritos ALTER COLUMN cliente_id DROP NOT NULL
  `).catch(e => console.log('⚠️ ALTER cliente_id DROP NOT NULL:', e.message));
  console.log('✅ solicitacao_favoritos.cliente_id agora aceita NULL (endereços de grupo)');
}

module.exports = { initColetaEnderecosTables };
