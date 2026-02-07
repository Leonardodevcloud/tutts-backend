const { createSocialCoreRouter } = require('./routes/social.routes');
const { createLiderancaRouter } = require('./routes/lideranca.routes');

function initSocialRoutes(pool) {
  const socialRouter = createSocialCoreRouter(pool);
  const liderancaRouter = createLiderancaRouter(pool);
  return { socialRouter, liderancaRouter };
}

module.exports = initSocialRoutes;
