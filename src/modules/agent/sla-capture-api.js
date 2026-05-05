/**
 * sla-capture-api.js
 * 
 * Thin wrapper sem dependências circulares.
 * Expõe apenas as funções necessárias de playwright-sla-capture
 * para módulos que não podem importar playwright-sla-capture diretamente
 * por causa do ciclo circular.
 *
 * Este módulo NÃO é importado por nenhum módulo que playwright-sla-capture
 * importa — portanto não cria ciclo.
 */
'use strict';

// Exporta funções que delegam para playwright-sla-capture.
// O require é feito aqui em tempo de módulo — este arquivo é carregado
// pelo index.js APÓS playwright-sla-capture já estar no cache completo.
module.exports = {
  get coletarOsEmExecucao() {
    return require('./playwright-sla-capture').coletarOsEmExecucao;
  },
  get garantirSessao() {
    return require('./playwright-sla-capture').garantirSessao;
  },
};
