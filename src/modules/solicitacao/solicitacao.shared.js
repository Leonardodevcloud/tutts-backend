/**
 * Solicitacao Shared - Auth middleware + validators
 */
const jwt = require('jsonwebtoken');

function createSolicitacaoHelpers(pool) {
  const JWT_SECRET = process.env.JWT_SECRET;

  const validarSenhaSimples = (senha) => {
    if (!senha || typeof senha !== 'string') {
      return { valido: false, erro: 'Senha é obrigatória' };
    }
    if (senha.length < 6) {
      return { valido: false, erro: 'Senha deve ter pelo menos 6 caracteres' };
    }
    return { valido: true };
  };

  const verificarTokenSolicitacao = async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.tipo !== 'solicitacao') return res.status(401).json({ error: 'Token inválido para solicitação' });
      const cliente = await pool.query('SELECT * FROM clientes_solicitacao WHERE id = $1', [decoded.id]);
      if (cliente.rows.length === 0 || !cliente.rows[0].ativo) return res.status(401).json({ error: 'Cliente inativo ou não encontrado' });
      req.clienteSolicitacao = cliente.rows[0];
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  };

  return { validarSenhaSimples, verificarTokenSolicitacao, JWT_SECRET };
}

module.exports = { createSolicitacaoHelpers };
