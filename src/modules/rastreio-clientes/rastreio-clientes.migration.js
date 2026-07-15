'use strict';

/**
 * rastreio-clientes.migration.js
 *
 * 2026-05 v3: removido UNIQUE de cliente_cod sozinho. Agora um mesmo
 * cliente_cod pode ter múltiplas linhas, cada uma com seu próprio
 * evolution_group_id + termos_filtro distintos. Útil quando o cliente
 * tem operações segmentadas (ex: 767 GALBA vai pro grupo X, 767 JOAO
 * vai pro grupo Y).
 *
 * Schema:
 *   - UNIQUE (cliente_cod, evolution_group_id) — impede duplicação do
 *     mesmo grupo dentro do mesmo cliente.
 *   - INDEX (cliente_cod, ativo) — usado pelo detector.
 *
 * Migração de bancos existentes (idempotente):
 *   - Drop constraint UNIQUE em cliente_cod se existir (nome conhecido
 *     gerado pelo Postgres é `rastreio_clientes_config_cliente_cod_key`)
 *   - Cria UNIQUE composto se não existir
 */

async function initRastreioClientesTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rastreio_clientes_config (
      id SERIAL PRIMARY KEY,
      cliente_cod VARCHAR(10) NOT NULL,
      nome_exibicao VARCHAR(100) NOT NULL,
      ativo BOOLEAN DEFAULT TRUE,
      evolution_group_id VARCHAR(120) NOT NULL,
      termos_filtro TEXT[],
      observacoes TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  // 2026-05 v3: remove UNIQUE antigo (cliente_cod sozinho).
  // O nome default que o Postgres atribuiu quando criou era
  // 'rastreio_clientes_config_cliente_cod_key'. Caso a constraint não
  // exista (db fresco), o IF EXISTS silencia o erro.
  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      DROP CONSTRAINT IF EXISTS rastreio_clientes_config_cliente_cod_key
  `).catch((e) => {
    console.warn('[rastreio-clientes] drop constraint legacy:', e.message);
  });

  // UNIQUE composto: impede duplicar mesmo cliente+grupo
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'rastreio_clientes_config_cliente_grupo_unique'
      ) THEN
        ALTER TABLE rastreio_clientes_config
          ADD CONSTRAINT rastreio_clientes_config_cliente_grupo_unique
          UNIQUE (cliente_cod, evolution_group_id);
      END IF;
    END $$;
  `).catch((e) => {
    console.warn('[rastreio-clientes] add unique composto:', e.message);
  });

  // 2026-05: rastreio direto ao cliente final (WhatsApp do número extraído da nota)
  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      ADD COLUMN IF NOT EXISTS rastreio_cliente_ativo BOOLEAN DEFAULT FALSE
  `).catch(e => console.warn('[rastreio-clientes] rastreio_cliente_ativo:', e.message));

  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      ADD COLUMN IF NOT EXISTS usa_hub BOOLEAN DEFAULT FALSE
  `).catch(e => console.warn('[rastreio-clientes] usa_hub:', e.message));

  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      ADD COLUMN IF NOT EXISTS rastreio_cliente_mensagem TEXT DEFAULT NULL
  `).catch(e => console.warn('[rastreio-clientes] rastreio_cliente_mensagem:', e.message));

  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      ADD COLUMN IF NOT EXISTS rastreio_cliente_nome_exibicao VARCHAR(120) DEFAULT NULL
  `).catch(e => console.warn('[rastreio-clientes] rastreio_cliente_nome_exibicao:', e.message));

  // ENVIAR_GRUPO_FLAG_V1
  // Separa "capturar" de "enviar no grupo".
  //
  // POR QUE: o toggle `ativo` desliga o DETECTOR — sem detector, nao entra
  // linha em sla_capturas, e sem sla_capturas o card do Hub perde a NF e o
  // nome do cliente final (o pontos_json e a fonte deles). Quem so quer
  // parar o WhatsApp precisava derrubar a captura junto.
  //
  // Com este flag: detector e captura seguem normais (o card continua
  // alimentado) e so o envio no grupo e pulado.
  //
  // DEFAULT TRUE: nada muda pra quem ja esta cadastrado.
  await pool.query(`
    ALTER TABLE rastreio_clientes_config
      ADD COLUMN IF NOT EXISTS enviar_grupo BOOLEAN DEFAULT TRUE
  `).catch(e => console.warn('[rastreio-clientes] enviar_grupo:', e.message));

  console.log('✅ Colunas rastreio_cliente_* verificadas');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rcc_ativo ON rastreio_clientes_config(ativo);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rcc_cliente_ativo ON rastreio_clientes_config(cliente_cod, ativo);`);

  // Seed: insere 814 e 767 se a tabela estiver vazia
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM rastreio_clientes_config');
  if (rows[0].n === 0) {
    const grp814 = process.env.EVOLUTION_GROUP_ID_814 || '';
    const grp767 = process.env.EVOLUTION_GROUP_ID_767 || grp814;
    await pool.query(
      `INSERT INTO rastreio_clientes_config
        (cliente_cod, nome_exibicao, ativo, evolution_group_id, termos_filtro, observacoes)
       VALUES
        ($1,'Cobra Center (814)',TRUE,$2,NULL,'Sem filtro - todas as OS deste cliente'),
        ($3,'Comollati Porto Seco (767)',TRUE,$4,$5,'Filtro discriminativo de endereço')`,
      ['814', grp814, '767', grp767, ['GALBA','NOVAS DE CASTRO','57061-510']]
    );
    console.log('[rastreio-clientes] seed 814/767 inserido');
  }
}

module.exports = initRastreioClientesTables;
