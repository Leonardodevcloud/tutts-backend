/**
 * src/shared/utils/validators.js
 * Funções de validação e sanitização de entrada
 */

const sanitizeString = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return str.trim().substring(0, maxLength).replace(/[<>]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
};

const sanitizeForSQL = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/['";\\]/g, '');
};

const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
};

const isValidCPF = (cpf) => {
  if (!cpf || typeof cpf !== 'string') return false;
  return cpf.replace(/\D/g, '').length === 11;
};

const isValidMoney = (value) => {
  if (value === null || value === undefined) return false;
  const num = parseFloat(value);
  return !isNaN(num) && num >= 0 && num <= 999999.99;
};

const isValidId = (id) => {
  const num = parseInt(id);
  return !isNaN(num) && num > 0 && num < 2147483647;
};

const isValidCodProfissional = (cod) => {
  if (!cod) return false;
  const str = String(cod).trim();
  return str.length >= 1 && str.length <= 20 && /^[a-zA-Z0-9_-]+$/.test(str);
};

// Middleware genérico de validação
const validarEntrada = (validacoes) => {
  return (req, res, next) => {
    const erros = [];

    for (const [campo, regras] of Object.entries(validacoes)) {
      const valor = req.body[campo] ?? req.params[campo] ?? req.query[campo];

      if (regras.required && (valor === undefined || valor === null || valor === '')) {
        erros.push(`${campo} é obrigatório`);
        continue;
      }

      if (valor !== undefined && valor !== null && valor !== '') {
        if (regras.type === 'string' && typeof valor !== 'string') erros.push(`${campo} deve ser texto`);
        if (regras.type === 'number' && isNaN(Number(valor))) erros.push(`${campo} deve ser número`);
        if (regras.minLength && String(valor).length < regras.minLength) erros.push(`${campo} deve ter pelo menos ${regras.minLength} caracteres`);
        if (regras.maxLength && String(valor).length > regras.maxLength) erros.push(`${campo} deve ter no máximo ${regras.maxLength} caracteres`);
        if (regras.pattern && !regras.pattern.test(String(valor))) erros.push(`${campo} tem formato inválido`);
        if (regras.isEmail && !isValidEmail(valor)) erros.push(`${campo} deve ser um email válido`);
        if (regras.isCPF && !isValidCPF(valor)) erros.push(`${campo} deve ser um CPF válido`);
        if (regras.isMoney && !isValidMoney(valor)) erros.push(`${campo} deve ser um valor monetário válido`);
        if (regras.isId && !isValidId(valor)) erros.push(`${campo} deve ser um ID válido`);
      }
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: 'Dados inválidos', detalhes: erros });
    }
    next();
  };
};

module.exports = {
  sanitizeString, sanitizeForSQL,
  isValidEmail, isValidCPF, isValidMoney, isValidId, isValidCodProfissional,
  validarEntrada,
};
