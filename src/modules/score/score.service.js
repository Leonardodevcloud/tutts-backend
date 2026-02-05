// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - SERVICE (Lógica de Negócio)
// Extraído de server.js (linhas 21258-21338)
// ============================================================

// Data mínima para contabilização do Score
const DATA_MINIMA_SCORE = '2025-12-01';

/**
 * Calcula pontos de uma OS individual
 * Regras: +0.75 no prazo, -1.00 fora do prazo
 * Bônus janela: +0.50 (10h-12h), +0.75 (16h-18h) - somente se no prazo
 */
function calcularPontosOS(dentroPrazo, horaSolicitacao) {
  let pontoPrazo = 0;
  let pontoBonus = 0;
  let janelaBonus = null;
  let detalhes = [];

  if (dentroPrazo === true) {
    pontoPrazo = 0.75;
    detalhes.push('No prazo (+0,75)');
  } else if (dentroPrazo === false) {
    pontoPrazo = -1.00;
    detalhes.push('Fora do prazo (-1,00)');
  }

  if (dentroPrazo === true && horaSolicitacao) {
    const hora = typeof horaSolicitacao === 'string'
      ? parseInt(horaSolicitacao.split(':')[0])
      : (horaSolicitacao instanceof Date ? horaSolicitacao.getHours() : null);

    if (hora !== null) {
      if (hora >= 10 && hora < 12) {
        pontoBonus = 0.50;
        janelaBonus = '10h-12h';
        detalhes.push('Bônus janela 10-12h (+0,50)');
      } else if (hora >= 16 && hora < 18) {
        pontoBonus = 0.75;
        janelaBonus = '16h-18h';
        detalhes.push('Bônus janela 16-18h (+0,75)');
      }
    }
  }

  return {
    ponto_prazo: pontoPrazo,
    ponto_bonus_janela: pontoBonus,
    ponto_total: pontoPrazo + pontoBonus,
    janela_bonus: janelaBonus,
    detalhamento: detalhes.join(' | ')
  };
}

/**
 * Verifica e atualiza conquistas de um profissional
 * Remove conquistas indevidas (score caiu) e adiciona novas
 */
async function verificarConquistas(pool, cod_prof) {
  try {
    const scoreResult = await pool.query(
      'SELECT score_total FROM score_totais WHERE cod_prof = $1',
      [cod_prof]
    );
    if (scoreResult.rows.length === 0) return;

    const scoreAtual = parseFloat(scoreResult.rows[0].score_total) || 0;

    // Remover conquistas que o profissional não deveria ter
    await pool.query(`
      DELETE FROM score_conquistas 
      WHERE cod_prof = $1 
      AND milestone_id IN (
        SELECT id FROM score_milestones WHERE pontos_necessarios > $2
      )
    `, [cod_prof, scoreAtual]);

    // Adicionar conquistas alcançadas
    const milestonesDisponiveis = await pool.query(`
      SELECT m.* FROM score_milestones m
      WHERE m.ativo = true
      AND m.id NOT IN (SELECT milestone_id FROM score_conquistas WHERE cod_prof = $1)
      AND m.pontos_necessarios <= $2
      ORDER BY m.pontos_necessarios ASC
    `, [cod_prof, scoreAtual]);

    for (const milestone of milestonesDisponiveis.rows) {
      await pool.query(`
        INSERT INTO score_conquistas (cod_prof, milestone_id)
        VALUES ($1, $2) ON CONFLICT (cod_prof, milestone_id) DO NOTHING
      `, [cod_prof, milestone.id]);
    }
  } catch (error) {
    console.error('Erro ao verificar conquistas:', error);
  }
}

/**
 * Determina nível e saques gratuitos baseado no score
 */
function determinarNivelGratuidade(score) {
  if (score >= 100) return { quantidadeSaques: 4, nivel: 'Prata' };
  if (score >= 80) return { quantidadeSaques: 2, nivel: 'Bronze' };
  return { quantidadeSaques: 0, nivel: null };
}

/**
 * Aplica gratuidades do mês para um profissional
 * Retorna: 'criado' | 'atualizado' | 'existente' | null
 */
async function aplicarGratuidadeProfissional(pool, prof, mesReferencia) {
  const score = parseFloat(prof.score_total) || 0;
  const { quantidadeSaques, nivel } = determinarNivelGratuidade(score);

  if (quantidadeSaques === 0) return null;

  const existente = await pool.query(
    'SELECT * FROM score_gratuidades WHERE cod_prof = $1 AND mes_referencia = $2',
    [prof.cod_prof, mesReferencia]
  );

  if (existente.rows.length > 0) {
    const atual = existente.rows[0];
    if (atual.quantidade_saques !== quantidadeSaques) {
      const diferenca = quantidadeSaques - atual.quantidade_saques;
      if (diferenca > 0 && atual.gratuidade_id) {
        await pool.query(
          'UPDATE gratuities SET quantity = quantity + $1, remaining = remaining + $1 WHERE id = $2',
          [diferenca, atual.gratuidade_id]
        );
      }
      await pool.query(
        'UPDATE score_gratuidades SET quantidade_saques = $1, nivel = $2, score_no_momento = $3 WHERE id = $4',
        [quantidadeSaques, nivel, score, atual.id]
      );
      return 'atualizado';
    }
    return 'existente';
  }

  // Criar nova gratuidade
  const gratuidade = await pool.query(`
    INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
    VALUES ($1, $2, $3, $3, 500.00, $4, 'ativa', 'Sistema Score')
    RETURNING id
  `, [prof.cod_prof, prof.nome_prof, quantidadeSaques, `Score ${nivel} - ${mesReferencia}`]);

  await pool.query(`
    INSERT INTO score_gratuidades (cod_prof, nome_prof, mes_referencia, score_no_momento, nivel, quantidade_saques, gratuidade_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [prof.cod_prof, prof.nome_prof, mesReferencia, score, nivel, quantidadeSaques, gratuidade.rows[0].id]);

  return 'criado';
}

module.exports = {
  DATA_MINIMA_SCORE,
  calcularPontosOS,
  verificarConquistas,
  determinarNivelGratuidade,
  aplicarGratuidadeProfissional
};
