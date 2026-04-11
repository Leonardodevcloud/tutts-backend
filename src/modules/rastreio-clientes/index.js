'use strict';
const { createRastreioClientesRouter } = require('./rastreio-clientes.routes');
const initRastreioClientesTables = require('./rastreio-clientes.migration');
module.exports = {
  initRastreioClientesRoutes: createRastreioClientesRouter,
  initRastreioClientesTables,
};
