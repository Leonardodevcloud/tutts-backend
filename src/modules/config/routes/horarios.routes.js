/**
 * Config Sub-Router: Horários + Avisos
 */
const express = require('express');

function createHorariosRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

router.get('/horarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM horarios_atendimento ORDER BY dia_semana');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários:', err);
    res.status(500).json({ error: 'Erro ao listar horários' });
  }
});

// PUT /api/horarios/:id - Atualizar horário de um dia
router.put('/horarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_inicio, hora_fim, ativo } = req.body;
    
    const result = await pool.query(
      `UPDATE horarios_atendimento 
       SET hora_inicio = $1, hora_fim = $2, ativo = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [hora_inicio || null, hora_fim || null, ativo, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar horário:', err);
    res.status(500).json({ error: 'Erro ao atualizar horário' });
  }
});

// GET /api/horarios/especiais - Listar horários especiais
router.get('/horarios/especiais', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data >= CURRENT_DATE ORDER BY data'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários especiais:', err);
    res.status(500).json({ error: 'Erro ao listar horários especiais' });
  }
});

// POST /api/horarios/especiais - Criar horário especial
router.post('/horarios/especiais', async (req, res) => {
  try {
    const { data, descricao, hora_inicio, hora_fim, fechado } = req.body;
    
    const result = await pool.query(
      `INSERT INTO horarios_especiais (data, descricao, hora_inicio, hora_fim, fechado)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (data) DO UPDATE SET 
         descricao = $2, hora_inicio = $3, hora_fim = $4, fechado = $5
       RETURNING *`,
      [data, descricao, fechado ? null : hora_inicio, fechado ? null : hora_fim, fechado]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar horário especial:', err);
    res.status(500).json({ error: 'Erro ao criar horário especial' });
  }
});

// DELETE /api/horarios/especiais/:id - Remover horário especial
router.delete('/horarios/especiais/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM horarios_especiais WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover horário especial:', err);
    res.status(500).json({ error: 'Erro ao remover horário especial' });
  }
});

// GET /api/horarios/verificar - Verificar se está dentro do horário de atendimento
router.get('/horarios/verificar', async (req, res) => {
  try {
    const agora = new Date();
    // Ajustar para horário de Brasília (GMT-3)
    const brasiliaOffset = -3 * 60; // minutos
    const localOffset = agora.getTimezoneOffset(); // minutos
    const brasilia = new Date(agora.getTime() + (localOffset + brasiliaOffset) * 60000);
    
    const diaSemana = brasilia.getDay(); // 0=Domingo, 1=Segunda...
    const horaAtual = brasilia.toTimeString().slice(0, 5); // "HH:MM"
    const dataHoje = brasilia.toISOString().split('T')[0]; // "YYYY-MM-DD"
    
    // Verificar se há horário especial para hoje
    const especial = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data = $1',
      [dataHoje]
    );
    
    let dentroHorario = false;
    let horarioInfo = null;
    
    if (especial.rows.length > 0) {
      // Usar horário especial
      const esp = especial.rows[0];
      if (esp.fechado) {
        dentroHorario = false;
        horarioInfo = { tipo: 'especial', descricao: esp.descricao, fechado: true };
      } else {
        dentroHorario = horaAtual >= esp.hora_inicio && horaAtual <= esp.hora_fim;
        horarioInfo = { 
          tipo: 'especial', 
          descricao: esp.descricao, 
          inicio: esp.hora_inicio, 
          fim: esp.hora_fim 
        };
      }
    } else {
      // Usar horário normal do dia
      const normal = await pool.query(
        'SELECT * FROM horarios_atendimento WHERE dia_semana = $1',
        [diaSemana]
      );
      
      if (normal.rows.length > 0) {
        const hor = normal.rows[0];
        if (!hor.ativo || !hor.hora_inicio || !hor.hora_fim) {
          dentroHorario = false;
          horarioInfo = { tipo: 'normal', fechado: true, diaSemana };
        } else {
          dentroHorario = horaAtual >= hor.hora_inicio && horaAtual <= hor.hora_fim;
          horarioInfo = { 
            tipo: 'normal', 
            inicio: hor.hora_inicio, 
            fim: hor.hora_fim, 
            diaSemana 
          };
        }
      }
    }
    
    // Buscar próximo horário de atendimento
    let proximoHorario = null;
    if (!dentroHorario) {
      // Buscar próximo dia com atendimento
      for (let i = 0; i <= 7; i++) {
        const proximaData = new Date(brasilia);
        proximaData.setDate(proximaData.getDate() + i);
        const proximoDia = proximaData.getDay();
        const proximaDataStr = proximaData.toISOString().split('T')[0];
        
        // Verificar especial
        const espProx = await pool.query(
          'SELECT * FROM horarios_especiais WHERE data = $1 AND fechado = false',
          [proximaDataStr]
        );
        
        if (espProx.rows.length > 0) {
          const esp = espProx.rows[0];
          if (i === 0 && horaAtual < esp.hora_inicio) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          } else if (i > 0) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          }
        } else {
          // Verificar normal
          const norProx = await pool.query(
            'SELECT * FROM horarios_atendimento WHERE dia_semana = $1 AND ativo = true',
            [proximoDia]
          );
          
          if (norProx.rows.length > 0 && norProx.rows[0].hora_inicio) {
            const nor = norProx.rows[0];
            if (i === 0 && horaAtual < nor.hora_inicio) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            } else if (i > 0) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            }
          }
        }
      }
    }
    
    res.json({
      dentroHorario,
      horarioInfo,
      proximoHorario,
      horaAtual,
      dataHoje
    });
  } catch (err) {
    console.error('❌ Erro ao verificar horário:', err);
    res.status(500).json({ error: 'Erro ao verificar horário' });
  }
});

// GET /api/avisos - Listar avisos do financeiro
router.get('/avisos', async (req, res) => {
  try {
    const { ativos } = req.query;
    let query = 'SELECT * FROM avisos_financeiro';
    if (ativos === 'true') {
      query += ' WHERE ativo = true';
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.status(500).json({ error: 'Erro ao listar avisos' });
  }
});

// POST /api/avisos - Criar aviso
router.post('/avisos', async (req, res) => {
  try {
    const { titulo, mensagem, tipo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `INSERT INTO avisos_financeiro (titulo, mensagem, tipo, exibir_fora_horario)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [titulo, mensagem, tipo || 'info', exibir_fora_horario || false]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: 'Erro ao criar aviso' });
  }
});

// PUT /api/avisos/:id - Atualizar aviso
router.put('/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, mensagem, tipo, ativo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `UPDATE avisos_financeiro 
       SET titulo = $1, mensagem = $2, tipo = $3, ativo = $4, exibir_fora_horario = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [titulo, mensagem, tipo, ativo, exibir_fora_horario, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: 'Erro ao atualizar aviso' });
  }
});

// DELETE /api/avisos/:id - Remover aviso
router.delete('/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos_financeiro WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover aviso:', err);
    res.status(500).json({ error: 'Erro ao remover aviso' });
  }
});

  // ==================== NOTIFICAÇÕES ====================


  return router;
}

module.exports = { createHorariosRoutes };
