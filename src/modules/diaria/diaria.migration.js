/**
 * MÓDULO DIÁRIA - Migration
 *
 * A Diária é o Garantido com UMA diferença: o horário pode ser individual por
 * motoboy. Todo o resto (padrão da central + exceção por motoboy, trava no 1º
 * ingresso do dia, desconto proporcional ao atraso) é o mesmo mecanismo.
 *
 * Padrão + exceção, igual o Garantido já faz com o valor:
 *
 *   filas_centrais.diaria_hora_inicio/fim/valor_padrao  -> vale pra TODO MUNDO
 *   diaria_escala                                       -> só as EXCEÇÕES
 *
 * Ou seja: numa central com diária ativa, quem entra na fila recebe. Quem está
 * na escala recebe com o horário (e o valor) dele.
 */
'use strict';

async function initDiariaTables(pool) {
  // ── Config por central ──
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS diaria_ativa           BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS diaria_valor_padrao    NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS diaria_hora_inicio     TIME DEFAULT '09:00'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS diaria_hora_fim        TIME DEFAULT '18:00'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS diaria_hora_tolerancia TIME`).catch(() => {});
  console.log('✅ Colunas de diária verificadas');

  // ── "Ou uma ou outra, nunca as duas" vira REGRA DO BANCO ──
  //
  // Isto podia ser um comentário, ou um if no frontend, ou disciplina. Não é:
  // com garantido_ativo e diaria_ativa sendo dois booleanos independentes,
  // ligar os dois é POSSÍVEL — e o que é possível acontece, às 2 da manhã, e
  // ninguém sabe dizer o que o motoboy recebe.
  //
  // Com o CHECK, o estado inválido deixa de existir. O banco recusa.
  //
  // ADD CONSTRAINT não tem IF NOT EXISTS, então o DO block confere o
  // pg_constraint antes — a migration roda em todo boot e não pode explodir na
  // segunda vez.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'filas_centrais_remuneracao_exclusiva'
      ) THEN
        ALTER TABLE filas_centrais
          ADD CONSTRAINT filas_centrais_remuneracao_exclusiva
          CHECK (NOT (COALESCE(garantido_ativo, false) AND COALESCE(diaria_ativa, false)));
      END IF;
    END $$;
  `).catch((e) => console.error('⚠️ CHECK remuneracao_exclusiva:', e.message));
  console.log('✅ CHECK garantido XOR diaria verificado');

  // ── Escala: SÓ as exceções ──
  //
  // valor NULL = usa o diaria_valor_padrao da central. É a mesma semântica do
  // garantido_valores_especiais: a linha só existe pra quem foge do padrão.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diaria_escala (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      hora_inicio TIME NOT NULL,
      hora_fim TIME NOT NULL,
      valor NUMERIC(10,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, cod_profissional),
      CONSTRAINT diaria_escala_horario_valido CHECK (hora_fim > hora_inicio)
    )
  `);
  console.log('✅ Tabela diaria_escala verificada');

  // ── Registro diário — trava no 1º ingresso ──
  //
  // hora_inicio_ref / hora_fim_ref: o registro GRAVA o horário que foi usado no
  // cálculo, em vez de reler a escala depois.
  //
  // Isso é uma diferença proposital em relação ao garantido_registros, que relê
  // a hora da central na hora de exibir. Lá isso é um bug latente: se o admin
  // mudar o horário da central, os registros ANTIGOS passam a mostrar o horário
  // novo, e o valor gravado deixa de fazer sentido com a hora ao lado dele.
  // Aqui o horário é POR MOTOBOY e muda mais — então o registro precisa lembrar
  // com o que ele foi calculado. Recibo não muda depois de emitido.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diaria_registros (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      data_ref DATE NOT NULL,
      hora_ingresso TIMESTAMP DEFAULT NOW(),
      hora_inicio_ref TIME,
      hora_fim_ref TIME,
      da_escala BOOLEAN NOT NULL DEFAULT false,
      valor_base NUMERIC(10,2) NOT NULL DEFAULT 0,
      fracao NUMERIC(7,5) NOT NULL DEFAULT 1,
      minutos_atraso INTEGER NOT NULL DEFAULT 0,
      valor_diaria NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, cod_profissional, data_ref)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_diaria_registros_central_data ON diaria_registros(central_id, data_ref)`).catch(() => {});
  console.log('✅ Tabela diaria_registros verificada');
}

module.exports = { initDiariaTables };
