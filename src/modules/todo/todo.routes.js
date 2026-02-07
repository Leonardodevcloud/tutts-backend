const express = require('express');
const { createTarefasRoutes } = require('./routes/tarefas.routes');
const { createWorkflowRoutes } = require('./routes/workflow.routes');

function createTodoRouter(pool) {
  const router = express.Router();
  router.use(createTarefasRoutes(pool));
  router.use(createWorkflowRoutes(pool));
  return router;
}

module.exports = { createTodoRouter, initTodoCron: function(pool) {
  const processarRecorrencias = async () => {
    try {
      const agora = new Date();
      const tarefasRecorrentes = await pool.query(`
        SELECT * FROM todo_tarefas 
        WHERE recorrente = true 
        AND status = 'concluida'
        AND proxima_recorrencia IS NOT NULL 
        AND proxima_recorrencia <= $1
      `, [agora]);
      let reabertas = 0;
      for (const tarefa of tarefasRecorrentes.rows) {
        const calcularProximaRecorrencia = (dataBase, tipo, intervalo) => {
          const data = new Date(dataBase);
          switch(tipo) {
            case 'diaria': data.setDate(data.getDate() + intervalo); break;
            case 'semanal': data.setDate(data.getDate() + (7 * intervalo)); break;
            case 'mensal': data.setMonth(data.getMonth() + intervalo); break;
            default: data.setDate(data.getDate() + intervalo);
          }
          return data;
        };
        const proximaData = calcularProximaRecorrencia(new Date(), tarefa.tipo_recorrencia, tarefa.intervalo_recorrencia || 1);
        await pool.query(`UPDATE todo_tarefas SET status = 'pendente', data_conclusao = NULL, concluido_por = NULL, concluido_por_nome = NULL, proxima_recorrencia = $1, updated_at = NOW() WHERE id = $2`, [proximaData, tarefa.id]);
        await pool.query(`INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name) VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')`, [tarefa.id]);
        reabertas++;
      }
      if (reabertas > 0) console.log(`🔄 ${reabertas} tarefas recorrentes reabertas`);
    } catch (err) { console.error('❌ Erro ao processar recorrências:', err.message); }
  };
  setInterval(processarRecorrencias, 60 * 60 * 1000);
  setTimeout(processarRecorrencias, 10000);
  console.log('🔄 Cron de recorrências Todo ativado (intervalo: 1h)');
} };
