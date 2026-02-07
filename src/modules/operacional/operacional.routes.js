const express = require('express');
const { createAvisosRouter } = require('./routes/avisos.routes');
const { createIncentivosRouter } = require('./routes/incentivos.routes');
const { createOperacoesRouter } = require('./routes/operacoes.routes');

module.exports = { createAvisosRouter, createIncentivosRouter, createOperacoesRouter };
