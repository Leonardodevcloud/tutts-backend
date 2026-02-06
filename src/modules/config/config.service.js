/**
 * MÓDULO CONFIG - Service
 * Lógica pura: geração de tokens
 */

/**
 * Gerar token único para links de indicação (12 caracteres alfanuméricos)
 */
function gerarTokenIndicacao() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

module.exports = { gerarTokenIndicacao };
