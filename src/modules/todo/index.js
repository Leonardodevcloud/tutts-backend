const { initTodoTables } = require('./todo.migration');
const { createTodoRouter, initTodoCron } = require('./todo.routes');
function initTodoRoutes(pool) { return createTodoRouter(pool); }
module.exports = { initTodoRoutes, initTodoTables, initTodoCron };
