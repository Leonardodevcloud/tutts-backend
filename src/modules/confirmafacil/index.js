'use strict';

const { initConfirmaFacilTables }   = require('./confirmafacil.migration');
const { createConfirmaFacilRouter } = require('./confirmafacil.routes');
const { getConfirmaFacilService }   = require('./confirmafacil.service');
const { getConfirmaFacilPoller }    = require('./confirmafacil.poller');

module.exports = {
  initConfirmaFacilTables,
  initConfirmaFacilRoutes: createConfirmaFacilRouter,
  getConfirmaFacilService,
  getConfirmaFacilPoller,
};
