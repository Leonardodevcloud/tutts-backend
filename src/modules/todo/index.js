const { initTodoTables } = require('./todo.migration');
const { createTodoRouter, initTodoCron } = require('./todo.routes');
function initTodoRoutes(pool, verificarToken) { return createTodoRouter(pool, verificarToken); }
module.exports = { initTodoRoutes, initTodoTables, initTodoCron };
