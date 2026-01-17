const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dns = require('dns');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto'); // Para 2FA TOTP
require('dotenv').config();

// Função para fazer requisições HTTP/HTTPS (substitui fetch)
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : require('http');
      
      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(options.headers || {})
        }
      };
      
      // Adicionar Content-Length se tiver body
      if (options.body) {
        requestOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      
      const req = httpModule.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const jsonData = data ? JSON.parse(data) : {};
            resolve({ 
              ok: res.statusCode >= 200 && res.statusCode < 300, 
              status: res.statusCode, 
              json: () => jsonData, 
              text: () => data 
            });
          } catch (e) {
            console.log('⚠️ httpRequest parse error:', e.message, 'data:', data.substring(0, 200));
            resolve({ 
              ok: false, 
              status: res.statusCode, 
              json: () => ({ error: 'Parse error', raw: data.substring(0, 500) }), 
              text: () => data 
            });
          }
        });
      });
      
      req.on('error', (err) => {
        console.log('❌ httpRequest error:', err.message);
        resolve({ 
          ok: false, 
          status: 0, 
          json: () => ({ error: err.message }), 
          text: () => err.message 
        });
      });
      
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ 
          ok: false, 
          status: 0, 
          json: () => ({ error: 'Timeout' }), 
          text: () => 'Timeout' 
        });
      });
      
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) {
      console.log('❌ httpRequest exception:', err.message);
      resolve({ 
        ok: false, 
        status: 0, 
        json: () => ({ error: err.message }), 
        text: () => err.message 
      });
    }
  });
}

// Forçar DNS para IPv4
dns.setDefaultResultOrder('ipv4first');

const app = express();
const port = process.env.PORT || 3001;

// ==================== SISTEMA DE LOGGING ESTRUTURADO ====================

// Níveis de log
const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  SECURITY: 'security'
};

// Configuração de logging
const LOG_CONFIG = {
  level: process.env.LOG_LEVEL || 'info',
  includeTimestamp: true,
  includeLevel: true,
  jsonFormat: process.env.NODE_ENV === 'production', // JSON em produção para melhor parsing
  colorize: process.env.NODE_ENV !== 'production'
};

// Cores para terminal (apenas em desenvolvimento)
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Mapear níveis para cores
const LEVEL_COLORS = {
  error: COLORS.red,
  warn: COLORS.yellow,
  info: COLORS.green,
  debug: COLORS.blue,
  security: COLORS.magenta
};

// Classe de Logger estruturado
class Logger {
  constructor(context = 'APP') {
    this.context = context;
  }
  
  _shouldLog(level) {
    const levels = ['error', 'warn', 'security', 'info', 'debug'];
    const configLevel = levels.indexOf(LOG_CONFIG.level);
    const msgLevel = levels.indexOf(level);
    return msgLevel <= configLevel;
  }
  
  _format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    
    if (LOG_CONFIG.jsonFormat) {
      // Formato JSON estruturado (para produção/ELK/Datadog)
      return JSON.stringify({
        timestamp,
        level,
        context: this.context,
        message,
        ...meta,
        // Não incluir dados sensíveis
        ...(meta.password && { password: '[REDACTED]' }),
        ...(meta.token && { token: '[REDACTED]' }),
        ...(meta.secret && { secret: '[REDACTED]' })
      });
    }
    
    // Formato legível (para desenvolvimento)
    const color = LOG_CONFIG.colorize ? (LEVEL_COLORS[level] || '') : '';
    const reset = LOG_CONFIG.colorize ? COLORS.reset : '';
    const levelStr = level.toUpperCase().padEnd(8);
    const contextStr = `[${this.context}]`.padEnd(15);
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    
    return `${timestamp} ${color}${levelStr}${reset} ${contextStr} ${message}${metaStr}`;
  }
  
  _log(level, message, meta = {}) {
    if (!this._shouldLog(level)) return;
    
    const formatted = this._format(level, message, meta);
    
    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }
  
  error(message, meta = {}) { this._log('error', message, meta); }
  warn(message, meta = {}) { this._log('warn', message, meta); }
  info(message, meta = {}) { this._log('info', message, meta); }
  debug(message, meta = {}) { this._log('debug', message, meta); }
  security(message, meta = {}) { this._log('security', message, meta); }
  
  // Logger para requests HTTP
  request(req, res, duration) {
    const meta = {
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.headers['x-forwarded-for'] || req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 100)
    };
    
    if (req.user) {
      meta.userId = req.user.id;
      meta.userCod = req.user.codProfissional;
    }
    
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    this._log(level, `${req.method} ${req.originalUrl || req.url} ${res.statusCode}`, meta);
  }
  
  // Logger para eventos de segurança
  securityEvent(event, details = {}) {
    this._log('security', `🔐 ${event}`, {
      event,
      ...details,
      timestamp: new Date().toISOString()
    });
  }
}

// Criar instâncias de logger para diferentes contextos
const logger = new Logger('SERVER');
const authLogger = new Logger('AUTH');
const dbLogger = new Logger('DATABASE');
const apiLogger = new Logger('API');
const securityLogger = new Logger('SECURITY');

// Middleware de logging de requests
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  // Log ao finalizar a resposta
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Não logar health checks em produção
    if (LOG_CONFIG.jsonFormat && (req.path === '/health' || req.path === '/api/health')) {
      return;
    }
    
    apiLogger.request(req, res, duration);
  });
  
  next();
};

// ==================== FIM SISTEMA DE LOGGING ====================

// ==================== CONFIGURAÇÕES DE SEGURANÇA EXPRESS ====================
// Trust proxy - necessário para Railway/Vercel/Heroku
// Permite que o Express confie nos headers X-Forwarded-* dos proxies
app.set('trust proxy', 1); // Confiar no primeiro proxy

// Desabilitar header X-Powered-By (não expor que é Express)
app.disable('x-powered-by');

// VERSÃO DO SERVIDOR - Para debug de deploy
const SERVER_VERSION = '2026-01-16-SECURITY-PATCH-V5';
app.get('/api/version', (req, res) => res.json({ version: SERVER_VERSION, timestamp: new Date().toISOString() }));

// ==================== TOKENS GLOBAIS TUTTS ====================
// CRÍTICO: Tokens devem ser definidos via variáveis de ambiente
const TUTTS_TOKENS = {
  GRAVAR: process.env.TUTTS_TOKEN_GRAVAR,
  STATUS: process.env.TUTTS_TOKEN_STATUS,
  PROFISSIONAIS: process.env.TUTTS_TOKEN_PROFISSIONAIS,
  CANCELAR: process.env.TUTTS_TOKEN_CANCELAR
};

// Validar tokens obrigatórios (warn, não bloqueia inicialização)
const tokensNaoConfigurados = Object.entries(TUTTS_TOKENS)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (tokensNaoConfigurados.length > 0) {
  console.warn('⚠️ ATENÇÃO: Os seguintes tokens Tutts NÃO estão configurados:');
  tokensNaoConfigurados.forEach(token => console.warn(`   - TUTTS_TOKEN_${token}`));
  console.warn('   Funcionalidades que dependem desses tokens não funcionarão!');
}

// Função para verificar se um token Tutts está disponível
const verificarTokenTutts = (tokenName) => {
  const token = TUTTS_TOKENS[tokenName];
  if (!token) {
    console.error(`❌ Token TUTTS_TOKEN_${tokenName} não configurado!`);
    return null;
  }
  return token;
};

// ==================== API KEY OPENROUTESERVICE (PROTEGIDA) ====================
const ORS_API_KEY = process.env.ORS_API_KEY;
if (!ORS_API_KEY) {
  console.warn('⚠️ ORS_API_KEY não configurada - Roteirizador não funcionará');
}

// ==================== CONFIGURAÇÕES DE SEGURANÇA ====================
// CRÍTICO: JWT_SECRET deve ser definido via variável de ambiente
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ERRO CRÍTICO: JWT_SECRET não está configurado!');
  console.error('Configure a variável de ambiente JWT_SECRET no servidor.');
  console.error('Use um valor forte e aleatório de pelo menos 32 caracteres.');
  process.exit(1);
}

// Configurações de tokens
const JWT_EXPIRES_IN = '1h';           // Access token: 1 hora (reduzido para segurança)
const REFRESH_TOKEN_EXPIRES_IN = '7d'; // Refresh token: 7 dias
const BCRYPT_ROUNDS = 10;

// Secret separado para refresh tokens (usa JWT_SECRET + sufixo)
const REFRESH_SECRET = JWT_SECRET + '_REFRESH';

// ==================== RATE LIMITING SEGURO ====================
// SEGURANÇA: Validar X-Forwarded-For para evitar bypass

// Função para extrair IP real de forma segura
const getClientIP = (req) => {
  // Railway/Vercel adicionam X-Forwarded-For automaticamente
  // Mas precisamos validar para evitar spoofing
  const forwardedFor = req.headers['x-forwarded-for'];
  
  if (forwardedFor) {
    // Pegar o primeiro IP (cliente original) - ignorar IPs internos
    const ips = forwardedFor.split(',').map(ip => ip.trim());
    // Filtrar IPs privados/internos que podem ser injetados
    const publicIP = ips.find(ip => {
      // Rejeitar IPs privados e localhost
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return false;
      if (ip.startsWith('127.') || ip === 'localhost' || ip === '::1') return false;
      return true;
    });
    if (publicIP) return publicIP;
  }
  
  // Fallback para req.ip (Railway/Express já processa corretamente)
  return req.ip || req.connection?.remoteAddress || 'unknown';
};

// Rate Limiters - configurados para funcionar com proxies
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // máximo 20 tentativas
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health' || req.path === '/api/health';
  },
  keyGenerator: (req) => getClientIP(req)
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 500, // máximo 500 requisições por minuto
  message: { error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health' || 
           req.path === '/api/health' ||
           req.path.startsWith('/api/score/') ||
           req.path.startsWith('/api/relatorios-diarios/');
  },
  keyGenerator: (req) => getClientIP(req)
});

const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10, // máximo 10 contas por hora por IP
  message: { error: 'Muitas contas criadas. Tente novamente em 1 hora.' },
  keyGenerator: (req) => getClientIP(req)
});

// Rate limiter específico para operações financeiras (mais restritivo)
const financialLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 30, // máximo 30 operações por minuto
  message: { error: 'Muitas operações financeiras. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Preferir ID do usuário autenticado (mais seguro que IP)
    if (req.user && req.user.id) {
      return `user_${req.user.id}`;
    }
    return getClientIP(req);
  }
});

// Rate limiter para criação de saques (muito restritivo)
const withdrawalCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // máximo 5 saques por hora por usuário
  message: { error: 'Limite de solicitações de saque atingido. Tente novamente em 1 hora.' },
  keyGenerator: (req) => {
    // SEMPRE usar codProfissional para saques (mais seguro)
    if (req.user && req.user.codProfissional) {
      return `withdrawal_${req.user.codProfissional}`;
    }
    return getClientIP(req);
  }
});

// Rate limiter para buscas/listagens pesadas (evitar DoS)
const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // máximo 60 buscas por minuto
  message: { error: 'Muitas buscas. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req)
});

// Rate limiter para uploads/operações pesadas
const heavyOperationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 10, // máximo 10 operações pesadas por 5 minutos
  message: { error: 'Muitas operações. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.user && req.user.id) {
      return `heavy_${req.user.id}`;
    }
    return getClientIP(req);
  }
});

// Rate limiter para exports/downloads
const exportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 20, // máximo 20 exports por 10 minutos
  message: { error: 'Muitos downloads. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.user && req.user.id) {
      return `export_${req.user.id}`;
    }
    return getClientIP(req);
  }
});

// ==================== MIDDLEWARES DE AUTENTICAÇÃO ====================

// Verificar token JWT
const verificarToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', expired: true });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// Verificar se é admin
const verificarAdmin = (req, res, next) => {
  if (!req.user || !['admin', 'admin_master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer permissão de administrador.' });
  }
  next();
};

// Verificar se é admin ou financeiro
const verificarAdminOuFinanceiro = (req, res, next) => {
  if (!req.user || !['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer permissão de admin ou financeiro.' });
  }
  next();
};

// Verificar se é o próprio usuário ou admin
const verificarProprioOuAdmin = (req, res, next) => {
  const userCod = req.params.cod_prof || req.params.userCod || req.body.user_cod;
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (['admin', 'admin_master'].includes(req.user.role) || req.user.codProfissional === userCod) {
    next();
  } else {
    return res.status(403).json({ error: 'Acesso negado' });
  }
};

// Middleware opcional de autenticação (não bloqueia, mas adiciona user se tiver token)
const verificarTokenOpcional = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // Token inválido, mas não bloqueia
    }
  }
  next();
};

// ==================== FUNÇÕES DE VALIDAÇÃO DE ENTRADA ====================

// Sanitizar string - remove caracteres perigosos
const sanitizeString = (str, maxLength = 255) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .substring(0, maxLength)
    .replace(/[<>]/g, '') // Remove < > para prevenir HTML injection
    .replace(/[\x00-\x1F\x7F]/g, ''); // Remove caracteres de controle
};

// Sanitizar para SQL (prevenir injection em casos especiais)
const sanitizeForSQL = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/['";\\]/g, '');
};

// Validar email
const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
};

// Validar CPF (formato)
const isValidCPF = (cpf) => {
  if (!cpf || typeof cpf !== 'string') return false;
  const cleaned = cpf.replace(/\D/g, '');
  return cleaned.length === 11;
};

// Validar valor monetário
const isValidMoney = (value) => {
  if (value === null || value === undefined) return false;
  const num = parseFloat(value);
  return !isNaN(num) && num >= 0 && num <= 999999.99;
};

// Validar ID numérico
const isValidId = (id) => {
  const num = parseInt(id);
  return !isNaN(num) && num > 0 && num < 2147483647;
};

// Validar código profissional
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
        if (regras.type === 'string' && typeof valor !== 'string') {
          erros.push(`${campo} deve ser texto`);
        }
        if (regras.type === 'number' && isNaN(Number(valor))) {
          erros.push(`${campo} deve ser número`);
        }
        if (regras.minLength && String(valor).length < regras.minLength) {
          erros.push(`${campo} deve ter pelo menos ${regras.minLength} caracteres`);
        }
        if (regras.maxLength && String(valor).length > regras.maxLength) {
          erros.push(`${campo} deve ter no máximo ${regras.maxLength} caracteres`);
        }
        if (regras.pattern && !regras.pattern.test(String(valor))) {
          erros.push(`${campo} tem formato inválido`);
        }
        if (regras.isEmail && !isValidEmail(valor)) {
          erros.push(`${campo} deve ser um email válido`);
        }
        if (regras.isCPF && !isValidCPF(valor)) {
          erros.push(`${campo} deve ser um CPF válido`);
        }
        if (regras.isMoney && !isValidMoney(valor)) {
          erros.push(`${campo} deve ser um valor monetário válido`);
        }
        if (regras.isId && !isValidId(valor)) {
          erros.push(`${campo} deve ser um ID válido`);
        }
      }
    }
    
    if (erros.length > 0) {
      return res.status(400).json({ error: 'Dados inválidos', detalhes: erros });
    }
    
    next();
  };
};

// ==================== FIM FUNÇÕES DE VALIDAÇÃO ====================

// ==================== VALIDAÇÃO DE SENHA FORTE ====================

// Requisitos de senha:
// - Mínimo 8 caracteres
// - Pelo menos 1 letra maiúscula
// - Pelo menos 1 letra minúscula  
// - Pelo menos 1 número
// NOTA: Para senhas de usuários comuns (motoboys), os requisitos são mais simples
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MIN_LENGTH_SIMPLE = 6; // Para reset de senha por admin

// Validar senha forte (para admins e novos cadastros)
const validarSenhaForte = (senha) => {
  if (!senha || typeof senha !== 'string') {
    return { valido: false, erro: 'Senha é obrigatória' };
  }
  
  if (senha.length < PASSWORD_MIN_LENGTH) {
    return { valido: false, erro: `Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` };
  }
  
  if (!/[a-z]/.test(senha)) {
    return { valido: false, erro: 'Senha deve conter pelo menos uma letra minúscula' };
  }
  
  if (!/[A-Z]/.test(senha)) {
    return { valido: false, erro: 'Senha deve conter pelo menos uma letra maiúscula' };
  }
  
  if (!/[0-9]/.test(senha)) {
    return { valido: false, erro: 'Senha deve conter pelo menos um número' };
  }
  
  // Verificar senhas muito comuns
  const senhasComuns = ['12345678', 'password', 'senha123', 'Senha123', 'Tutts123', 'Admin123'];
  if (senhasComuns.some(s => senha.toLowerCase() === s.toLowerCase())) {
    return { valido: false, erro: 'Senha muito comum. Escolha uma senha mais segura' };
  }
  
  return { valido: true };
};

// Validar senha simples (mínimo 6 caracteres, para casos específicos)
const validarSenhaSimples = (senha) => {
  if (!senha || typeof senha !== 'string') {
    return { valido: false, erro: 'Senha é obrigatória' };
  }
  
  if (senha.length < PASSWORD_MIN_LENGTH_SIMPLE) {
    return { valido: false, erro: `Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH_SIMPLE} caracteres` };
  }
  
  return { valido: true };
};

// ==================== FIM VALIDAÇÃO DE SENHA ====================

// ==================== CONTROLE DE BLOQUEIO DE CONTA ====================

// Configurações de bloqueio
const LOGIN_CONFIG = {
  MAX_ATTEMPTS: 5,           // Máximo de tentativas antes de bloquear
  BLOCK_DURATION_MINUTES: 15, // Duração do bloqueio em minutos
  ATTEMPT_WINDOW_MINUTES: 30  // Janela de tempo para contar tentativas
};

// Verificar se conta está bloqueada
const verificarContaBloqueada = async (codProfissional) => {
  try {
    const result = await pool.query(
      `SELECT * FROM blocked_accounts 
       WHERE LOWER(cod_profissional) = LOWER($1) 
       AND blocked_until > NOW()`,
      [codProfissional]
    );
    
    if (result.rows.length > 0) {
      const blocked = result.rows[0];
      const minutosRestantes = Math.ceil((new Date(blocked.blocked_until) - new Date()) / 60000);
      return {
        bloqueada: true,
        motivo: blocked.reason,
        tentativas: blocked.attempts_count,
        minutosRestantes,
        desbloqueioPrevisto: blocked.blocked_until
      };
    }
    
    return { bloqueada: false };
  } catch (error) {
    console.error('❌ Erro ao verificar bloqueio:', error.message);
    return { bloqueada: false }; // Em caso de erro, permitir (fail-open)
  }
};

// Registrar tentativa de login
const registrarTentativaLogin = async (codProfissional, ip, sucesso) => {
  try {
    // Registrar tentativa
    await pool.query(
      `INSERT INTO login_attempts (cod_profissional, ip_address, success) 
       VALUES ($1, $2, $3)`,
      [codProfissional.toLowerCase(), ip, sucesso]
    );
    
    // Se foi sucesso, remover bloqueio (se existir) e limpar tentativas
    if (sucesso) {
      await pool.query(
        `DELETE FROM blocked_accounts WHERE LOWER(cod_profissional) = LOWER($1)`,
        [codProfissional]
      );
      // Limpar tentativas antigas (manter só últimas 24h para auditoria)
      await pool.query(
        `DELETE FROM login_attempts 
         WHERE LOWER(cod_profissional) = LOWER($1) 
         AND created_at < NOW() - INTERVAL '24 hours'`,
        [codProfissional]
      );
      return { bloqueado: false };
    }
    
    // Contar tentativas falhas recentes
    const tentativas = await pool.query(
      `SELECT COUNT(*) as count FROM login_attempts 
       WHERE LOWER(cod_profissional) = LOWER($1) 
       AND success = false 
       AND created_at > NOW() - INTERVAL '${LOGIN_CONFIG.ATTEMPT_WINDOW_MINUTES} minutes'`,
      [codProfissional]
    );
    
    const numTentativas = parseInt(tentativas.rows[0].count);
    
    // Se excedeu limite, bloquear conta
    if (numTentativas >= LOGIN_CONFIG.MAX_ATTEMPTS) {
      const blockedUntil = new Date(Date.now() + LOGIN_CONFIG.BLOCK_DURATION_MINUTES * 60000);
      
      await pool.query(
        `INSERT INTO blocked_accounts (cod_profissional, blocked_until, attempts_count, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cod_profissional) 
         DO UPDATE SET blocked_until = $2, attempts_count = $3, reason = $4`,
        [
          codProfissional.toLowerCase(), 
          blockedUntil, 
          numTentativas,
          `Conta bloqueada após ${numTentativas} tentativas de login falhas`
        ]
      );
      
      securityLogger.securityEvent('ACCOUNT_BLOCKED', {
        codProfissional,
        blockedUntil: blockedUntil.toISOString(),
        attempts: numTentativas
      });
      
      return {
        bloqueado: true,
        tentativas: numTentativas,
        minutosRestantes: LOGIN_CONFIG.BLOCK_DURATION_MINUTES
      };
    }
    
    return {
      bloqueado: false,
      tentativas: numTentativas,
      tentativasRestantes: LOGIN_CONFIG.MAX_ATTEMPTS - numTentativas
    };
  } catch (error) {
    console.error('❌ Erro ao registrar tentativa:', error.message);
    return { bloqueado: false };
  }
};

// Limpar bloqueios expirados (executar periodicamente)
const limparBloqueiosExpirados = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM blocked_accounts WHERE blocked_until < NOW() RETURNING cod_profissional`
    );
    if (result.rows.length > 0) {
      console.log(`🔓 ${result.rows.length} bloqueio(s) expirado(s) removido(s)`);
    }
  } catch (error) {
    console.error('❌ Erro ao limpar bloqueios:', error.message);
  }
};

// Executar limpeza a cada 5 minutos
setInterval(limparBloqueiosExpirados, 5 * 60 * 1000);

// ==================== FIM CONTROLE DE BLOQUEIO ====================

// Função para gerar token JWT
const gerarToken = (user) => {
  return jwt.sign(
    { 
      id: user.id,
      codProfissional: user.cod_profissional,
      role: user.role,
      nome: user.full_name
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

// Função para hash de senha
const hashSenha = async (senha) => {
  return await bcrypt.hash(senha, BCRYPT_ROUNDS);
};

// Função para verificar senha
const verificarSenha = async (senha, hash) => {
  return await bcrypt.compare(senha, hash);
};

// ==================== FUNÇÕES DE REFRESH TOKEN ====================

// Gerar refresh token
const gerarRefreshToken = (user) => {
  return jwt.sign(
    { 
      id: user.id,
      codProfissional: user.cod_profissional,
      type: 'refresh'
    },
    REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
};

// Salvar refresh token no banco
const salvarRefreshToken = async (userId, refreshToken, req) => {
  try {
    // Hash do token para armazenar (não guardar token em texto plano)
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const ip = getClientIP(req);
    const deviceInfo = req.headers['user-agent']?.substring(0, 255) || 'Unknown';
    
    // Calcular expiração (7 dias)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    // Revogar tokens antigos do mesmo dispositivo (limitar a 5 sessões)
    const existingTokens = await pool.query(
      `SELECT id FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // Manter no máximo 5 sessões ativas
    if (existingTokens.rows.length >= 5) {
      const tokensToRevoke = existingTokens.rows.slice(4).map(t => t.id);
      if (tokensToRevoke.length > 0) {
        await pool.query(
          `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() 
           WHERE id = ANY($1)`,
          [tokensToRevoke]
        );
      }
    }
    
    // Salvar novo token
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokenHash, deviceInfo, ip, expiresAt]
    );
    
    return true;
  } catch (error) {
    console.error('❌ Erro ao salvar refresh token:', error.message);
    return false;
  }
};

// Validar refresh token
const validarRefreshToken = async (refreshToken, userId) => {
  try {
    // Verificar assinatura do token
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    
    if (decoded.type !== 'refresh' || decoded.id !== userId) {
      return { valido: false, erro: 'Token inválido' };
    }
    
    // Buscar tokens não revogados do usuário
    const result = await pool.query(
      `SELECT id, token_hash FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()`,
      [userId]
    );
    
    // Verificar se algum hash bate
    for (const row of result.rows) {
      const match = await bcrypt.compare(refreshToken, row.token_hash);
      if (match) {
        return { valido: true, tokenId: row.id };
      }
    }
    
    return { valido: false, erro: 'Token não encontrado ou revogado' };
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { valido: false, erro: 'Token expirado' };
    }
    return { valido: false, erro: 'Token inválido' };
  }
};

// Revogar refresh token específico
const revogarRefreshToken = async (tokenId) => {
  try {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE id = $1`,
      [tokenId]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao revogar token:', error.message);
    return false;
  }
};

// Revogar todos os refresh tokens de um usuário (logout de todas as sessões)
const revogarTodosTokens = async (userId) => {
  try {
    const result = await pool.query(
      `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() 
       WHERE user_id = $1 AND revoked = false
       RETURNING id`,
      [userId]
    );
    console.log(`🔒 ${result.rows.length} sessão(ões) revogada(s) para user_id: ${userId}`);
    return result.rows.length;
  } catch (error) {
    console.error('❌ Erro ao revogar tokens:', error.message);
    return 0;
  }
};

// Limpar refresh tokens expirados (executar periodicamente)
const limparRefreshTokensExpirados = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR (revoked = true AND revoked_at < NOW() - INTERVAL '7 days')`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 ${result.rowCount} refresh token(s) expirado(s) removido(s)`);
    }
  } catch (error) {
    console.error('❌ Erro ao limpar refresh tokens:', error.message);
  }
};

// Executar limpeza a cada hora
setInterval(limparRefreshTokensExpirados, 60 * 60 * 1000);

// ==================== FIM FUNÇÕES DE REFRESH TOKEN ====================

// ==================== FUNÇÕES DE 2FA (TOTP) ====================

// Configurações 2FA
const TOTP_CONFIG = {
  ISSUER: 'Tutts',
  ALGORITHM: 'SHA1',
  DIGITS: 6,
  PERIOD: 30, // segundos
  WINDOW: 1   // Aceita código anterior/próximo (tolerância)
};

// Chave para criptografar secrets no banco
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || JWT_SECRET.substring(0, 32).padEnd(32, '0');

// Criptografar secret para armazenar no banco
const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

// Descriptografar secret do banco
const decryptSecret = (encryptedData) => {
  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// Gerar secret aleatório para 2FA (Base32)
const generateTOTPSecret = () => {
  const buffer = crypto.randomBytes(20);
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < buffer.length; i++) {
    secret += base32Chars[buffer[i] % 32];
  }
  return secret;
};

// Converter Base32 para bytes
const base32ToBytes = (base32) => {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.toUpperCase()) {
    const val = base32Chars.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
};

// Gerar código TOTP
const generateTOTP = (secret, time = null) => {
  const counter = Math.floor((time || Date.now()) / 1000 / TOTP_CONFIG.PERIOD);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  
  const key = base32ToBytes(secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, TOTP_CONFIG.DIGITS);
  
  return code.toString().padStart(TOTP_CONFIG.DIGITS, '0');
};

// Verificar código TOTP (com janela de tolerância)
const verifyTOTP = (secret, code) => {
  const now = Date.now();
  
  for (let i = -TOTP_CONFIG.WINDOW; i <= TOTP_CONFIG.WINDOW; i++) {
    const time = now + (i * TOTP_CONFIG.PERIOD * 1000);
    const expectedCode = generateTOTP(secret, time);
    if (expectedCode === code) {
      return true;
    }
  }
  return false;
};

// Gerar URI para QR Code (compatível com Google Authenticator)
const generateTOTPUri = (secret, userEmail, userName) => {
  const label = encodeURIComponent(`${TOTP_CONFIG.ISSUER}:${userName || userEmail}`);
  const params = new URLSearchParams({
    secret: secret,
    issuer: TOTP_CONFIG.ISSUER,
    algorithm: TOTP_CONFIG.ALGORITHM,
    digits: TOTP_CONFIG.DIGITS.toString(),
    period: TOTP_CONFIG.PERIOD.toString()
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

// Gerar códigos de backup (8 códigos de 8 caracteres)
const generateBackupCodes = () => {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
  }
  return codes;
};

// Verificar código de backup
const verifyBackupCode = async (userId, code) => {
  try {
    const result = await pool.query(
      'SELECT backup_codes FROM user_2fa WHERE user_id = $1 AND enabled = true',
      [userId]
    );
    
    if (result.rows.length === 0) return { valid: false };
    
    const backupCodes = result.rows[0].backup_codes || [];
    const codeHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    
    const index = backupCodes.findIndex(bc => bc === codeHash);
    if (index === -1) return { valid: false };
    
    // Remover código usado
    backupCodes.splice(index, 1);
    await pool.query(
      'UPDATE user_2fa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
      [backupCodes, userId]
    );
    
    return { valid: true, codesRemaining: backupCodes.length };
  } catch (error) {
    console.error('❌ Erro ao verificar backup code:', error.message);
    return { valid: false };
  }
};

// Verificar se código já foi usado (prevenir replay attacks)
const isCodeUsed = async (userId, code) => {
  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    
    // Limpar códigos antigos (mais de 2 minutos)
    await pool.query(
      'DELETE FROM used_2fa_codes WHERE used_at < NOW() - INTERVAL \'2 minutes\''
    );
    
    // Verificar se código foi usado
    const result = await pool.query(
      'SELECT id FROM used_2fa_codes WHERE user_id = $1 AND code_hash = $2',
      [userId, codeHash]
    );
    
    if (result.rows.length > 0) return true;
    
    // Marcar como usado
    await pool.query(
      'INSERT INTO used_2fa_codes (user_id, code_hash) VALUES ($1, $2)',
      [userId, codeHash]
    );
    
    return false;
  } catch (error) {
    console.error('❌ Erro ao verificar código usado:', error.message);
    return false; // Fail-open para não bloquear usuário
  }
};

// Verificar se usuário tem 2FA habilitado
const has2FAEnabled = async (userId) => {
  try {
    const result = await pool.query(
      'SELECT enabled FROM user_2fa WHERE user_id = $1',
      [userId]
    );
    return result.rows.length > 0 && result.rows[0].enabled === true;
  } catch (error) {
    console.error('❌ Erro ao verificar 2FA:', error.message);
    return false;
  }
};

// Obter secret do usuário (descriptografado)
const getUserTOTPSecret = async (userId) => {
  try {
    const result = await pool.query(
      'SELECT secret_encrypted FROM user_2fa WHERE user_id = $1 AND enabled = true',
      [userId]
    );
    
    if (result.rows.length === 0) return null;
    return decryptSecret(result.rows[0].secret_encrypted);
  } catch (error) {
    console.error('❌ Erro ao obter secret 2FA:', error.message);
    return null;
  }
};

// ==================== FIM FUNÇÕES DE 2FA ====================

// ==================== FUNÇÃO DE AUDITORIA ====================

// Categorias de ações para auditoria
const AUDIT_CATEGORIES = {
  AUTH: 'auth',           // Login, logout, registro
  USER: 'user',           // Gestão de usuários
  FINANCIAL: 'financial', // Saques, gratuidades
  DATA: 'data',           // BI, importações, exclusões
  CONFIG: 'config',       // Configurações do sistema
  SCORE: 'score',         // Sistema de pontuação
  ADMIN: 'admin'          // Ações administrativas
};

// Função para registrar log de auditoria
const registrarAuditoria = async (req, action, category, resource = null, resourceId = null, details = null, status = 'success') => {
  try {
    const user = req.user || {};
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    await pool.query(`
      INSERT INTO audit_logs (user_id, user_cod, user_name, user_role, action, category, resource, resource_id, details, ip_address, user_agent, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      user.id || null,
      user.codProfissional || req.body?.codProfissional || 'anonymous',
      user.nome || req.body?.fullName || 'Anônimo',
      user.role || 'guest',
      action,
      category,
      resource,
      resourceId?.toString(),
      details ? JSON.stringify(details) : null,
      ip,
      userAgent,
      status
    ]);
  } catch (error) {
    console.error('❌ Erro ao registrar auditoria:', error.message);
    // Não propagar erro para não afetar a operação principal
  }
};

// ==================== FIM FUNÇÃO DE AUDITORIA ====================

// ==================== TRATAMENTO SEGURO DE ERROS ====================

// Função para log de erro (interno) e resposta genérica (externa)
// NUNCA expõe error.message para o cliente em produção
const handleError = (res, error, contexto, statusCode = 500) => {
  // Log interno completo (para debug)
  console.error(`❌ ${contexto}:`, error.message || error);
  
  // Em produção, mensagem genérica. Em dev, pode mostrar mais detalhes.
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
  
  const mensagemCliente = isProduction 
    ? 'Erro interno do servidor' 
    : `${contexto}: ${error.message || 'Erro desconhecido'}`;
  
  return res.status(statusCode).json({ 
    error: mensagemCliente,
    // Código de referência para suporte (pode ser usado para buscar nos logs)
    ref: Date.now().toString(36)
  });
};

// Mensagens de erro padrão por tipo de operação
const ERRO_MSGS = {
  CRIAR: 'Não foi possível criar o registro',
  ATUALIZAR: 'Não foi possível atualizar o registro',
  DELETAR: 'Não foi possível excluir o registro',
  BUSCAR: 'Não foi possível buscar os dados',
  AUTENTICAR: 'Erro na autenticação',
  VALIDAR: 'Dados inválidos',
  PERMISSAO: 'Permissão negada'
};

// ==================== FIM TRATAMENTO DE ERROS ====================

// ==================== FIM CONFIGURAÇÕES DE SEGURANÇA ====================

// Validar DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('❌ ERRO: DATABASE_URL não está configurada!');
  console.error('Configure a variável de ambiente DATABASE_URL no Render.');
  process.exit(1);
}

console.log('🔄 Conectando ao banco de dados...');
// SEGURANÇA: Não logar URL do banco (contém credenciais)

// Configuração do banco de dados
// NOTA SOBRE SSL: Neon/Railway/Supabase usam SSL por padrão
// rejectUnauthorized: false é necessário porque esses serviços usam certificados 
// que podem não estar na cadeia de confiança do Node.js
// Em um ambiente ideal, usaríamos o certificado CA do provedor
const sslConfig = {
  rejectUnauthorized: false,
  // Se você tiver o certificado CA do Neon, descomente abaixo:
  // ca: process.env.DATABASE_CA_CERT
};

// Log de segurança sobre SSL
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')) {
  console.log('🔐 Conexão SSL ativada para o banco de dados');
  if (sslConfig.rejectUnauthorized === false) {
    console.log('⚠️  SSL: rejectUnauthorized=false (padrão para Neon/Railway)');
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : sslConfig,
  // Configurações de pool para melhor performance e segurança
  max: 20, // máximo de conexões
  idleTimeoutMillis: 30000, // fechar conexões ociosas após 30s
  connectionTimeoutMillis: 10000, // timeout de conexão 10s
  // Segurança: não expor erros detalhados do banco
  application_name: 'tutts-backend'
});

// Testar conexão e criar tabelas
pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    dbLogger.error('Falha na conexão com banco de dados', { error: err.message });
  } else {
    dbLogger.info('Banco de dados conectado', { serverTime: res.rows[0].now });
    // Criar tabelas necessárias
    await createTables();
  }
});

// Função para criar todas as tabelas necessárias
async function createTables() {
  try {
    // Tabela de dados financeiros do usuário
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_financial_data (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        pix_tipo VARCHAR(20) DEFAULT 'cpf',
        terms_accepted BOOLEAN DEFAULT FALSE,
        terms_accepted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela user_financial_data verificada');
    
    // Adicionar coluna pix_tipo se não existir
    await pool.query(`
      ALTER TABLE user_financial_data ADD COLUMN IF NOT EXISTS pix_tipo VARCHAR(20) DEFAULT 'cpf'
    `).catch(() => {});

    // Tabela de logs de alterações financeiras
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_logs (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela financial_logs verificada');

    // Tabela de solicitações de saque
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        requested_amount DECIMAL(10,2) NOT NULL,
        fee_amount DECIMAL(10,2) DEFAULT 0,
        final_amount DECIMAL(10,2) NOT NULL,
        has_gratuity BOOLEAN DEFAULT FALSE,
        gratuity_id INTEGER,
        status VARCHAR(50) DEFAULT 'aguardando_aprovacao',
        admin_id INTEGER,
        admin_name VARCHAR(255),
        conciliacao_omie BOOLEAN DEFAULT FALSE,
        debito BOOLEAN DEFAULT FALSE,
        approved_at TIMESTAMP,
        saldo_status VARCHAR(20),
        reject_reason VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela withdrawal_requests verificada');

    // Garantir que a coluna admin_name existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255)`);
      console.log('✅ Coluna admin_name verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna reject_reason existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
      console.log('✅ Coluna reject_reason verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna debito_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS debito_at TIMESTAMP`);
      console.log('✅ Coluna debito_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna debito_plific_at existe (data do débito na Plific)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS debito_plific_at TIMESTAMP`);
      console.log('✅ Coluna debito_plific_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna approved_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
      console.log('✅ Coluna approved_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna saldo_status existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS saldo_status VARCHAR(20)`);
      console.log('✅ Coluna saldo_status verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna lancamento_at existe (migração) - data/hora da aprovação
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS lancamento_at TIMESTAMP`);
      console.log('✅ Coluna lancamento_at verificada');
      
      // Preencher retroativamente lancamento_at para registros aprovados que não têm essa data
      const resultado = await pool.query(`
        UPDATE withdrawal_requests 
        SET lancamento_at = COALESCE(approved_at, updated_at, created_at)
        WHERE status IN ('aprovado', 'aprovado_gratuidade') 
        AND lancamento_at IS NULL
      `);
      if (resultado.rowCount > 0) {
        console.log(`✅ lancamento_at preenchido retroativamente para ${resultado.rowCount} registros`);
      }
    } catch (e) {
      // Coluna já existe ou outro erro
      console.log('⚠️ Erro na migração lancamento_at:', e.message);
    }

    // ==================== ÍNDICES PARA PERFORMANCE ====================
    console.log('🔧 Criando índices de performance para withdrawal_requests...');
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_status ON withdrawal_requests(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_user_cod ON withdrawal_requests(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_created_at ON withdrawal_requests(created_at DESC)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_conciliacao ON withdrawal_requests(conciliacao_omie, debito)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_status_created ON withdrawal_requests(status, created_at DESC)`).catch(() => {});
    
    // Índices para gratuities
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gratuities_user_cod ON gratuities(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gratuities_status ON gratuities(status)`).catch(() => {});
    
    // Índices para restricted_professionals
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_restricted_user_cod ON restricted_professionals(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_restricted_status ON restricted_professionals(status)`).catch(() => {});
    
    console.log('✅ Índices de performance criados/verificados');
    // ==================== FIM ÍNDICES ====================

    // Garantir que a coluna endereco_completo existe na tabela solicitacao_favoritos
    try {
      await pool.query(`ALTER TABLE solicitacao_favoritos ADD COLUMN IF NOT EXISTS endereco_completo TEXT`);
      console.log('✅ Coluna endereco_completo verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Tabela de gratuidades
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gratuities (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        quantity INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        value DECIMAL(10,2) NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        expired_at TIMESTAMP
      )
    `);
    console.log('✅ Tabela gratuities verificada');
    
    // Migração: adicionar colunas user_name e created_by em gratuities
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

    // Tabela de profissionais restritos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS restricted_professionals (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        user_name VARCHAR(255),
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'ativo',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        removed_at TIMESTAMP,
        removed_reason TEXT
      )
    `);
    console.log('✅ Tabela restricted_professionals verificada');

    // Migração: adicionar colunas em restricted_professionals
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

    // Tabela de solicitações de recuperação de senha
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_recovery (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        new_password VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255)
      )
    `);
    console.log('✅ Tabela password_recovery verificada');

    // Tabela de promoções de indicação
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promocoes_indicacao (
        id SERIAL PRIMARY KEY,
        regiao VARCHAR(255) NOT NULL,
        valor_bonus DECIMAL(10,2) NOT NULL,
        detalhes TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_at TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela promocoes_indicacao verificada');

    // Migração: adicionar coluna detalhes se não existir
    try {
      await pool.query(`ALTER TABLE promocoes_indicacao ADD COLUMN IF NOT EXISTS detalhes TEXT`);
      console.log('✅ Coluna detalhes verificada');
    } catch (e) {
      // Coluna já existe
    }

    // Tabela de indicações dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS indicacoes (
        id SERIAL PRIMARY KEY,
        promocao_id INTEGER REFERENCES promocoes_indicacao(id),
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        indicado_nome VARCHAR(255) NOT NULL,
        indicado_cpf VARCHAR(14),
        indicado_contato VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        valor_bonus DECIMAL(10,2),
        regiao VARCHAR(255),
        motivo_rejeicao TEXT,
        credito_lancado BOOLEAN DEFAULT FALSE,
        lancado_por VARCHAR(255),
        lancado_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255),
        link_token VARCHAR(100)
      )
    `);
    console.log('✅ Tabela indicacoes verificada');

    // Nova tabela: Links de indicação (tokens únicos por usuário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS indicacao_links (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        token VARCHAR(100) UNIQUE NOT NULL,
        promocao_id INTEGER,
        regiao VARCHAR(255),
        valor_bonus DECIMAL(10,2),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela indicacao_links verificada');

    // Migração: adicionar colunas de promoção na tabela indicacao_links
    try {
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS promocao_id INTEGER`);
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS regiao VARCHAR(255)`);
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS valor_bonus DECIMAL(10,2)`);
    } catch (e) {}

    // Migração: adicionar coluna link_token se não existir
    try {
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS link_token VARCHAR(100)`);
    } catch (e) {}

    // Migração: adicionar colunas de crédito lançado se não existirem
    try {
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS credito_lancado BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS lancado_por VARCHAR(255)`);
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS lancado_at TIMESTAMP`);
      console.log('✅ Colunas de crédito verificadas');
    } catch (e) {
      // Colunas já existem
    }

    // Tabela de promoções para novatos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promocoes_novatos (
        id SERIAL PRIMARY KEY,
        regiao VARCHAR(255) NOT NULL,
        cliente VARCHAR(255) NOT NULL,
        valor_bonus DECIMAL(10,2) NOT NULL,
        detalhes TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_at TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela promocoes_novatos verificada');

    // Tabela de inscrições dos novatos nas promoções
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inscricoes_novatos (
        id SERIAL PRIMARY KEY,
        promocao_id INTEGER REFERENCES promocoes_novatos(id),
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        valor_bonus DECIMAL(10,2),
        regiao VARCHAR(255),
        cliente VARCHAR(255),
        motivo_rejeicao TEXT,
        credito_lancado BOOLEAN DEFAULT FALSE,
        lancado_por VARCHAR(255),
        lancado_at TIMESTAMP,
        debito BOOLEAN DEFAULT FALSE,
        debitado_por VARCHAR(255),
        debitado_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255)
      )
    `);
    console.log('✅ Tabela inscricoes_novatos verificada');

    // Migração: adicionar colunas de débito se não existirem
    try {
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debito BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_por VARCHAR(255)`);
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_at TIMESTAMP`);
      console.log('✅ Colunas de débito verificadas');
    } catch (e) {
      // Colunas já existem
    }

    // Tabela de configuração do Quiz de Procedimentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_procedimentos_config (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(500) DEFAULT 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagem1 TEXT,
        imagem2 TEXT,
        imagem3 TEXT,
        imagem4 TEXT,
        pergunta1 TEXT,
        resposta1 BOOLEAN,
        pergunta2 TEXT,
        resposta2 BOOLEAN,
        pergunta3 TEXT,
        resposta3 BOOLEAN,
        pergunta4 TEXT,
        resposta4 BOOLEAN,
        pergunta5 TEXT,
        resposta5 BOOLEAN,
        valor_gratuidade DECIMAL(10,2) DEFAULT 500.00,
        ativo BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela quiz_procedimentos_config verificada');

    // Tabela de respostas do quiz (para controlar quem já respondeu)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_procedimentos_respostas (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL UNIQUE,
        user_name VARCHAR(255),
        acertos INTEGER,
        passou BOOLEAN,
        gratuidade_criada BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela quiz_procedimentos_respostas verificada');

    // Tabela de Horários de Atendimento
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horarios_atendimento (
        id SERIAL PRIMARY KEY,
        dia_semana INT NOT NULL, -- 0=Domingo, 1=Segunda... 6=Sábado
        hora_inicio TIME,
        hora_fim TIME,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela horarios_atendimento verificada');

    // Tabela de Horários Especiais (feriados, datas específicas)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horarios_especiais (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL UNIQUE,
        descricao VARCHAR(255),
        hora_inicio TIME,
        hora_fim TIME,
        fechado BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela horarios_especiais verificada');

    // Tabela de Avisos do Financeiro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos_financeiro (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(255) NOT NULL,
        mensagem TEXT NOT NULL,
        tipo VARCHAR(50) DEFAULT 'info', -- info, warning, error, success
        ativo BOOLEAN DEFAULT true,
        exibir_fora_horario BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela avisos_financeiro verificada');

    // Inserir horários padrão se tabela estiver vazia
    const horariosExistentes = await pool.query('SELECT COUNT(*) FROM horarios_atendimento');
    if (parseInt(horariosExistentes.rows[0].count) === 0) {
      // Segunda a Sexta: 09:00 às 18:00
      for (let dia = 1; dia <= 5; dia++) {
        await pool.query(
          'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
          [dia, '09:00', '18:00', true]
        );
      }
      // Sábado: 08:00 às 12:00
      await pool.query(
        'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
        [6, '08:00', '12:00', true]
      );
      // Domingo: Fechado
      await pool.query(
        'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
        [0, null, null, false]
      );
      console.log('✅ Horários padrão inseridos');
    }

    // ============================================
    // TABELAS DE DISPONIBILIDADE
    // ============================================
    
    // Tabela de Regiões de Disponibilidade
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_regioes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        gestores VARCHAR(255),
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar coluna gestores se não existir
    await pool.query(`ALTER TABLE disponibilidade_regioes ADD COLUMN IF NOT EXISTS gestores VARCHAR(255)`).catch(() => {});
    console.log('✅ Tabela disponibilidade_regioes verificada');

    // Tabela de Lojas de Disponibilidade
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_lojas (
        id SERIAL PRIMARY KEY,
        regiao_id INT NOT NULL REFERENCES disponibilidade_regioes(id) ON DELETE CASCADE,
        codigo VARCHAR(20) NOT NULL,
        nome VARCHAR(200) NOT NULL,
        qtd_titulares INT DEFAULT 0,
        qtd_excedentes INT DEFAULT 0,
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar colunas se não existirem
    await pool.query(`ALTER TABLE disponibilidade_lojas ADD COLUMN IF NOT EXISTS qtd_titulares INT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_lojas ADD COLUMN IF NOT EXISTS qtd_excedentes INT DEFAULT 0`).catch(() => {});
    console.log('✅ Tabela disponibilidade_lojas verificada');

    // Tabela de Linhas de Disponibilidade (Entregadores)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_linhas (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        status VARCHAR(20) DEFAULT 'A CONFIRMAR',
        observacao TEXT,
        is_excedente BOOLEAN DEFAULT FALSE,
        is_reposicao BOOLEAN DEFAULT FALSE,
        observacao_criada_por VARCHAR(200),
        observacao_criada_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar colunas se não existirem
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_excedente BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_reposicao BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS observacao_criada_por VARCHAR(200)`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS observacao_criada_em TIMESTAMP`).catch(() => {});
    console.log('✅ Tabela disponibilidade_linhas verificada');
    
    // Tabela de Histórico de Observações (persiste após reset)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_observacoes_historico (
        id SERIAL PRIMARY KEY,
        linha_id INT,
        loja_id INT,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        observacao TEXT NOT NULL,
        criada_por VARCHAR(200),
        criada_em TIMESTAMP,
        data_reset DATE,
        data_planilha DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_obs_hist_data ON disponibilidade_observacoes_historico(data_reset)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_obs_hist_cod ON disponibilidade_observacoes_historico(cod_profissional)`).catch(() => {});
    console.log('✅ Tabela disponibilidade_observacoes_historico verificada');

    // Tabela de Faltosos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_faltosos (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        motivo TEXT NOT NULL,
        data_falta DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_faltosos verificada');

    // Tabela de EM LOJA (registro diário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_em_loja (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        data_registro DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_em_loja verificada');

    // Tabela de SEM CONTATO (com tracking de dias consecutivos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_sem_contato (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        data_registro DATE DEFAULT CURRENT_DATE,
        dias_consecutivos INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_sem_contato verificada');

    // Tabela de Espelho (histórico diário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_espelho (
        id SERIAL PRIMARY KEY,
        data_registro DATE DEFAULT CURRENT_DATE,
        dados JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_espelho verificada');

    // Tabela de Restrições de Motoboys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_restricoes (
        id SERIAL PRIMARY KEY,
        cod_profissional VARCHAR(50) NOT NULL,
        nome_profissional VARCHAR(200),
        loja_id INT REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        todas_lojas BOOLEAN DEFAULT false,
        motivo TEXT NOT NULL,
        ativo BOOLEAN DEFAULT true,
        criado_por VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_restricoes verificada');

    // Índices para performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_lojas_regiao ON disponibilidade_lojas(regiao_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_loja ON disponibilidade_linhas(loja_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_cod ON disponibilidade_linhas(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_espelho_data ON disponibilidade_espelho(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_faltosos_data ON disponibilidade_faltosos(data_falta)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_em_loja_data ON disponibilidade_em_loja(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_sem_contato_data ON disponibilidade_sem_contato(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_sem_contato_cod ON disponibilidade_sem_contato(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_restricoes_cod ON disponibilidade_restricoes(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_restricoes_loja ON disponibilidade_restricoes(loja_id)`).catch(() => {});

    // ============================================
    // TABELAS DE RECRUTAMENTO
    // ============================================

    // Tabela de necessidades de recrutamento
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recrutamento_necessidades (
        id SERIAL PRIMARY KEY,
        nome_cliente VARCHAR(255) NOT NULL,
        data_conclusao DATE NOT NULL,
        quantidade_motos INTEGER NOT NULL DEFAULT 1,
        quantidade_backup INTEGER NOT NULL DEFAULT 0,
        observacao TEXT,
        status VARCHAR(50) DEFAULT 'em_andamento',
        criado_por VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela recrutamento_necessidades verificada');

    // Tabela de motos atribuídas ao recrutamento
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recrutamento_atribuicoes (
        id SERIAL PRIMARY KEY,
        necessidade_id INTEGER REFERENCES recrutamento_necessidades(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL DEFAULT 'titular',
        cod_profissional VARCHAR(50) NOT NULL,
        nome_profissional VARCHAR(200),
        atribuido_por VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela recrutamento_atribuicoes verificada');

    // Índices para recrutamento
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_necessidade_status ON recrutamento_necessidades(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_atribuicoes_necessidade ON recrutamento_atribuicoes(necessidade_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_atribuicoes_cod ON recrutamento_atribuicoes(cod_profissional)`).catch(() => {});

    // ============================================
    // TABELAS DA LOJA
    // ============================================

    // Tabela de estoque da loja
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_estoque (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        marca VARCHAR(255),
        valor DECIMAL(10,2) NOT NULL,
        quantidade INTEGER DEFAULT 0,
        tem_tamanho BOOLEAN DEFAULT FALSE,
        imagem_url TEXT,
        status VARCHAR(20) DEFAULT 'ativo',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_estoque verificada');

    // Tabela de tamanhos do estoque
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_estoque_tamanhos (
        id SERIAL PRIMARY KEY,
        estoque_id INTEGER REFERENCES loja_estoque(id) ON DELETE CASCADE,
        tamanho VARCHAR(20) NOT NULL,
        quantidade INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_estoque_tamanhos verificada');

    // Tabela de movimentações de estoque (entradas e saídas)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_estoque_movimentacoes (
        id SERIAL PRIMARY KEY,
        estoque_id INTEGER REFERENCES loja_estoque(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL,
        quantidade INTEGER NOT NULL,
        tamanho VARCHAR(20),
        motivo TEXT,
        pedido_id INTEGER REFERENCES loja_pedidos(id),
        user_name VARCHAR(255),
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_estoque_movimentacoes verificada');

    // Tabela de produtos à venda
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_produtos (
        id SERIAL PRIMARY KEY,
        estoque_id INTEGER REFERENCES loja_estoque(id),
        nome VARCHAR(255) NOT NULL,
        descricao TEXT,
        marca VARCHAR(255),
        valor DECIMAL(10,2) NOT NULL,
        imagem_url TEXT,
        parcelas_config JSONB DEFAULT '[]',
        abatimento_avista DECIMAL(5,2) DEFAULT 0,
        abatimento_2semanas DECIMAL(5,2) DEFAULT 0,
        abatimento_3semanas DECIMAL(5,2) DEFAULT 0,
        abatimento_4semanas DECIMAL(5,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'ativo',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_produtos verificada');

    // Migração: adicionar coluna parcelas_config se não existir
    try {
      await pool.query(`ALTER TABLE loja_produtos ADD COLUMN IF NOT EXISTS parcelas_config JSONB DEFAULT '[]'`);
      console.log('✅ Coluna parcelas_config verificada');
    } catch (e) {}

    // Tabela de pedidos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_pedidos (
        id SERIAL PRIMARY KEY,
        produto_id INTEGER REFERENCES loja_produtos(id),
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        produto_nome VARCHAR(255) NOT NULL,
        tamanho VARCHAR(20),
        marca VARCHAR(255),
        valor_original DECIMAL(10,2) NOT NULL,
        tipo_abatimento VARCHAR(50) NOT NULL,
        valor_abatimento DECIMAL(10,2) DEFAULT 0,
        valor_final DECIMAL(10,2) NOT NULL,
        parcelas INTEGER DEFAULT 1,
        valor_parcela DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'pendente',
        admin_id VARCHAR(255),
        admin_name VARCHAR(255),
        observacao TEXT,
        debito_lancado BOOLEAN DEFAULT FALSE,
        debito_lancado_em TIMESTAMP,
        debito_lancado_por VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_pedidos verificada');
    
    // Adicionar colunas que podem não existir
    await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado_em TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado_por VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE loja_estoque ADD COLUMN IF NOT EXISTS tipo_tamanho VARCHAR(20) DEFAULT 'letras'`).catch(() => {});

    // Tabela de sugestões de produtos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loja_sugestoes (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        sugestao TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        resposta TEXT,
        respondido_por VARCHAR(255),
        respondido_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela loja_sugestoes verificada');

    // ========== MÓDULO BI ==========
    
    // Tabela de configuração de prazos por cliente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazos_cliente (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL, -- 'cliente' ou 'centro_custo'
        codigo VARCHAR(100) NOT NULL, -- Cód. cliente ou nome do centro de custo
        nome VARCHAR(255), -- Nome para exibição
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tipo, codigo)
      )
    `);
    console.log('✅ Tabela bi_prazos_cliente verificada');

    // Tabela de faixas de prazo por cliente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_faixas_prazo (
        id SERIAL PRIMARY KEY,
        prazo_cliente_id INTEGER REFERENCES bi_prazos_cliente(id) ON DELETE CASCADE,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2), -- NULL significa infinito
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_faixas_prazo verificada');

    // Tabela de prazo padrão (para clientes não configurados)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazo_padrao (
        id SERIAL PRIMARY KEY,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_prazo_padrao verificada');

    // ========== TABELAS PARA PRAZO PROFISSIONAL ==========
    
    // Tabela de prazos profissionais por cliente/centro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazos_prof_cliente (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL, -- 'cliente' ou 'centro_custo'
        codigo VARCHAR(100) NOT NULL,
        nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tipo, codigo)
      )
    `);
    console.log('✅ Tabela bi_prazos_prof_cliente verificada');

    // Faixas de km para prazo profissional por cliente/centro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_faixas_prazo_prof (
        id SERIAL PRIMARY KEY,
        prazo_prof_cliente_id INTEGER REFERENCES bi_prazos_prof_cliente(id) ON DELETE CASCADE,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_faixas_prazo_prof verificada');

    // Prazo profissional padrão
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazo_prof_padrao (
        id SERIAL PRIMARY KEY,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_prazo_prof_padrao verificada');

    // Tabela de entregas (dados importados do Excel)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_entregas (
        id SERIAL PRIMARY KEY,
        os INTEGER NOT NULL,
        ponto INTEGER DEFAULT 1,
        num_pedido VARCHAR(100),
        cod_cliente INTEGER,
        nome_cliente VARCHAR(255),
        empresa VARCHAR(255),
        nome_fantasia VARCHAR(255),
        centro_custo VARCHAR(255),
        cidade_p1 VARCHAR(100),
        endereco TEXT,
        bairro VARCHAR(100),
        cidade VARCHAR(100),
        estado VARCHAR(10),
        cod_prof INTEGER,
        nome_prof VARCHAR(255),
        data_hora TIMESTAMP,
        data_hora_alocado TIMESTAMP,
        data_solicitado DATE,
        hora_solicitado TIME,
        data_chegada DATE,
        hora_chegada TIME,
        data_saida DATE,
        hora_saida TIME,
        categoria VARCHAR(100),
        valor DECIMAL(10,2),
        distancia DECIMAL(10,2),
        valor_prof DECIMAL(10,2),
        finalizado TIMESTAMP,
        execucao_comp VARCHAR(20),
        execucao_espera VARCHAR(20),
        status VARCHAR(50),
        motivo VARCHAR(50),
        ocorrencia VARCHAR(100),
        velocidade_media DECIMAL(10,2),
        data_upload DATE DEFAULT CURRENT_DATE,
        dentro_prazo BOOLEAN,
        prazo_minutos INTEGER,
        tempo_execucao_minutos INTEGER,
        dentro_prazo_prof BOOLEAN,
        prazo_prof_minutos INTEGER,
        tempo_execucao_prof_minutos INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_entregas verificada');

    // Migration: Adicionar coluna ponto se não existir
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS ponto INTEGER DEFAULT 1`).catch(() => {});
    
    // Migration: Adicionar colunas de prazo profissional
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS dentro_prazo_prof BOOLEAN`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS prazo_prof_minutos INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS tempo_execucao_prof_minutos INTEGER`).catch(() => {});
    
    // Migration: Aumentar tamanho de campos VARCHAR que podem ser pequenos demais
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN estado TYPE VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN status TYPE VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN motivo TYPE VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN ocorrencia TYPE VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN execucao_comp TYPE VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN execucao_espera TYPE VARCHAR(50)`).catch(() => {});
    
    // Índices do BI
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_data ON bi_entregas(data_solicitado)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_cliente ON bi_entregas(cod_cliente)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_centro ON bi_entregas(centro_custo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_prof ON bi_entregas(cod_prof)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_prazo ON bi_entregas(dentro_prazo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_os_ponto ON bi_entregas(os, ponto)`).catch(() => {});
    // Índice UNIQUE para UPSERT (ON CONFLICT)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bi_entregas_os_ponto_unique ON bi_entregas(os, ponto)`).catch(() => {});
    
    // Migration: Adicionar coluna tempo_entrega_prof_minutos para T. Entrega Prof
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS tempo_entrega_prof_minutos INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS dentro_prazo_prof BOOLEAN`).catch(() => {});

    // Tabela de histórico de uploads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_upload_historico (
        id SERIAL PRIMARY KEY,
        usuario_id VARCHAR(100),
        usuario_nome VARCHAR(255),
        nome_arquivo VARCHAR(500),
        total_linhas INTEGER,
        linhas_inseridas INTEGER,
        linhas_ignoradas INTEGER,
        os_novas INTEGER,
        os_ignoradas INTEGER,
        data_upload TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_upload_historico verificada');

    // Tabela de histórico de relatórios IA
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_relatorios_ia (
        id SERIAL PRIMARY KEY,
        usuario_id VARCHAR(100),
        usuario_nome VARCHAR(255),
        cod_cliente INTEGER,
        nome_cliente VARCHAR(255),
        centro_custo VARCHAR(255),
        tipo_analise VARCHAR(500),
        data_inicio DATE,
        data_fim DATE,
        metricas JSONB,
        relatorio TEXT,
        filtros JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_relatorios_ia verificada');


    // Colunas de coordenadas para mapa de calor
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_coords ON bi_entregas(latitude, longitude) WHERE latitude IS NOT NULL`).catch(() => {});
    console.log('✅ Colunas latitude/longitude verificadas');

    // ============================================
    // TABELAS DE RESUMO PRÉ-CALCULADAS (OTIMIZAÇÃO)
    // ============================================
    
    // Resumo diário geral
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_diario (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL UNIQUE,
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        total_retornos INTEGER DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        ticket_medio DECIMAL(10,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        tempo_medio_alocacao DECIMAL(8,2) DEFAULT 0,
        tempo_medio_coleta DECIMAL(8,2) DEFAULT 0,
        total_profissionais INTEGER DEFAULT 0,
        media_ent_profissional DECIMAL(8,2) DEFAULT 0,
        km_total DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_resumo_diario verificada');
    
    // Resumo por cliente (por dia)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_cliente (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL,
        cod_cliente INTEGER NOT NULL,
        nome_fantasia VARCHAR(255),
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        total_retornos INTEGER DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        ticket_medio DECIMAL(10,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        total_profissionais INTEGER DEFAULT 0,
        media_ent_profissional DECIMAL(8,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(data, cod_cliente)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_cliente_data ON bi_resumo_cliente(data)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_cliente_cod ON bi_resumo_cliente(cod_cliente)`).catch(() => {});
    console.log('✅ Tabela bi_resumo_cliente verificada');
    
    // Resumo por profissional (por dia)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_profissional (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL,
        cod_prof INTEGER NOT NULL,
        nome_prof VARCHAR(255),
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        km_total DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(data, cod_prof)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_prof_data ON bi_resumo_profissional(data)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_prof_cod ON bi_resumo_profissional(cod_prof)`).catch(() => {});
    console.log('✅ Tabela bi_resumo_profissional verificada');
    
    // Resumo geral (métricas totais - atualizado a cada upload)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_geral (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50) NOT NULL UNIQUE,
        valor_json JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_resumo_geral verificada');

    // Índices da loja
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_estoque_status ON loja_estoque(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_produtos_status ON loja_produtos(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_pedidos_user ON loja_pedidos(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_pedidos_status ON loja_pedidos(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_sugestoes_status ON loja_sugestoes(status)`).catch(() => {});

    // ============================================
    // TABELAS TO-DO
    // ============================================
    
    // Tabela de Grupos de TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_grupos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        descricao TEXT,
        icone VARCHAR(50) DEFAULT '📋',
        cor VARCHAR(20) DEFAULT '#7c3aed',
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        visivel_para JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_grupos verificada');

    // Tabela principal de Tarefas TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_tarefas (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        descricao TEXT,
        status VARCHAR(30) DEFAULT 'pendente',
        prioridade VARCHAR(20) DEFAULT 'media',
        data_prazo TIMESTAMP,
        data_conclusao TIMESTAMP,
        recorrente BOOLEAN DEFAULT FALSE,
        tipo_recorrencia VARCHAR(20),
        intervalo_recorrencia INT DEFAULT 1,
        proxima_recorrencia TIMESTAMP,
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        criado_por_foto TEXT,
        responsaveis JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        concluido_por VARCHAR(50),
        concluido_por_nome VARCHAR(255)
      )
    `);
    // Adicionar colunas se não existirem
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS criado_por_foto TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS intervalo_recorrencia INT DEFAULT 1`).catch(() => {});
    console.log('✅ Tabela todo_tarefas verificada');

    // Tabela de Anexos das Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_anexos (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        nome_arquivo VARCHAR(500) NOT NULL,
        tipo_arquivo VARCHAR(100),
        tamanho INT,
        url TEXT NOT NULL,
        enviado_por VARCHAR(50),
        enviado_por_nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_anexos verificada');

    // Tabela de Comentários nas Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_comentarios (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_comentarios verificada');

    // Tabela de Histórico/Log de Ações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_historico (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        acao VARCHAR(100) NOT NULL,
        descricao TEXT,
        user_cod VARCHAR(50),
        user_name VARCHAR(255),
        dados_anteriores JSONB,
        dados_novos JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_historico verificada');

    // Índices do TO-DO
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_grupo ON todo_tarefas(grupo_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_status ON todo_tarefas(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_criador ON todo_tarefas(criado_por)`).catch(() => {});

    // ============================================
    // NOVAS TABELAS TO-DO - MELHORIAS
    // ============================================

    // Tabela de Subtarefas/Checklist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_subtarefas (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        concluida BOOLEAN DEFAULT FALSE,
        ordem INT DEFAULT 0,
        concluida_por VARCHAR(50),
        concluida_por_nome VARCHAR(255),
        concluida_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_subtarefas verificada');

    // Tabela de Time Tracking (registro de tempo)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_time_tracking (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        inicio TIMESTAMP NOT NULL,
        fim TIMESTAMP,
        duracao_segundos INT,
        descricao TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_time_tracking verificada');

    // Tabela de Dependências entre Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_dependencias (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        depende_de INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        tipo VARCHAR(30) DEFAULT 'finish_to_start',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tarefa_id, depende_de)
      )
    `);
    console.log('✅ Tabela todo_dependencias verificada');

    // Tabela de Templates de Tarefas Recorrentes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_templates (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE SET NULL,
        nome VARCHAR(255) NOT NULL,
        titulo_tarefa VARCHAR(500) NOT NULL,
        descricao TEXT,
        prioridade VARCHAR(20) DEFAULT 'media',
        checklist JSONB DEFAULT '[]',
        tempo_estimado_minutos INT,
        criado_por VARCHAR(50),
        criado_por_nome VARCHAR(255),
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_templates verificada');

    // Migração: adicionar novas colunas na tabela todo_tarefas
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS coluna_kanban VARCHAR(30) DEFAULT 'todo'`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_estimado_minutos INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_gasto_segundos INT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_ativo BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_inicio TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_user_cod VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS template_id INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS cor VARCHAR(20)`).catch(() => {});
    console.log('✅ Colunas adicionais todo_tarefas verificadas');

    // Índices adicionais
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_tarefa ON todo_subtarefas(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_time_tarefa ON todo_time_tracking(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_kanban ON todo_tarefas(coluna_kanban)`).catch(() => {});

    // ============================================
    // TABELA DE PERMISSÕES DE ADMIN
    // ============================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_permissions (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL UNIQUE,
        user_name VARCHAR(255),
        modules JSONB DEFAULT '[]',
        tabs JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela admin_permissions verificada');

    // Adicionar coluna modules e tabs à tabela users (para admins)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_modules JSONB DEFAULT '[]'`).catch(() => {});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_tabs JSONB DEFAULT '{}'`).catch(() => {});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
    console.log('✅ Colunas de permissões adicionadas à tabela users');
    
    // ===== SISTEMA DE SETORES =====
    // Tabela de setores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS setores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        descricao TEXT,
        cor VARCHAR(20) DEFAULT '#6366f1',
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela setores criada');
    
    // Adicionar coluna setor_id na tabela users
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS setor_id INTEGER REFERENCES setores(id)`).catch(() => {});
    console.log('✅ Coluna setor_id adicionada à tabela users');
    
    // Adicionar coluna setores_destino na tabela relatorios_diarios
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS setores_destino INTEGER[] DEFAULT '{}'`).catch(() => {});
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS para_todos BOOLEAN DEFAULT true`).catch(() => {});
    console.log('✅ Colunas setores_destino e para_todos adicionadas à tabela relatorios_diarios');

    // ==================== MÓDULO SOCIAL ====================
    // Tabela de perfis sociais (foto e nome de exibição)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_profiles (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        profile_photo TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_profiles verificada/criada');

    // Tabela de status online dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_status (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_status verificada/criada');

    // Tabela de mensagens e reações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_messages (
        id SERIAL PRIMARY KEY,
        from_user_cod VARCHAR(50) NOT NULL,
        from_user_name VARCHAR(255),
        to_user_cod VARCHAR(50) NOT NULL,
        message_type VARCHAR(20) DEFAULT 'message',
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_messages verificada/criada');
    
    // ==================== MENSAGENS DA LIDERANÇA ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_mensagens (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(255) NOT NULL,
        conteudo TEXT NOT NULL,
        tipo_conteudo VARCHAR(50) DEFAULT 'texto',
        midia_url TEXT,
        midia_tipo VARCHAR(50),
        criado_por_cod VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        criado_por_foto TEXT,
        recorrente BOOLEAN DEFAULT false,
        tipo_recorrencia VARCHAR(50),
        intervalo_recorrencia INT DEFAULT 1,
        proxima_exibicao TIMESTAMP,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela lideranca_mensagens verificada/criada');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_visualizacoes (
        id SERIAL PRIMARY KEY,
        mensagem_id INT REFERENCES lideranca_mensagens(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_nome VARCHAR(255),
        user_foto TEXT,
        visualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mensagem_id, user_cod)
      )
    `);
    console.log('✅ Tabela lideranca_visualizacoes verificada/criada');
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_msg_ativo ON lideranca_mensagens(ativo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_viz_msg ON lideranca_visualizacoes(mensagem_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_viz_user ON lideranca_visualizacoes(user_cod)`).catch(() => {});
    
    // Tabela de reações às mensagens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_reacoes (
        id SERIAL PRIMARY KEY,
        mensagem_id INT REFERENCES lideranca_mensagens(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_nome VARCHAR(255),
        user_foto TEXT,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mensagem_id, user_cod, emoji)
      )
    `);
    console.log('✅ Tabela lideranca_reacoes verificada/criada');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_reacoes_msg ON lideranca_reacoes(mensagem_id)`).catch(() => {});
    // ==================== FIM MENSAGENS DA LIDERANÇA ====================
    
    // ==================== FIM MÓDULO SOCIAL ====================

    // ==================== MÓDULO AVISOS ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(255) NOT NULL,
        regioes TEXT[] DEFAULT '{}',
        todas_regioes BOOLEAN DEFAULT false,
        data_inicio TIMESTAMP NOT NULL,
        data_fim TIMESTAMP NOT NULL,
        recorrencia_tipo VARCHAR(50) DEFAULT 'uma_vez',
        recorrencia_intervalo INTEGER DEFAULT 0,
        imagem_url TEXT,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos_visualizacoes (
        id SERIAL PRIMARY KEY,
        aviso_id INTEGER REFERENCES avisos(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        visualizado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(aviso_id, user_cod)
      )
    `);
    // ==================== FIM MÓDULO AVISOS ====================

    // ==================== MÓDULO OPERAÇÕES ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS operacoes (
        id SERIAL PRIMARY KEY,
        regiao VARCHAR(100) NOT NULL,
        nome_cliente VARCHAR(255) NOT NULL,
        endereco TEXT NOT NULL,
        modelo VARCHAR(50) NOT NULL,
        quantidade_motos INTEGER NOT NULL DEFAULT 1,
        obrigatoriedade_bau BOOLEAN DEFAULT FALSE,
        possui_garantido BOOLEAN DEFAULT FALSE,
        valor_garantido DECIMAL(10,2) DEFAULT 0,
        data_inicio DATE NOT NULL,
        observacoes TEXT,
        status VARCHAR(50) DEFAULT 'ativo',
        criado_por VARCHAR(100),
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela operacoes verificada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS operacoes_faixas_km (
        id SERIAL PRIMARY KEY,
        operacao_id INTEGER NOT NULL REFERENCES operacoes(id) ON DELETE CASCADE,
        km_inicio INTEGER NOT NULL,
        km_fim INTEGER NOT NULL,
        valor_motoboy DECIMAL(10,2) NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela operacoes_faixas_km verificada');
    // ==================== FIM MÓDULO OPERAÇÕES ====================
// ==================== INÍCIO MÓDULO SCORE/GAMIFICAÇÃO ====================
    
    // Tabela de histórico de pontos (extrato detalhado)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_historico (
        id SERIAL PRIMARY KEY,
        cod_prof INTEGER NOT NULL,
        nome_prof VARCHAR(255),
        os VARCHAR(50) NOT NULL,
        data_os DATE NOT NULL,
        hora_solicitacao TIME,
        tempo_entrega_minutos INTEGER,
        prazo_minutos INTEGER,
        ponto_prazo DECIMAL(5,2) DEFAULT 0,
        ponto_bonus_janela DECIMAL(5,2) DEFAULT 0,
        ponto_total DECIMAL(5,2) DEFAULT 0,
        dentro_prazo BOOLEAN DEFAULT FALSE,
        janela_bonus VARCHAR(20),
        detalhamento TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(cod_prof, os)
      )
    `);
    console.log('✅ Tabela score_historico verificada');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_score_hist_prof ON score_historico(cod_prof)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_score_hist_data ON score_historico(data_os)`).catch(() => {});

    // Tabela de totais por profissional (cache para performance)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_totais (
        id SERIAL PRIMARY KEY,
        cod_prof INTEGER UNIQUE NOT NULL,
        nome_prof VARCHAR(255),
        score_total DECIMAL(10,2) DEFAULT 0,
        total_os INTEGER DEFAULT 0,
        os_no_prazo INTEGER DEFAULT 0,
        os_fora_prazo INTEGER DEFAULT 0,
        bonus_janela_total DECIMAL(10,2) DEFAULT 0,
        ultimo_calculo TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela score_totais verificada');

    // Tabela de milestones/benefícios do clube
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_milestones (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        descricao TEXT,
        pontos_necessarios INTEGER NOT NULL,
        icone VARCHAR(50) DEFAULT '🏆',
        cor VARCHAR(20) DEFAULT '#7c3aed',
        beneficio TEXT,
        ativo BOOLEAN DEFAULT TRUE,
        ordem INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela score_milestones verificada');

    // Tabela de milestones conquistados por profissional
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_conquistas (
        id SERIAL PRIMARY KEY,
        cod_prof INTEGER NOT NULL,
        milestone_id INTEGER REFERENCES score_milestones(id),
        conquistado_em TIMESTAMP DEFAULT NOW(),
        notificado BOOLEAN DEFAULT FALSE,
        UNIQUE(cod_prof, milestone_id)
      )
    `);
    console.log('✅ Tabela score_conquistas verificada');

    // Inserir milestones padrão se não existirem
    const milestonesCount = await pool.query('SELECT COUNT(*) FROM score_milestones');
    if (parseInt(milestonesCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem) VALUES
        ('Bronze', '2 saques gratuitos de R$500/mês', 80, '🥉', '#cd7f32', '2 saques gratuitos de R$500 por mês', 1),
        ('Prata', '+2 saques gratuitos/mês (total: 4)', 100, '🥈', '#c0c0c0', '+2 saques gratuitos de R$500 por mês (total: 4)', 2),
        ('Ouro', '1 Camisa Tutts', 250, '🥇', '#ffd700', '1 Camisa Tutts (Retirada única)', 3),
        ('Platina', '1 Óleo de motor', 300, '💎', '#e5e4e2', '1 Óleo de motor (Retirada única)', 4),
        ('Diamante', 'Sorteio Vale Combustível', 500, '👑', '#b9f2ff', 'Participação em sorteio de Vale Combustível R$100 por mês', 5)
      `);
      console.log('✅ Milestones padrão inseridos');
    }
    
    // Tabela para controlar gratuidades do Score (mensal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_gratuidades (
        id SERIAL PRIMARY KEY,
        cod_prof INTEGER NOT NULL,
        nome_prof VARCHAR(255),
        mes_referencia VARCHAR(7) NOT NULL,
        score_no_momento DECIMAL(10,2),
        nivel VARCHAR(50),
        quantidade_saques INTEGER DEFAULT 0,
        gratuidade_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(cod_prof, mes_referencia)
      )
    `);
    console.log('✅ Tabela score_gratuidades verificada');
    
    // Tabela para controlar prêmios físicos (Camisa, Óleo, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS score_premios_fisicos (
        id SERIAL PRIMARY KEY,
        cod_prof INTEGER NOT NULL,
        nome_prof VARCHAR(255),
        milestone_id INTEGER REFERENCES score_milestones(id),
        tipo_premio VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'disponivel',
        confirmado_por VARCHAR(255),
        confirmado_em TIMESTAMP,
        observacao TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(cod_prof, milestone_id)
      )
    `);
    console.log('✅ Tabela score_premios_fisicos verificada');
    
    // ==================== FIM MÓDULO SCORE/GAMIFICAÇÃO ====================

    // ==================== MÓDULO AUDITORIA ====================
    
    // Tabela de logs de auditoria
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_cod VARCHAR(50),
        user_name VARCHAR(255),
        user_role VARCHAR(50),
        action VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        resource VARCHAR(100),
        resource_id VARCHAR(100),
        details JSONB,
        ip_address VARCHAR(50),
        user_agent TEXT,
        status VARCHAR(20) DEFAULT 'success',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Índices para consultas rápidas
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_cod ON audit_logs(user_cod)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`);
    
    console.log('✅ Tabela audit_logs verificada');
    
    // ==================== FIM MÓDULO AUDITORIA ====================

    // ==================== MÓDULO BLOQUEIO DE CONTA ====================
    
    // Tabela para controle de tentativas de login
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id SERIAL PRIMARY KEY,
        cod_profissional VARCHAR(50) NOT NULL,
        ip_address VARCHAR(50),
        success BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Índices para consultas rápidas
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_cod ON login_attempts(cod_profissional)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at DESC)`);
    
    // Tabela para contas bloqueadas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocked_accounts (
        id SERIAL PRIMARY KEY,
        cod_profissional VARCHAR(50) UNIQUE NOT NULL,
        blocked_until TIMESTAMP NOT NULL,
        reason VARCHAR(255) DEFAULT 'Muitas tentativas de login falhas',
        attempts_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocked_accounts_cod ON blocked_accounts(cod_profissional)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocked_accounts_until ON blocked_accounts(blocked_until)`);
    
    console.log('✅ Tabelas de controle de login verificadas');
    
    // ==================== FIM MÓDULO BLOQUEIO DE CONTA ====================

    // ==================== MÓDULO REFRESH TOKENS ====================
    
    // Tabela para refresh tokens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        device_info VARCHAR(255),
        ip_address VARCHAR(50),
        expires_at TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Índices para consultas rápidas
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at)`);
    
    console.log('✅ Tabela refresh_tokens verificada');
    
    // ==================== FIM MÓDULO REFRESH TOKENS ====================

    // ==================== MÓDULO 2FA (TWO-FACTOR AUTHENTICATION) ====================
    
    // Tabela para configuração de 2FA dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_2fa (
        id SERIAL PRIMARY KEY,
        user_id INT UNIQUE NOT NULL,
        secret_encrypted VARCHAR(255) NOT NULL,
        enabled BOOLEAN DEFAULT FALSE,
        backup_codes TEXT[], -- Códigos de backup criptografados
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_2fa_user ON user_2fa(user_id)`);
    
    // Tabela para códigos 2FA usados (prevenir replay attacks)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS used_2fa_codes (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        used_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_used_2fa_user ON used_2fa_codes(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_used_2fa_used_at ON used_2fa_codes(used_at)`);
    
    console.log('✅ Tabelas de 2FA verificadas');
    
    // ==================== FIM MÓDULO 2FA ====================

    console.log('✅ Todas as tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error.message);
  }
}

// ============================================
// FUNÇÃO PARA ATUALIZAR RESUMOS PRÉ-CALCULADOS
// ============================================
async function atualizarResumos(datasAfetadas = null) {
  try {
    console.log('📊 Iniciando atualização dos resumos pré-calculados...');
    const inicio = Date.now();
    
    // Construir filtro de datas se especificado
    let filtroData = '';
    const params = [];
    if (datasAfetadas && datasAfetadas.length > 0) {
      filtroData = 'AND data_solicitado = ANY($1::date[])';
      params.push(datasAfetadas);
      console.log(`📊 Atualizando resumos para ${datasAfetadas.length} data(s)...`);
    } else {
      console.log('📊 Atualizando TODOS os resumos...');
    }
    
    // 1. RESUMO DIÁRIO - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_diario (
        data, total_os, total_entregas, entregas_no_prazo, entregas_fora_prazo,
        taxa_prazo, total_retornos, valor_total, valor_prof, ticket_medio,
        tempo_medio_entrega, tempo_medio_alocacao, tempo_medio_coleta,
        total_profissionais, media_ent_profissional, km_total, updated_at
      )
      SELECT 
        data_solicitado,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_execucao_minutos END), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_entrega_prof_minutos END), 2),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
              NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL ${filtroData}
      GROUP BY data_solicitado
      ON CONFLICT (data) DO UPDATE SET
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        total_retornos = EXCLUDED.total_retornos,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        ticket_medio = EXCLUDED.ticket_medio,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        tempo_medio_alocacao = EXCLUDED.tempo_medio_alocacao,
        tempo_medio_coleta = EXCLUDED.tempo_medio_coleta,
        total_profissionais = EXCLUDED.total_profissionais,
        media_ent_profissional = EXCLUDED.media_ent_profissional,
        km_total = EXCLUDED.km_total,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo diário atualizado');
    
    // 2. RESUMO POR CLIENTE - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_cliente (
        data, cod_cliente, nome_fantasia, total_os, total_entregas,
        entregas_no_prazo, entregas_fora_prazo, taxa_prazo, total_retornos,
        valor_total, valor_prof, ticket_medio, tempo_medio_entrega,
        total_profissionais, media_ent_profissional, updated_at
      )
      SELECT 
        data_solicitado,
        cod_cliente,
        MAX(nome_fantasia),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
              NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL AND cod_cliente IS NOT NULL ${filtroData}
      GROUP BY data_solicitado, cod_cliente
      ON CONFLICT (data, cod_cliente) DO UPDATE SET
        nome_fantasia = EXCLUDED.nome_fantasia,
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        total_retornos = EXCLUDED.total_retornos,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        ticket_medio = EXCLUDED.ticket_medio,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        total_profissionais = EXCLUDED.total_profissionais,
        media_ent_profissional = EXCLUDED.media_ent_profissional,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo por cliente atualizado');
    
    // 3. RESUMO POR PROFISSIONAL - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_profissional (
        data, cod_prof, nome_prof, total_os, total_entregas,
        entregas_no_prazo, entregas_fora_prazo, taxa_prazo,
        valor_total, valor_prof, tempo_medio_entrega, km_total, updated_at
      )
      SELECT 
        data_solicitado,
        cod_prof,
        MAX(nome_prof),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL AND cod_prof IS NOT NULL ${filtroData}
      GROUP BY data_solicitado, cod_prof
      ON CONFLICT (data, cod_prof) DO UPDATE SET
        nome_prof = EXCLUDED.nome_prof,
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        km_total = EXCLUDED.km_total,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo por profissional atualizado');
    
    const tempo = ((Date.now() - inicio) / 1000).toFixed(2);
    console.log(`✅ Resumos atualizados em ${tempo}s`);
    
    return { success: true, tempo };
  } catch (error) {
    console.error('❌ Erro ao atualizar resumos:', error);
    return { success: false, error: error.message };
  }
}

// ==================== MIDDLEWARES DE SEGURANÇA ====================

// Helmet - Headers de segurança (configurado para funcionar com PWA)
// ==================== CORS - DEVE VIR ANTES DE TUDO ====================

// Detectar ambiente
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';

// Lista de origens permitidas (CONDICIONAL POR AMBIENTE)
const allowedOrigins = [
  'https://www.centraltutts.online',
  'https://centraltutts.online',
  'https://tutts-frontend.vercel.app',
  'https://tutts-frontend-git-main.vercel.app',
  // Desenvolvimento local - SÓ em ambiente não-produção
  ...(isProduction ? [] : [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3001'
  ])
];

console.log(`🔒 CORS configurado para ${isProduction ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'} - ${allowedOrigins.length} origens permitidas`);

// Função para verificar se origem é permitida
const isOriginAllowed = (origin) => {
  if (!origin) return false; // Bloquear requisições sem origem em produção
  // Permitir qualquer subdomínio do Vercel para preview deploys
  if (origin.includes('tutts-frontend') && origin.includes('vercel.app')) return true;
  return allowedOrigins.includes(origin);
};

// Função para setar headers CORS (usada em todos os lugares)
const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin;
  
  // SEGURANÇA: Só permitir origens da whitelist
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // Requisições sem Origin (como de apps mobile ou server-to-server)
    // Permitir apenas para endpoints públicos específicos
    const publicPaths = ['/health', '/api/health', '/api/version'];
    if (publicPaths.some(p => req.path.startsWith(p))) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    // Para outros endpoints, não setar CORS (bloqueará requisições de browsers sem origin)
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Pragma');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
};

// OPTIONS (preflight) DEVE vir ANTES de qualquer outro middleware
app.options('*', (req, res) => {
  setCorsHeaders(req, res);
  return res.status(200).end();
});

// CORS para TODAS as requisições - ANTES do helmet
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  next();
});

// ==================== FIM CORS ====================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://unpkg.com", "https://cdn.sheetjs.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "https://*.tile.openstreetmap.org", "https://api.qrserver.com"],
      connectSrc: ["'self'", "https://tutts-backend-production.up.railway.app", "wss://tutts-backend-production.up.railway.app", "https://nominatim.openstreetmap.org", "https://viacep.com.br", "https://api.qrserver.com"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    },
    reportOnly: false
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  dnsPrefetchControl: { allow: true },
  frameguard: { action: 'sameorigin' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,
  xssFilter: true
}));

// Rate limiting global para API
app.use('/api/', apiLimiter);

// Middleware de logging de requests (após rate limiter)
app.use(requestLogger);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check (raiz e /api/health) - Público
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', message: 'API funcionando' });
});

// ==================== PROXY OPENROUTESERVICE (ROTEIRIZADOR) ====================
// SEGURANÇA: API Key protegida no backend

// Proxy para geocodificação
app.get('/api/routing/geocode', verificarToken, async (req, res) => {
  try {
    if (!ORS_API_KEY) {
      return res.status(503).json({ error: 'Serviço de geocodificação não configurado' });
    }
    
    const { text } = req.query;
    
    if (!text || text.length < 3) {
      return res.status(400).json({ error: 'Texto de busca inválido' });
    }
    
    const sanitizedText = text.replace(/[<>\"'&]/g, '').substring(0, 200);
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(sanitizedText)}&boundary.country=BR&size=1`;
    
    const response = await httpRequest(url);
    const data = response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Erro no serviço de geocodificação' });
    }
    
    res.json(data);
  } catch (error) {
    console.error('❌ Erro no proxy geocode:', error.message);
    res.status(500).json({ error: 'Erro interno no serviço de geocodificação' });
  }
});

// Proxy para otimização de rota
app.post('/api/routing/optimize', verificarToken, async (req, res) => {
  try {
    if (!ORS_API_KEY) {
      return res.status(503).json({ error: 'Serviço de roteirização não configurado' });
    }
    
    const { jobs, vehicles } = req.body;
    
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'Jobs inválidos' });
    }
    if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
      return res.status(400).json({ error: 'Vehicles inválidos' });
    }
    if (jobs.length > 50) {
      return res.status(400).json({ error: 'Máximo de 50 pontos permitido' });
    }
    
    for (const job of jobs) {
      if (!job.location || !Array.isArray(job.location) || job.location.length !== 2) {
        return res.status(400).json({ error: 'Coordenadas de job inválidas' });
      }
      const [lng, lat] = job.location;
      if (typeof lng !== 'number' || typeof lat !== 'number' || 
          lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Coordenadas fora do intervalo válido' });
      }
    }
    
    const response = await httpRequest('https://api.openrouteservice.org/optimization', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ORS_API_KEY
      },
      body: JSON.stringify({ jobs, vehicles })
    });
    
    const data = response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Erro no serviço de otimização' });
    }
    
    await registrarAuditoria(req, 'ROUTE_OPTIMIZE', AUDIT_CATEGORIES.DATA, 'routing', null, {
      pontos: jobs.length,
      usuario: req.user.codProfissional
    });
    
    res.json(data);
  } catch (error) {
    console.error('❌ Erro no proxy optimize:', error.message);
    res.status(500).json({ error: 'Erro interno no serviço de otimização' });
  }
});

// Proxy para direções (geometria da rota)
app.post('/api/routing/directions', verificarToken, async (req, res) => {
  try {
    if (!ORS_API_KEY) {
      return res.status(503).json({ error: 'Serviço de direções não configurado' });
    }
    
    const { coordinates } = req.body;
    
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Coordenadas inválidas (mínimo 2 pontos)' });
    }
    if (coordinates.length > 50) {
      return res.status(400).json({ error: 'Máximo de 50 pontos permitido' });
    }
    
    for (const coord of coordinates) {
      if (!Array.isArray(coord) || coord.length !== 2) {
        return res.status(400).json({ error: 'Formato de coordenada inválido' });
      }
      const [lng, lat] = coord;
      if (typeof lng !== 'number' || typeof lat !== 'number' ||
          lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Coordenadas fora do intervalo válido' });
      }
    }
    
    const response = await httpRequest('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ORS_API_KEY
      },
      body: JSON.stringify({ coordinates })
    });
    
    const data = response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Erro no serviço de direções' });
    }
    
    res.json(data);
  } catch (error) {
    console.error('❌ Erro no proxy directions:', error.message);
    res.status(500).json({ error: 'Erro interno no serviço de direções' });
  }
});

// ==================== FIM PROXY OPENROUTESERVICE ====================

// ============================================
// USUÁRIOS (existente)
// ============================================

// Registrar novo usuário
app.post('/api/users/register', createAccountLimiter, async (req, res) => {
  try {
    const { codProfissional, password, fullName, role } = req.body;

    // Validação de input
    if (!codProfissional || !password || !fullName) {
      return res.status(400).json({ error: 'Código profissional, senha e nome são obrigatórios' });
    }

    // Validar senha forte
    const validacaoSenha = validarSenhaForte(password);
    if (!validacaoSenha.valido) {
      return res.status(400).json({ error: validacaoSenha.erro });
    }

    console.log('📝 Tentando registrar:', { codProfissional, fullName, role });

    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Código profissional já existe');
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // role pode ser 'user', 'admin' ou 'admin_financeiro'
    const validRoles = ['user', 'admin', 'admin_financeiro'];
    const userRole = validRoles.includes(role) ? role : 'user';
    
    // Hash da senha
    const hashedPassword = await hashSenha(password);
    
    const result = await pool.query(
      `INSERT INTO users (cod_profissional, password, full_name, role, created_at) 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING id, cod_profissional, full_name, role, created_at`,
      [codProfissional, hashedPassword, fullName, userRole]
    );

    console.log('✅ Usuário registrado:', result.rows[0]);
    
    // Gerar token JWT para o novo usuário
    const token = gerarToken(result.rows[0]);
    
    res.status(201).json({
      ...result.rows[0],
      token
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao registrar usuário');
  }
});

// Login com rate limiting e bloqueio de conta
app.post('/api/users/login', loginLimiter, async (req, res) => {
  try {
    const { codProfissional, password } = req.body;

    if (!codProfissional || !password) {
      return res.status(400).json({ error: 'Código profissional e senha são obrigatórios' });
    }

    const clientIP = getClientIP(req);
    console.log('🔐 Tentando login:', codProfissional);

    // SEGURANÇA: Verificar se conta está bloqueada
    const bloqueio = await verificarContaBloqueada(codProfissional);
    if (bloqueio.bloqueada) {
      securityLogger.securityEvent('LOGIN_BLOCKED', {
        codProfissional,
        minutosRestantes: bloqueio.minutosRestantes,
        ip: clientIP
      });
      await registrarAuditoria(req, 'LOGIN_BLOCKED', AUDIT_CATEGORIES.AUTH, 'users', codProfissional, {
        motivo: bloqueio.motivo,
        minutosRestantes: bloqueio.minutosRestantes
      }, 'blocked');
      return res.status(429).json({ 
        error: `Conta temporariamente bloqueada. Tente novamente em ${bloqueio.minutosRestantes} minuto(s).`,
        bloqueada: true,
        minutosRestantes: bloqueio.minutosRestantes
      });
    }

    // Buscar usuário no banco
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, password, setor_id, COALESCE(allowed_modules, \'[]\') as allowed_modules, COALESCE(allowed_tabs, \'{}\') as allowed_tabs FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (result.rows.length === 0) {
      console.log('❌ Usuário não encontrado');
      // Registrar tentativa falha mesmo para usuário inexistente (previne enumeração)
      const tentativa = await registrarTentativaLogin(codProfissional, clientIP, false);
      if (tentativa.bloqueado) {
        return res.status(429).json({
          error: `Conta bloqueada por ${tentativa.minutosRestantes} minuto(s) devido a muitas tentativas falhas.`,
          bloqueada: true,
          minutosRestantes: tentativa.minutosRestantes
        });
      }
      return res.status(401).json({ 
        error: 'Credenciais inválidas',
        tentativasRestantes: tentativa.tentativasRestantes
      });
    }

    const user = result.rows[0];
    
    // Verificar senha com bcrypt
    // Suporte para senhas antigas (texto plano) e novas (hash)
    let senhaValida = false;
    
    if (user.password.startsWith('$2')) {
      // Senha já está em hash bcrypt
      senhaValida = await verificarSenha(password, user.password);
    } else {
      // Senha antiga em texto plano - comparar diretamente
      senhaValida = (user.password === password);
      
      // Se senha antiga válida, atualizar para bcrypt
      if (senhaValida) {
        const hashedPassword = await hashSenha(password);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
        console.log('🔄 Senha migrada para bcrypt:', user.cod_profissional);
      }
    }

    if (!senhaValida) {
      console.log('❌ Senha inválida');
      // Registrar tentativa de login falha e verificar bloqueio
      const tentativa = await registrarTentativaLogin(codProfissional, clientIP, false);
      await registrarAuditoria(req, 'LOGIN_FAILED', AUDIT_CATEGORIES.AUTH, 'users', codProfissional, { 
        motivo: 'Senha inválida',
        tentativas: tentativa.tentativas 
      }, 'failed');
      
      if (tentativa.bloqueado) {
        return res.status(429).json({
          error: `Conta bloqueada por ${tentativa.minutosRestantes} minuto(s) devido a muitas tentativas falhas.`,
          bloqueada: true,
          minutosRestantes: tentativa.minutosRestantes
        });
      }
      
      return res.status(401).json({ 
        error: 'Credenciais inválidas',
        tentativasRestantes: tentativa.tentativasRestantes
      });
    }

    // Login bem-sucedido - verificar se tem 2FA
    const tem2FA = await has2FAEnabled(user.id);
    
    if (tem2FA) {
      // Se tem 2FA, não completar login ainda - retornar status pendente
      authLogger.info('2FA requerido', { codProfissional: user.cod_profissional });
      
      // Gerar token temporário para completar 2FA (curta duração)
      const tempToken = jwt.sign(
        { id: user.id, codProfissional: user.cod_profissional, pending2FA: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      
      return res.json({
        requires2FA: true,
        tempToken,
        message: 'Verificação de dois fatores necessária'
      });
    }
    
    // Sem 2FA - login normal
    await registrarTentativaLogin(codProfissional, clientIP, true);

    // Remover senha do objeto antes de enviar
    delete user.password;

    // Gerar token JWT
    const token = gerarToken(user);

    // Registrar login bem-sucedido
    req.user = { id: user.id, codProfissional: user.cod_profissional, nome: user.full_name, role: user.role };
    await registrarAuditoria(req, 'LOGIN_SUCCESS', AUDIT_CATEGORIES.AUTH, 'users', user.id, { role: user.role });

    authLogger.info('Login bem-sucedido', { codProfissional: user.cod_profissional, role: user.role });
    
    // Gerar refresh token e salvar
    const refreshToken = gerarRefreshToken(user);
    await salvarRefreshToken(user.id, refreshToken, req);
    
    res.json({
      ...user,
      token,
      refreshToken,
      expiresIn: 3600 // 1 hora em segundos
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao fazer login');
  }
});

// Endpoint para verificar token
app.get('/api/users/verify-token', verificarToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Endpoint para renovar token usando refresh token
app.post('/api/users/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token é obrigatório' });
    }
    
    // Decodificar refresh token para pegar userId
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Refresh token expirado', expired: true });
      }
      return res.status(401).json({ error: 'Refresh token inválido' });
    }
    
    // Validar refresh token no banco
    const validacao = await validarRefreshToken(refreshToken, decoded.id);
    if (!validacao.valido) {
      return res.status(401).json({ error: validacao.erro });
    }
    
    // Buscar dados atualizados do usuário
    const result = await pool.query(
      `SELECT id, cod_profissional, full_name, role, setor_id, 
              COALESCE(allowed_modules, '[]') as allowed_modules, 
              COALESCE(allowed_tabs, '{}') as allowed_tabs 
       FROM users WHERE id = $1`,
      [decoded.id]
    );
    
    if (result.rows.length === 0) {
      // Revogar token se usuário não existe mais
      await revogarRefreshToken(validacao.tokenId);
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    
    const user = result.rows[0];
    
    // Gerar novo access token
    const newToken = gerarToken(user);
    
    // Opcionalmente, rotacionar refresh token (mais seguro)
    // const newRefreshToken = gerarRefreshToken(user);
    // await revogarRefreshToken(validacao.tokenId);
    // await salvarRefreshToken(user.id, newRefreshToken, req);
    
    console.log('🔄 Token renovado para:', user.cod_profissional);
    
    res.json({ 
      token: newToken,
      // refreshToken: newRefreshToken, // Descomente se rotacionar
      expiresIn: 3600,
      user: {
        id: user.id,
        cod_profissional: user.cod_profissional,
        full_name: user.full_name,
        role: user.role,
        setor_id: user.setor_id,
        allowed_modules: user.allowed_modules,
        allowed_tabs: user.allowed_tabs
      }
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao renovar token');
  }
});

// Endpoint para logout (revogar refresh token)
app.post('/api/users/logout', verificarToken, async (req, res) => {
  try {
    const { refreshToken, allDevices } = req.body;
    
    if (allDevices) {
      // Revogar todas as sessões
      const count = await revogarTodosTokens(req.user.id);
      await registrarAuditoria(req, 'LOGOUT_ALL', AUDIT_CATEGORIES.AUTH, 'users', req.user.id, {
        sessoes_revogadas: count
      });
      return res.json({ message: `Logout realizado em ${count} dispositivo(s)` });
    }
    
    if (refreshToken) {
      // Revogar apenas esta sessão
      const validacao = await validarRefreshToken(refreshToken, req.user.id);
      if (validacao.valido) {
        await revogarRefreshToken(validacao.tokenId);
      }
    }
    
    await registrarAuditoria(req, 'LOGOUT', AUDIT_CATEGORIES.AUTH, 'users', req.user.id);
    res.json({ message: 'Logout realizado com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao fazer logout');
  }
});

// Endpoint para listar sessões ativas
app.get('/api/users/sessions', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, device_info, ip_address, created_at, expires_at
       FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    
    res.json(result.rows.map(r => ({
      id: r.id,
      device: r.device_info,
      ip: r.ip_address,
      createdAt: r.created_at,
      expiresAt: r.expires_at
    })));
  } catch (error) {
    return handleError(res, error, 'Erro ao listar sessões');
  }
});

// Endpoint para revogar sessão específica
app.delete('/api/users/sessions/:id', verificarToken, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    
    // Verificar se a sessão pertence ao usuário
    const result = await pool.query(
      `SELECT id FROM refresh_tokens WHERE id = $1 AND user_id = $2 AND revoked = false`,
      [sessionId, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    await revogarRefreshToken(sessionId);
    await registrarAuditoria(req, 'SESSION_REVOKED', AUDIT_CATEGORIES.AUTH, 'refresh_tokens', sessionId);
    
    res.json({ message: 'Sessão revogada com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao revogar sessão');
  }
});

// ==================== ENDPOINTS DE 2FA ====================

// Verificar se 2FA está habilitado para o usuário atual
app.get('/api/users/2fa/status', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT enabled, verified_at, array_length(backup_codes, 1) as backup_codes_remaining 
       FROM user_2fa WHERE user_id = $1`,
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.json({ enabled: false, configured: false });
    }
    
    const { enabled, verified_at, backup_codes_remaining } = result.rows[0];
    res.json({
      enabled,
      configured: true,
      verifiedAt: verified_at,
      backupCodesRemaining: backup_codes_remaining || 0
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao verificar status 2FA');
  }
});

// Iniciar configuração de 2FA (gerar secret e QR code)
app.post('/api/users/2fa/setup', verificarToken, async (req, res) => {
  try {
    // Verificar se já tem 2FA configurado e habilitado
    const existing = await pool.query(
      'SELECT enabled FROM user_2fa WHERE user_id = $1',
      [req.user.id]
    );
    
    if (existing.rows.length > 0 && existing.rows[0].enabled) {
      return res.status(400).json({ error: '2FA já está habilitado. Desabilite primeiro para reconfigurar.' });
    }
    
    // Gerar novo secret
    const secret = generateTOTPSecret();
    const secretEncrypted = encryptSecret(secret);
    
    // Gerar URI para QR code
    const uri = generateTOTPUri(secret, req.user.codProfissional, req.user.nome);
    
    // Salvar ou atualizar (não habilitado ainda)
    await pool.query(`
      INSERT INTO user_2fa (user_id, secret_encrypted, enabled)
      VALUES ($1, $2, false)
      ON CONFLICT (user_id) 
      DO UPDATE SET secret_encrypted = $2, enabled = false, updated_at = NOW()
    `, [req.user.id, secretEncrypted]);
    
    await registrarAuditoria(req, '2FA_SETUP_STARTED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    res.json({
      secret, // Mostrar para usuário digitar manualmente se preferir
      qrCodeUri: uri, // Para gerar QR code no frontend
      message: 'Escaneie o QR code com Google Authenticator ou outro app TOTP'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao configurar 2FA');
  }
});

// Verificar e ativar 2FA (após escanear QR code)
app.post('/api/users/2fa/verify', verificarToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Código de 6 dígitos é obrigatório' });
    }
    
    // Buscar secret não verificado
    const result = await pool.query(
      'SELECT secret_encrypted FROM user_2fa WHERE user_id = $1 AND enabled = false',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Inicie a configuração do 2FA primeiro' });
    }
    
    // Descriptografar e verificar
    const secret = decryptSecret(result.rows[0].secret_encrypted);
    const isValid = verifyTOTP(secret, code);
    
    if (!isValid) {
      return res.status(400).json({ error: 'Código inválido. Tente novamente.' });
    }
    
    // Gerar códigos de backup
    const backupCodes = generateBackupCodes();
    const backupCodesHashed = backupCodes.map(c => 
      crypto.createHash('sha256').update(c).digest('hex')
    );
    
    // Ativar 2FA
    await pool.query(`
      UPDATE user_2fa 
      SET enabled = true, verified_at = NOW(), backup_codes = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [backupCodesHashed, req.user.id]);
    
    await registrarAuditoria(req, '2FA_ENABLED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    securityLogger.securityEvent('2FA_ENABLED', { codProfissional: req.user.codProfissional });
    
    res.json({
      success: true,
      message: '2FA ativado com sucesso!',
      backupCodes, // Mostrar apenas UMA vez ao usuário
      warning: 'SALVE esses códigos de backup em local seguro. Eles não serão mostrados novamente!'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao verificar 2FA');
  }
});

// Completar login com 2FA
app.post('/api/users/2fa/authenticate', async (req, res) => {
  try {
    const { tempToken, code, isBackupCode } = req.body;
    
    if (!tempToken || !code) {
      return res.status(400).json({ error: 'Token temporário e código são obrigatórios' });
    }
    
    // Verificar token temporário
    let decoded;
    try {
      decoded = jwt.verify(tempToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    
    if (!decoded.pending2FA) {
      return res.status(400).json({ error: 'Token inválido para 2FA' });
    }
    
    const userId = decoded.id;
    
    // Verificar se código já foi usado (replay attack)
    if (!isBackupCode && await isCodeUsed(userId, code)) {
      return res.status(400).json({ error: 'Código já utilizado. Aguarde o próximo código.' });
    }
    
    let isValid = false;
    let backupCodesRemaining = null;
    
    if (isBackupCode) {
      // Verificar código de backup
      const backupResult = await verifyBackupCode(userId, code);
      isValid = backupResult.valid;
      backupCodesRemaining = backupResult.codesRemaining;
    } else {
      // Verificar código TOTP
      const secret = await getUserTOTPSecret(userId);
      if (secret) {
        isValid = verifyTOTP(secret, code);
      }
    }
    
    if (!isValid) {
      await registrarAuditoria({ user: decoded }, '2FA_FAILED', AUDIT_CATEGORIES.AUTH, 'users', userId, {
        isBackupCode
      }, 'failed');
      return res.status(401).json({ error: 'Código inválido' });
    }
    
    // 2FA válido - completar login
    const userResult = await pool.query(
      `SELECT id, cod_profissional, full_name, role, setor_id, 
              COALESCE(allowed_modules, '[]') as allowed_modules, 
              COALESCE(allowed_tabs, '{}') as allowed_tabs 
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const user = userResult.rows[0];
    
    // Gerar tokens
    const token = gerarToken(user);
    const refreshToken = gerarRefreshToken(user);
    await salvarRefreshToken(user.id, refreshToken, req);
    
    await registrarAuditoria({ user }, 'LOGIN_2FA_SUCCESS', AUDIT_CATEGORIES.AUTH, 'users', user.id, {
      isBackupCode
    });
    
    authLogger.info('Login 2FA bem-sucedido', { codProfissional: user.cod_profissional, isBackupCode });
    
    const response = {
      ...user,
      token,
      refreshToken,
      expiresIn: 3600
    };
    
    // Avisar se restam poucos códigos de backup
    if (backupCodesRemaining !== null && backupCodesRemaining <= 2) {
      response.warning = `Atenção: Você tem apenas ${backupCodesRemaining} código(s) de backup restante(s). Considere gerar novos.`;
    }
    
    res.json(response);
  } catch (error) {
    return handleError(res, error, 'Erro na autenticação 2FA');
  }
});

// Desabilitar 2FA (requer senha atual)
app.post('/api/users/2fa/disable', verificarToken, async (req, res) => {
  try {
    const { password, code } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Senha atual é obrigatória' });
    }
    
    // Verificar senha
    const userResult = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const senhaValida = await verificarSenha(password, userResult.rows[0].password);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    
    // Verificar código 2FA atual (se fornecido)
    if (code) {
      const secret = await getUserTOTPSecret(req.user.id);
      if (secret && !verifyTOTP(secret, code)) {
        return res.status(401).json({ error: 'Código 2FA incorreto' });
      }
    }
    
    // Desabilitar 2FA
    await pool.query(
      'DELETE FROM user_2fa WHERE user_id = $1',
      [req.user.id]
    );
    
    await registrarAuditoria(req, '2FA_DISABLED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    securityLogger.securityEvent('2FA_DISABLED', { codProfissional: req.user.codProfissional });
    
    res.json({ success: true, message: '2FA desabilitado com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao desabilitar 2FA');
  }
});

// Regenerar códigos de backup
app.post('/api/users/2fa/backup-codes/regenerate', verificarToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Código 2FA atual é obrigatório' });
    }
    
    // Verificar se 2FA está habilitado
    const secret = await getUserTOTPSecret(req.user.id);
    if (!secret) {
      return res.status(400).json({ error: '2FA não está habilitado' });
    }
    
    // Verificar código atual
    if (!verifyTOTP(secret, code)) {
      return res.status(401).json({ error: 'Código 2FA incorreto' });
    }
    
    // Gerar novos códigos de backup
    const backupCodes = generateBackupCodes();
    const backupCodesHashed = backupCodes.map(c => 
      crypto.createHash('sha256').update(c).digest('hex')
    );
    
    await pool.query(
      'UPDATE user_2fa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
      [backupCodesHashed, req.user.id]
    );
    
    await registrarAuditoria(req, '2FA_BACKUP_CODES_REGENERATED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    res.json({
      success: true,
      backupCodes,
      warning: 'SALVE esses códigos de backup em local seguro. Os códigos anteriores foram invalidados!'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao regenerar códigos de backup');
  }
});

// ==================== FIM ENDPOINTS DE 2FA ====================

// Listar todos os usuários (APENAS ADMIN - protegido)
app.get('/api/users', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, u.setor_id, u.created_at,
        s.nome as setor_nome, s.cor as setor_cor
      FROM users u
      LEFT JOIN setores s ON u.setor_id = s.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários: ' + error.message });
  }
});

// Resetar senha
app.post('/api/users/reset-password', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { codProfissional, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    }

    // Hash da nova senha
    const hashedPassword = await hashSenha(newPassword);

    const result = await pool.query(
      'UPDATE users SET password = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name',
      [hashedPassword, codProfissional]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    console.log(`🔐 Senha resetada para: ${codProfissional} por ${req.user.codProfissional}`);
    res.json({ message: 'Senha alterada com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: 'Erro ao resetar senha: ' + error.message });
  }
});

// Alterar própria senha
app.post('/api/users/change-password', verificarToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    }

    // Buscar usuário atual
    const userResult = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Verificar senha atual
    const senhaAtualValida = await verificarSenha(currentPassword, userResult.rows[0].password);
    if (!senhaAtualValida) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    // Hash da nova senha
    const hashedPassword = await hashSenha(newPassword);

    await pool.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedPassword, req.user.id]
    );

    console.log(`🔐 Senha alterada pelo próprio usuário: ${req.user.codProfissional}`);
    res.json({ message: 'Senha alterada com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao alterar senha:', error);
    res.status(500).json({ error: 'Erro ao alterar senha: ' + error.message });
  }
});

// Atualizar role do usuário (Admin Master APENAS)
// SEGURANÇA: Apenas admin_master pode alterar roles
app.patch('/api/users/:codProfissional/role', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode alterar roles
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de alterar role por: ${req.user.codProfissional} (${req.user.role})`);
      await registrarAuditoria(req, 'ROLE_CHANGE_DENIED', AUDIT_CATEGORIES.ADMIN, 'users', req.params.codProfissional, {
        tentativa_role: req.body.role,
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode alterar roles.' });
    }
    
    const { codProfissional } = req.params;
    const { role } = req.body;
    
    // Validar roles permitidos
    const rolesPermitidos = ['user', 'admin', 'admin_financeiro', 'admin_master'];
    if (!rolesPermitidos.includes(role)) {
      return res.status(400).json({ error: 'Role inválido' });
    }
    
    // Não permitir rebaixar a si mesmo de admin_master
    if (req.user.codProfissional === codProfissional && role !== 'admin_master') {
      return res.status(400).json({ error: 'Você não pode rebaixar seu próprio role de Admin Master' });
    }
    
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name, role',
      [role, codProfissional]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Registrar auditoria
    await registrarAuditoria(req, 'ROLE_CHANGE', AUDIT_CATEGORIES.ADMIN, 'users', result.rows[0].id, {
      cod_profissional: codProfissional,
      novo_role: role,
      alterado_por: req.user.codProfissional
    });
    
    console.log(`👑 Role atualizado: ${codProfissional} -> ${role} (por ${req.user.codProfissional})`);
    res.json({ message: 'Role atualizado com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao atualizar role:', error);
    res.status(500).json({ error: 'Erro ao atualizar role: ' + error.message });
  }
});

// ============================================
// ENDPOINTS DE PERMISSÕES DE ADMIN
// ============================================

// Listar todos os admins com permissões (APENAS ADMIN_MASTER)
app.get('/api/admin-permissions', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode ver/gerenciar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Acesso negado a admin-permissions por: ${req.user.codProfissional}`);
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode gerenciar permissões.' });
    }
    
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, 
             COALESCE(u.allowed_modules::text, '[]') as allowed_modules,
             COALESCE(u.allowed_tabs::text, '{}') as allowed_tabs,
             u.created_at
      FROM users u
      WHERE u.role IN ('admin', 'admin_financeiro')
      ORDER BY u.full_name
    `);
    
    // Parse JSON strings
    const rows = result.rows.map(row => {
      try {
        row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
        row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
      } catch (e) {
        row.allowed_modules = [];
        row.allowed_tabs = {};
      }
      return row;
    });
    
    res.json(rows);
  } catch (error) {
    console.error('❌ Erro ao listar permissões:', error);
    res.json([]);
  }
});

// Atualizar permissões de um admin (APENAS ADMIN_MASTER)
app.patch('/api/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode alterar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de alterar permissões por: ${req.user.codProfissional}`);
      await registrarAuditoria(req, 'PERMISSIONS_CHANGE_DENIED', AUDIT_CATEGORIES.ADMIN, 'users', req.params.codProfissional, {
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode alterar permissões.' });
    }
    
    const { codProfissional } = req.params;
    const { allowed_modules, allowed_tabs } = req.body;
    
    // Garantir que são objetos válidos
    const modules = Array.isArray(allowed_modules) ? allowed_modules : [];
    const tabs = (allowed_tabs && typeof allowed_tabs === 'object') ? allowed_tabs : {};
    
    const result = await pool.query(`
      UPDATE users 
      SET allowed_modules = $1::jsonb, allowed_tabs = $2::jsonb
      WHERE LOWER(cod_profissional) = LOWER($3)
      RETURNING id, cod_profissional, full_name, role, allowed_modules, allowed_tabs
    `, [JSON.stringify(modules), JSON.stringify(tabs), codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'Usuário não encontrado', success: false });
    }
    
    // Registrar auditoria
    await registrarAuditoria(req, 'PERMISSIONS_CHANGE', AUDIT_CATEGORIES.ADMIN, 'users', result.rows[0].id, {
      cod_profissional: codProfissional,
      modulos: modules,
      alterado_por: req.user.codProfissional
    });
    
    console.log(`🔐 Permissões atualizadas: ${codProfissional} (por ${req.user.codProfissional})`);
    res.json({ message: 'Permissões atualizadas com sucesso', user: result.rows[0], success: true });
  } catch (error) {
    console.error('❌ Erro ao atualizar permissões:', error);
    res.json({ message: 'Erro ao atualizar', success: false, error: error.message });
  }
});

// Obter permissões de um admin específico (ADMIN_MASTER ou próprio usuário)
app.get('/api/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    const { codProfissional } = req.params;
    
    // Permitir acesso apenas para admin_master ou o próprio usuário consultando suas permissões
    if (req.user.role !== 'admin_master' && req.user.codProfissional.toLowerCase() !== codProfissional.toLowerCase()) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const result = await pool.query(`
      SELECT id, cod_profissional, full_name, role, 
             COALESCE(allowed_modules::text, '[]') as allowed_modules,
             COALESCE(allowed_tabs::text, '{}') as allowed_tabs
      FROM users
      WHERE LOWER(cod_profissional) = LOWER($1)
    `, [codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ allowed_modules: [], allowed_tabs: {} });
    }
    
    // Parse JSON strings se necessário
    const row = result.rows[0];
    try {
      row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
      row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
    } catch (e) {
      row.allowed_modules = [];
      row.allowed_tabs = {};
    }
    
    res.json(row);
  } catch (error) {
    console.error('❌ Erro ao buscar permissões:', error);
    res.json({ allowed_modules: [], allowed_tabs: {} });
  }
});

// Deletar usuário (APENAS ADMIN_MASTER)
app.delete('/api/users/:codProfissional', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode deletar usuários
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de deletar usuário por: ${req.user.codProfissional}`);
      await registrarAuditoria(req, 'USER_DELETE_DENIED', AUDIT_CATEGORIES.USER, 'users', req.params.codProfissional, {
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode deletar usuários.' });
    }
    
    const { codProfissional } = req.params;
    
    // Não permitir deletar a si mesmo
    if (req.user.codProfissional.toLowerCase() === codProfissional.toLowerCase()) {
      return res.status(400).json({ error: 'Você não pode deletar sua própria conta' });
    }
    
    const deletedData = {
      user: null,
      submissions: 0,
      withdrawals: 0,
      gratuities: 0,
      indicacoes: 0,
      inscricoesNovatos: 0,
      quizRespostas: 0
    };
    
    // Função auxiliar para deletar de uma tabela (ignora se tabela não existe)
    const safeDelete = async (query, params) => {
      try {
        const result = await pool.query(query, params);
        return result.rowCount || 0;
      } catch (err) {
        // Ignora erro se tabela não existe
        if (err.code === '42P01') return 0; // undefined_table
        throw err;
      }
    };
    
    // 1. Deletar submissões (solicitações de saque)
    deletedData.submissions = await safeDelete(
      'DELETE FROM submissions WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 2. Deletar saques (withdrawals)
    deletedData.withdrawals = await safeDelete(
      'DELETE FROM withdrawal_requests WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 3. Deletar gratuidades
    deletedData.gratuities = await safeDelete(
      'DELETE FROM gratuities WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 4. Deletar indicações (onde é o indicador)
    deletedData.indicacoes = await safeDelete(
      'DELETE FROM indicacoes WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 5. Deletar inscrições em promoções novatos
    deletedData.inscricoesNovatos = await safeDelete(
      'DELETE FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 6. Deletar respostas do quiz de procedimentos
    deletedData.quizRespostas = await safeDelete(
      'DELETE FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 7. Por fim, deletar o usuário
    const userResult = await pool.query(
      'DELETE FROM users WHERE LOWER(cod_profissional) = LOWER($1) RETURNING *',
      [codProfissional]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    deletedData.user = userResult.rows[0];
    
    // Registrar auditoria
    await registrarAuditoria(req, 'USER_DELETE', AUDIT_CATEGORIES.USER, 'users', codProfissional, {
      nome: deletedData.user.full_name,
      role: deletedData.user.role,
      dados_excluidos: {
        submissions: deletedData.submissions,
        withdrawals: deletedData.withdrawals,
        gratuities: deletedData.gratuities,
        indicacoes: deletedData.indicacoes
      }
    });
    
    console.log(`🗑️ Usuário ${codProfissional} e todos os dados associados foram excluídos:`, deletedData);
    
    res.json({ 
      message: 'Usuário e todos os dados associados excluídos com sucesso', 
      deleted: deletedData 
    });
    
  } catch (error) {
    console.error('❌ Erro ao deletar usuário:', error);
    res.status(500).json({ error: 'Erro ao deletar usuário: ' + error.message });
  }
});

// ============================================
// SUBMISSÕES (COM AUTENTICAÇÃO - CORRIGIDO)
// ============================================

// POST - Criar submissão (REQUER AUTENTICAÇÃO)
app.post('/api/submissions', verificarToken, async (req, res) => {
  try {
    const { ordemServico, motivo, imagemComprovante, imagens, coordenadas } = req.body;
    
    // SEGURANÇA: Usar dados do token JWT, não do body
    const userId = req.user.id;
    const userCod = req.user.codProfissional;
    const userName = req.user.nome;
    
    // Validação de entrada
    if (!ordemServico || ordemServico.length < 1 || ordemServico.length > 50) {
      return res.status(400).json({ error: 'Ordem de serviço inválida' });
    }
    if (!motivo || motivo.length < 1 || motivo.length > 1000) {
      return res.status(400).json({ error: 'Motivo inválido' });
    }
    
    const sanitizedOrdemServico = ordemServico.toString().trim().substring(0, 50);
    const sanitizedMotivo = motivo.toString().trim().substring(0, 1000);

    const result = await pool.query(
      `INSERT INTO submissions 
       (ordem_servico, motivo, status, user_id, user_cod, user_name, 
        imagem_comprovante, imagens, coordenadas, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, $7, $8, NOW()) 
       RETURNING *`,
      [sanitizedOrdemServico, sanitizedMotivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas]
    );

    await registrarAuditoria(req, 'SUBMISSION_CREATE', AUDIT_CATEGORIES.DATA, 'submissions', result.rows[0].id, {
      ordem_servico: sanitizedOrdemServico
    });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao criar submissão' });
  }
});

// GET - Listar submissões (REQUER AUTENTICAÇÃO)
app.get('/api/submissions', verificarToken, async (req, res) => {
  try {
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    
    let query;
    let params;
    
    if (isAdmin) {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        ORDER BY created_at DESC
        LIMIT 1000
      `;
      params = [];
    } else {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        WHERE user_cod = $1 
        ORDER BY created_at DESC
        LIMIT 500
      `;
      params = [req.user.codProfissional];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro interno ao listar submissões' });
  }
});

// GET - Buscar imagem de submissão (REQUER AUTENTICAÇÃO)
app.get('/api/submissions/:id/imagem', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    
    let query;
    let params;
    
    if (isAdmin) {
      query = 'SELECT imagem_comprovante FROM submissions WHERE id = $1';
      params = [submissionId];
    } else {
      query = 'SELECT imagem_comprovante FROM submissions WHERE id = $1 AND user_cod = $2';
      params = [submissionId, req.user.codProfissional];
    }
    
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json({ imagem: result.rows[0].imagem_comprovante });
  } catch (error) {
    console.error('❌ Erro ao buscar imagem:', error);
    res.status(500).json({ error: 'Erro interno ao buscar imagem' });
  }
});

// PATCH - Atualizar submissão (APENAS ADMINS)
app.patch('/api/submissions/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao } = req.body;
    
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const validStatuses = ['pendente', 'aprovado', 'rejeitado', 'em_analise'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    
    const validatedBy = req.user.id;
    const validatedByName = req.user.nome;

    const result = await pool.query(
      `UPDATE submissions 
       SET status = $1, 
           observacao = $2, 
           validated_by = $3, 
           validated_by_name = $4, 
           updated_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [status, (observacao || '').substring(0, 1000), validatedBy, validatedByName, submissionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    await registrarAuditoria(req, 'SUBMISSION_UPDATE', AUDIT_CATEGORIES.DATA, 'submissions', submissionId, {
      novo_status: status
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar submissão' });
  }
});

// DELETE - Excluir submissão (APENAS ADMIN MASTER)
app.delete('/api/submissions/:id', verificarToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin_master') {
      await registrarAuditoria(req, 'SUBMISSION_DELETE_DENIED', AUDIT_CATEGORIES.DATA, 'submissions', req.params.id, {
        motivo: 'Permissão negada'
      }, 'denied');
      return res.status(403).json({ error: 'Apenas admin master pode excluir submissões' });
    }
    
    const { id } = req.params;
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const existing = await pool.query('SELECT ordem_servico, user_cod FROM submissions WHERE id = $1', [submissionId]);
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    const result = await pool.query(
      'DELETE FROM submissions WHERE id = $1 RETURNING *',
      [submissionId]
    );

    await registrarAuditoria(req, 'SUBMISSION_DELETE', AUDIT_CATEGORIES.DATA, 'submissions', submissionId, {
      ordem_servico: existing.rows[0].ordem_servico,
      user_cod_original: existing.rows[0].user_cod
    });

    res.json({ message: 'Submissão excluída com sucesso', deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao deletar submissão' });
  }
});

// ============================================
// DADOS FINANCEIROS DO USUÁRIO
// ============================================

// Verificar se usuário aceitou termos (protegido - apenas próprio usuário ou admin)
app.get('/api/financial/check-terms/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin pode verificar
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT terms_accepted FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    res.json({ 
      hasAccepted: result.rows.length > 0 && result.rows[0].terms_accepted,
      hasData: result.rows.length > 0
    });
  } catch (error) {
    console.error('❌ Erro ao verificar termos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aceitar termos (protegido - apenas próprio usuário)
app.post('/api/financial/accept-terms', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.body;
    
    // SEGURANÇA: Apenas o próprio usuário pode aceitar seus termos
    if (req.user.codProfissional !== userCod) {
      console.log(`⚠️ [SEGURANÇA] Tentativa de aceitar termos para outro usuário: ${req.user.codProfissional} -> ${userCod}`);
      return res.status(403).json({ error: 'Você só pode aceitar termos para sua própria conta' });
    }
    
    // Verificar se já existe registro
    const existing = await pool.query(
      'SELECT id FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE user_financial_data SET terms_accepted = true, terms_accepted_at = NOW() WHERE user_cod = $1',
        [userCod]
      );
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, terms_accepted, terms_accepted_at) 
         VALUES ($1, '', '', '', true, NOW())`,
        [userCod]
      );
    }

    // Log
    await pool.query(
      'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
      [userCod, 'ACEITE_TERMOS', 'Termos aceitos']
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao aceitar termos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter dados financeiros do usuário (PROTEGIDO - dados sensíveis)
app.get('/api/financial/data/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // CRÍTICO: Dados financeiros são sensíveis (CPF, PIX)
    // Apenas o próprio usuário ou admin podem acessar
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Acesso negado a dados financeiros: ${req.user.codProfissional} tentou acessar ${userCod}`);
        return res.status(403).json({ error: 'Acesso negado aos dados financeiros' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (result.rows.length === 0) {
      return res.json({ data: null });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter dados financeiros:', error);
    res.status(500).json({ error: error.message });
  }
});

// Salvar/Atualizar dados financeiros (PROTEGIDO)
app.post('/api/financial/data', verificarToken, async (req, res) => {
  try {
    const { userCod, fullName, cpf, pixKey, pixTipo } = req.body;
    
    // SEGURANÇA: Apenas o próprio usuário pode alterar seus dados financeiros
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Tentativa de alterar dados financeiros de outro usuário: ${req.user.codProfissional} -> ${userCod}`);
        return res.status(403).json({ error: 'Você só pode alterar seus próprios dados financeiros' });
      }
    }
    
    // ==================== VALIDAÇÃO DE INPUTS ====================
    
    // Validar nome (não vazio, sem caracteres especiais perigosos)
    if (!fullName || fullName.trim().length < 3) {
      return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
    }
    if (fullName.length > 255) {
      return res.status(400).json({ error: 'Nome muito longo (máx 255 caracteres)' });
    }
    // Sanitizar nome - remover caracteres potencialmente perigosos
    const nomeSeguro = fullName.replace(/[<>\"'%;()&+]/g, '').trim();
    
    // Validação completa de CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      return res.status(400).json({ error: 'CPF deve ter 11 dígitos. Verifique se digitou corretamente.' });
    }
    // Verificar se não é CPF com todos dígitos iguais
    if (/^(\d)\1{10}$/.test(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido. Não é permitido CPF com todos os dígitos iguais.' });
    }
    // Validar dígitos verificadores do CPF
    const validarCPF = (cpf) => {
      let soma = 0, resto;
      for (let i = 1; i <= 9; i++) soma += parseInt(cpf.substring(i-1, i)) * (11 - i);
      resto = (soma * 10) % 11;
      if (resto === 10 || resto === 11) resto = 0;
      if (resto !== parseInt(cpf.substring(9, 10))) return false;
      soma = 0;
      for (let i = 1; i <= 10; i++) soma += parseInt(cpf.substring(i-1, i)) * (12 - i);
      resto = (soma * 10) % 11;
      if (resto === 10 || resto === 11) resto = 0;
      if (resto !== parseInt(cpf.substring(10, 11))) return false;
      return true;
    };
    if (!validarCPF(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido. Por favor, verifique se digitou os números corretamente.' });
    }
    
    // Validar chave PIX baseado no tipo
    const tiposPix = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'];
    const tipoPixSeguro = tiposPix.includes(pixTipo) ? pixTipo : 'cpf';
    
    if (!pixKey || pixKey.trim().length === 0) {
      return res.status(400).json({ error: 'Chave PIX é obrigatória' });
    }
    
    const pixKeyLimpo = pixKey.trim();
    if (tipoPixSeguro === 'cpf') {
      const pixCpfLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (pixCpfLimpo.length !== 11) {
        return res.status(400).json({ error: 'Chave PIX CPF deve ter 11 dígitos' });
      }
    } else if (tipoPixSeguro === 'cnpj') {
      const pixCnpjLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (pixCnpjLimpo.length !== 14) {
        return res.status(400).json({ error: 'Chave PIX CNPJ deve ter 14 dígitos' });
      }
    } else if (tipoPixSeguro === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(pixKeyLimpo)) {
        return res.status(400).json({ error: 'Chave PIX Email inválida' });
      }
    } else if (tipoPixSeguro === 'telefone') {
      const telLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (telLimpo.length < 10 || telLimpo.length > 11) {
        return res.status(400).json({ error: 'Chave PIX Telefone inválida' });
      }
    } else if (tipoPixSeguro === 'aleatoria') {
      if (pixKeyLimpo.length !== 32 && pixKeyLimpo.length !== 36) {
        return res.status(400).json({ error: 'Chave PIX aleatória deve ter 32 ou 36 caracteres' });
      }
    }
    
    // ==================== FIM VALIDAÇÃO ====================
    
    // Verificar se já existe
    const existing = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      const oldData = existing.rows[0];
      
      await pool.query(
        `UPDATE user_financial_data 
         SET full_name = $1, cpf = $2, pix_key = $3, pix_tipo = $4, updated_at = NOW() 
         WHERE user_cod = $5`,
        [nomeSeguro, cpfLimpo, pixKeyLimpo, tipoPixSeguro, userCod]
      );

      // Log de alterações
      if (oldData.full_name !== nomeSeguro) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_NOME', oldData.full_name, nomeSeguro]
        );
      }
      if (oldData.cpf !== cpfLimpo) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_CPF', '***' + oldData.cpf?.slice(-4), '***' + cpfLimpo.slice(-4)]
        );
      }
      if (oldData.pix_key !== pixKeyLimpo) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_PIX', oldData.pix_key, pixKey]
        );
      }
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, pix_tipo, terms_accepted) 
         VALUES ($1, $2, $3, $4, $5, true)`,
        [userCod, fullName, cpf, pixKey, pixTipo || 'cpf']
      );

      await pool.query(
        'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
        [userCod, 'CADASTRO_DADOS', 'Dados financeiros cadastrados']
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar dados financeiros:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter logs de alterações financeiras (PROTEGIDO)
app.get('/api/financial/logs/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin podem ver logs
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado aos logs financeiros' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM financial_logs WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao obter logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HORÁRIOS DE ATENDIMENTO E AVISOS
// ============================================

// GET /api/horarios - Listar todos os horários de atendimento
app.get('/api/horarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM horarios_atendimento ORDER BY dia_semana');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários:', err);
    res.status(500).json({ error: 'Erro ao listar horários' });
  }
});

// PUT /api/horarios/:id - Atualizar horário de um dia
app.put('/api/horarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_inicio, hora_fim, ativo } = req.body;
    
    const result = await pool.query(
      `UPDATE horarios_atendimento 
       SET hora_inicio = $1, hora_fim = $2, ativo = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [hora_inicio || null, hora_fim || null, ativo, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar horário:', err);
    res.status(500).json({ error: 'Erro ao atualizar horário' });
  }
});

// GET /api/horarios/especiais - Listar horários especiais
app.get('/api/horarios/especiais', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data >= CURRENT_DATE ORDER BY data'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários especiais:', err);
    res.status(500).json({ error: 'Erro ao listar horários especiais' });
  }
});

// POST /api/horarios/especiais - Criar horário especial
app.post('/api/horarios/especiais', async (req, res) => {
  try {
    const { data, descricao, hora_inicio, hora_fim, fechado } = req.body;
    
    const result = await pool.query(
      `INSERT INTO horarios_especiais (data, descricao, hora_inicio, hora_fim, fechado)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (data) DO UPDATE SET 
         descricao = $2, hora_inicio = $3, hora_fim = $4, fechado = $5
       RETURNING *`,
      [data, descricao, fechado ? null : hora_inicio, fechado ? null : hora_fim, fechado]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar horário especial:', err);
    res.status(500).json({ error: 'Erro ao criar horário especial' });
  }
});

// DELETE /api/horarios/especiais/:id - Remover horário especial
app.delete('/api/horarios/especiais/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM horarios_especiais WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover horário especial:', err);
    res.status(500).json({ error: 'Erro ao remover horário especial' });
  }
});

// GET /api/horarios/verificar - Verificar se está dentro do horário de atendimento
app.get('/api/horarios/verificar', async (req, res) => {
  try {
    const agora = new Date();
    // Ajustar para horário de Brasília (GMT-3)
    const brasiliaOffset = -3 * 60; // minutos
    const localOffset = agora.getTimezoneOffset(); // minutos
    const brasilia = new Date(agora.getTime() + (localOffset + brasiliaOffset) * 60000);
    
    const diaSemana = brasilia.getDay(); // 0=Domingo, 1=Segunda...
    const horaAtual = brasilia.toTimeString().slice(0, 5); // "HH:MM"
    const dataHoje = brasilia.toISOString().split('T')[0]; // "YYYY-MM-DD"
    
    // Verificar se há horário especial para hoje
    const especial = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data = $1',
      [dataHoje]
    );
    
    let dentroHorario = false;
    let horarioInfo = null;
    
    if (especial.rows.length > 0) {
      // Usar horário especial
      const esp = especial.rows[0];
      if (esp.fechado) {
        dentroHorario = false;
        horarioInfo = { tipo: 'especial', descricao: esp.descricao, fechado: true };
      } else {
        dentroHorario = horaAtual >= esp.hora_inicio && horaAtual <= esp.hora_fim;
        horarioInfo = { 
          tipo: 'especial', 
          descricao: esp.descricao, 
          inicio: esp.hora_inicio, 
          fim: esp.hora_fim 
        };
      }
    } else {
      // Usar horário normal do dia
      const normal = await pool.query(
        'SELECT * FROM horarios_atendimento WHERE dia_semana = $1',
        [diaSemana]
      );
      
      if (normal.rows.length > 0) {
        const hor = normal.rows[0];
        if (!hor.ativo || !hor.hora_inicio || !hor.hora_fim) {
          dentroHorario = false;
          horarioInfo = { tipo: 'normal', fechado: true, diaSemana };
        } else {
          dentroHorario = horaAtual >= hor.hora_inicio && horaAtual <= hor.hora_fim;
          horarioInfo = { 
            tipo: 'normal', 
            inicio: hor.hora_inicio, 
            fim: hor.hora_fim, 
            diaSemana 
          };
        }
      }
    }
    
    // Buscar próximo horário de atendimento
    let proximoHorario = null;
    if (!dentroHorario) {
      // Buscar próximo dia com atendimento
      for (let i = 0; i <= 7; i++) {
        const proximaData = new Date(brasilia);
        proximaData.setDate(proximaData.getDate() + i);
        const proximoDia = proximaData.getDay();
        const proximaDataStr = proximaData.toISOString().split('T')[0];
        
        // Verificar especial
        const espProx = await pool.query(
          'SELECT * FROM horarios_especiais WHERE data = $1 AND fechado = false',
          [proximaDataStr]
        );
        
        if (espProx.rows.length > 0) {
          const esp = espProx.rows[0];
          if (i === 0 && horaAtual < esp.hora_inicio) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          } else if (i > 0) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          }
        } else {
          // Verificar normal
          const norProx = await pool.query(
            'SELECT * FROM horarios_atendimento WHERE dia_semana = $1 AND ativo = true',
            [proximoDia]
          );
          
          if (norProx.rows.length > 0 && norProx.rows[0].hora_inicio) {
            const nor = norProx.rows[0];
            if (i === 0 && horaAtual < nor.hora_inicio) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            } else if (i > 0) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            }
          }
        }
      }
    }
    
    res.json({
      dentroHorario,
      horarioInfo,
      proximoHorario,
      horaAtual,
      dataHoje
    });
  } catch (err) {
    console.error('❌ Erro ao verificar horário:', err);
    res.status(500).json({ error: 'Erro ao verificar horário' });
  }
});

// GET /api/avisos - Listar avisos do financeiro
app.get('/api/avisos', async (req, res) => {
  try {
    const { ativos } = req.query;
    let query = 'SELECT * FROM avisos_financeiro';
    if (ativos === 'true') {
      query += ' WHERE ativo = true';
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.status(500).json({ error: 'Erro ao listar avisos' });
  }
});

// POST /api/avisos - Criar aviso
app.post('/api/avisos', async (req, res) => {
  try {
    const { titulo, mensagem, tipo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `INSERT INTO avisos_financeiro (titulo, mensagem, tipo, exibir_fora_horario)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [titulo, mensagem, tipo || 'info', exibir_fora_horario || false]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: 'Erro ao criar aviso' });
  }
});

// PUT /api/avisos/:id - Atualizar aviso
app.put('/api/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, mensagem, tipo, ativo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `UPDATE avisos_financeiro 
       SET titulo = $1, mensagem = $2, tipo = $3, ativo = $4, exibir_fora_horario = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [titulo, mensagem, tipo, ativo, exibir_fora_horario, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: 'Erro ao atualizar aviso' });
  }
});

// DELETE /api/avisos/:id - Remover aviso
app.delete('/api/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos_financeiro WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover aviso:', err);
    res.status(500).json({ error: 'Erro ao remover aviso' });
  }
});

// ============================================
// SOLICITAÇÕES DE SAQUE
// ============================================

// ==================== NOVO: Endpoint otimizado - Apenas Pendentes ====================
app.get('/api/withdrawals/pendentes', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason,
        EXTRACT(EPOCH FROM (NOW() - w.created_at))/3600 as horas_aguardando
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      WHERE w.status IN ('pending', 'aguardando_aprovacao')
      ORDER BY w.created_at ASC
    `);
    
    const withdrawals = result.rows.map(w => ({
      ...w,
      isDelayed: parseFloat(w.horas_aguardando) > 1
    }));
    
    console.log(`📋 [withdrawals/pendentes] Retornando ${withdrawals.length} saques pendentes`);
    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques pendentes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== NOVO: Contadores (ultra leve) ====================
app.get('/api/withdrawals/contadores', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('pending', 'aguardando_aprovacao')) as pendentes,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as aprovados,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
        COUNT(*) as total
      FROM withdrawal_requests
    `);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter contadores:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== NOVO: Histórico paginado ====================
app.get('/api/withdrawals/historico', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, user_cod, data_inicio, data_fim } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereConditions = [];
    
    if (status) {
      params.push(status);
      whereConditions.push(`w.status = $${params.length}`);
    } else {
      whereConditions.push(`w.status NOT IN ('pending', 'aguardando_aprovacao')`);
    }
    
    if (user_cod) {
      params.push(user_cod);
      whereConditions.push(`w.user_cod = $${params.length}`);
    }
    
    if (data_inicio) {
      params.push(data_inicio);
      whereConditions.push(`w.created_at >= $${params.length}::date`);
    }
    
    if (data_fim) {
      params.push(data_fim);
      whereConditions.push(`w.created_at <= $${params.length}::date + interval '1 day'`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    const result = await pool.query(`
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      ${whereClause}
      ORDER BY w.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);
    
    const countResult = await pool.query(`SELECT COUNT(*) as total FROM withdrawal_requests w ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / parseInt(limit));
    
    res.json({
      data: result.rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages, hasNext: parseInt(page) < totalPages, hasPrev: parseInt(page) > 1 }
    });
  } catch (error) {
    console.error('❌ Erro ao listar histórico:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar solicitação de saque
app.post('/api/withdrawals', verificarToken, withdrawalCreateLimiter, async (req, res) => {
  try {
    const { userCod, userName, cpf, pixKey, requestedAmount } = req.body;

    // Validar que o usuário só pode criar saque para si mesmo (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Tentativa de criar saque para outro usuário: ${req.user.codProfissional} tentou criar para ${userCod}`);
        return res.status(403).json({ error: 'Você só pode criar saques para sua própria conta' });
      }
    }

    // Verificar se está restrito
    const restricted = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );
    const isRestricted = restricted.rows.length > 0;

    // Verificar gratuidade ativa
    const gratuity = await pool.query(
      "SELECT * FROM gratuities WHERE user_cod = $1 AND status = 'ativa' AND remaining > 0 ORDER BY created_at ASC LIMIT 1",
      [userCod]
    );
    
    const hasGratuity = gratuity.rows.length > 0;
    let gratuityId = null;
    let feeAmount = requestedAmount * 0.045; // 4.5%
    let finalAmount = requestedAmount - feeAmount;

    if (hasGratuity) {
      gratuityId = gratuity.rows[0].id;
      feeAmount = 0;
      finalAmount = requestedAmount;

      // Decrementar gratuidade
      const newRemaining = gratuity.rows[0].remaining - 1;
      if (newRemaining <= 0) {
        await pool.query(
          "UPDATE gratuities SET remaining = 0, status = 'expirada', expired_at = NOW() WHERE id = $1",
          [gratuityId]
        );
      } else {
        await pool.query(
          'UPDATE gratuities SET remaining = $1 WHERE id = $2',
          [newRemaining, gratuityId]
        );
      }
    }

    const result = await pool.query(
      `INSERT INTO withdrawal_requests 
       (user_cod, user_name, cpf, pix_key, requested_amount, fee_amount, final_amount, has_gratuity, gratuity_id, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aguardando_aprovacao') 
       RETURNING *`,
      [userCod, userName, cpf, pixKey, requestedAmount, feeAmount, finalAmount, hasGratuity, gratuityId]
    );

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_CREATE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', result.rows[0].id, {
      valor: requestedAmount,
      taxa: feeAmount,
      valor_final: finalAmount,
      gratuidade: hasGratuity,
      restrito: isRestricted
    });

    // ==================== NOTIFICAR VIA WEBSOCKET ====================
    if (global.notifyNewWithdrawal) {
      global.notifyNewWithdrawal(result.rows[0]);
    }

    res.status(201).json({ 
      ...result.rows[0], 
      isRestricted 
    });
  } catch (error) {
    console.error('❌ Erro ao criar saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar saques do usuário
app.get('/api/withdrawals/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // Usuário só pode ver seus próprios saques (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    // Adicionar verificação de atraso (mais de 1 hora)
    const now = new Date();
    const withdrawals = result.rows.map(w => {
      const createdAt = new Date(w.created_at);
      const diffMs = now - createdAt;
      const diffHours = diffMs / (1000 * 60 * 60);
      
      return {
        ...w,
        isDelayed: w.status === 'aguardando_aprovacao' && diffHours > 1
      };
    });

    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar todos os saques (admin financeiro)
app.get('/api/withdrawals', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      ORDER BY w.created_at DESC
    `;
    
    if (status) {
      query = `
        SELECT w.*, 
          CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
          r.reason as restriction_reason
        FROM withdrawal_requests w
        LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
        WHERE w.status = $1
        ORDER BY w.created_at DESC
      `;
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saque
app.patch('/api/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminId, adminName, rejectReason, dataDebito } = req.body;
    console.log('📅 dataDebito recebido do frontend:', dataDebito);

    // Se status for aprovado ou aprovado_gratuidade, salvar a data de aprovação
    const isAprovado = status === 'aprovado' || status === 'aprovado_gratuidade';
    
    // Buscar dados do saque antes de atualizar (para pegar user_cod e valor)
    const saqueAtual = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [id]);
    if (saqueAtual.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }
    const dadosSaque = saqueAtual.rows[0];
    
    // Se for aprovação, fazer débito automático na API Plific
    if (isAprovado) {
      try {
        const valorDebito = parseFloat(dadosSaque.requested_amount);
        const idProf = dadosSaque.user_cod;
        
        // Definir descrição baseado no tipo de aprovação
        const descricaoDebito = status === 'aprovado_gratuidade' 
          ? 'Saque Emergencial - Gratuito'
          : 'Saque emergencial - Prestação de Serviços';
        
        const dataDebitoFormatada = dataDebito ? dataDebito.split('T')[0] : new Date().toISOString().split('T')[0];
        console.log(`💳 Iniciando débito Plific - Prof: ${idProf}, Tipo: ${status}, Data: ${dataDebitoFormatada}`);
        
        const urlDebito = `${PLIFIC_BASE_URL}/lancarDebitoProfissional`;
        const responseDebito = await fetch(urlDebito, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${PLIFIC_TOKEN}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            idProf: parseInt(idProf),
            valor: valorDebito,
            descricao: descricaoDebito,
            data: dataDebito ? dataDebito.split('T')[0] : new Date().toISOString().split('T')[0]
          })
        });
        
        const respostaDebito = await responseDebito.json();
        
        if (respostaDebito.status !== '200' && respostaDebito.status !== 200) {
          console.error('❌ Erro ao debitar Plific:', respostaDebito);
          return res.status(400).json({ 
            error: 'Erro ao debitar no Plific', 
            details: respostaDebito.msgUsuario || respostaDebito.dados?.msg || 'Falha no débito'
          });
        }
        
        console.log(`✅ Débito Plific realizado com sucesso - Prof: ${idProf}`);
        
        // Limpar cache do profissional para atualizar saldo
        const cacheKey = `saldo_${idProf}`;
        plificSaldoCache.delete(cacheKey);
        
      } catch (erroDebito) {
        console.error('❌ Exceção ao debitar Plific:', erroDebito);
        return res.status(500).json({ 
          error: 'Erro ao processar débito', 
          details: erroDebito.message 
        });
      }
    }
    
    // Definir a data do débito na Plific (a que foi enviada ou NOW())
    const debitoPlificAt = isAprovado ? (dataDebito || new Date().toISOString()) : null;
    
    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET status = $1, admin_id = $2, admin_name = $3, reject_reason = $4, 
           approved_at = CASE WHEN $5 THEN NOW() ELSE approved_at END,
           lancamento_at = CASE WHEN $5 THEN NOW() ELSE lancamento_at END,
           debito_plific_at = CASE WHEN $5 THEN $7::timestamp ELSE debito_plific_at END,
           updated_at = NOW() 
       WHERE id = $6 
       RETURNING *`,
      [status, adminId, adminName, rejectReason || null, isAprovado, id, debitoPlificAt]
    );

    // Registrar auditoria
    const saque = result.rows[0];
    await registrarAuditoria(req, `WITHDRAWAL_${status.toUpperCase()}`, AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: saque.user_cod,
      valor: saque.requested_amount,
      admin: adminName,
      motivo_rejeicao: rejectReason,
      debito_plific: isAprovado ? 'realizado' : null
    });

    // ==================== NOTIFICAR VIA WEBSOCKET ====================
    if (global.notifyWithdrawalUpdate) {
      global.notifyWithdrawalUpdate(result.rows[0], status);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Excluir saque
app.delete('/api/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar dados antes de excluir para auditoria
    const saqueAntes = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [id]);

    const result = await pool.query(
      'DELETE FROM withdrawal_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_DELETE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: result.rows[0].user_cod,
      valor: result.rows[0].requested_amount,
      status_anterior: result.rows[0].status
    });

    console.log('🗑️ Saque excluído:', id);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar conciliação/débito
app.patch('/api/withdrawals/:id/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { conciliacaoOmie, debito } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET conciliacao_omie = COALESCE($1, conciliacao_omie), 
           debito = COALESCE($2, debito),
           updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [conciliacaoOmie, debito, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar conciliação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito com data/hora
app.patch('/api/withdrawals/:id/debito', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitoAt } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET debito = $1, debito_at = $2, updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [debito, debitoAt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💳 Débito atualizado:', id, debito, debitoAt);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saldo
app.patch('/api/withdrawals/:id/saldo', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { saldoStatus } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET saldo_status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [saldoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💰 Saldo status atualizado:', id, saldoStatus);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saldo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard de conciliação (PROTEGIDO - apenas admin financeiro)
app.get('/api/withdrawals/dashboard/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as total_aprovados,
        COUNT(*) FILTER (WHERE conciliacao_omie = true) as total_conciliado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND conciliacao_omie = false) as pendente_conciliacao,
        COUNT(*) FILTER (WHERE debito = true) as total_debitado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND debito = false) as pendente_debito,
        COALESCE(SUM(final_amount) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')), 0) as valor_total_aprovado,
        COALESCE(SUM(final_amount) FILTER (WHERE conciliacao_omie = true), 0) as valor_conciliado,
        COALESCE(SUM(final_amount) FILTER (WHERE debito = true), 0) as valor_debitado
      FROM withdrawal_requests
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GRATUIDADES
// ============================================

// Listar todas as gratuidades
app.get('/api/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM gratuities ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM gratuities WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar gratuidades do usuário (PROTEGIDO)
app.get('/api/gratuities/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin podem ver gratuidades
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM gratuities WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar gratuidade
app.post('/api/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, quantity, value, reason, createdBy } = req.body;

    const result = await pool.query(
      `INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, 'ativa', $7) 
       RETURNING *`,
      [userCod, userName || null, quantity, quantity, value, reason || null, createdBy || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar gratuidade
app.delete('/api/gratuities/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM gratuities WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gratuidade não encontrada' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao deletar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROFISSIONAIS RESTRITOS
// ============================================

// Listar todos os restritos
app.get('/api/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM restricted_professionals ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM restricted_professionals WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar restritos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário está restrito
app.get('/api/restricted/check/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    res.json({ 
      isRestricted: result.rows.length > 0,
      restriction: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Adicionar restrição
app.post('/api/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, reason, createdBy } = req.body;

    // Verificar se já existe e está ativo
    const existing = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Profissional já está restrito' });
    }

    // Verificar se existe registro inativo (para reativar)
    const inactive = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status != 'ativo'",
      [userCod]
    );

    let result;
    if (inactive.rows.length > 0) {
      // Reativar registro existente
      result = await pool.query(
        `UPDATE restricted_professionals 
         SET user_name = $2, reason = $3, status = 'ativo', created_by = $4, created_at = NOW(), removed_at = NULL, removed_reason = NULL
         WHERE user_cod = $1
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    } else {
      // Criar novo registro
      result = await pool.query(
        `INSERT INTO restricted_professionals (user_cod, user_name, reason, status, created_by) 
         VALUES ($1, $2, $3, 'ativo', $4) 
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao adicionar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remover restrição
app.patch('/api/restricted/:id/remove', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { removedReason } = req.body;

    const result = await pool.query(
      `UPDATE restricted_professionals 
       SET status = 'removido', removed_at = NOW(), removed_reason = $1 
       WHERE id = $2 
       RETURNING *`,
      [removedReason || 'Restrição suspensa', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao remover restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NOTIFICAÇÕES (existente)
// ============================================

app.post('/api/notifications', async (req, res) => {
  try {
    const { message, type, forUser } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications (message, type, for_user, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING *`,
      [message, type, forUser]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar notificação:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;

    const result = await pool.query(
      "SELECT * FROM notifications WHERE for_user = $1 OR for_user = 'admin' ORDER BY created_at DESC LIMIT 50",
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar notificações:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// RECUPERAÇÃO DE SENHA
// ============================================

// Solicitar recuperação de senha (público - com rate limit)
app.post('/api/password-recovery', loginLimiter, async (req, res) => {
  try {
    const { cod, name } = req.body;

    console.log('🔐 Solicitação de recuperação:', { cod, name });

    // Verificar se usuário existe
    const userResult = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [cod]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Código profissional não encontrado' });
    }

    const user = userResult.rows[0];

    // Verificar se o nome confere (para segurança)
    if (user.full_name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Nome não confere com o cadastro' });
    }

    // Verificar se já existe solicitação pendente
    const existingRequest = await pool.query(
      "SELECT * FROM password_recovery WHERE LOWER(user_cod) = LOWER($1) AND status = 'pendente'",
      [cod]
    );

    if (existingRequest.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma solicitação pendente para este código' });
    }

    // Criar solicitação
    const result = await pool.query(
      `INSERT INTO password_recovery (user_cod, user_name, status, created_at) 
       VALUES ($1, $2, 'pendente', NOW()) 
       RETURNING *`,
      [cod, name]
    );

    console.log('✅ Solicitação de recuperação criada:', result.rows[0]);
    res.status(201).json({ success: true, message: 'Solicitação enviada com sucesso' });
  } catch (error) {
    console.error('❌ Erro na recuperação de senha:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar solicitações de recuperação (APENAS ADMIN)
app.get('/api/password-recovery', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_cod, user_name, status, created_at, resolved_at, resolved_by FROM password_recovery ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar recuperações:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resetar senha (APENAS ADMIN - com hash de senha)
app.patch('/api/password-recovery/:id/reset', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    console.log('🔐 Resetando senha, ID:', id, 'por:', req.user.codProfissional);

    // Validar senha
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
    }

    // Buscar solicitação
    const requestResult = await pool.query(
      'SELECT * FROM password_recovery WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    const request = requestResult.rows[0];

    // CRÍTICO: Fazer hash da senha antes de salvar!
    const hashedPassword = await hashSenha(newPassword);

    // Atualizar senha do usuário COM HASH
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE LOWER(cod_profissional) = LOWER($2)',
      [hashedPassword, request.user_cod]
    );

    // Marcar solicitação como resolvida (NÃO salvar a senha em texto plano!)
    const result = await pool.query(
      `UPDATE password_recovery 
       SET status = 'resolvido', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING id, user_cod, user_name, status, resolved_at, resolved_by`,
      [req.user.nome || req.user.codProfissional, id]
    );

    // Registrar auditoria
    await registrarAuditoria(req, 'PASSWORD_RESET', AUDIT_CATEGORIES.AUTH, 'users', request.user_cod, {
      solicitacao_id: id,
      admin: req.user.codProfissional
    });

    console.log('✅ Senha resetada com sucesso por:', req.user.codProfissional);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancelar solicitação (APENAS ADMIN)
app.delete('/api/password-recovery/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM password_recovery WHERE id = $1 RETURNING id, user_cod, user_name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    // Registrar auditoria
    await registrarAuditoria(req, 'PASSWORD_RECOVERY_DELETE', AUDIT_CATEGORIES.AUTH, 'password_recovery', id, {
      user_cod: result.rows[0].user_cod,
      admin: req.user.codProfissional
    });

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar solicitação:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROMOÇÕES DE INDICAÇÃO
// ============================================

// Listar promoções
app.get('/api/promocoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_indicacao ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuário)
app.get('/api/promocoes/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_indicacao WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar promoção
app.post('/api/promocoes', async (req, res) => {
  try {
    const { regiao, valor_bonus, detalhes, created_by } = req.body;

    console.log('📣 Criando promoção:', { regiao, valor_bonus, detalhes });

    const result = await pool.query(
      `INSERT INTO promocoes_indicacao (regiao, valor_bonus, detalhes, status, created_by, created_at) 
       VALUES ($1, $2, $3, 'ativa', $4, NOW()) 
       RETURNING *`,
      [regiao, valor_bonus, detalhes || null, created_by]
    );

    console.log('✅ Promoção criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção (status ou dados completos)
app.patch('/api/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, valor_bonus, detalhes } = req.body;

    let result;
    
    // Se só veio status, atualiza só o status
    if (status && !regiao && !valor_bonus) {
      result = await pool.query(
        'UPDATE promocoes_indicacao SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualização completa
      result = await pool.query(
        'UPDATE promocoes_indicacao SET regiao = COALESCE($1, regiao), valor_bonus = COALESCE($2, valor_bonus), detalhes = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
        [regiao, valor_bonus, detalhes, id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Excluir promoção
app.delete('/api/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM promocoes_indicacao WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INDICAÇÕES
// ============================================

// Listar todas as indicações (admin)
app.get('/api/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM indicacoes ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações do usuário
app.get('/api/indicacoes/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar indicação
app.post('/api/indicacoes', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao } = req.body;

    console.log('👥 Criando indicação:', { user_cod, indicado_nome });

    // Calcular data de expiração (30 dias)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const result = await pool.query(
      `INSERT INTO indicacoes (promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), $9) 
       RETURNING *`,
      [promocao_id, user_cod, user_name, indicado_nome, indicado_cpf || null, indicado_contato, valor_bonus, regiao, expiresAt]
    );

    console.log('✅ Indicação criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar indicação
app.patch('/api/indicacoes/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Indicação aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar indicação
app.patch('/api/indicacoes/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('❌ Indicação rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado
app.patch('/api/indicacoes/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    console.log('💰 Atualizando crédito:', { id, credito_lancado, lancado_por });

    const result = await pool.query(
      `UPDATE indicacoes 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, credito_lancado ? lancado_por : null, credito_lancado ? new Date() : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Crédito atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar indicações antigas (pode ser chamado periodicamente)
app.post('/api/indicacoes/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} indicações expiradas`);
    res.json({ expiradas: result.rows.length, indicacoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NOVO SISTEMA DE LINKS DE INDICAÇÃO
// ============================================

// Gerar token único
const gerarTokenIndicacao = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

// Gerar ou obter link de indicação do usuário
app.post('/api/indicacao-link/gerar', async (req, res) => {
  try {
    const { user_cod, user_name, promocao_id, regiao, valor_bonus } = req.body;
    
    if (!user_cod || !user_name) {
      return res.status(400).json({ error: 'user_cod e user_name são obrigatórios' });
    }
    
    // Gerar novo token único (sempre gera um novo para cada promoção)
    let token = gerarTokenIndicacao();
    let tentativas = 0;
    while (tentativas < 10) {
      const existe = await pool.query('SELECT id FROM indicacao_links WHERE token = $1', [token]);
      if (existe.rows.length === 0) break;
      token = gerarTokenIndicacao();
      tentativas++;
    }
    
    // Criar novo link com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacao_links (user_cod, user_name, token, promocao_id, regiao, valor_bonus) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_cod, user_name, token, promocao_id || null, regiao || null, valor_bonus || null]
    );
    
    console.log('✅ Link de indicação gerado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao gerar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter link existente do usuário
app.get('/api/indicacao-link/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacao_links WHERE LOWER(user_cod) = LOWER($1) AND active = TRUE',
      [userCod]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error('❌ Erro ao buscar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validar token (público - para página de cadastro)
app.get('/api/indicacao-link/validar/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      'SELECT user_cod, user_name FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    res.json({ valido: true, indicador: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao validar token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cadastrar indicado via link (público)
app.post('/api/indicacao-link/cadastrar', async (req, res) => {
  try {
    const { token, nome, telefone } = req.body;
    
    if (!token || !nome || !telefone) {
      return res.status(400).json({ error: 'Token, nome e telefone são obrigatórios' });
    }
    
    // Validar token e pegar dados da promoção
    const linkResult = await pool.query(
      'SELECT * FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    const link = linkResult.rows[0];
    
    // Verificar se este telefone já foi indicado por este usuário
    const jaIndicado = await pool.query(
      `SELECT id FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) AND indicado_contato = $2`,
      [link.user_cod, telefone]
    );
    
    if (jaIndicado.rows.length > 0) {
      return res.status(400).json({ error: 'Este telefone já foi indicado anteriormente' });
    }
    
    // Criar indicação com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacoes (user_cod, user_name, indicado_nome, indicado_contato, link_token, promocao_id, regiao, valor_bonus, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW()) RETURNING *`,
      [link.user_cod, link.user_name, nome, telefone, token, link.promocao_id, link.regiao, link.valor_bonus]
    );
    
    console.log('✅ Indicação via link cadastrada:', result.rows[0]);
    res.json({ success: true, indicacao: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao cadastrar indicado:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações recebidas via link (para admin)
app.get('/api/indicacao-link/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM indicacoes WHERE link_token IS NOT NULL ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações via link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estatísticas de indicações por usuário
app.get('/api/indicacao-link/estatisticas/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes,
        COUNT(CASE WHEN status = 'aprovada' THEN 1 END) as aprovadas,
        COUNT(CASE WHEN status = 'rejeitada' THEN 1 END) as rejeitadas
       FROM indicacoes 
       WHERE LOWER(user_cod) = LOWER($1) AND link_token IS NOT NULL`,
      [userCod]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROMOÇÕES NOVATOS
// ============================================

// Listar regiões disponíveis da planilha (para criar promoções)
app.get('/api/promocoes-novatos/regioes', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    const regioes = new Set();
    lines.forEach(line => {
      const cols = line.split(',');
      const cidade = cols[3]?.trim(); // coluna Cidade (índice 3 = coluna D)
      if (cidade && cidade.length > 0 && cidade !== '') {
        regioes.add(cidade);
      }
    });
    
    res.json([...regioes].sort());
  } catch (err) {
    console.error('❌ Erro ao buscar regiões para novatos:', err);
    res.json([]);
  }
});

// Verificar elegibilidade do usuário para promoções novatos
// Regras: 
// 1. Deve haver promoção ativa para a região do usuário (região vem da planilha)
// 2. Usuário nunca realizou nenhuma corrida OU não realizou corrida nos últimos 15 dias
app.get('/api/promocoes-novatos/elegibilidade/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // Buscar região do usuário na planilha do Google Sheets
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    const sheetText = await sheetResponse.text();
    const sheetLines = sheetText.split('\n').slice(1); // pular header
    
    let userRegiao = null;
    for (const line of sheetLines) {
      const cols = line.split(',');
      if (cols[0]?.trim() === userCod.toString()) {
        userRegiao = cols[3]?.trim(); // coluna Cidade (índice 3 = coluna D)
        break;
      }
    }
    
    // Verificar se há promoções ativas
    const promoResult = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa'"
    );
    
    if (promoResult.rows.length === 0) {
      return res.json({ 
        elegivel: false, 
        motivo: 'Nenhuma promoção ativa no momento',
        promocoes: [],
        userRegiao
      });
    }
    
    // Verificar histórico de entregas do usuário
    // cod_prof na bi_entregas é INTEGER, userCod pode ser string
    const userCodNumerico = parseInt(userCod.toString().replace(/\D/g, ''), 10);
    
    const entregasResult = await pool.query(`
      SELECT 
        COUNT(*) as total_entregas,
        MAX(data_solicitado) as ultima_entrega
      FROM bi_entregas 
      WHERE cod_prof = $1
    `, [userCodNumerico]);
    
    const totalEntregas = parseInt(entregasResult.rows[0]?.total_entregas) || 0;
    const ultimaEntrega = entregasResult.rows[0]?.ultima_entrega;
    
    // Calcular dias desde a última entrega
    let diasSemEntrega = null;
    if (ultimaEntrega) {
      const hoje = new Date();
      const dataUltima = new Date(ultimaEntrega);
      diasSemEntrega = Math.floor((hoje - dataUltima) / (1000 * 60 * 60 * 24));
    }
    
    // Verificar elegibilidade:
    // - Nunca fez entrega (totalEntregas === 0) OU
    // - Não fez entrega nos últimos 15 dias (diasSemEntrega >= 15)
    const elegivelPorEntregas = totalEntregas === 0 || (diasSemEntrega !== null && diasSemEntrega >= 15);
    
    if (!elegivelPorEntregas) {
      return res.json({
        elegivel: false,
        motivo: `Você realizou entregas recentemente (última há ${diasSemEntrega} dias). Promoção disponível apenas para quem não fez entregas nos últimos 15 dias.`,
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao
      });
    }
    
    // Filtrar promoções por região do usuário
    let promocoesDisponiveis = promoResult.rows;
    
    // Se o usuário tem região na planilha, filtrar promoções compatíveis
    if (userRegiao) {
      promocoesDisponiveis = promoResult.rows.filter(promo => {
        const regiaoPromo = (promo.regiao || '').toLowerCase().trim();
        const regiaoUser = userRegiao.toLowerCase().trim();
        
        // Compatível se:
        // - Região da promoção é igual à região do usuário
        // - Região da promoção contém a região do usuário (ou vice-versa)
        // - Região da promoção é "Todas", "Geral" ou vazia
        return regiaoPromo === regiaoUser ||
               regiaoPromo.includes(regiaoUser) || 
               regiaoUser.includes(regiaoPromo) ||
               regiaoPromo.includes('todas') || 
               regiaoPromo.includes('geral') ||
               regiaoPromo === '' ||
               !promo.regiao;
      });
    }
    
    if (promocoesDisponiveis.length === 0) {
      return res.json({
        elegivel: false,
        motivo: userRegiao 
          ? `Não há promoções ativas para sua região (${userRegiao}).` 
          : 'Você não está cadastrado na planilha de profissionais ou não tem região definida.',
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao
      });
    }
    
    res.json({
      elegivel: true,
      motivo: totalEntregas === 0 
        ? 'Você é um novo profissional! Aproveite as promoções.' 
        : `Você não realiza entregas há ${diasSemEntrega} dias. Volte a entregar com bônus!`,
      promocoes: promocoesDisponiveis,
      totalEntregas,
      diasSemEntrega,
      userRegiao
    });
    
  } catch (error) {
    console.error('❌ Erro ao verificar elegibilidade novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar todas as promoções de novatos
app.get('/api/promocoes-novatos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_novatos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuários)
app.get('/api/promocoes-novatos/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar nova promoção novatos
app.post('/api/promocoes-novatos', async (req, res) => {
  try {
    const { regiao, cliente, valor_bonus, detalhes, created_by } = req.body;

    const result = await pool.query(
      `INSERT INTO promocoes_novatos (regiao, cliente, valor_bonus, detalhes, status, created_by, created_at) 
       VALUES ($1, $2, $3, $4, 'ativa', $5, NOW()) 
       RETURNING *`,
      [regiao, cliente, valor_bonus, detalhes || null, created_by || 'Admin']
    );

    console.log('✅ Promoção novatos criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção novatos (status ou dados)
app.patch('/api/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, cliente, valor_bonus, detalhes } = req.body;

    let result;
    if (status && !regiao) {
      // Apenas atualizar status
      result = await pool.query(
        'UPDATE promocoes_novatos SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualizar todos os campos
      result = await pool.query(
        'UPDATE promocoes_novatos SET regiao = COALESCE($1, regiao), cliente = COALESCE($2, cliente), valor_bonus = COALESCE($3, valor_bonus), detalhes = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
        [regiao, cliente, valor_bonus, detalhes, id]
      );
    }

    console.log('✅ Promoção novatos atualizada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar promoção novatos
app.delete('/api/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se tem inscrições pendentes
    const inscricoes = await pool.query(
      "SELECT COUNT(*) FROM inscricoes_novatos WHERE promocao_id = $1 AND status = 'pendente'",
      [id]
    );
    
    if (parseInt(inscricoes.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Não é possível deletar promoção com inscrições pendentes' });
    }

    const result = await pool.query(
      'DELETE FROM promocoes_novatos WHERE id = $1 RETURNING *',
      [id]
    );

    console.log('🗑️ Promoção novatos deletada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao deletar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INSCRIÇÕES NOVATOS
// ============================================

// Listar todas as inscrições (admin)
app.get('/api/inscricoes-novatos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar inscrições de um usuário
app.get('/api/inscricoes-novatos/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar inscrição novatos (usuário se inscreve)
app.post('/api/inscricoes-novatos', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, valor_bonus, regiao, cliente } = req.body;

    // Verificar se já está inscrito nesta promoção
    const existing = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE promocao_id = $1 AND LOWER(user_cod) = LOWER($2)',
      [promocao_id, user_cod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já está inscrito nesta promoção' });
    }

    // Criar inscrição com expiração em 10 dias
    const result = await pool.query(
      `INSERT INTO inscricoes_novatos (promocao_id, user_cod, user_name, valor_bonus, regiao, cliente, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW(), NOW() + INTERVAL '10 days') 
       RETURNING *`,
      [promocao_id, user_cod, user_name, valor_bonus, regiao, cliente]
    );

    console.log('✅ Inscrição novatos criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar inscrição novatos
app.patch('/api/inscricoes-novatos/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by || 'Admin', id]
    );

    console.log('✅ Inscrição novatos aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar inscrição novatos
app.patch('/api/inscricoes-novatos/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by || 'Admin', id]
    );

    console.log('❌ Inscrição novatos rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado para inscrição novatos
app.patch('/api/inscricoes-novatos/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, lancado_por, credito_lancado ? new Date() : null, id]
    );

    console.log('💰 Crédito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar inscrições novatos antigas (chamado periodicamente)
app.post('/api/inscricoes-novatos/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} inscrições novatos expiradas`);
    res.json({ expiradas: result.rows.length, inscricoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito para inscrição novatos
app.patch('/api/inscricoes-novatos/:id/debito', async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET debito = $1, debitado_por = $2, debitado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [debito, debitado_por, debito ? new Date() : null, id]
    );

    console.log('💳 Débito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// QUIZ DE PROCEDIMENTOS (Promoção Novato)
// ============================================

// Obter configuração do quiz
app.get('/api/quiz-procedimentos/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      // Retorna config padrão vazia
      return res.json({
        titulo: 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagens: [null, null, null, null],
        perguntas: [
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true }
        ],
        valor_gratuidade: 500.00,
        ativo: false
      });
    }
    const config = result.rows[0];
    res.json({
      id: config.id,
      titulo: config.titulo,
      imagens: [config.imagem1, config.imagem2, config.imagem3, config.imagem4],
      perguntas: [
        { texto: config.pergunta1, resposta: config.resposta1 },
        { texto: config.pergunta2, resposta: config.resposta2 },
        { texto: config.pergunta3, resposta: config.resposta3 },
        { texto: config.pergunta4, resposta: config.resposta4 },
        { texto: config.pergunta5, resposta: config.resposta5 }
      ],
      valor_gratuidade: parseFloat(config.valor_gratuidade),
      ativo: config.ativo
    });
  } catch (error) {
    console.error('❌ Erro ao obter config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Salvar configuração do quiz
app.post('/api/quiz-procedimentos/config', async (req, res) => {
  try {
    const { titulo, imagens, perguntas, valor_gratuidade, ativo } = req.body;
    
    // Verificar se já existe config
    const existing = await pool.query('SELECT id FROM quiz_procedimentos_config LIMIT 1');
    
    if (existing.rows.length > 0) {
      // Atualizar
      await pool.query(
        `UPDATE quiz_procedimentos_config SET 
          titulo = $1,
          imagem1 = $2, imagem2 = $3, imagem3 = $4, imagem4 = $5,
          pergunta1 = $6, resposta1 = $7,
          pergunta2 = $8, resposta2 = $9,
          pergunta3 = $10, resposta3 = $11,
          pergunta4 = $12, resposta4 = $13,
          pergunta5 = $14, resposta5 = $15,
          valor_gratuidade = $16, ativo = $17, updated_at = NOW()
        WHERE id = $18`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo,
          existing.rows[0].id
        ]
      );
    } else {
      // Inserir
      await pool.query(
        `INSERT INTO quiz_procedimentos_config 
          (titulo, imagem1, imagem2, imagem3, imagem4, 
           pergunta1, resposta1, pergunta2, resposta2, pergunta3, resposta3,
           pergunta4, resposta4, pergunta5, resposta5, valor_gratuidade, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo
        ]
      );
    }
    
    console.log('✅ Config quiz salva');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário já respondeu o quiz
app.get('/api/quiz-procedimentos/verificar/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [userCod]
    );
    res.json({ 
      ja_respondeu: result.rows.length > 0,
      dados: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar quiz:', error);
    res.json({ ja_respondeu: false });
  }
});

// Responder o quiz
app.post('/api/quiz-procedimentos/responder', async (req, res) => {
  try {
    const { user_cod, user_name, respostas } = req.body;
    
    // Verificar se já respondeu
    const existing = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [user_cod]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já respondeu este quiz' });
    }
    
    // Buscar config para verificar respostas corretas
    const configResult = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (configResult.rows.length === 0) {
      return res.status(400).json({ error: 'Quiz não configurado' });
    }
    
    const config = configResult.rows[0];
    const respostasCorretas = [
      config.resposta1, config.resposta2, config.resposta3, config.resposta4, config.resposta5
    ];
    
    // Contar acertos
    let acertos = 0;
    for (let i = 0; i < 5; i++) {
      if (respostas[i] === respostasCorretas[i]) acertos++;
    }
    
    const passou = acertos === 5;
    
    // Registrar resposta
    await pool.query(
      `INSERT INTO quiz_procedimentos_respostas (user_cod, user_name, acertos, passou, gratuidade_criada)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_cod, user_name, acertos, passou, passou]
    );
    
    // Se passou, criar gratuidade automaticamente
    if (passou) {
      await pool.query(
        `INSERT INTO gratuities (user_cod, quantity, remaining, value, reason, status, created_at)
         VALUES ($1, 1, 1, $2, 'Promoção Novato', 'ativa', NOW())`,
        [user_cod, config.valor_gratuidade]
      );
      console.log(`🎉 Gratuidade criada para ${user_name} (${user_cod}): R$ ${config.valor_gratuidade}`);
    }
    
    res.json({ 
      success: true, 
      acertos, 
      passou,
      valor_gratuidade: passou ? parseFloat(config.valor_gratuidade) : 0
    });
  } catch (error) {
    console.error('❌ Erro ao responder quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar quem respondeu o quiz (admin)
app.get('/api/quiz-procedimentos/respostas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar respostas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DISPONIBILIDADE - ROTAS
// ============================================

// GET /api/disponibilidade - Lista todas as regiões, lojas e linhas
app.get('/api/disponibilidade', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    res.json({
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar disponibilidade:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// POST /api/disponibilidade/regioes - Criar região
app.post('/api/disponibilidade/regioes', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    
    const result = await pool.query(
      'INSERT INTO disponibilidade_regioes (nome) VALUES ($1) RETURNING *',
      [nome.toUpperCase().trim()]
    );
    console.log('✅ Região criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Região já existe' });
    }
    console.error('❌ Erro ao criar região:', err);
    res.status(500).json({ error: 'Erro ao criar região' });
  }
});

// PUT /api/disponibilidade/regioes/:id - Atualizar região
app.put('/api/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, gestores, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_regioes 
       SET nome = COALESCE($1, nome), gestores = COALESCE($2, gestores), ordem = COALESCE($3, ordem), updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [nome ? nome.toUpperCase().trim() : null, gestores !== undefined ? gestores : null, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// DELETE /api/disponibilidade/regioes/:id - Deletar região
app.delete('/api/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_regioes WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    console.log('🗑️ Região deletada:', result.rows[0]);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar região:', err);
    res.status(500).json({ error: 'Erro ao deletar região' });
  }
});

// POST /api/disponibilidade/lojas - Criar loja com linhas
app.post('/api/disponibilidade/lojas', async (req, res) => {
  try {
    const { regiao_id, codigo, nome, qtd_titulares, qtd_excedentes } = req.body;
    
    if (!regiao_id || !codigo || !nome) {
      return res.status(400).json({ error: 'Campos obrigatórios: regiao_id, codigo, nome' });
    }
    
    // Verificar se região existe
    const regiaoCheck = await pool.query('SELECT id FROM disponibilidade_regioes WHERE id = $1', [regiao_id]);
    if (regiaoCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Região não encontrada' });
    }
    
    const titulares = Math.min(parseInt(qtd_titulares) || 0, 50);
    const excedentes = Math.min(parseInt(qtd_excedentes) || 0, 50);
    
    // Criar loja
    const lojaResult = await pool.query(
      'INSERT INTO disponibilidade_lojas (regiao_id, codigo, nome, qtd_titulares, qtd_excedentes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [regiao_id, codigo.trim(), nome.toUpperCase().trim(), titulares, excedentes]
    );
    const loja = lojaResult.rows[0];
    
    // Criar linhas vazias
    const linhas = [];
    
    // Criar linhas de titulares
    for (let i = 0; i < titulares; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', false]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    // Criar linhas de excedentes
    for (let i = 0; i < excedentes; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', true]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    console.log('✅ Loja criada:', loja.nome, 'com', titulares, 'titulares e', excedentes, 'excedentes');
    res.json({ loja, linhas });
  } catch (err) {
    console.error('❌ Erro ao criar loja:', err);
    res.status(500).json({ error: 'Erro ao criar loja' });
  }
});

// PUT /api/disponibilidade/lojas/:id - Atualizar loja
app.put('/api/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, nome, qtd_titulares, qtd_excedentes, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_lojas 
       SET codigo = COALESCE($1, codigo), 
           nome = COALESCE($2, nome), 
           qtd_titulares = COALESCE($3, qtd_titulares),
           qtd_excedentes = COALESCE($4, qtd_excedentes),
           ordem = COALESCE($5, ordem), 
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [codigo, nome ? nome.toUpperCase().trim() : null, qtd_titulares, qtd_excedentes, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('✅ Loja atualizada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar loja:', err);
    res.status(500).json({ error: 'Erro ao atualizar loja' });
  }
});

// DELETE /api/disponibilidade/lojas/:id - Deletar loja
app.delete('/api/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_lojas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('🗑️ Loja deletada:', result.rows[0]);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar loja:', err);
    res.status(500).json({ error: 'Erro ao deletar loja' });
  }
});

// POST /api/disponibilidade/linhas - Adicionar linhas a uma loja
app.post('/api/disponibilidade/linhas', async (req, res) => {
  try {
    const { loja_id, quantidade, is_excedente } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    // Verificar se loja existe
    const lojaCheck = await pool.query('SELECT id FROM disponibilidade_lojas WHERE id = $1', [loja_id]);
    if (lojaCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Loja não encontrada' });
    }
    
    const qtd = Math.min(parseInt(quantidade) || 1, 50);
    const excedente = is_excedente === true;
    const linhas = [];
    
    for (let i = 0; i < qtd; i++) {
      const result = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja_id, 'A CONFIRMAR', excedente]
      );
      linhas.push(result.rows[0]);
    }
    
    console.log('✅', qtd, excedente ? 'excedente(s)' : 'titular(es)', 'adicionado(s) à loja', loja_id);
    res.json(linhas);
  } catch (err) {
    console.error('❌ Erro ao criar linhas:', err);
    res.status(500).json({ error: 'Erro ao criar linhas' });
  }
});

// PUT /api/disponibilidade/linhas/:id - Atualizar linha
app.put('/api/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, nome_profissional, status, observacao, observacao_usuario } = req.body;
    
    // Validar status - incluindo SEM CONTATO e A CAMINHO
    const statusValidos = ['A CONFIRMAR', 'CONFIRMADO', 'A CAMINHO', 'EM LOJA', 'FALTANDO', 'SEM CONTATO'];
    const statusFinal = statusValidos.includes(status) ? status : 'A CONFIRMAR';
    
    // Buscar linha atual para verificar se observação mudou
    const linhaAtual = await pool.query('SELECT observacao FROM disponibilidade_linhas WHERE id = $1', [id]);
    const obsAtual = linhaAtual.rows[0]?.observacao || '';
    const obsNova = observacao || '';
    
    // Se observação foi adicionada ou modificada, registrar quem e quando
    let observacaoCriadaPor = null;
    let observacaoCriadaEm = null;
    
    if (obsNova && obsNova !== obsAtual) {
      // Observação foi modificada ou criada - registrar metadados
      observacaoCriadaPor = observacao_usuario || 'Sistema';
      observacaoCriadaEm = new Date();
    } else if (obsNova) {
      // Observação não mudou - manter os metadados existentes
      const metadados = await pool.query(
        'SELECT observacao_criada_por, observacao_criada_em FROM disponibilidade_linhas WHERE id = $1',
        [id]
      );
      if (metadados.rows.length > 0) {
        observacaoCriadaPor = metadados.rows[0].observacao_criada_por;
        observacaoCriadaEm = metadados.rows[0].observacao_criada_em;
      }
    }
    // Se observação foi removida (obsNova vazio), os metadados ficam null
    
    const result = await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = $1, 
           nome_profissional = $2, 
           status = $3, 
           observacao = $4,
           observacao_criada_por = $5,
           observacao_criada_em = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [
        cod_profissional || null, 
        nome_profissional || null, 
        statusFinal, 
        observacao || null,
        observacaoCriadaPor,
        observacaoCriadaEm,
        id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar linha:', err);
    res.status(500).json({ error: 'Erro ao atualizar linha' });
  }
});

// DELETE /api/disponibilidade/linhas/:id - Deletar linha
app.delete('/api/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar linha:', err);
    res.status(500).json({ error: 'Erro ao deletar linha' });
  }
});

// DELETE /api/disponibilidade/limpar-linhas - Limpa todas as linhas (mantém estrutura)
app.delete('/api/disponibilidade/limpar-linhas', async (req, res) => {
  try {
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL, updated_at = CURRENT_TIMESTAMP`
    );
    console.log('🧹 Todas as linhas de disponibilidade foram resetadas');
    res.json({ success: true, message: 'Todas as linhas foram resetadas' });
  } catch (err) {
    console.error('❌ Erro ao limpar linhas:', err);
    res.status(500).json({ error: 'Erro ao limpar linhas' });
  }
});

// ============================================
// FALTOSOS
// ============================================

// POST /api/disponibilidade/faltosos - Registrar faltoso
app.post('/api/disponibilidade/faltosos', async (req, res) => {
  try {
    const { loja_id, cod_profissional, nome_profissional, motivo, data_falta } = req.body;
    
    if (!loja_id || !motivo) {
      return res.status(400).json({ error: 'Campos obrigatórios: loja_id, motivo' });
    }
    
    // Usar data_falta enviada ou data atual
    const dataFalta = data_falta || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_faltosos (loja_id, cod_profissional, nome_profissional, motivo, data_falta)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [loja_id, cod_profissional || null, nome_profissional || null, motivo, dataFalta]
    );
    
    console.log('⚠️ Faltoso registrado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao registrar faltoso:', err);
    res.status(500).json({ error: 'Erro ao registrar faltoso' });
  }
});

// GET /api/disponibilidade/faltosos - Listar faltosos com filtros
app.get('/api/disponibilidade/faltosos', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT f.*, l.codigo as loja_codigo, l.nome as loja_nome, r.nome as regiao_nome
      FROM disponibilidade_faltosos f
      JOIN disponibilidade_lojas l ON f.loja_id = l.id
      JOIN disponibilidade_regioes r ON l.regiao_id = r.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND f.data_falta >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND f.data_falta <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND f.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY f.data_falta DESC, f.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar faltosos:', err);
    res.status(500).json({ error: 'Erro ao listar faltosos' });
  }
});

// DELETE /api/disponibilidade/faltosos/:id - Excluir registro de falta
app.delete('/api/disponibilidade/faltosos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM disponibilidade_faltosos WHERE id = $1', [id]);
    console.log('🗑️ Falta excluída:', id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir falta:', err);
    res.status(500).json({ error: 'Erro ao excluir falta' });
  }
});

// POST /api/disponibilidade/linha-reposicao - Criar linha de reposição
app.post('/api/disponibilidade/linha-reposicao', async (req, res) => {
  try {
    const { loja_id, after_linha_id } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_linhas (loja_id, status, is_reposicao)
       VALUES ($1, 'A CONFIRMAR', true) RETURNING *`,
      [loja_id]
    );
    
    console.log('🔄 Linha de reposição criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar linha de reposição:', err);
    res.status(500).json({ error: 'Erro ao criar linha de reposição' });
  }
});

// GET /api/disponibilidade/em-loja - Listar registros de motoboys EM LOJA
app.get('/api/disponibilidade/em-loja', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT e.*, l.nome as loja_nome
      FROM disponibilidade_em_loja e
      LEFT JOIN disponibilidade_lojas l ON e.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND e.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND e.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND e.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY e.data_registro DESC, e.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar em loja:', err);
    res.status(500).json({ error: 'Erro ao listar em loja' });
  }
});

// GET /api/disponibilidade/sem-contato - Listar registros de motoboys SEM CONTATO
app.get('/api/disponibilidade/sem-contato', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id, apenas_risco } = req.query;
    
    let query = `
      SELECT s.*, l.nome as loja_nome
      FROM disponibilidade_sem_contato s
      LEFT JOIN disponibilidade_lojas l ON s.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND s.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND s.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND s.loja_id = $${params.length}`;
    }
    if (apenas_risco === 'true') {
      // Apenas motoboys com 2+ dias (risco de remoção)
      query += ` AND s.dias_consecutivos >= 2`;
    }
    
    query += ' ORDER BY s.dias_consecutivos DESC, s.data_registro DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sem contato:', err);
    res.status(500).json({ error: 'Erro ao listar sem contato' });
  }
});

// GET /api/disponibilidade/ranking-em-loja - Ranking de motoboys que mais trabalharam
app.get('/api/disponibilidade/ranking-em-loja', async (req, res) => {
  try {
    const { dias = 30 } = req.query;
    
    const result = await pool.query(`
      SELECT 
        cod_profissional,
        nome_profissional,
        COUNT(*) as total_dias,
        MAX(data_registro) as ultimo_dia
      FROM disponibilidade_em_loja
      WHERE data_registro >= CURRENT_DATE - $1::int
      AND cod_profissional IS NOT NULL
      GROUP BY cod_profissional, nome_profissional
      ORDER BY total_dias DESC
      LIMIT 20
    `, [dias]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking em loja:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking em loja' });
  }
});

// GET /api/disponibilidade/motoboys - Listar todos os motoboys com histórico completo
app.get('/api/disponibilidade/motoboys', async (req, res) => {
  try {
    const { loja_id, busca, dias = 30 } = req.query;
    
    // 1. Buscar todos os motoboys únicos das linhas (atuais e históricos)
    let motoboyQuery = `
      SELECT DISTINCT 
        cod_profissional,
        nome_profissional,
        loja_id
      FROM disponibilidade_linhas
      WHERE cod_profissional IS NOT NULL AND cod_profissional != ''
    `;
    
    const params = [];
    
    if (loja_id) {
      params.push(loja_id);
      motoboyQuery += ` AND loja_id = $${params.length}`;
    }
    
    if (busca) {
      params.push(`%${busca}%`);
      motoboyQuery += ` AND (cod_profissional ILIKE $${params.length} OR nome_profissional ILIKE $${params.length})`;
    }
    
    const motoboysResult = await pool.query(motoboyQuery, params);
    
    // 2. Para cada motoboy, buscar estatísticas
    const motoboys = [];
    
    for (const mb of motoboysResult.rows) {
      // Buscar contagem de EM LOJA
      const emLojaResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez
        FROM disponibilidade_em_loja
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de SEM CONTATO
      const semContatoResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez, MAX(dias_consecutivos) as max_dias
        FROM disponibilidade_sem_contato
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de FALTAS
      const faltasResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_falta) as ultima_falta
        FROM disponibilidade_faltosos
        WHERE cod_profissional = $1
        AND data_falta >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar lojas onde rodou
      const lojasResult = await pool.query(`
        SELECT DISTINCT l.id, l.nome, l.codigo
        FROM disponibilidade_em_loja el
        JOIN disponibilidade_lojas l ON el.loja_id = l.id
        WHERE el.cod_profissional = $1
        AND el.data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar info da loja atual
      const lojaAtualResult = await pool.query(`
        SELECT l.id, l.nome, l.codigo, r.nome as regiao_nome
        FROM disponibilidade_lojas l
        LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
        WHERE l.id = $1
      `, [mb.loja_id]);
      
      // Buscar status atual
      const statusAtualResult = await pool.query(`
        SELECT status, observacao
        FROM disponibilidade_linhas
        WHERE cod_profissional = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [mb.cod_profissional]);
      
      motoboys.push({
        cod: mb.cod_profissional,
        nome: mb.nome_profissional,
        loja_id: mb.loja_id,
        loja_atual: lojaAtualResult.rows[0] || null,
        status_atual: statusAtualResult.rows[0]?.status || 'A CONFIRMAR',
        observacao: statusAtualResult.rows[0]?.observacao || null,
        estatisticas: {
          em_loja: {
            total: parseInt(emLojaResult.rows[0]?.total) || 0,
            ultima_vez: emLojaResult.rows[0]?.ultima_vez || null
          },
          sem_contato: {
            total: parseInt(semContatoResult.rows[0]?.total) || 0,
            ultima_vez: semContatoResult.rows[0]?.ultima_vez || null,
            max_dias_consecutivos: parseInt(semContatoResult.rows[0]?.max_dias) || 0
          },
          faltas: {
            total: parseInt(faltasResult.rows[0]?.total) || 0,
            ultima_falta: faltasResult.rows[0]?.ultima_falta || null
          }
        },
        lojas_rodou: lojasResult.rows
      });
    }
    
    // Ordenar por nome
    motoboys.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    
    res.json({
      total: motoboys.length,
      periodo_dias: parseInt(dias),
      motoboys
    });
  } catch (err) {
    console.error('❌ Erro ao buscar motoboys:', err);
    res.status(500).json({ error: 'Erro ao buscar motoboys' });
  }
});

// ============================================
// RESTRIÇÕES DE MOTOBOYS
// ============================================

// GET /api/disponibilidade/restricoes - Listar todas as restrições
app.get('/api/disponibilidade/restricoes', async (req, res) => {
  try {
    const { ativo = 'true' } = req.query;
    
    let query = `
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
    `;
    
    if (ativo === 'true') {
      query += ' WHERE r.ativo = true';
    }
    
    query += ' ORDER BY r.created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar restrições:', err);
    res.status(500).json({ error: 'Erro ao buscar restrições' });
  }
});

// GET /api/disponibilidade/restricoes/verificar - Verificar se um motoboy está restrito em uma loja
app.get('/api/disponibilidade/restricoes/verificar', async (req, res) => {
  try {
    const { cod_profissional, loja_id } = req.query;
    
    if (!cod_profissional) {
      return res.json({ restrito: false });
    }
    
    // Verifica se está restrito em TODAS as lojas ou na loja específica
    const result = await pool.query(`
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
      WHERE r.cod_profissional = $1 
      AND r.ativo = true
      AND (r.todas_lojas = true OR r.loja_id = $2)
      LIMIT 1
    `, [cod_profissional, loja_id || null]);
    
    if (result.rows.length > 0) {
      const restricao = result.rows[0];
      res.json({
        restrito: true,
        motivo: restricao.motivo,
        todas_lojas: restricao.todas_lojas,
        loja_nome: restricao.loja_nome,
        loja_codigo: restricao.loja_codigo,
        criado_em: restricao.created_at
      });
    } else {
      res.json({ restrito: false });
    }
  } catch (err) {
    console.error('❌ Erro ao verificar restrição:', err);
    res.status(500).json({ error: 'Erro ao verificar restrição' });
  }
});

// POST /api/disponibilidade/restricoes - Criar nova restrição
app.post('/api/disponibilidade/restricoes', async (req, res) => {
  try {
    const { cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por } = req.body;
    
    if (!cod_profissional || !motivo) {
      return res.status(400).json({ error: 'Código e motivo são obrigatórios' });
    }
    
    // Verificar se já existe restrição ativa para este motoboy nesta loja
    const existente = await pool.query(`
      SELECT id FROM disponibilidade_restricoes 
      WHERE cod_profissional = $1 
      AND ativo = true
      AND (todas_lojas = true OR loja_id = $2 OR $3 = true)
    `, [cod_profissional, loja_id || null, todas_lojas || false]);
    
    if (existente.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma restrição ativa para este motoboy nesta loja' });
    }
    
    const result = await pool.query(`
      INSERT INTO disponibilidade_restricoes 
      (cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      cod_profissional,
      nome_profissional || null,
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      criado_por || null
    ]);
    
    console.log(`🚫 Nova restrição criada: ${cod_profissional} - ${nome_profissional}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar restrição:', err);
    res.status(500).json({ error: 'Erro ao criar restrição' });
  }
});

// PUT /api/disponibilidade/restricoes/:id - Atualizar restrição
app.put('/api/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { loja_id, todas_lojas, motivo, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET loja_id = $1, todas_lojas = $2, motivo = $3, ativo = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      ativo !== undefined ? ativo : true,
      id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar restrição:', err);
    res.status(500).json({ error: 'Erro ao atualizar restrição' });
  }
});

// DELETE /api/disponibilidade/restricoes/:id - Remover restrição (desativar)
app.delete('/api/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ao invés de deletar, desativa
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET ativo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    console.log(`✅ Restrição ${id} desativada`);
    res.json({ success: true, message: 'Restrição removida' });
  } catch (err) {
    console.error('❌ Erro ao remover restrição:', err);
    res.status(500).json({ error: 'Erro ao remover restrição' });
  }
});

// ============================================
// ESPELHO (Histórico)
// ============================================

// POST /api/disponibilidade/espelho - Salvar snapshot antes do reset
app.post('/api/disponibilidade/espelho', async (req, res) => {
  try {
    // Buscar todos os dados atuais
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      salvo_em: new Date().toISOString()
    };
    
    // Verificar se já existe espelho para hoje
    const hoje = new Date().toISOString().split('T')[0];
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [hoje]
    );
    
    if (existing.rows.length > 0) {
      // Atualizar o existente
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1 WHERE data_registro = $2',
        [JSON.stringify(dados), hoje]
      );
    } else {
      // Criar novo
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [hoje, JSON.stringify(dados)]
      );
    }
    
    console.log('📸 Espelho salvo para', hoje);
    res.json({ success: true, data: hoje });
  } catch (err) {
    console.error('❌ Erro ao salvar espelho:', err);
    res.status(500).json({ error: 'Erro ao salvar espelho' });
  }
});

// GET /api/disponibilidade/espelho - Listar datas disponíveis
app.get('/api/disponibilidade/espelho', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, data_registro, created_at FROM disponibilidade_espelho ORDER BY data_registro DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar espelhos:', err);
    res.status(500).json({ error: 'Erro ao listar espelhos' });
  }
});

// GET /api/disponibilidade/espelho/:data - Buscar espelho por data
app.get('/api/disponibilidade/espelho/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(
      'SELECT * FROM disponibilidade_espelho WHERE data_registro = $1',
      [data]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Espelho não encontrado para esta data' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar espelho:', err);
    res.status(500).json({ error: 'Erro ao buscar espelho' });
  }
});

// DELETE /api/disponibilidade/espelho/:id - Excluir espelho por ID
app.delete('/api/disponibilidade/espelho/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_espelho WHERE id = $1 RETURNING data_registro', [id]);
    if (result.rows.length > 0) {
      console.log('🗑️ Espelho excluído:', result.rows[0].data_registro);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir espelho:', err);
    res.status(500).json({ error: 'Erro ao excluir espelho' });
  }
});

// PATCH /api/disponibilidade/faltosos/corrigir-datas - Corrigir datas erradas
app.patch('/api/disponibilidade/faltosos/corrigir-datas', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_faltosos SET data_falta = $1 WHERE data_falta = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Datas corrigidas: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir datas:', err);
    res.status(500).json({ error: 'Erro ao corrigir datas' });
  }
});

// PATCH /api/disponibilidade/espelho/corrigir-data - Corrigir data do espelho
app.patch('/api/disponibilidade/espelho/corrigir-data', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_espelho SET data_registro = $1 WHERE data_registro = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Data do espelho corrigida: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir data do espelho:', err);
    res.status(500).json({ error: 'Erro ao corrigir data do espelho' });
  }
});

// POST /api/disponibilidade/resetar - Resetar status (com salvamento de espelho)
app.post('/api/disponibilidade/resetar', async (req, res) => {
  try {
    // Pegar a data da planilha (enviada pelo frontend) ou usar hoje
    const { data_planilha } = req.body || {};
    const dataEspelho = data_planilha || new Date().toISOString().split('T')[0];
    
    // 1. Salvar espelho antes de resetar
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      data_planilha: dataEspelho,
      salvo_em: new Date().toISOString()
    };
    
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [dataEspelho]
    );
    
    let espelhoSalvo = false;
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1, created_at = CURRENT_TIMESTAMP WHERE data_registro = $2',
        [JSON.stringify(dados), dataEspelho]
      );
      espelhoSalvo = true;
    } else {
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [dataEspelho, JSON.stringify(dados)]
      );
      espelhoSalvo = true;
    }
    console.log('📸 Espelho salvo antes do reset:', dataEspelho, '- Linhas:', linhas.rows.length);
    
    // 1.5. SALVAR OBSERVAÇÕES NO HISTÓRICO antes de resetar
    const linhasComObs = linhas.rows.filter(l => l.observacao && l.observacao.trim() !== '');
    let observacoesSalvas = 0;
    
    for (const linha of linhasComObs) {
      await pool.query(
        `INSERT INTO disponibilidade_observacoes_historico 
         (linha_id, loja_id, cod_profissional, nome_profissional, observacao, criada_por, criada_em, data_reset, data_planilha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
        [
          linha.id,
          linha.loja_id,
          linha.cod_profissional,
          linha.nome_profissional,
          linha.observacao,
          linha.observacao_criada_por,
          linha.observacao_criada_em,
          dataEspelho
        ]
      );
      observacoesSalvas++;
    }
    console.log('📝 Observações salvas no histórico:', observacoesSalvas);
    
    // 2. REGISTRAR MOTOBOYS "EM LOJA" antes de resetar
    const emLojaLinhas = linhas.rows.filter(l => l.status === 'EM LOJA' && l.cod_profissional);
    for (const linha of emLojaLinhas) {
      await pool.query(
        `INSERT INTO disponibilidade_em_loja (loja_id, cod_profissional, nome_profissional, data_registro)
         VALUES ($1, $2, $3, $4)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho]
      );
    }
    console.log('🏪 Motoboys EM LOJA registrados:', emLojaLinhas.length);
    
    // 3. REGISTRAR MOTOBOYS "SEM CONTATO" e verificar dias consecutivos
    const semContatoLinhas = linhas.rows.filter(l => l.status === 'SEM CONTATO' && l.cod_profissional);
    const removidos = [];
    
    for (const linha of semContatoLinhas) {
      // Verificar se já tem registro recente (ontem ou antes)
      const ultimoRegistro = await pool.query(
        `SELECT * FROM disponibilidade_sem_contato 
         WHERE cod_profissional = $1 AND loja_id = $2
         ORDER BY data_registro DESC LIMIT 1`,
        [linha.cod_profissional, linha.loja_id]
      );
      
      let diasConsecutivos = 1;
      
      if (ultimoRegistro.rows.length > 0) {
        const ultimaData = new Date(ultimoRegistro.rows[0].data_registro);
        const dataAtual = new Date(dataEspelho);
        const diffDias = Math.floor((dataAtual - ultimaData) / (1000 * 60 * 60 * 24));
        
        // Se o último registro foi ontem (ou há 1 dia), incrementa contador
        if (diffDias === 1) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos + 1;
        }
        // Se foi no mesmo dia, mantém o mesmo contador
        else if (diffDias === 0) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos;
        }
        // Se foi há mais de 1 dia, reseta contador
      }
      
      // Inserir novo registro
      await pool.query(
        `INSERT INTO disponibilidade_sem_contato (loja_id, cod_profissional, nome_profissional, data_registro, dias_consecutivos)
         VALUES ($1, $2, $3, $4, $5)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho, diasConsecutivos]
      );
      
      // AUTO-REMOÇÃO: Se chegou a 3 dias consecutivos, remove da planilha
      if (diasConsecutivos >= 3) {
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL
           WHERE id = $1`,
          [linha.id]
        );
        removidos.push({
          cod: linha.cod_profissional,
          nome: linha.nome_profissional,
          dias: diasConsecutivos
        });
        console.log('🚫 Auto-removido por 3 dias SEM CONTATO:', linha.cod_profissional, linha.nome_profissional);
      }
    }
    console.log('📵 Motoboys SEM CONTATO registrados:', semContatoLinhas.length, '- Removidos:', removidos.length);
    
    // 4. Processar linhas de reposição
    // Regra: Se há excedente vazio disponível, migra o usuário para lá. Senão, reposição vira nova linha excedente.
    
    // Buscar todas as linhas de reposição que têm usuário preenchido
    const reposicoesPreenchidas = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND cod_profissional IS NOT NULL AND cod_profissional != ''`
    );
    
    // Buscar todas as linhas de reposição vazias
    const reposicoesVazias = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND (cod_profissional IS NULL OR cod_profissional = '')`
    );
    
    console.log('📊 Reposições preenchidas:', reposicoesPreenchidas.rows.length);
    console.log('📊 Reposições vazias:', reposicoesVazias.rows.length);
    
    // Para cada reposição preenchida, tentar migrar para excedente vazio da mesma loja
    for (const reposicao of reposicoesPreenchidas.rows) {
      // Buscar excedente vazio na mesma loja
      const excedenteVazio = await pool.query(
        `SELECT id FROM disponibilidade_linhas 
         WHERE loja_id = $1 AND is_excedente = true 
         AND (cod_profissional IS NULL OR cod_profissional = '')
         LIMIT 1`,
        [reposicao.loja_id]
      );
      
      if (excedenteVazio.rows.length > 0) {
        // Migrar usuário para o excedente vazio
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = $1, nome_profissional = $2
           WHERE id = $3`,
          [reposicao.cod_profissional, reposicao.nome_profissional, excedenteVazio.rows[0].id]
        );
        // Deletar a linha de reposição (já migrou o usuário)
        await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1', [reposicao.id]);
        console.log('✅ Usuário migrado de reposição para excedente vazio:', reposicao.cod_profissional);
      } else {
        // Não há excedente vazio, converter reposição em nova linha excedente (mantém o usuário)
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET is_excedente = true, is_reposicao = false 
           WHERE id = $1`,
          [reposicao.id]
        );
        console.log('✅ Reposição convertida em excedente adicional:', reposicao.cod_profissional);
      }
    }
    
    // Deletar reposições vazias (não precisam virar excedente)
    await pool.query(
      `DELETE FROM disponibilidade_linhas WHERE is_reposicao = true`
    );
    console.log('🗑️ Reposições vazias removidas');
    
    // 5. Resetar APENAS status (MANTER observações, cod e nome!)
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET status = 'A CONFIRMAR', 
           updated_at = CURRENT_TIMESTAMP`
    );
    
    console.log('🔄 Status resetado com sucesso (códigos e nomes mantidos)');
    res.json({ 
      success: true, 
      espelho_data: dataEspelho, 
      espelho_salvo: espelhoSalvo,
      em_loja_registrados: emLojaLinhas.length,
      sem_contato_registrados: semContatoLinhas.length,
      removidos_por_sem_contato: removidos
    });
  } catch (err) {
    console.error('❌ Erro ao resetar:', err);
    res.status(500).json({ error: 'Erro ao resetar status' });
  }
});

// ============================================
// HISTÓRICO DE OBSERVAÇÕES
// ============================================

// GET /api/disponibilidade/observacoes-historico - Listar histórico de observações com filtros
app.get('/api/disponibilidade/observacoes-historico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_profissional, loja_id, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM disponibilidade_observacoes_historico WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      query += ` AND data_reset >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      query += ` AND data_reset <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    if (cod_profissional) {
      query += ` AND cod_profissional = $${paramIndex}`;
      params.push(cod_profissional);
      paramIndex++;
    }
    
    if (loja_id) {
      query += ` AND loja_id = $${paramIndex}`;
      params.push(loja_id);
      paramIndex++;
    }
    
    query += ` ORDER BY data_reset DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de observações:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico de observações' });
  }
});

// GET /api/disponibilidade/observacoes-historico/datas - Listar datas disponíveis no histórico
app.get('/api/disponibilidade/observacoes-historico/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_reset, data_planilha, COUNT(*) as total_observacoes
      FROM disponibilidade_observacoes_historico
      GROUP BY data_reset, data_planilha
      ORDER BY data_reset DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar datas do histórico:', err);
    res.status(500).json({ error: 'Erro ao buscar datas do histórico' });
  }
});

// ============================================
// RELATÓRIOS E HISTÓRICO
// ============================================

// GET /api/disponibilidade/relatorios/metricas - Métricas dos últimos 7 espelhos salvos
app.get('/api/disponibilidade/relatorios/metricas', async (req, res) => {
  try {
    // Buscar os últimos 7 espelhos salvos (independente da data)
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Processar métricas por dia
    const metricas = [];
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      const totalTitulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let percOperacao = 0;
      if (totalTitulares > 0) {
        percOperacao = Math.min((emLoja / totalTitulares) * 100, 100);
      }
      
      metricas.push({
        data: espelho.data_registro,
        totalTitulares,
        emLoja,
        faltando,
        semContato,
        percOperacao: parseFloat(percOperacao.toFixed(1))
      });
    }
    
    res.json(metricas);
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-lojas - Ranking de lojas por % EM LOJA
app.get('/api/disponibilidade/relatorios/ranking-lojas', async (req, res) => {
  try {
    // Buscar últimos 7 espelhos
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Buscar lojas para ter os nomes
    const lojasResult = await pool.query(`
      SELECT l.*, r.nome as regiao_nome 
      FROM disponibilidade_lojas l
      LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
    `);
    const lojasInfo = {};
    lojasResult.rows.forEach(l => {
      lojasInfo[l.id] = { nome: l.nome, regiao: l.regiao_nome };
    });
    
    // Agrupar dados por loja
    const lojasMap = {};
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      // Agrupar linhas por loja
      const linhasPorLoja = {};
      linhas.forEach(linha => {
        if (!linha.loja_id) return;
        if (!linhasPorLoja[linha.loja_id]) {
          linhasPorLoja[linha.loja_id] = [];
        }
        linhasPorLoja[linha.loja_id].push(linha);
      });
      
      // Calcular métricas por loja neste dia
      Object.entries(linhasPorLoja).forEach(([lojaId, linhasLoja]) => {
        if (!lojasMap[lojaId]) {
          lojasMap[lojaId] = {
            loja_id: lojaId,
            loja_nome: lojasInfo[lojaId]?.nome || 'Desconhecida',
            regiao_nome: lojasInfo[lojaId]?.regiao || '',
            dias: []
          };
        }
        
        const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
        const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
        // % baseado em EM LOJA vs TITULARES, limitado a 100%
        const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
        
        lojasMap[lojaId].dias.push(perc);
      });
    }
    
    // Calcular média por loja
    const ranking = Object.values(lojasMap).map(loja => {
      const mediaPerc = loja.dias.length > 0 
        ? (loja.dias.reduce((a, b) => a + b, 0) / loja.dias.length).toFixed(1)
        : 0;
      return {
        loja_id: loja.loja_id,
        loja_nome: loja.loja_nome,
        regiao_nome: loja.regiao_nome,
        mediaPerc: parseFloat(mediaPerc),
        diasAnalisados: loja.dias.length
      };
    });
    
    // Ordenar por média (melhores primeiro)
    ranking.sort((a, b) => b.mediaPerc - a.mediaPerc);
    
    res.json(ranking);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking lojas:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-faltosos - Ranking de entregadores que mais faltam
app.get('/api/disponibilidade/relatorios/ranking-faltosos', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltosos do período
    const faltosos = await pool.query(`
      SELECT f.*, l.nome as loja_nome
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      ORDER BY f.data_falta DESC
    `);
    
    // Agrupar por profissional
    const profissionaisMap = {};
    faltosos.rows.forEach(falta => {
      const key = falta.cod_profissional || falta.nome_profissional;
      if (!key) return;
      
      if (!profissionaisMap[key]) {
        profissionaisMap[key] = {
          cod: falta.cod_profissional,
          nome: falta.nome_profissional,
          loja_nome: falta.loja_nome,
          totalFaltas: 0,
          motivos: [],
          ultimaFalta: falta.data_falta
        };
      }
      profissionaisMap[key].totalFaltas++;
      if (falta.motivo && !profissionaisMap[key].motivos.includes(falta.motivo)) {
        profissionaisMap[key].motivos.push(falta.motivo);
      }
    });
    
    // Converter para array e ordenar
    const ranking = Object.values(profissionaisMap);
    ranking.sort((a, b) => b.totalFaltas - a.totalFaltas);
    
    res.json(ranking.slice(0, 20)); // Top 20
  } catch (err) {
    console.error('❌ Erro ao buscar ranking faltosos:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/comparativo - Comparar últimos 3 espelhos salvos
app.get('/api/disponibilidade/relatorios/comparativo', async (req, res) => {
  try {
    // Buscar os 3 últimos espelhos salvos (ordenados por data_registro DESC)
    const espelhosResult = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 3
    `);
    
    // Função para calcular métricas com lógica correta de %
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const calcularMetricas = (linhas, dataRegistro) => {
      if (!linhas || linhas.length === 0) {
        return null;
      }
      
      const titulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let perc = 0;
      if (titulares > 0) {
        perc = Math.min((emLoja / titulares) * 100, 100);
      }
      
      return { 
        titulares, 
        emLoja,
        faltando, 
        semContato, 
        perc: parseFloat(perc.toFixed(1)),
        data: dataRegistro
      };
    };
    
    // Extrair linhas do espelho (campo dados é JSON)
    const extrairLinhasEspelho = (espelho) => {
      if (!espelho) return [];
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      return dados?.linhas || [];
    };
    
    // Formatar data para exibição
    const formatarData = (data) => {
      if (!data) return '';
      const d = new Date(data);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    };
    
    const espelhos = espelhosResult.rows;
    
    // Mais recente = "HOJE" (ou último salvo)
    // Segundo = "ONTEM" (ou penúltimo salvo)  
    // Terceiro = "ANTERIOR" (ou antepenúltimo salvo)
    const resultado = {
      hoje: espelhos[0] ? calcularMetricas(extrairLinhasEspelho(espelhos[0]), espelhos[0].data_registro) : null,
      ontem: espelhos[1] ? calcularMetricas(extrairLinhasEspelho(espelhos[1]), espelhos[1].data_registro) : null,
      semanaPassada: espelhos[2] ? calcularMetricas(extrairLinhasEspelho(espelhos[2]), espelhos[2].data_registro) : null,
      // Labels dinâmicos baseados nas datas reais
      labels: {
        hoje: espelhos[0] ? formatarData(espelhos[0].data_registro) : 'MAIS RECENTE',
        ontem: espelhos[1] ? formatarData(espelhos[1].data_registro) : 'ANTERIOR',
        semanaPassada: espelhos[2] ? formatarData(espelhos[2].data_registro) : '3º ANTERIOR'
      }
    };
    
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao buscar comparativo:', err);
    res.status(500).json({ error: 'Erro ao buscar comparativo' });
  }
});

// GET /api/disponibilidade/relatorios/heatmap - Heatmap de faltas por dia da semana e loja
app.get('/api/disponibilidade/relatorios/heatmap', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltas com dia da semana
    const faltas = await pool.query(`
      SELECT 
        f.loja_id,
        l.nome as loja_nome,
        EXTRACT(DOW FROM f.data_falta) as dia_semana,
        COUNT(*) as total_faltas
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      GROUP BY f.loja_id, l.nome, EXTRACT(DOW FROM f.data_falta)
      ORDER BY l.nome, dia_semana
    `);
    
    // Organizar em formato de heatmap
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const lojasMap = {};
    
    faltas.rows.forEach(row => {
      if (!lojasMap[row.loja_id]) {
        lojasMap[row.loja_id] = {
          loja_nome: row.loja_nome,
          dias: [0, 0, 0, 0, 0, 0, 0]
        };
      }
      lojasMap[row.loja_id].dias[parseInt(row.dia_semana)] = parseInt(row.total_faltas);
    });
    
    res.json({
      diasSemana,
      lojas: Object.values(lojasMap)
    });
  } catch (err) {
    console.error('❌ Erro ao buscar heatmap:', err);
    res.status(500).json({ error: 'Erro ao buscar heatmap' });
  }
});

// ============================================
// LINK PÚBLICO (SOMENTE LEITURA)
// ============================================

// GET /api/disponibilidade/publico - Retorna página HTML com panorama somente leitura
app.get('/api/disponibilidade/publico', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas');
    
    // Calcular dados de cada loja
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const lojasComDados = lojas.rows.map(loja => {
      const linhasLoja = linhas.rows.filter(l => l.loja_id === loja.id);
      const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const aCaminho = linhasLoja.filter(l => l.status === 'A CAMINHO').length;
      const confirmado = linhasLoja.filter(l => l.status === 'CONFIRMADO').length;
      const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
      const semContato = linhasLoja.filter(l => l.status === 'SEM CONTATO').length;
      const emOperacao = aCaminho + confirmado + emLoja;
      const falta = Math.max(0, titulares - emOperacao);
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
      const regiao = regioes.rows.find(r => r.id === loja.regiao_id);
      return { ...loja, titulares, aCaminho, confirmado, emLoja, semContato, emOperacao, falta, perc, regiao };
    });
    
    // Totais
    let totalGeral = { aCaminho: 0, confirmado: 0, emLoja: 0, titulares: 0, falta: 0, semContato: 0, emOperacao: 0 };
    lojasComDados.forEach(l => {
      totalGeral.aCaminho += l.aCaminho;
      totalGeral.confirmado += l.confirmado;
      totalGeral.emLoja += l.emLoja;
      totalGeral.titulares += l.titulares;
      totalGeral.falta += l.falta;
      totalGeral.semContato += l.semContato;
      totalGeral.emOperacao += l.emOperacao;
    });
    // % geral baseado em EM LOJA vs TITULARES, limitado a 100%
    const percGeral = totalGeral.titulares > 0 ? Math.min((totalGeral.emLoja / totalGeral.titulares) * 100, 100) : 0;
    
    // Gerar HTML - Design Clean
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panorama - Disponibilidade</title>
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 12px; }
    .header { background: white; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { font-size: 15px; color: #1e293b; font-weight: 600; }
    .header .info { font-size: 11px; color: #64748b; margin-top: 4px; }
    .badge { padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-yellow { background: #fef3c7; color: #a16207; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #f8fafc; color: #475569; padding: 8px 6px; text-align: center; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    th.lojas { text-align: left; }
    td { padding: 4px 6px; border: 1px solid #e2e8f0; text-align: center; }
    td.loja { text-align: left; background: #fafafa; font-weight: 500; }
    tr.regiao td { background: #e2e8f0; font-weight: 700; text-align: center; color: #1e293b; }
    tr.total td { background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1; }
    tr.critico { background: #fef2f2; }
    tr.critico td.loja { background: #fef2f2; }
    .num-zero { color: #cbd5e1; }
    .num-acaminho { color: #ea580c; }
    .num-confirmado { color: #16a34a; }
    .num-emloja { color: #2563eb; font-weight: 700; }
    .num-ideal { color: #64748b; }
    .num-falta { color: #dc2626; font-weight: 600; }
    .num-semcontato { color: #d97706; }
    .perc { font-weight: 700; }
    .perc-ok { background: #bbf7d0; color: #15803d; }
    .perc-warn { background: #fde68a; color: #a16207; }
    .perc-danger { background: #fecaca; color: #b91c1c; }
    .perc-neutral { background: #f1f5f9; color: #475569; }
    .footer { margin-top: 12px; text-align: center; font-size: 10px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📊 PANORAMA DIÁRIO OPERACIONAL</h1>
      <div class="info">Atualizado: ${new Date().toLocaleString('pt-BR')} | Auto-refresh: 2min</div>
    </div>
    <div>
      <span class="badge ${percGeral >= 100 ? 'badge-green' : percGeral >= 80 ? 'badge-yellow' : 'badge-red'}">
        ${percGeral.toFixed(0)}% GERAL
      </span>
      ${totalGeral.falta > 0 ? `<span class="badge badge-red" style="margin-left:5px">⚠️ FALTAM ${totalGeral.falta}</span>` : ''}
    </div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th class="lojas">LOJAS</th>
        <th>A CAMINHO</th>
        <th>CONFIR.</th>
        <th>EM LOJA</th>
        <th>IDEAL</th>
        <th>FALTA</th>
        <th>S/ CONTATO</th>
        <th>%</th>
      </tr>
    </thead>
    <tbody>`;
    
    // Renderizar por região
    regioes.rows.forEach(regiao => {
      const lojasReg = lojasComDados.filter(l => l.regiao_id === regiao.id);
      if (lojasReg.length === 0) return;
      
      // Header região
      html += `<tr class="regiao"><td colspan="8">${regiao.nome}${regiao.gestores ? ` (${regiao.gestores})` : ''}</td></tr>`;
      
      // Lojas
      lojasReg.forEach(loja => {
        const critico = loja.perc < 50 ? 'critico' : '';
        const percClass = loja.perc >= 100 ? 'perc-ok' : loja.perc >= 80 ? 'perc-neutral' : loja.perc >= 50 ? 'perc-warn' : 'perc-danger';
        html += `<tr class="${critico}">
          <td class="loja">${loja.perc < 50 ? '🔴 ' : ''}${loja.nome}</td>
          <td class="${loja.aCaminho > 0 ? 'num-acaminho' : 'num-zero'}">${loja.aCaminho}</td>
          <td class="${loja.confirmado > 0 ? 'num-confirmado' : 'num-zero'}">${loja.confirmado}</td>
          <td class="${loja.emLoja > 0 ? 'num-emloja' : 'num-zero'}">${loja.emLoja}</td>
          <td class="num-ideal">${loja.titulares}</td>
          <td class="${loja.falta > 0 ? 'num-falta' : 'num-zero'}">${loja.falta > 0 ? -loja.falta : 0}</td>
          <td class="${loja.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${loja.semContato}</td>
          <td class="perc ${percClass}">${loja.perc.toFixed(0)}%</td>
        </tr>`;
      });
    });
    
    // Total geral
    const totalPercClass = percGeral >= 100 ? 'perc-ok' : percGeral >= 80 ? 'perc-neutral' : percGeral >= 50 ? 'perc-warn' : 'perc-danger';
    html += `<tr class="total">
      <td style="text-align:left;color:#1e293b">TOTAL GERAL</td>
      <td class="num-acaminho">${totalGeral.aCaminho}</td>
      <td class="num-confirmado">${totalGeral.confirmado}</td>
      <td class="num-emloja">${totalGeral.emLoja}</td>
      <td class="num-ideal">${totalGeral.titulares}</td>
      <td class="${totalGeral.falta > 0 ? 'num-falta' : 'num-zero'}">${totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
      <td class="${totalGeral.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${totalGeral.semContato}</td>
      <td class="perc ${totalPercClass}" style="font-weight:800">${percGeral.toFixed(0)}%</td>
    </tr>`;
    
    html += `</tbody></table>
  <div class="footer">
    Esta página atualiza automaticamente a cada 2 minutos | Sistema Tutts
  </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('❌ Erro ao gerar página pública:', err);
    res.status(500).send('Erro ao gerar página');
  }
});

// ============================================
// LOJA - ENDPOINTS
// ============================================

// === ESTOQUE ===

// GET - Listar estoque
app.get('/api/loja/estoque', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, 
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
      FROM loja_estoque e
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar estoque:', err);
    res.status(500).json({ error: 'Erro ao listar estoque' });
  }
});

// POST - Adicionar item ao estoque
app.post('/api/loja/estoque', async (req, res) => {
  try {
    const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, created_by } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_estoque (nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, imagem_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [nome, marca, valor, quantidade || 0, tem_tamanho || false, tipo_tamanho || 'letras', imagem_url, created_by]
    );
    
    const estoqueId = result.rows[0].id;
    
    // Se tem tamanhos, inserir na tabela de tamanhos
    if (tem_tamanho && tamanhos && tamanhos.length > 0) {
      for (const t of tamanhos) {
        await pool.query(
          `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
          [estoqueId, t.tamanho, t.quantidade || 0]
        );
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar estoque:', err);
    res.status(500).json({ error: 'Erro ao adicionar estoque' });
  }
});

// PUT - Atualizar item do estoque
app.put('/api/loja/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, status } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_estoque SET nome=$1, marca=$2, valor=$3, quantidade=$4, tem_tamanho=$5, tipo_tamanho=$6, imagem_url=$7, status=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho || 'letras', imagem_url, status || 'ativo', id]
    );
    
    // Atualizar tamanhos
    if (tem_tamanho) {
      // Remover tamanhos antigos
      await pool.query(`DELETE FROM loja_estoque_tamanhos WHERE estoque_id = $1`, [id]);
      
      // Inserir novos
      if (tamanhos && tamanhos.length > 0) {
        for (const t of tamanhos) {
          await pool.query(
            `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
            [id, t.tamanho, t.quantidade || 0]
          );
        }
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar estoque:', err);
    res.status(500).json({ error: 'Erro ao atualizar estoque' });
  }
});

// DELETE - Remover item do estoque
app.delete('/api/loja/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_estoque WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover estoque:', err);
    res.status(500).json({ error: 'Erro ao remover estoque' });
  }
});

// === PRODUTOS À VENDA ===

// GET - Listar produtos
app.get('/api/loja/produtos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, e.tem_tamanho,
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
      FROM loja_produtos p
      LEFT JOIN loja_estoque e ON e.id = p.estoque_id
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      GROUP BY p.id, e.tem_tamanho
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar produtos:', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// GET - Produtos ativos (para usuário)
app.get('/api/loja/produtos/ativos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, e.tem_tamanho, e.quantidade as estoque_total,
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL AND t.quantidade > 0), '[]') as tamanhos
      FROM loja_produtos p
      LEFT JOIN loja_estoque e ON e.id = p.estoque_id
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      WHERE p.status = 'ativo'
      GROUP BY p.id, e.tem_tamanho, e.quantidade
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar produtos ativos:', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// POST - Adicionar produto à venda
app.post('/api/loja/produtos', async (req, res) => {
  try {
    const { estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_produtos (estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [estoque_id, nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), created_by]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar produto:', err);
    res.status(500).json({ error: 'Erro ao adicionar produto' });
  }
});

// PUT - Atualizar produto
app.put('/api/loja/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, marca, valor, imagem_url, parcelas_config, status } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_produtos SET nome=$1, descricao=$2, marca=$3, valor=$4, imagem_url=$5, parcelas_config=$6, status=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), status, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar produto:', err);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE - Remover produto
app.delete('/api/loja/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_produtos WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover produto:', err);
    res.status(500).json({ error: 'Erro ao remover produto' });
  }
});

// === PEDIDOS ===

// GET - Listar todos os pedidos (admin)
app.get('/api/loja/pedidos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM loja_pedidos ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// GET - Pedidos do usuário
app.get('/api/loja/pedidos/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_pedidos WHERE user_cod = $1 ORDER BY created_at DESC`,
      [userCod]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar pedidos do usuário:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// POST - Criar pedido
app.post('/api/loja/pedidos', async (req, res) => {
  try {
    const { produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_pedidos (produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// PATCH - Atualizar status do pedido
app.patch('/api/loja/pedidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_id, admin_name, observacao, debito_lancado, debito_lancado_em, debito_lancado_por } = req.body;
    
    let result;
    
    // Se for atualização de débito lançado
    if (debito_lancado !== undefined) {
      result = await pool.query(
        `UPDATE loja_pedidos SET debito_lancado=$1, debito_lancado_em=$2, debito_lancado_por=$3, updated_at=NOW()
         WHERE id=$4 RETURNING *`,
        [debito_lancado, debito_lancado_em, debito_lancado_por, id]
      );
    } else {
      // Atualização de status
      result = await pool.query(
        `UPDATE loja_pedidos SET status=$1, admin_id=$2, admin_name=$3, observacao=$4, updated_at=NOW()
         WHERE id=$5 RETURNING *`,
        [status, admin_id, admin_name, observacao, id]
      );
      
      // Se aprovado, decrementar estoque
      if (status === 'aprovado') {
        const pedido = result.rows[0];
        if (pedido.tamanho) {
          // Decrementar do tamanho específico
          await pool.query(`
            UPDATE loja_estoque_tamanhos 
            SET quantidade = quantidade - 1 
            WHERE estoque_id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
            AND tamanho = $2 AND quantidade > 0
          `, [pedido.produto_id, pedido.tamanho]);
        } else {
          // Decrementar do estoque geral
          await pool.query(`
            UPDATE loja_estoque 
            SET quantidade = quantidade - 1 
            WHERE id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
            AND quantidade > 0
          `, [pedido.produto_id]);
        }
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar pedido:', err);
    res.status(500).json({ error: 'Erro ao atualizar pedido' });
  }
});

// DELETE - Remover pedido
app.delete('/api/loja/pedidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_pedidos WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover pedido:', err);
    res.status(500).json({ error: 'Erro ao remover pedido' });
  }
});

// ==================== MOVIMENTAÇÕES DE ESTOQUE ====================

// GET - Listar movimentações de um item
app.get('/api/loja/estoque/:id/movimentacoes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_estoque_movimentacoes WHERE estoque_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar movimentações:', err);
    res.status(500).json({ error: 'Erro ao listar movimentações' });
  }
});

// GET - Listar todas movimentações
app.get('/api/loja/movimentacoes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, e.nome as produto_nome, e.marca
      FROM loja_estoque_movimentacoes m
      LEFT JOIN loja_estoque e ON m.estoque_id = e.id
      ORDER BY m.created_at DESC
      LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar movimentações:', err);
    res.status(500).json({ error: 'Erro ao listar movimentações' });
  }
});

// POST - Registrar entrada de estoque
app.post('/api/loja/estoque/:id/entrada', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantidade, tamanho, motivo, created_by } = req.body;
    
    // Registrar movimentação
    await pool.query(
      `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
       VALUES ($1, 'entrada', $2, $3, $4, $5)`,
      [id, quantidade, tamanho || null, motivo || 'Entrada manual', created_by]
    );
    
    // Atualizar quantidade
    if (tamanho) {
      await pool.query(
        `UPDATE loja_estoque_tamanhos SET quantidade = quantidade + $1 WHERE estoque_id = $2 AND tamanho = $3`,
        [quantidade, id, tamanho]
      );
    } else {
      await pool.query(
        `UPDATE loja_estoque SET quantidade = quantidade + $1 WHERE id = $2`,
        [quantidade, id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao registrar entrada:', err);
    res.status(500).json({ error: 'Erro ao registrar entrada' });
  }
});

// POST - Registrar saída de estoque
app.post('/api/loja/estoque/:id/saida', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantidade, tamanho, motivo, created_by } = req.body;
    
    // Registrar movimentação
    await pool.query(
      `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
       VALUES ($1, 'saida', $2, $3, $4, $5)`,
      [id, quantidade, tamanho || null, motivo || 'Saída manual', created_by]
    );
    
    // Atualizar quantidade
    if (tamanho) {
      await pool.query(
        `UPDATE loja_estoque_tamanhos SET quantidade = GREATEST(0, quantidade - $1) WHERE estoque_id = $2 AND tamanho = $3`,
        [quantidade, id, tamanho]
      );
    } else {
      await pool.query(
        `UPDATE loja_estoque SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2`,
        [quantidade, id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao registrar saída:', err);
    res.status(500).json({ error: 'Erro ao registrar saída' });
  }
});

// ==================== SUGESTÕES DE PRODUTOS ====================

// GET - Listar todas sugestões (admin)
app.get('/api/loja/sugestoes', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM loja_sugestoes ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sugestões:', err);
    res.status(500).json({ error: 'Erro ao listar sugestões' });
  }
});

// GET - Listar sugestões do usuário
app.get('/api/loja/sugestoes/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_sugestoes WHERE user_cod = $1 ORDER BY created_at DESC`,
      [userCod]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sugestões:', err);
    res.status(500).json({ error: 'Erro ao listar sugestões' });
  }
});

// POST - Criar sugestão
app.post('/api/loja/sugestoes', async (req, res) => {
  try {
    const { user_cod, user_name, sugestao } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_sugestoes (user_cod, user_name, sugestao) VALUES ($1, $2, $3) RETURNING *`,
      [user_cod, user_name, sugestao]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar sugestão:', err);
    res.status(500).json({ error: 'Erro ao criar sugestão' });
  }
});

// PATCH - Responder sugestão (admin)
app.patch('/api/loja/sugestoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resposta, respondido_por } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_sugestoes SET status=$1, resposta=$2, respondido_por=$3, respondido_em=NOW() WHERE id=$4 RETURNING *`,
      [status, resposta, respondido_por, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao responder sugestão:', err);
    res.status(500).json({ error: 'Erro ao responder sugestão' });
  }
});

// DELETE - Remover sugestão
app.delete('/api/loja/sugestoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_sugestoes WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover sugestão:', err);
    res.status(500).json({ error: 'Erro ao remover sugestão' });
  }
});

// ==================== MÓDULO BI ====================

// Listar todos os clientes/centros de custo configurados
app.get('/api/bi/prazos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.*, 
        COALESCE(json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
          ORDER BY fp.km_min
        ) FILTER (WHERE fp.id IS NOT NULL), '[]') as faixas
      FROM bi_prazos_cliente pc
      LEFT JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar prazos:', err);
    res.status(500).json({ error: 'Erro ao listar prazos' });
  }
});

// Buscar prazo padrão
app.get('/api/bi/prazo-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo padrão' });
  }
});

// Salvar prazo padrão
app.post('/api/bi/prazo-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo padrão' });
  }
});

// Criar/Atualizar configuração de prazo para cliente/centro
app.post('/api/bi/prazos', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_cliente (tipo, codigo, nome, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3, updated_at = NOW()
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo WHERE prazo_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo (prazo_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo' });
  }
});

// Remover configuração de prazo
app.delete('/api/bi/prazos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo:', err);
    res.status(500).json({ error: 'Erro ao remover prazo' });
  }
});

// ========== ROTAS DE PRAZO PROFISSIONAL ==========

// Listar prazos profissionais
app.get('/api/bi/prazos-prof', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.id, pc.tipo, pc.codigo, pc.nome,
        json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
        ) as faixas
      FROM bi_prazos_prof_cliente pc
      LEFT JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json({ success: true, prazos: result.rows });
  } catch (err) {
    console.error('❌ Erro ao listar prazos profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar prazos profissionais' });
  }
});

// Buscar prazo profissional padrão
app.get('/api/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo prof padrão' });
  }
});

// Salvar prazo profissional padrão
app.post('/api/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_prof_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_prof_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo prof padrão' });
  }
});

// Criar/Atualizar configuração de prazo profissional para cliente/centro
app.post('/api/bi/prazos-prof', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_prof_cliente (tipo, codigo, nome)
      VALUES ($1, $2, $3)
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo_prof WHERE prazo_prof_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo_prof (prazo_prof_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo profissional' });
  }
});

// Remover configuração de prazo profissional
app.delete('/api/bi/prazos-prof/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_prof_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao remover prazo profissional' });
  }
});

// Recalcular prazos profissionais de todas as entregas
app.post('/api/bi/entregas/recalcular-prazo-prof', async (req, res) => {
  try {
    // Buscar configurações de prazo profissional
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_prof_cliente pc
      JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando Prazo Prof - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    
    // Buscar todas as entregas com data_hora_alocado
    const entregas = await pool.query(`
      SELECT id, cod_cliente, centro_custo, distancia, data_hora_alocado, finalizado 
      FROM bi_entregas 
      WHERE data_hora_alocado IS NOT NULL
    `);
    console.log(`🔄 Total de entregas com alocação: ${entregas.rows.length}`);
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Usa prazo padrão profissional
      if (prazoPadrao.rows.length > 0) {
        for (const faixa of prazoPadrao.rows) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Fallback: 60 minutos para qualquer distância
      return 60;
    };
    
    // Calcular tempo de execução profissional (alocado -> finalizado)
    const calcularTempoExecucaoProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = new Date(dataHoraAlocado);
      const fim = new Date(finalizado);
      if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    let atualizados = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let semPrazoCount = 0;
    
    for (const e of entregas.rows) {
      const distancia = parseFloat(e.distancia) || 0;
      const prazoMinutos = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucaoProf(e.data_hora_alocado, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, alocado=${e.data_hora_alocado}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo_prof = $1, prazo_prof_minutos = $2, tempo_execucao_prof_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Prazo Prof Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular prazo prof:', err);
    res.status(500).json({ error: 'Erro ao recalcular prazo profissional' });
  }
});

// DIAGNÓSTICO - verificar dados do BI
// Endpoint para inicializar prazos com valores do DAX
app.post('/api/bi/inicializar-prazos-dax', async (req, res) => {
  try {
    // Tabela de prazos baseada no DAX_Prazo_Cliente
    const faixasPadrao = [
      { km_min: 0, km_max: 10, prazo_segundos: 3600 },
      { km_min: 10, km_max: 15, prazo_segundos: 4500 },
      { km_min: 15, km_max: 20, prazo_segundos: 5400 },
      { km_min: 20, km_max: 25, prazo_segundos: 6300 },
      { km_min: 25, km_max: 30, prazo_segundos: 7200 },
      { km_min: 30, km_max: 35, prazo_segundos: 8100 },
      { km_min: 35, km_max: 40, prazo_segundos: 9000 },
      { km_min: 40, km_max: 45, prazo_segundos: 9900 },
      { km_min: 45, km_max: 50, prazo_segundos: 10800 },
      { km_min: 50, km_max: 55, prazo_segundos: 11700 },
      { km_min: 55, km_max: 60, prazo_segundos: 12600 },
      { km_min: 60, km_max: 65, prazo_segundos: 13500 },
      { km_min: 65, km_max: 70, prazo_segundos: 14400 },
      { km_min: 70, km_max: 75, prazo_segundos: 15300 },
      { km_min: 75, km_max: 80, prazo_segundos: 16200 },
      { km_min: 80, km_max: 85, prazo_segundos: 17100 },
      { km_min: 85, km_max: 90, prazo_segundos: 18000 },
      { km_min: 90, km_max: 95, prazo_segundos: 18900 },
      { km_min: 95, km_max: 100, prazo_segundos: 19800 },
      // Acima de 100km = Fora do Prazo (prazo impossível de cumprir)
      { km_min: 100, km_max: null, prazo_segundos: 0 }
    ];
    
    // Limpar tabela de prazo padrão
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir faixas padrão (convertendo segundos para minutos)
    for (const faixa of faixasPadrao) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_segundos / 60]
      );
    }
    
    // Recalcular prazo para todos os registros
    const totalAtualizados = await pool.query(`
      WITH prazo_calc AS (
        SELECT 
          e.id,
          CASE 
            -- Faixas padrão baseadas na distância
            WHEN e.distancia <= 10 THEN 60
            WHEN e.distancia <= 15 THEN 75
            WHEN e.distancia <= 20 THEN 90
            WHEN e.distancia <= 25 THEN 105
            WHEN e.distancia <= 30 THEN 120
            WHEN e.distancia <= 35 THEN 135
            WHEN e.distancia <= 40 THEN 150
            WHEN e.distancia <= 45 THEN 165
            WHEN e.distancia <= 50 THEN 180
            WHEN e.distancia <= 55 THEN 195
            WHEN e.distancia <= 60 THEN 210
            WHEN e.distancia <= 65 THEN 225
            WHEN e.distancia <= 70 THEN 240
            WHEN e.distancia <= 75 THEN 255
            WHEN e.distancia <= 80 THEN 270
            WHEN e.distancia <= 85 THEN 285
            WHEN e.distancia <= 90 THEN 300
            WHEN e.distancia <= 95 THEN 315
            WHEN e.distancia <= 100 THEN 330
            ELSE 0 -- Acima de 100km = sempre fora do prazo
          END as prazo_calculado
        FROM bi_entregas e
        WHERE e.distancia IS NOT NULL
      )
      UPDATE bi_entregas e
      SET prazo_minutos = pc.prazo_calculado,
          dentro_prazo = CASE 
            WHEN pc.prazo_calculado = 0 THEN false
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos <= pc.prazo_calculado THEN true
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos > pc.prazo_calculado THEN false
            ELSE NULL
          END
      FROM prazo_calc pc
      WHERE e.id = pc.id
    `);
    
    res.json({
      success: true,
      message: 'Prazos inicializados com valores do DAX',
      faixasPadrao: faixasPadrao.length,
      registrosAtualizados: totalAtualizados.rowCount
    });
  } catch (error) {
    console.error('Erro ao inicializar prazos DAX:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para preencher hora_solicitado a partir de data_hora (para dados antigos)
app.post('/api/bi/preencher-hora-solicitado', async (req, res) => {
  try {
    console.log('🕐 Preenchendo hora_solicitado a partir de data_hora...');
    
    // Atualizar hora_solicitado extraindo a hora de data_hora onde está null
    const result = await pool.query(`
      UPDATE bi_entregas 
      SET hora_solicitado = data_hora::time 
      WHERE hora_solicitado IS NULL AND data_hora IS NOT NULL
    `);
    
    console.log(`✅ ${result.rowCount} registros atualizados com hora_solicitado`);
    
    res.json({ 
      success: true, 
      message: `${result.rowCount} registros atualizados com hora_solicitado`,
      atualizados: result.rowCount 
    });
  } catch (error) {
    console.error('❌ Erro ao preencher hora_solicitado:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bi/diagnostico', async (req, res) => {
  try {
    // Versão do código para verificar deploy
    const versao = '2025-12-27-v11-fix-coleta-ponto';
    
    // Verificar prazo padrão
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    // Verificar entregas
    const entregas = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas`);
    const amostra = await pool.query(`SELECT id, os, ponto, cod_cliente, centro_custo, distancia, data_hora, data_hora_alocado, finalizado, execucao_comp, dentro_prazo, prazo_minutos, tempo_execucao_minutos FROM bi_entregas LIMIT 5`);
    
    // Verificar quantos têm prazo calculado
    const comPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo IS NOT NULL`);
    const dentroPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = true`);
    const foraPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = false`);
    
    // === NOVO: Diagnóstico de Alocação e Pontos ===
    const distribuicaoPontos = await pool.query(`
      SELECT COALESCE(ponto, 1) as ponto, COUNT(*) as total 
      FROM bi_entregas 
      GROUP BY COALESCE(ponto, 1) 
      ORDER BY ponto
    `);
    
    const comAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE data_hora_alocado IS NOT NULL`);
    const comFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE finalizado IS NOT NULL`);
    const ponto1ComAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL`);
    const ponto2PlusComFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL`);
    
    // Amostra de cálculo de tempo
    const amostraTempos = await pool.query(`
      SELECT 
        os, ponto, cod_cliente,
        data_hora,
        data_hora_alocado,
        finalizado,
        CASE WHEN COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora)) / 60
          ELSE NULL
        END as tempo_alocacao_min,
        CASE WHEN COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (finalizado - data_hora)) / 60
          ELSE NULL
        END as tempo_entrega_min
      FROM bi_entregas
      WHERE data_hora IS NOT NULL
      LIMIT 10
    `);
    
    // Verificar centros de custo
    const comCentroCusto = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != ''`);
    const centrosUnicos = await pool.query(`SELECT DISTINCT centro_custo, cod_cliente FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' LIMIT 20`);
    
    // Verificar motivos (retornos)
    const comMotivo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != ''`);
    const motivosErro = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%'`);
    const motivosUnicos = await pool.query(`SELECT DISTINCT motivo, COUNT(*) as qtd FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != '' GROUP BY motivo ORDER BY qtd DESC LIMIT 20`);
    const amostraErros = await pool.query(`SELECT os, ponto, cod_cliente, motivo FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%' LIMIT 10`);
    
    // Verificar ocorrências (nova regra de retornos)
    const comOcorrencia = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != ''`);
    const ocorrenciasRetorno = await pool.query(`
      SELECT COUNT(*) as total FROM bi_entregas 
      WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' 
         OR LOWER(ocorrencia) LIKE '%clienteaus%'
         OR LOWER(ocorrencia) LIKE '%cliente ausente%'
         OR LOWER(ocorrencia) LIKE '%loja fechada%'
         OR LOWER(ocorrencia) LIKE '%produto incorreto%'
    `);
    const ocorrenciasUnicas = await pool.query(`SELECT DISTINCT ocorrencia, COUNT(*) as qtd FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != '' GROUP BY ocorrencia ORDER BY qtd DESC LIMIT 30`);
    
    res.json({
      versao: versao,
      totalEntregas: entregas.rows[0].total,
      // Diagnóstico de tempos
      diagnosticoTempos: {
        distribuicaoPontos: distribuicaoPontos.rows,
        comDataHoraAlocado: comAlocado.rows[0].total,
        comFinalizado: comFinalizado.rows[0].total,
        ponto1ComAlocado: ponto1ComAlocado.rows[0].total,
        ponto2PlusComFinalizado: ponto2PlusComFinalizado.rows[0].total,
        amostraTempos: amostraTempos.rows
      },
      // Prazo
      comPrazoCalculado: comPrazo.rows[0].total,
      dentroPrazo: dentroPrazo.rows[0].total,
      foraPrazo: foraPrazo.rows[0].total,
      prazoPadrao: prazoPadrao.rows,
      // Centro de custo
      comCentroCusto: comCentroCusto.rows[0].total,
      centrosUnicos: centrosUnicos.rows,
      // Motivos e Ocorrências
      comMotivo: comMotivo.rows[0].total,
      motivosComErro: motivosErro.rows[0].total,
      motivosUnicos: motivosUnicos.rows,
      amostraErros: amostraErros.rows,
      comOcorrencia: comOcorrencia.rows[0].total,
      ocorrenciasRetorno: ocorrenciasRetorno.rows[0].total,
      ocorrenciasUnicas: ocorrenciasUnicas.rows,
      amostraEntregas: amostra.rows
    });
  } catch (err) {
    console.error('❌ Erro no diagnóstico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload de entregas (recebe JSON do Excel processado no frontend)
app.post('/api/bi/entregas/upload', async (req, res) => {
  try {
    const { entregas, data_referencia, usuario_id, usuario_nome, nome_arquivo } = req.body;
    
    console.log(`📤 Upload BI: Recebendo ${entregas?.length || 0} entregas`);
    console.log(`👤 Usuário: ${usuario_nome || 'não informado'} (${usuario_id || 'sem id'})`);
    console.log(`📁 Arquivo: ${nome_arquivo || 'não informado'}`);
    
    if (!entregas || entregas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma entrega recebida' });
    }
    
    // ============================================
    // PASSO 1: Extrair todas as OS únicas do Excel
    // ============================================
    const osDoExcel = [...new Set(entregas.map(e => parseInt(e.os)).filter(os => os && !isNaN(os)))];
    console.log(`📋 Total de OS únicas no Excel: ${osDoExcel.length}`);
    
    if (osDoExcel.length === 0) {
      return res.status(400).json({ error: 'Nenhuma OS válida encontrada no arquivo' });
    }
    
    // ============================================
    // PASSO 2: Verificar quais OS já existem no banco
    // ============================================
    const osExistentesQuery = await pool.query(`
      SELECT DISTINCT os FROM bi_entregas WHERE os = ANY($1::int[])
    `, [osDoExcel]);
    
    const osExistentes = new Set(osExistentesQuery.rows.map(r => r.os));
    console.log(`🔍 OS que já existem no banco: ${osExistentes.size}`);
    
    // ============================================
    // PASSO 3: Filtrar apenas entregas com OS novas
    // ============================================
    const entregasNovas = entregas.filter(e => {
      const os = parseInt(e.os);
      return os && !isNaN(os) && !osExistentes.has(os);
    });
    
    const osIgnoradas = osDoExcel.filter(os => osExistentes.has(os));
    console.log(`✅ Entregas novas para inserir: ${entregasNovas.length}`);
    console.log(`⏭️ Linhas ignoradas (OS já existe): ${entregas.length - entregasNovas.length}`);
    
    if (entregasNovas.length === 0) {
      // Registrar tentativa no histórico mesmo sem inserir nada
      await pool.query(`
        INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, data_upload)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [usuario_id, usuario_nome, nome_arquivo, entregas.length, 0, entregas.length]);
      
      return res.json({ 
        success: true, 
        inseridos: 0, 
        ignorados: entregas.length,
        os_ignoradas: osIgnoradas.length,
        message: 'Todas as OS já existem no banco de dados'
      });
    }
    
    // ============================================
    // PASSO 4: Buscar configurações de prazo
    // ============================================
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `).catch(() => ({ rows: [] }));
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`).catch(() => ({ rows: [] }));
    
    // Função para encontrar prazo baseado na distância - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Se não tem configuração personalizada, usa regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo (prazo 0)
      return 0;
    };
    
    // Funções auxiliares de parsing
    const parseDataHora = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        return new Date(excelEpoch.getTime() + valor * 86400000);
      }
      if (typeof valor === 'string') {
        const regex = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
        const match = valor.match(regex);
        if (match) {
          const [_, dia, mes, ano, hora, min, seg] = match;
          return new Date(ano, mes - 1, dia, hora, min, seg || 0);
        }
        const d = new Date(valor);
        if (!isNaN(d.getTime())) return d;
      }
      return null;
    };
    
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      if (execucaoComp !== null && execucaoComp !== undefined && execucaoComp !== '') {
        if (typeof execucaoComp === 'number') {
          return Math.round(execucaoComp * 24 * 60);
        }
        if (typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
          const partes = execucaoComp.split(':');
          if (partes.length >= 2) {
            return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
          }
        }
      }
      if (dataHora && finalizado && typeof dataHora === 'number' && typeof finalizado === 'number') {
        const diff = finalizado - dataHora;
        if (diff >= 0) {
          return Math.round(diff * 24 * 60);
        }
      }
      return null;
    };
    
    // Função para calcular T. Entrega Prof a partir de Data/Hora Alocado até Finalizado
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = parseDataHora(dataHoraAlocado);
      const fim = parseDataHora(finalizado);
      if (!inicio || !fim) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    // Buscar configurações de prazo profissional
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProf = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProf.rows;
      
      const prazoProfPadraoResult = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoResult.rows;
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback');
    }
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Usa prazo padrão profissional
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Fallback: 60 minutos para qualquer distância
      return 60;
    };
    
    const parseData = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        const date = new Date(excelEpoch.getTime() + valor * 86400000);
        return date.toISOString().split('T')[0];
      }
      if (typeof valor === 'string' && valor.includes('/')) {
        const partes = valor.split(/[\s\/]/);
        if (partes.length >= 3) {
          return `${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`;
        }
      }
      return valor;
    };
    
    const parseTimestamp = (valor) => {
      const d = parseDataHora(valor);
      return d ? d.toISOString() : null;
    };
    
    const parseNum = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') return valor;
      const str = String(valor).replace(',', '.').replace(/[^\d.-]/g, '');
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    };
    
    // Função para parsear hora (HH:MM:SS ou HH:MM)
    const parseHora = (valor) => {
      if (!valor) return null;
      try {
        // Se for string no formato HH:MM:SS ou HH:MM
        if (typeof valor === 'string') {
          const match = valor.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          if (match) {
            const h = match[1].padStart(2, '0');
            const m = match[2].padStart(2, '0');
            const s = match[3] ? match[3].padStart(2, '0') : '00';
            return `${h}:${m}:${s}`;
          }
        }
        // Se for número decimal do Excel (fração do dia)
        if (typeof valor === 'number' && valor < 1) {
          const totalSeconds = Math.round(valor * 24 * 60 * 60);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    const truncar = (str, max) => str ? String(str).substring(0, max) : null;
    
    // ============================================
    // PASSO 5: Processar e inserir entregas novas
    // ============================================
    let inseridos = 0;
    let erros = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(entregasNovas.length / BATCH_SIZE);
    
    console.log(`📦 Processando ${entregasNovas.length} linhas novas em ${totalBatches} lotes`);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, entregasNovas.length);
      const batch = entregasNovas.slice(start, end);
      
      const dadosLote = [];
      
      for (const e of batch) {
        try {
          const os = parseInt(e.os);
          if (!os) continue;
          
          const distancia = parseNum(e.distancia) || 0;
          const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
          const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
          const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
          
          // Calcular Prazo Profissional: Data/Hora Alocado → Finalizado
          const prazoMinutosProf = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
          const tempoEntregaProf = calcularTempoEntregaProf(e.data_hora_alocado, e.finalizado);
          const dentroPrazoProf = (prazoMinutosProf !== null && tempoEntregaProf !== null) ? tempoEntregaProf <= prazoMinutosProf : null;
          
          if (dentroPrazo === true) dentroPrazoCount++;
          if (dentroPrazo === false) foraPrazoCount++;
          
          // Extrair ponto - primeiro tenta campo direto, depois extrai do endereço
          let ponto = parseInt(e.ponto || e.Ponto || e.seq || e.Seq || e.sequencia || e.Sequencia || e.pt || e.Pt || 0) || 0;
          const enderecoStr = e.endereco || e['Endereço'] || e.Endereco || '';
          if (ponto === 0 && enderecoStr) {
            const matchPonto = String(enderecoStr).match(/^Ponto\s*(\d+)/i);
            if (matchPonto) ponto = parseInt(matchPonto[1]) || 1;
          }
          if (ponto === 0) ponto = 1;
          
          dadosLote.push({
            os,
            ponto,
            num_pedido: truncar(e.num_pedido || e['Num Pedido'] || e['Num pedido'] || e['num pedido'], 100),
            cod_cliente: parseInt(e.cod_cliente || e['Cod Cliente'] || e['Cod cliente'] || e['cod cliente'] || e['Cód Cliente'] || e['Cód. cliente']) || null,
            nome_cliente: truncar(e.nome_cliente || e['Nome cliente'] || e['Nome Cliente'], 255),
            empresa: truncar(e.empresa || e.Empresa, 255),
            nome_fantasia: truncar(e.nome_fantasia || e['Nome Fantasia'] || e['Nome fantasia'], 255),
            centro_custo: truncar(e.centro_custo || e['Centro Custo'] || e['Centro custo'] || e['centro custo'] || e['Centro de Custo'] || e['Centro de custo'] || e.CentroCusto, 255),
            cidade_p1: truncar(e.cidade_p1 || e['Cidade P1'] || e['Cidade p1'], 100),
            endereco: enderecoStr || null,
            bairro: truncar(e.bairro, 100),
            cidade: truncar(e.cidade, 100),
            estado: truncar(e.estado, 50),
            cod_prof: parseInt(e.cod_prof) || null,
            nome_prof: truncar(e.nome_prof, 255),
            data_hora: parseTimestamp(e.data_hora),
            data_hora_alocado: parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado'] || e['Data Hora Alocado'] || e['DataHoraAlocado']),
            finalizado: parseTimestamp(e.finalizado),
            data_solicitado: parseData(e.data_solicitado) || parseData(e.data_hora),
            hora_solicitado: parseHora(e.hora_solicitado || e['H. Solicitação'] || e['H.Solicitação'] || e['H. Solicitacao'] || e['H.Solicitacao'] || e['Hora Solicitação'] || e['Hora Solicitacao'] || e['hora_solicitacao'] || e['HSolicitacao'] || e['h_solicitacao']),
            data_chegada: parseData(e.data_chegada || e['Data Chegada'] || e['Data chegada']),
            hora_chegada: parseHora(e.hora_chegada || e['Hora Chegada'] || e['Hora chegada']),
            data_saida: parseData(e.data_saida || e['Data Saida'] || e['Data Saída'] || e['Data saida']),
            hora_saida: parseHora(e.hora_saida || e['Hora Saida'] || e['Hora Saída'] || e['Hora saida']),
            categoria: truncar(e.categoria, 100),
            valor: parseNum(e.valor),
            distancia: distancia,
            valor_prof: parseNum(e.valor_prof),
            execucao_comp: truncar(e.execucao_comp ? String(e.execucao_comp) : null, 50),
            execucao_espera: truncar(e.execucao_espera ? String(e.execucao_espera) : null, 50),
            status: truncar(e.status, 100),
            motivo: truncar(e.motivo, 255),
            ocorrencia: truncar(e.ocorrencia, 255),
            velocidade_media: parseNum(e.velocidade_media),
            dentro_prazo: dentroPrazo,
            prazo_minutos: prazoMinutos,
            tempo_execucao_minutos: tempoExecucao,
            tempo_entrega_prof_minutos: tempoEntregaProf,
            dentro_prazo_prof: dentroPrazoProf,
            data_upload: data_referencia || new Date().toISOString().split('T')[0],
            latitude: parseNum(e.latitude || e.Latitude || e.lat || e.Lat || e.LAT || e.LATITUDE),
            longitude: parseNum(e.longitude || e.Longitude || e.lng || e.Lng || e.LNG || e.LONGITUDE || e.long || e.Long)
          });
        } catch (err) {
          erros++;
        }
      }
      
      // Inserir lote
      if (dadosLote.length > 0) {
        for (const d of dadosLote) {
          try {
            await pool.query(`
              INSERT INTO bi_entregas (
                os, ponto, num_pedido, cod_cliente, nome_cliente, empresa,
                nome_fantasia, centro_custo, cidade_p1, endereco,
                bairro, cidade, estado, cod_prof, nome_prof,
                data_hora, data_hora_alocado, finalizado, data_solicitado, hora_solicitado,
                data_chegada, hora_chegada, data_saida, hora_saida,
                categoria, valor, distancia, valor_prof,
                execucao_comp, execucao_espera, status, motivo, ocorrencia, velocidade_media,
                dentro_prazo, prazo_minutos, tempo_execucao_minutos, 
                tempo_entrega_prof_minutos, dentro_prazo_prof,
                data_upload, latitude, longitude
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
            `, [
              d.os, d.ponto, d.num_pedido, d.cod_cliente, d.nome_cliente, d.empresa,
              d.nome_fantasia, d.centro_custo, d.cidade_p1, d.endereco,
              d.bairro, d.cidade, d.estado, d.cod_prof, d.nome_prof,
              d.data_hora, d.data_hora_alocado, d.finalizado, d.data_solicitado, d.hora_solicitado,
              d.data_chegada, d.hora_chegada, d.data_saida, d.hora_saida,
              d.categoria, d.valor, d.distancia, d.valor_prof,
              d.execucao_comp, d.execucao_espera, d.status, d.motivo, d.ocorrencia, d.velocidade_media,
              d.dentro_prazo, d.prazo_minutos, d.tempo_execucao_minutos,
              d.tempo_entrega_prof_minutos, d.dentro_prazo_prof,
              d.data_upload, d.latitude, d.longitude
            ]);
            inseridos++;
          } catch (singleErr) {
            erros++;
          }
        }
      }
    }
    
    // ============================================
    // PASSO 6: Registrar no histórico de uploads
    // ============================================
    const linhasIgnoradas = entregas.length - entregasNovas.length;
    
    await pool.query(`
      INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, os_novas, os_ignoradas, data_upload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      usuario_id, 
      usuario_nome, 
      nome_arquivo, 
      entregas.length, 
      inseridos, 
      linhasIgnoradas,
      osDoExcel.length - osIgnoradas.length,
      osIgnoradas.length
    ]);
    
    console.log(`✅ Upload concluído: ${inseridos} inseridos, ${linhasIgnoradas} ignorados (OS duplicada), ${erros} erros`);
    console.log(`📊 Dentro do prazo: ${dentroPrazoCount}, Fora do prazo: ${foraPrazoCount}`);
    
    // ============================================
    // PASSO 7: Atualizar resumos pré-calculados
    // ============================================
    // Extrair datas únicas das entregas inseridas para atualizar apenas essas datas
    const datasAfetadas = [...new Set(entregasNovas.map(e => e.data_solicitado).filter(d => d))];
    console.log(`📊 Atualizando resumos para ${datasAfetadas.length} data(s)...`);
    
    // Atualizar resumos em background (não bloqueia a resposta)
    atualizarResumos(datasAfetadas).then(resultado => {
      console.log('📊 Resumos atualizados:', resultado);
    }).catch(err => {
      console.error('❌ Erro ao atualizar resumos:', err);
    });
    
    res.json({
      success: true,
      inseridos,
      ignorados: linhasIgnoradas,
      erros,
      os_novas: osDoExcel.length - osIgnoradas.length,
      os_ignoradas: osIgnoradas.length,
      dentro_prazo: dentroPrazoCount,
      fora_prazo: foraPrazoCount
    });
  } catch (err) {
    console.error('❌ Erro no upload:', err);
    res.status(500).json({ error: 'Erro ao fazer upload: ' + err.message });
  }
});

// Recalcular prazos de todas as entregas
app.post('/api/bi/entregas/recalcular', async (req, res) => {
  try {
    // Buscar configurações de prazo
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    if (prazoPadrao.rows.length > 0) {
      console.log(`🔄 Faixas padrão:`, prazoPadrao.rows.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', '));
    } else {
      console.log(`⚠️ ATENÇÃO: Nenhum prazo padrão configurado! Configure na aba Prazos.`);
    }
    
    // Buscar todas as entregas
    const entregas = await pool.query(`SELECT id, cod_cliente, centro_custo, distancia, data_hora, finalizado, execucao_comp FROM bi_entregas`);
    console.log(`🔄 Total de entregas: ${entregas.rows.length}`);
    
    // Função para encontrar prazo - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo
      return 0;
    };
    
    // Calcular tempo em minutos
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      // Se tiver execucao_comp como string HH:MM:SS
      if (execucaoComp && typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
        const partes = execucaoComp.split(':');
        if (partes.length >= 2) {
          return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
        }
      }
      
      // Calcular a partir dos timestamps
      if (!dataHora || !finalizado) return null;
      const inicio = new Date(dataHora);
      const fim = new Date(finalizado);
      if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    let atualizados = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let semPrazoCount = 0;
    
    for (const e of entregas.rows) {
      const distancia = parseFloat(e.distancia) || 0;
      const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, execComp="${e.execucao_comp}", data_hora=${e.data_hora}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo = $1, prazo_minutos = $2, tempo_execucao_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular:', err);
    res.status(500).json({ error: 'Erro ao recalcular' });
  }
});

// Atualizar resumos pré-calculados (forçar recálculo)
app.post('/api/bi/atualizar-resumos', async (req, res) => {
  try {
    console.log('📊 Forçando atualização de resumos...');
    const resultado = await atualizarResumos();
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao atualizar resumos:', err);
    res.status(500).json({ error: 'Erro ao atualizar resumos: ' + err.message });
  }
});

// Obter métricas do dashboard usando resumos pré-calculados (OTIMIZADO)
app.get('/api/bi/dashboard-rapido', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Usar resumo diário para métricas gerais
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Se tem filtro de cliente, usar bi_resumo_cliente
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        // Buscar métricas por cliente
        const clienteQuery = await pool.query(`
          SELECT 
            SUM(total_os) as total_os,
            SUM(total_entregas) as total_entregas,
            SUM(entregas_no_prazo) as entregas_no_prazo,
            SUM(entregas_fora_prazo) as entregas_fora_prazo,
            ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
            SUM(total_retornos) as total_retornos,
            SUM(valor_total) as valor_total,
            SUM(valor_prof) as valor_prof,
            ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
            ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
            SUM(total_profissionais) as total_profissionais
          FROM bi_resumo_cliente
          ${whereClause} AND cod_cliente = ANY($${paramIndex}::int[])
        `, [...params, clientes]);
        
        return res.json({
          metricas: clienteQuery.rows[0] || {},
          fonte: 'resumo_cliente'
        });
      }
    }
    
    // Sem filtro de cliente, usar resumo diário
    const diarioQuery = await pool.query(`
      SELECT 
        SUM(total_os) as total_os,
        SUM(total_entregas) as total_entregas,
        SUM(entregas_no_prazo) as entregas_no_prazo,
        SUM(entregas_fora_prazo) as entregas_fora_prazo,
        ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
        SUM(total_retornos) as total_retornos,
        SUM(valor_total) as valor_total,
        SUM(valor_prof) as valor_prof,
        ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
        ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
        ROUND(AVG(tempo_medio_alocacao), 2) as tempo_medio_alocacao,
        ROUND(AVG(tempo_medio_coleta), 2) as tempo_medio_coleta,
        SUM(total_profissionais) as total_profissionais,
        ROUND(AVG(media_ent_profissional), 2) as media_ent_profissional,
        SUM(km_total) as km_total
      FROM bi_resumo_diario
      ${whereClause}
    `, params);
    
    res.json({
      metricas: diarioQuery.rows[0] || {},
      fonte: 'resumo_diario'
    });
  } catch (err) {
    console.error('❌ Erro dashboard rápido:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ============================================
// RELATÓRIO IA COM GEMINI
// ============================================
app.get('/api/bi/relatorio-ia', async (req, res) => {
  try {
    const { data_inicio, data_fim, prompt_custom } = req.query;
    // Suportar múltiplos tipos
    const tipos = req.query.tipo ? (Array.isArray(req.query.tipo) ? req.query.tipo : [req.query.tipo]) : ['performance'];
    const cod_cliente = req.query.cod_cliente ? (Array.isArray(req.query.cod_cliente) ? req.query.cod_cliente : [req.query.cod_cliente]) : [];
    const centro_custo = req.query.centro_custo ? (Array.isArray(req.query.centro_custo) ? req.query.centro_custo : [req.query.centro_custo]) : [];
    
    console.log(`🤖 Gerando relatório IA: tipos=${tipos.join(', ')}, período=${data_inicio} a ${data_fim}`);
    
    // Verificar se tem API key do Gemini
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(400).json({ error: 'API Key do Gemini não configurada. Adicione GEMINI_API_KEY nas variáveis de ambiente.' });
    }
    
    // Construir filtro WHERE
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente.length > 0) {
      whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
      params.push(cod_cliente.map(c => parseInt(c)));
      paramIndex++;
    }
    if (centro_custo.length > 0) {
      whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
      params.push(centro_custo);
      paramIndex++;
    }
    
    // 1. Buscar métricas gerais (EXPANDIDO)
    const metricasQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 2) as tempo_medio_entrega,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 2) as tempo_medio_alocacao,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_entrega_prof_minutos > 0 AND tempo_entrega_prof_minutos <= 300 THEN tempo_entrega_prof_minutos END), 2) as tempo_medio_coleta,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_profissionais,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_cliente END) as total_clientes,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 2) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as total_retornos,
        MIN(data_solicitado) as data_inicio_real,
        MAX(data_solicitado) as data_fim_real
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    const metricas = metricasQuery.rows[0];
    
    // 2. Buscar dados por dia
    const porDiaQuery = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // 3. Buscar top clientes (com mais dados)
    const topClientesQuery = await pool.query(`
      SELECT 
        nome_fantasia as cliente,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as retornos
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 4. Buscar top profissionais (com mais dados)
    const topProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_recebido
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 5. Buscar piores profissionais (taxa baixa)
    const pioresProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) >= 10
      ORDER BY ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) ASC
      LIMIT 5
    `, params);
    
    // 6. Buscar distribuição por dia da semana
    const porDiaSemanaQuery = await pool.query(`
      SELECT 
        EXTRACT(DOW FROM data_solicitado) as dia_semana,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(DOW FROM data_solicitado)
      ORDER BY EXTRACT(DOW FROM data_solicitado)
    `, params);
    
    // 7. Buscar distribuição por hora do dia (usando data_hora que é TIMESTAMP)
    let porHoraQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause} AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora)
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) > 0
      ORDER BY EXTRACT(HOUR FROM data_hora)
    `, params);
    
    console.log('📊 Dados por hora (data_hora):', porHoraQuery.rows.length, 'registros');
    
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const dadosDiaSemana = porDiaSemanaQuery.rows.map(r => ({
      dia: diasSemana[parseInt(r.dia_semana)],
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0,
      tempo_medio: parseFloat(r.tempo_medio) || 0
    }));
    
    const dadosPorHora = porHoraQuery.rows.map(r => ({
      hora: parseInt(r.hora),
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0
    })).sort((a, b) => a.hora - b.hora);
    
    // Calcular horário de pico
    const horarioPico = dadosPorHora.length > 0 
      ? dadosPorHora.reduce((max, h) => h.entregas > max.entregas ? h : max, dadosPorHora[0])
      : null;
    
    // Calcular total de entregas para % do pico
    const totalEntregasHora = dadosPorHora.reduce((sum, h) => sum + h.entregas, 0);
    
    // Identificar janela de pico (3 horas consecutivas com maior volume)
    let melhorJanela = { inicio: 0, fim: 0, entregas: 0 };
    for (let i = 0; i < dadosPorHora.length - 2; i++) {
      const somaJanela = dadosPorHora[i].entregas + (dadosPorHora[i+1]?.entregas || 0) + (dadosPorHora[i+2]?.entregas || 0);
      if (somaJanela > melhorJanela.entregas) {
        melhorJanela = { 
          inicio: dadosPorHora[i].hora, 
          fim: dadosPorHora[i+2]?.hora || dadosPorHora[i].hora, 
          entregas: somaJanela 
        };
      }
    }
    
    // Calcular variações e tendências
    // Função para formatar data
    const formatarData = (d) => {
      if (!d) return '';
      const data = new Date(d);
      return data.toLocaleDateString('pt-BR');
    };
    
    const evolucaoDiaria = porDiaQuery.rows.slice(-14).map(r => ({
      data: formatarData(r.data),
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa) || 0,
      valor: parseFloat(r.valor) || 0,
      profissionais: parseInt(r.profissionais) || 0
    }));
    
    // Calcular média de profissionais por dia
    const todosDias = porDiaQuery.rows.map(r => parseInt(r.profissionais) || 0);
    const mediaProfissionaisDia = todosDias.length > 0 
      ? (todosDias.reduce((a, b) => a + b, 0) / todosDias.length).toFixed(1) 
      : 0;
    
    // Calcular tendência (comparar primeira metade com segunda metade)
    const metade = Math.floor(evolucaoDiaria.length / 2);
    const primeiraParte = evolucaoDiaria.slice(0, metade);
    const segundaParte = evolucaoDiaria.slice(metade);
    const mediaPrimeira = primeiraParte.length > 0 ? primeiraParte.reduce((a, b) => a + b.taxa_prazo, 0) / primeiraParte.length : 0;
    const mediaSegunda = segundaParte.length > 0 ? segundaParte.reduce((a, b) => a + b.taxa_prazo, 0) / segundaParte.length : 0;
    const tendencia = mediaSegunda - mediaPrimeira;
    
    // Montar contexto para a IA (EXPANDIDO)
    const contexto = {
      periodo: { inicio: data_inicio || metricas.data_inicio_real, fim: data_fim || metricas.data_fim_real },
      metricas_gerais: {
        total_os: parseInt(metricas.total_os) || 0,
        total_entregas: parseInt(metricas.total_entregas) || 0,
        taxa_prazo: parseFloat(metricas.taxa_prazo) || 0,
        entregas_no_prazo: parseInt(metricas.entregas_no_prazo) || 0,
        entregas_fora_prazo: parseInt(metricas.entregas_fora_prazo) || 0,
        total_retornos: parseInt(metricas.total_retornos) || 0,
        valor_total: parseFloat(metricas.valor_total) || 0,
        valor_profissionais: parseFloat(metricas.valor_prof) || 0,
        lucro_bruto: (parseFloat(metricas.valor_total) || 0) - (parseFloat(metricas.valor_prof) || 0),
        margem_percentual: parseFloat(metricas.valor_total) > 0 ? (((parseFloat(metricas.valor_total) - parseFloat(metricas.valor_prof)) / parseFloat(metricas.valor_total)) * 100).toFixed(1) : 0,
        tempo_medio_entrega: parseFloat(metricas.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(metricas.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(metricas.tempo_medio_coleta) || 0,
        km_total: parseFloat(metricas.km_total) || 0,
        km_medio: parseFloat(metricas.km_medio) || 0,
        total_profissionais_distintos: parseInt(metricas.total_profissionais) || 0,
        total_clientes: parseInt(metricas.total_clientes) || 0,
        total_dias_periodo: porDiaQuery.rows.length || 1,
        media_entregas_por_dia: porDiaQuery.rows.length > 0 ? (parseInt(metricas.total_entregas) / porDiaQuery.rows.length).toFixed(1) : 0,
        media_profissionais_por_dia: mediaProfissionaisDia,
        profissionais_ideais_por_dia: porDiaQuery.rows.length > 0 ? Math.ceil((parseInt(metricas.total_entregas) / porDiaQuery.rows.length) / 10) : 0,
        media_entregas_por_profissional_dia: mediaProfissionaisDia > 0 ? ((parseInt(metricas.total_entregas) / porDiaQuery.rows.length) / mediaProfissionaisDia).toFixed(1) : 0,
        ticket_medio: parseInt(metricas.total_entregas) > 0 ? (parseFloat(metricas.valor_total) / parseInt(metricas.total_entregas)).toFixed(2) : 0
      },
      tendencia: {
        variacao_taxa: tendencia.toFixed(1),
        direcao: tendencia > 1 ? 'MELHORANDO' : tendencia < -1 ? 'PIORANDO' : 'ESTÁVEL'
      },
      evolucao_diaria: evolucaoDiaria,
      top_clientes: topClientesQuery.rows.map(r => ({
        cliente: r.cliente,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        valor: parseFloat(r.valor) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_medio: parseFloat(r.km_medio) || 0,
        retornos: parseInt(r.retornos) || 0
      })),
      top_profissionais: topProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_total: parseFloat(r.km_total) || 0,
        valor_recebido: parseFloat(r.valor_recebido) || 0
      })),
      piores_profissionais: pioresProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0
      })),
      distribuicao_dia_semana: dadosDiaSemana,
      distribuicao_hora: dadosPorHora,
      horario_pico: horarioPico ? {
        hora: horarioPico.hora,
        entregas_total_periodo: horarioPico.entregas,
        entregas_media_dia: (horarioPico.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual_do_total: totalEntregasHora > 0 ? ((horarioPico.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        // Profissionais para o pico: 3 pedidos por moto (considerando retorno e nova coleta)
        profissionais_necessarios: Math.ceil(horarioPico.entregas / (porDiaQuery.rows.length || 1) / 3)
      } : null,
      janela_pico: {
        inicio: melhorJanela.inicio,
        fim: melhorJanela.fim,
        duracao_horas: melhorJanela.fim - melhorJanela.inicio + 1,
        entregas_total_periodo: melhorJanela.entregas,
        entregas_media_dia: (melhorJanela.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual_do_total: totalEntregasHora > 0 ? ((melhorJanela.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        // Profissionais para o pico: 3 pedidos por moto por hora (ida + volta + nova coleta ~20min cada)
        // Em uma janela de 3 horas, cada moto pode fazer ~3 entregas por hora = 9 entregas na janela
        // Mas para ser conservador, consideramos 3 entregas por moto na janela toda
        profissionais_necessarios: Math.ceil(melhorJanela.entregas / (porDiaQuery.rows.length || 1) / 3)
      }
    };
    
    // Definir prompt base por tipo
    const promptsBase = {
      performance: `## 📈 PERFORMANCE GERAL
Analise a performance OPERACIONAL (NÃO mencione valores financeiros, faturamento ou margem):
- Taxa de prazo atual vs benchmark (85%+ é bom)
- Tempo médio de entrega (adequado ou não, ideal < 60min)
- Pontos fortes operacionais (máx 3) - ex: taxa de prazo, tempo, eficiência
- Pontos fracos operacionais (máx 3) - ex: atrasos, tempo alto, retornos
- **NOTA GERAL: X/10** (baseada apenas em métricas operacionais)

⚠️ NÃO inclua informações de faturamento, valores, lucro ou margem nesta seção.`,
      
      tendencias: `## 📉 TENDÊNCIAS E PREDIÇÃO

⚠️ IMPORTANTE: Use EXATAMENTE os dados fornecidos na seção "HORÁRIO DE PICO" e "JANELA DE PICO". NÃO invente números.

**1️⃣ COMPORTAMENTO DA DEMANDA**
- Analise a seção "TENDÊNCIA" do contexto
- Informe se está: 📈 CRESCIMENTO | 📉 QUEDA | ➡️ ESTÁVEL
- Se queda >15%: emita 🔴 ALERTA

**2️⃣ SAZONALIDADE E PICOS**
Use EXATAMENTE os dados da seção "POR DIA DA SEMANA":
| Ranking | Dia | Volume | 
|---------|-----|--------|
| 🥇 | [copie do contexto] | X ent |
| 🥈 | [copie do contexto] | X ent |
| 🥉 | [copie do contexto] | X ent |

**Horário de Pico:** Copie EXATAMENTE da seção "JANELA DE PICO"
- Janela: [copie inicio]h às [copie fim]h
- Média diária no pico: [copie entregas_media_dia] entregas/dia
- % do total diário: [copie percentual_do_total]%

**3️⃣ DIMENSIONAMENTO PREDITIVO PARA O PICO**
COPIE os valores da seção "JANELA DE PICO":
- Média de entregas/dia no pico: [entregas_media_dia do contexto]
- Regra: 3 pedidos por motoboy no pico (moto faz ida, volta e pega novo pedido)
- **👥 Profissionais necessários:** [profissionais_necessarios do contexto] motoboys
- Cálculo: [entregas_media_dia] ÷ 3 = [profissionais_necessarios]

**4️⃣ INSIGHTS ESTRATÉGICOS**
- Status geral: 🟢 SAUDÁVEL | 🟡 ATENÇÃO | 🔴 CRÍTICO
- Recomendação (1-2 frases)`,
      
      alertas: `## ⚠️ ALERTAS URGENTES
Liste APENAS problemas críticos:
🔴 CRÍTICO: [problema] → [ação]
🟡 ATENÇÃO: [problema] → [ação]
🟢 MONITORAR: [problema] → [ação]
Máximo 5 alertas.`,
      
      gestao_profissionais: `## 👥 GESTÃO DE PROFISSIONAIS

**1️⃣ EQUILÍBRIO DE CARGA (Meta: 10 entregas/profissional/DIA)**
Use os dados de "MÉTRICAS DE DIMENSIONAMENTO":
- Média de entregas/dia: [media_entregas_por_dia do contexto]
- Média de profissionais/dia (real): [media_profissionais_por_dia do contexto]
- Profissionais ideais/dia: [profissionais_ideais_por_dia do contexto]
- Média entregas/moto/dia: [media_entregas_por_profissional_dia do contexto]

**Status da operação:**
Compare "Média de profissionais/dia (real)" com "Profissionais ideais/dia":
- ✅ ADEQUADO: se real ≈ ideal (diferença < 20%)
- ⚠️ SUBDIMENSIONADO: se real < ideal (poucos motoboys, cada um faz mais de 10/dia)
- 🔴 SUPERDIMENSIONADO: se real > ideal (muitos motoboys, cada um faz menos de 10/dia)

**Apresente:**
| Métrica | Valor |
|---------|-------|
| Entregas/dia (média) | [copie do contexto] |
| Profissionais/dia (real) | [copie do contexto] |
| Profissionais ideais/dia | [copie do contexto] |
| Entregas/moto/dia | [copie do contexto] |
| Status | ✅/⚠️/🔴 |
| Recomendação | [ação se necessário] |

**2️⃣ ANÁLISE DE ROTATIVIDADE (CHURN)**
- Total de profissionais distintos que trabalharam no período: X
- Profissionais necessários por dia: X
- Proporção: (distintos ÷ necessários/dia)
- Status:
  - ✅ NORMAL: proporção < 2x
  - ⚠️ ALTA ROTATIVIDADE: proporção entre 2x e 4x
  - 🔴 ROTATIVIDADE CRÍTICA: proporção > 4x
- Se alta rotatividade: explicar impacto e recomendar ação

**3️⃣ DISPARIDADE DE CARGA/REMUNERAÇÃO**
Identificar OUTLIERS (profissionais com volume muito diferente da média):
| Profissional | Entregas | Desvio da Média | Status |
Sinalize com ⚠️ quem está >50% acima ou abaixo da média do grupo.

**4️⃣ RANKING DE PERFORMANCE (por % de entregas no prazo)**
🏆 **TOP 3 - Melhores Taxas de Prazo:**
🥇 [nome] - [X]% no prazo - [X] entregas
🥈 [nome] - [X]% no prazo - [X] entregas
🥉 [nome] - [X]% no prazo - [X] entregas

⚠️ **DETRATORES - Piores Taxas de Prazo:**
1. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
2. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
3. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]

**Se TODOS estiverem com baixa performance (<85% no prazo), emita:**
🔴 **ALERTA: BAIXA PERFORMANCE GERAL DA EQUIPE**
- Taxa média de prazo: X%
- Meta: 85%
- Ação recomendada: [sugestão]`,
      
      personalizado: prompt_custom ? `## ✨ ANÁLISE PERSONALIZADA\n${prompt_custom}` : null
    };
    
    // Reordenar tipos para alertas vir sempre por último
    const tiposOrdenados = [...tipos].sort((a, b) => {
      if (a === 'alertas') return 1;
      if (b === 'alertas') return -1;
      return 0;
    });
    
    // Combinar prompts dos tipos selecionados
    const promptsCombinados = tiposOrdenados
      .map(t => promptsBase[t])
      .filter(p => p !== null)
      .join('\n\n');
    
    const tiposLabel = tipos.map(t => {
      const labels = {performance: 'Performance', tendencias: 'Tendências', alertas: 'Alertas', gestao_profissionais: 'Gestão de Profissionais', personalizado: 'Personalizado'};
      return labels[t] || t;
    }).join(', ');
    
    const promptCompleto = `Você é um analista de operações de delivery. Seja DIRETO e VISUAL. Use emojis, tabelas e formatação para facilitar a leitura. Evite textos longos.

📊 **DADOS DA OPERAÇÃO** (${contexto.periodo.inicio} a ${contexto.periodo.fim})

📦 **RESUMO GERAL**
| Métrica | Valor |
|---------|-------|
| Total Entregas | ${contexto.metricas_gerais.total_entregas.toLocaleString()} |
| ✅ No Prazo | ${contexto.metricas_gerais.entregas_no_prazo.toLocaleString()} (${contexto.metricas_gerais.taxa_prazo}%) |
| ❌ Fora Prazo | ${contexto.metricas_gerais.entregas_fora_prazo.toLocaleString()} |
| 🔄 Retornos | ${contexto.metricas_gerais.total_retornos.toLocaleString()} |
| ⏱️ Tempo Médio | ${contexto.metricas_gerais.tempo_medio_entrega} min |
| 🚗 KM Médio | ${contexto.metricas_gerais.km_medio} km |
| 👥 Profissionais distintos | ${contexto.metricas_gerais.total_profissionais_distintos} |
| 🏢 Clientes | ${contexto.metricas_gerais.total_clientes} |

📊 **MÉTRICAS DE DIMENSIONAMENTO**
| Métrica | Valor |
|---------|-------|
| Total de dias no período | ${contexto.metricas_gerais.total_dias_periodo} dias |
| Média de entregas/dia | ${contexto.metricas_gerais.media_entregas_por_dia} ent/dia |
| **👥 Média de profissionais/dia (real)** | ${contexto.metricas_gerais.media_profissionais_por_dia} motoboys |
| **👥 Profissionais ideais/dia** | ${contexto.metricas_gerais.profissionais_ideais_por_dia} motoboys |
| Média entregas/profissional/dia | ${contexto.metricas_gerais.media_entregas_por_profissional_dia} ent/moto/dia |
| Meta por profissional | 10 ent/dia |
| Profissionais distintos no período | ${contexto.metricas_gerais.total_profissionais_distintos} |

💵 **FINANCEIRO**
| Métrica | Valor |
|---------|-------|
| Faturamento | R$ ${contexto.metricas_gerais.valor_total.toLocaleString('pt-BR')} |
| Custo Profissionais | R$ ${contexto.metricas_gerais.valor_profissionais.toLocaleString('pt-BR')} |
| Lucro Bruto | R$ ${contexto.metricas_gerais.lucro_bruto.toLocaleString('pt-BR')} |
| Margem | ${contexto.metricas_gerais.margem_percentual}% |
| Ticket Médio | R$ ${contexto.metricas_gerais.ticket_medio} |

📈 **TENDÊNCIA:** ${contexto.tendencia.direcao} (${contexto.tendencia.variacao_taxa > 0 ? '+' : ''}${contexto.tendencia.variacao_taxa}%)

📅 **EVOLUÇÃO DIÁRIA (últimos ${contexto.evolucao_diaria.length} dias)**
${contexto.evolucao_diaria.map(d => `${d.data}: ${d.entregas} ent | ${d.taxa_prazo}% ✓ | R$${d.valor.toLocaleString('pt-BR')}`).join('\n')}

🏢 **TOP CLIENTES**
${contexto.top_clientes.map((c, i) => `${i+1}. ${c.cliente}: ${c.entregas} ent | ${c.taxa_prazo}% | R$${c.valor.toLocaleString('pt-BR')} | ${c.tempo_medio}min | ${c.retornos} ret`).join('\n')}

👤 **TOP PROFISSIONAIS**
${contexto.top_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.entregas} ent | ${p.taxa_prazo}% | ${p.tempo_medio}min | ${p.km_total.toLocaleString()}km | R$${p.valor_recebido.toLocaleString('pt-BR')}`).join('\n')}

⚠️ **PROFISSIONAIS COM BAIXA PERFORMANCE** (mín 10 entregas)
${contexto.piores_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.taxa_prazo}% prazo | ${p.tempo_medio}min | ${p.entregas} ent`).join('\n')}

📆 **POR DIA DA SEMANA**
${contexto.distribuicao_dia_semana.map(d => `${d.dia}: ${d.entregas} ent | ${d.taxa_prazo}% | ${d.tempo_medio}min`).join('\n')}

⏰ **DISTRIBUIÇÃO POR HORÁRIO**
${contexto.distribuicao_hora.filter(h => h.entregas > 0).map(h => `${h.hora}h: ${h.entregas} ent | ${h.taxa_prazo}%`).join('\n')}

🔥 **HORÁRIO DE PICO (hora única com maior volume)**
${contexto.horario_pico ? `- Hora: ${contexto.horario_pico.hora}h
- Média por dia: ${contexto.horario_pico.entregas_media_dia} entregas/dia
- % do total diário: ${contexto.horario_pico.percentual_do_total}%
- **👥 Profissionais necessários no pico: ${contexto.horario_pico.profissionais_necessarios} motoboys**
- Regra: 3 pedidos/moto no horário de pico (ida + volta + nova coleta)
- Cálculo: ${contexto.horario_pico.entregas_media_dia} ÷ 3 = ${contexto.horario_pico.profissionais_necessarios}` : '- Sem dados de horário disponíveis'}

🔥 **JANELA DE PICO (${contexto.janela_pico ? contexto.janela_pico.duracao_horas : 3} horas consecutivas com maior volume)**
${contexto.janela_pico ? `- Janela: ${contexto.janela_pico.inicio}h às ${contexto.janela_pico.fim + 1}h (${contexto.janela_pico.duracao_horas}h de duração)
- Média por dia nesta janela: ${contexto.janela_pico.entregas_media_dia} entregas/dia
- % do total diário: ${contexto.janela_pico.percentual_do_total}% das entregas do dia
- **👥 Profissionais necessários na janela: ${contexto.janela_pico.profissionais_necessarios} motoboys**
- Regra: 3 pedidos/moto durante a janela de pico
- Cálculo: ${contexto.janela_pico.entregas_media_dia} ÷ 3 = ${contexto.janela_pico.profissionais_necessarios}` : '- Sem dados disponíveis'}

---
🎯 **SUAS TAREFAS:**
${promptsCombinados}

---
📝 **REGRAS OBRIGATÓRIAS:**
🚨 **CRÍTICO: Use SOMENTE os números fornecidos acima. NÃO invente dados!**
- Para HORÁRIO DE PICO: copie os valores das seções "HORÁRIO DE PICO" e "JANELA DE PICO"
- Para PROFISSIONAIS NO PICO: use o cálculo (média_dia ÷ 3), pois cada moto faz 3 pedidos no pico
- Seja DIRETO, sem enrolação
- Use emojis para facilitar leitura
- Use tabelas quando possível
- Bullets curtos, máximo 1 linha
- Destaque números importantes em **negrito**
- Para rankings use 🥇🥈🥉
- Para status use ✅❌⚠️🔴🟡🟢
${tipos.length > 1 ? '- Faça TODAS as análises solicitadas, separadas por seção' : ''}`;

    console.log('🤖 Chamando API Gemini...');
    
    // Chamar API do Gemini - aumentar tokens para múltiplas análises
    const maxTokens = tipos.length > 1 ? 4096 : 2048;
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptCompleto }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens
        }
      })
    });
    
    const geminiData = await geminiResponse.json();
    
    if (geminiData.error) {
      console.error('❌ Erro Gemini:', geminiData.error);
      return res.status(500).json({ error: 'Erro na API Gemini: ' + geminiData.error.message });
    }
    
    const relatorio = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Não foi possível gerar o relatório.';
    
    console.log('✅ Relatório IA gerado com sucesso');
    
    // Buscar nome do cliente se filtrado
    let clienteInfo = null;
    if (cod_cliente.length > 0) {
      try {
        const clienteQuery = await pool.query(`
          SELECT DISTINCT cod_cliente, 
                 COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text) as nome
          FROM bi_entregas 
          WHERE cod_cliente = ANY($1::int[])
          LIMIT 1
        `, [cod_cliente.map(c => parseInt(c))]);
        if (clienteQuery.rows.length > 0) {
          clienteInfo = {
            codigo: clienteQuery.rows[0].cod_cliente,
            nome: clienteQuery.rows[0].nome
          };
        }
      } catch (e) {
        console.log('⚠️ Não foi possível buscar nome do cliente:', e.message);
        clienteInfo = {
          codigo: cod_cliente[0],
          nome: null
        };
      }
    }
    
    // Salvar no histórico
    const usuario_id = req.query.usuario_id || null;
    const usuario_nome = req.query.usuario_nome || null;
    
    try {
      await pool.query(`
        INSERT INTO bi_relatorios_ia 
        (usuario_id, usuario_nome, cod_cliente, nome_cliente, centro_custo, tipo_analise, data_inicio, data_fim, metricas, relatorio, filtros)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        usuario_id,
        usuario_nome,
        clienteInfo?.codigo || null,
        clienteInfo?.nome || null,
        centro_custo.length > 0 ? centro_custo.join(', ') : null,
        tiposLabel,
        data_inicio || null,
        data_fim || null,
        JSON.stringify(contexto.metricas_gerais),
        relatorio,
        JSON.stringify({
          cliente: clienteInfo,
          centro_custo: centro_custo.length > 0 ? centro_custo : null
        })
      ]);
      console.log('✅ Relatório salvo no histórico');
    } catch (histErr) {
      console.error('⚠️ Erro ao salvar histórico:', histErr.message);
    }
    
    res.json({
      success: true,
      tipo_analise: tiposLabel,
      tipos_selecionados: tipos,
      periodo: contexto.periodo,
      metricas: contexto.metricas_gerais,
      relatorio,
      // Filtros aplicados
      filtros: {
        cliente: clienteInfo,
        centro_custo: centro_custo.length > 0 ? centro_custo : null
      },
      // Dados para gráficos
      graficos: {
        evolucao_diaria: contexto.evolucao_diaria,
        distribuicao_dia_semana: contexto.distribuicao_dia_semana,
        distribuicao_hora: contexto.distribuicao_hora,
        top_clientes: contexto.top_clientes.slice(0, 5),
        top_profissionais: contexto.top_profissionais.slice(0, 5),
        horario_pico: contexto.horario_pico,
        janela_pico: contexto.janela_pico
      }
    });
    
  } catch (err) {
    console.error('❌ Erro ao gerar relatório IA:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório: ' + err.message });
  }
});

// Endpoint para listar histórico de relatórios IA
app.get('/api/bi/relatorio-ia/historico', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, usuario_id, usuario_nome, cod_cliente, nome_cliente, centro_custo, 
             tipo_analise, data_inicio, data_fim, metricas, filtros, created_at
      FROM bi_relatorios_ia 
      ORDER BY created_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para buscar relatório específico do histórico
app.get('/api/bi/relatorio-ia/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM bi_relatorios_ia WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar relatório:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para deletar relatório do histórico
app.delete('/api/bi/relatorio-ia/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_relatorios_ia WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao deletar relatório:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para gerar relatório Word (.docx nativo)
app.post('/api/bi/relatorio-ia/word', async (req, res) => {
  try {
    const { tipo_analise, periodo, metricas, relatorio, filtros } = req.body;
    
    console.log('📄 Gerando relatório Word (.docx)...');
    
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, 
            Header, Footer, AlignmentType, BorderStyle, WidthType, 
            ShadingType, PageNumber, ImageRun, PageBreak, VerticalAlign } = require('docx');
    const https = require('https');
    
    // Baixar logo
    let logoBuffer = null;
    try {
      logoBuffer = await new Promise((resolve, reject) => {
        https.get('https://raw.githubusercontent.com/Leonardodevcloud/tutts-frontend/main/Gemini_Generated_Image_s64zrms64zrms64z.png', (response) => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
        }).on('error', reject);
      });
      console.log('✅ Logo baixada com sucesso');
    } catch (e) {
      console.log('⚠️ Não foi possível baixar a logo:', e.message);
    }
    
    // Montar título dinâmico
    let tituloRelatorio = "RELATÓRIO OPERACIONAL";
    let subtituloCliente = "";
    
    if (filtros?.cliente) {
      tituloRelatorio += ` - ${filtros.cliente.codigo}`;
      subtituloCliente = filtros.cliente.nome || "";
      if (filtros.centro_custo && filtros.centro_custo.length > 0) {
        subtituloCliente += ` | Centro de Custo: ${filtros.centro_custo.join(', ')}`;
      }
    } else if (filtros?.centro_custo && filtros.centro_custo.length > 0) {
      subtituloCliente = `Centro de Custo: ${filtros.centro_custo.join(', ')}`;
    }
    
    const m = metricas || {};
    
    // Função para criar célula de métrica
    const criarCelulaMetrica = (valor, label, corValor, corFundo) => {
      return new TableCell({
        width: { size: 2340, type: WidthType.DXA },
        shading: { fill: corFundo, type: ShadingType.CLEAR },
        margins: { top: 200, bottom: 200, left: 100, right: 100 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({ text: valor, bold: true, size: 40, color: corValor })]
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: label, size: 18, color: "64748B" })]
          })
        ]
      });
    };
    
    // Criar tabela de métricas
    const tabelaMetricas = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [2340, 2340, 2340, 2340],
      borders: {
        top: { style: BorderStyle.NONE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE },
        right: { style: BorderStyle.NONE },
        insideHorizontal: { style: BorderStyle.NONE },
        insideVertical: { style: BorderStyle.NONE }
      },
      rows: [
        new TableRow({
          children: [
            criarCelulaMetrica((m.total_entregas || 0).toLocaleString('pt-BR'), "ENTREGAS", "2563EB", "DBEAFE"),
            criarCelulaMetrica((m.taxa_prazo || 0).toFixed(1) + "%", "TAXA PRAZO", "16A34A", "DCFCE7"),
            criarCelulaMetrica((m.tempo_medio_entrega || 0).toFixed(0) + " min", "TEMPO MÉDIO", "7C3AED", "EDE9FE"),
            criarCelulaMetrica(String(m.media_profissionais_por_dia || 0), "MOTOS/DIA", "EA580C", "FFEDD5")
          ]
        })
      ]
    });
    
    // Processar relatório em parágrafos - SEM TEXTO BRANCO
    const processarRelatorio = (texto) => {
      if (!texto) return [];
      
      const paragrafos = [];
      const linhas = texto.split('\n');
      
      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!linha.trim()) {
          paragrafos.push(new Paragraph({ spacing: { before: 150, after: 150 }, children: [] }));
          continue;
        }
        
        const isTituloSecao = /^##\s/.test(linha);
        const isAlertaCritico = /🔴/.test(linha);
        const isAlertaAtencao = /🟡/.test(linha);
        const isAlertaOk = /🟢|✅/.test(linha);
        const isSubtitulo = /^[1️⃣2️⃣3️⃣4️⃣]/.test(linha);
        const isItemLista = /^[-*•]\s/.test(linha.trim()) || /^[🥇🥈🥉]/.test(linha);
        const isTabelaSeparador = /^\|[-\s|]+\|$/.test(linha);
        
        if (isTabelaSeparador) continue;
        
        let textoLimpo = linha
          .replace(/^##\s*/, '')
          .replace(/\*\*/g, '');
        
        if (isTituloSecao) {
          // Título de seção - BORDA COLORIDA em vez de fundo (mais compatível)
          paragrafos.push(new Paragraph({ spacing: { before: 400, after: 0 }, children: [] }));
          paragrafos.push(new Paragraph({
            spacing: { before: 0, after: 200 },
            border: {
              top: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              bottom: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              left: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              right: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" }
            },
            shading: { fill: "EDE9FE", type: ShadingType.CLEAR },
            children: [new TextRun({ text: "  " + textoLimpo + "  ", bold: true, size: 26, color: "6D28D9" })]
          }));
        } else if (isAlertaCritico) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "FEE2E2", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "DC2626" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, bold: true, size: 22, color: "DC2626" })]
          }));
        } else if (isAlertaAtencao) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "FEF3C7", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "F59E0B" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, bold: true, size: 22, color: "92400E" })]
          }));
        } else if (isAlertaOk) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "EDE9FE", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "7C3AED" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, size: 22, color: "6D28D9" })]
          }));
        } else if (isSubtitulo) {
          paragrafos.push(new Paragraph({ spacing: { before: 350, after: 0 }, children: [] }));
          paragrafos.push(new Paragraph({
            spacing: { before: 0, after: 150 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: "7C3AED" } },
            children: [new TextRun({ text: textoLimpo, bold: true, size: 26, color: "7C3AED" })]
          }));
        } else if (isItemLista) {
          paragrafos.push(new Paragraph({
            spacing: { before: 100, after: 100 },
            indent: { left: 500 },
            children: [new TextRun({ text: textoLimpo, size: 22, color: "374151" })]
          }));
        } else {
          paragrafos.push(new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [new TextRun({ text: textoLimpo, size: 22, color: "374151" })]
          }));
        }
      }
      
      return paragrafos;
    };
    
    // ==================== SEÇÃO 1: CAPA ====================
    const secaoCapa = {
      properties: {
        page: {
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      children: [
        // Espaço superior
        new Paragraph({ spacing: { before: 2000, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        
        // Logo centralizada
        ...(logoBuffer ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          children: [new ImageRun({
            data: logoBuffer,
            transformation: { width: 200, height: 200 },
            type: 'png'
          })]
        })] : []),
        
        // Espaço
        new Paragraph({ spacing: { before: 400, after: 400 }, children: [] }),
        
        // Título principal
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: tituloRelatorio, bold: true, size: 56, color: "7C3AED" })]
        }),
        
        // Subtítulo cliente
        ...(subtituloCliente ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: subtituloCliente, bold: true, size: 32, color: "374151" })]
        })] : []),
        
        // Espaço
        new Paragraph({ spacing: { before: 400, after: 400 }, children: [] }),
        
        // Linha decorativa
        new Paragraph({
          alignment: AlignmentType.CENTER,
          border: { bottom: { style: BorderStyle.SINGLE, size: 20, color: "7C3AED" } },
          spacing: { after: 400 },
          children: [new TextRun({ text: "                                                                                    ", size: 8 })]
        }),
        
        // Tipo de análise
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 150 },
          children: [new TextRun({ text: tipo_analise || 'Análise Geral', size: 28, color: "6B7280" })]
        }),
        
        // Período
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 150 },
          children: [new TextRun({ text: `Período: ${periodo?.inicio || ''} a ${periodo?.fim || ''}`, size: 24, color: "6B7280" })]
        }),
        
        // Data de geração
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
          children: [new TextRun({ text: `Gerado em: ${new Date().toLocaleString('pt-BR')}`, size: 22, color: "9CA3AF" })]
        }),
        
        // Espaço grande
        new Paragraph({ spacing: { before: 2000, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        
        // Rodapé da capa
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "Sistema Tutts - Business Intelligence", size: 20, color: "9CA3AF" })]
        })
      ]
    };
    
    // ==================== SEÇÃO 2: CONTEÚDO ====================
    const secaoConteudo = {
      properties: {
        page: {
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      headers: {
        default: new Header({
          children: [
            ...(logoBuffer ? [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new ImageRun({
                data: logoBuffer,
                transformation: { width: 60, height: 60 },
                type: 'png'
              })]
            })] : [])
          ]
        })
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              border: { top: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" } },
              spacing: { before: 200 },
              children: [
                new TextRun({ text: "Sistema Tutts - Business Intelligence  •  Página ", size: 18, color: "9CA3AF" }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "9CA3AF" }),
                new TextRun({ text: " de ", size: 18, color: "9CA3AF" }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "9CA3AF" })
              ]
            })
          ]
        })
      },
      children: [
        // Título do relatório
        new Paragraph({
          spacing: { after: 100 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 20, color: "7C3AED" } },
          children: [new TextRun({ text: "📋 " + tituloRelatorio, bold: true, size: 36, color: "7C3AED" })]
        }),
        
        // Info
        new Paragraph({
          spacing: { before: 150, after: 300 },
          children: [new TextRun({ text: `${tipo_analise || 'Análise'} • Período: ${periodo?.inicio || ''} a ${periodo?.fim || ''}`, size: 20, color: "6B7280" })]
        }),
        
        // Métricas
        tabelaMetricas,
        
        // Espaço
        new Paragraph({ spacing: { before: 500, after: 300 }, children: [] }),
        
        // Título análise detalhada
        new Paragraph({
          spacing: { after: 300 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: "7C3AED" } },
          children: [new TextRun({ text: "📊 ANÁLISE DETALHADA", bold: true, size: 32, color: "7C3AED" })]
        }),
        
        // Espaço
        new Paragraph({ spacing: { before: 200, after: 200 }, children: [] }),
        
        // Conteúdo
        ...processarRelatorio(relatorio)
      ]
    };
    
    // Criar documento com 2 seções
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: "Arial", size: 22, color: "374151" }
          }
        }
      },
      sections: [secaoCapa, secaoConteudo]
    });
    
    // Gerar buffer
    const buffer = await Packer.toBuffer(doc);
    
    // Montar nome do arquivo
    let nomeArquivo = 'relatorio-operacional';
    if (filtros?.cliente) {
      nomeArquivo += '-' + filtros.cliente.codigo;
    }
    nomeArquivo += '-' + new Date().toISOString().split('T')[0] + '.docx';
    
    // Enviar arquivo
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=' + nomeArquivo);
    res.send(buffer);
    
    console.log('✅ Relatório Word (.docx) gerado com sucesso');
    
  } catch (err) {
    console.error('❌ Erro ao gerar Word:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: 'Erro ao gerar documento: ' + err.message });
  }
});

// Atualizar data_hora_alocado em massa (para registros existentes)
app.post('/api/bi/entregas/atualizar-alocado', async (req, res) => {
  try {
    const { entregas } = req.body;
    
    if (!entregas || !Array.isArray(entregas)) {
      return res.status(400).json({ error: 'Array de entregas é obrigatório' });
    }
    
    console.log(`📊 Atualizando data_hora_alocado para ${entregas.length} registros...`);
    
    // Função para parsear timestamp
    const parseTimestamp = (val) => {
      if (!val) return null;
      try {
        // Tenta diferentes formatos
        if (typeof val === 'string') {
          // Formato DD/MM/YYYY HH:MM:SS
          const match = val.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):?(\d{2})?/);
          if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4], match[5], match[6] || 0);
          }
          // Formato ISO
          const d = new Date(val);
          if (!isNaN(d.getTime())) return d;
        }
        // Excel serial number
        if (typeof val === 'number') {
          const excelDate = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(excelDate.getTime())) return excelDate;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    let atualizados = 0;
    let erros = 0;
    
    for (const e of entregas) {
      const os = parseInt(e.os);
      const ponto = parseInt(e.ponto) || 1;
      const dataHoraAlocado = parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado']);
      
      if (!os || !dataHoraAlocado) {
        erros++;
        continue;
      }
      
      try {
        const result = await pool.query(`
          UPDATE bi_entregas 
          SET data_hora_alocado = $1 
          WHERE os = $2 AND COALESCE(ponto, 1) = $3 AND data_hora_alocado IS NULL
        `, [dataHoraAlocado, os, ponto]);
        
        if (result.rowCount > 0) atualizados++;
      } catch (err) {
        erros++;
      }
    }
    
    console.log(`✅ Atualização concluída: ${atualizados} atualizados, ${erros} erros`);
    res.json({ success: true, atualizados, erros });
  } catch (err) {
    console.error('❌ Erro ao atualizar data_hora_alocado:', err);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// Dashboard BI - Métricas gerais COMPLETO
app.get('/api/bi/dashboard', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      where += ` AND data_solicitado >= $${paramIndex++}`;
      params.push(data_inicio);
    }
    if (data_fim) {
      where += ` AND data_solicitado <= $${paramIndex++}`;
      params.push(data_fim);
    }
    if (cod_cliente) {
      where += ` AND cod_cliente = $${paramIndex++}`;
      params.push(cod_cliente);
    }
    if (centro_custo) {
      where += ` AND centro_custo = $${paramIndex++}`;
      params.push(centro_custo);
    }
    if (cod_prof) {
      where += ` AND cod_prof = $${paramIndex++}`;
      params.push(cod_prof);
    }
    if (categoria) {
      where += ` AND categoria ILIKE $${paramIndex++}`;
      params.push(`%${categoria}%`);
    }
    if (status_prazo === 'dentro') {
      where += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      where += ` AND dentro_prazo = false`;
    }
    // Filtro de prazo profissional
    const status_prazo_prof = req.query.status_prazo_prof;
    if (status_prazo_prof === 'dentro') {
      where += ` AND dentro_prazo_prof = true`;
    } else if (status_prazo_prof === 'fora') {
      where += ` AND dentro_prazo_prof = false`;
    }
    if (cidade) {
      where += ` AND cidade = $${paramIndex++}`;
      params.push(cidade);
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Métricas gerais completas
    const metricas = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo IS NULL) as sem_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = true) as dentro_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = false) as fora_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof IS NULL) as sem_prazo_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_dentro_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_fora_prof,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(AVG(tempo_execucao_prof_minutos)::numeric, 2) as tempo_medio_prof,
        ROUND(AVG(distancia)::numeric, 2) as distancia_media,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_profissional,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento,
        ROUND(AVG(valor)::numeric, 2) as ticket_medio,
        COUNT(DISTINCT cod_prof) as total_entregadores,
        COUNT(DISTINCT cod_cliente) as total_clientes,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_entregas_entregador,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
    `, params);
    
    // Entregas por dia
    const porDia = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Por centro de custo
    const porCentro = await pool.query(`
      SELECT 
        centro_custo,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
      FROM bi_entregas ${where}
      GROUP BY centro_custo
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Ranking profissionais
    const ranking = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Por categoria
    const porCategoria = await pool.query(`
      SELECT 
        categoria,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY categoria
      ORDER BY total DESC
    `, params);
    
    res.json({
      metricas: metricas.rows[0],
      porDia: porDia.rows,
      porCentro: porCentro.rows,
      ranking: ranking.rows,
      porCategoria: porCategoria.rows
    });
  } catch (err) {
    console.error('❌ Erro no dashboard:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
app.get('/api/bi/dashboard-completo', async (req, res) => {
  try {
    let { data_inicio, data_fim, cod_prof, categoria, status_prazo, status_prazo_prof, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    // Suporte a múltiplos clientes e centros de custo
    let cod_cliente = req.query.cod_cliente;
    let centro_custo = req.query.centro_custo;
    
    // Converter para array se necessário
    if (cod_cliente && !Array.isArray(cod_cliente)) cod_cliente = [cod_cliente];
    if (centro_custo && !Array.isArray(centro_custo)) centro_custo = [centro_custo];
    
    // Clientes que não devem ter filtro de centro de custo (mostrar todos CC)
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    console.log('📊 Dashboard-completo:', { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, status_retorno, clientesSemFiltroCC });
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    // Múltiplos clientes
    if (cod_cliente && cod_cliente.length > 0) { 
      where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
      params.push(cod_cliente.map(c => parseInt(c))); 
    }
    // Múltiplos centros de custo - COM exceção para clientes sem filtro
    if (centro_custo && centro_custo.length > 0) {
      if (clientesSemFiltroCC.length > 0) {
        // Filtrar por CC OU ser um cliente sem filtro de CC
        where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
        params.push(centro_custo);
        params.push(clientesSemFiltroCC);
      } else {
        where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
        params.push(centro_custo); 
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    // Filtro de prazo profissional
    if (status_prazo_prof === 'dentro') { where += ` AND dentro_prazo_prof = true`; }
    else if (status_prazo_prof === 'fora') { where += ` AND dentro_prazo_prof = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    console.log('📊 WHERE:', where, 'Params:', params);
    
    // Buscar regras de contagem
    const regrasContagem = await pool.query('SELECT cod_cliente FROM bi_regras_contagem');
    const clientesComRegra = new Set(regrasContagem.rows.map(r => String(r.cod_cliente)));
    console.log('📊 Clientes COM regra de contagem:', [...clientesComRegra]);
    console.log('📊 Total de clientes com regra:', clientesComRegra.size);
    
    // Buscar máscaras
    const mascaras = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mapMascaras = {};
    mascaras.rows.forEach(m => { mapMascaras[String(m.cod_cliente)] = m.mascara; });
    
    // ============================================
    // BUSCAR CONFIGURAÇÕES DE PRAZO PROFISSIONAL
    // ============================================
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProfQuery = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProfQuery.rows;
      
      const prazoProfPadraoQuery = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoQuery.rows;
      
      console.log('📊 Prazos Prof carregados:', { 
        especificos: prazosProfCliente.length, 
        padrao: prazoProfPadrao.length,
        faixasPadrao: prazoProfPadrao.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', ')
      });
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback hardcoded');
    }
    
    // Função para encontrar prazo profissional baseado no cliente/centro e distância
    const encontrarPrazoProfissional = (codCliente, centroCusto, distancia) => {
      // 1. Primeiro busca configuração específica por cliente
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      
      // 2. Se não achou, busca por centro de custo
      if (faixas.length === 0 && centroCusto) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // 3. Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
        // Se não encontrou faixa adequada nas específicas, continua para o padrão
      }
      
      // 4. Usa prazo padrão profissional do banco
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // 5. Fallback hardcoded (se nada configurado no banco)
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 135;
      if (distancia <= 35) return 150;
      if (distancia <= 40) return 165;
      if (distancia <= 45) return 180;
      if (distancia <= 50) return 195;
      if (distancia <= 55) return 210;
      if (distancia <= 60) return 225;
      if (distancia <= 65) return 240;
      if (distancia <= 70) return 255;
      if (distancia <= 75) return 270;
      if (distancia <= 80) return 285;
      return 300;
    };
    
    // ============================================
    // BUSCAR TODOS OS CLIENTES EXISTENTES NO SISTEMA
    // ============================================
    const todosClientesQuery = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_cliente 
      FROM bi_entregas 
      WHERE cod_cliente IS NOT NULL
      ORDER BY cod_cliente
    `);
    const todosClientes = todosClientesQuery.rows;
    console.log('📊 Total de clientes no sistema:', todosClientes.length);
    
    // ============================================
    // QUERY SQL PARA TEMPOS MÉDIOS 
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposQuery = await pool.query(`
      SELECT 
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
    `, params);
    
    const temposSQL = temposQuery.rows[0] || {};
    console.log('📊 Tempos calculados via SQL:', temposSQL);
    
    // Buscar todos os dados filtrados
    const dadosQuery = await pool.query(`
      SELECT os, COALESCE(ponto, 1) as ponto, cod_cliente, nome_cliente, 
        cod_prof, nome_prof, dentro_prazo, tempo_execucao_minutos,
        tempo_entrega_prof_minutos, dentro_prazo_prof,
        valor, valor_prof, distancia, ocorrencia, centro_custo, motivo, finalizado,
        data_hora, data_hora_alocado, data_chegada, hora_chegada
      FROM bi_entregas ${where}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Total registros retornados:', dados.length);
    
    // Debug: contar quantos têm data_hora_alocado
    const comAlocado = dados.filter(d => d.data_hora_alocado).length;
    const ponto1 = dados.filter(d => parseInt(d.ponto) === 1).length;
    const comAlocadoPonto1 = dados.filter(d => d.data_hora_alocado && parseInt(d.ponto) === 1).length;
    console.log('📊 Debug Alocação: comAlocado=' + comAlocado + ', ponto1=' + ponto1 + ', comAlocadoPonto1=' + comAlocadoPonto1);
    
    // ============================================
    // FUNÇÃO: Calcular tempo de alocação seguindo regra do BI (DAX)
    // Regra: Se solicitado após 17h E alocação no dia seguinte,
    //        início da contagem = 08:00 do dia da alocação
    // ============================================
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      // Ignora: Ponto != 1 OU dados inválidos
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1; // COALESCE(ponto, 1)
      if (pontoNum !== 1) return null;
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      // Ignora se alocado < solicitado (dados invertidos)
      if (alocado < solicitado) return null;
      
      // Hora da solicitação
      const horaSolicitado = solicitado.getHours();
      
      // Verifica se foi solicitado após 17h
      const depoisDas17 = horaSolicitado >= 17;
      
      // Verifica se a alocação foi no dia seguinte
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      
      if (depoisDas17 && !mesmaData) {
        // Se solicitado após 17h E alocação no dia seguinte,
        // início = 08:00 do dia da alocação
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        // Caso contrário, início = data/hora solicitado
        inicioContagem = solicitado;
      }
      
      // Calcula diferença em minutos
      const difMs = alocado - inicioContagem;
      const difMinutos = difMs / (1000 * 60);
      
      // Retorna null se negativo ou inválido
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular tempo de entrega (Ponto <> 1: Solicitado -> Chegada)
    // Usa data_chegada + hora_chegada (como o Power BI), com fallback para finalizado
    // Regra: Se não é mesma data, início = 08:00 do dia da chegada
    // ============================================
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null; // Apenas pontos de entrega (<> 1)
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      // DEBUG: Log primeiro registro para ver estrutura dos dados
      if (!calcularTempoEntrega.logged) {
        console.log('📊 DEBUG calcularTempoEntrega - Exemplo de row:', {
          ponto: row.ponto,
          data_hora: row.data_hora,
          data_chegada: row.data_chegada,
          hora_chegada: row.hora_chegada,
          finalizado: row.finalizado,
          tipo_data_chegada: typeof row.data_chegada,
          tipo_hora_chegada: typeof row.hora_chegada
        });
        calcularTempoEntrega.logged = true;
      }
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          // data_chegada pode ser Date ou string
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {
          console.log('📊 DEBUG calcularTempoEntrega - Erro:', e.message);
        }
      }
      
      // Fallback: usar finalizado se válido E >= solicitado
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      // Verifica se é mesma data
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        // Se não é mesma data, início = 08:00 do dia da chegada
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    calcularTempoEntrega.logged = false;
    
    // ============================================
    // FUNÇÃO: Calcular tempo de coleta (Ponto = 1: Alocado -> Saída)
    // Conforme DAX_MedColetaSegundos: usa Alocado como início
    // Regra: Se depois das 17h E não mesma data, início = 08:00 do dia da saída
    // ============================================
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null; // Apenas ponto 1 (coleta)
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {
          // Ignorar erro de parsing
        }
      }
      
      // Fallback: usar finalizado se válido E >= alocado
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      // Verifica hora da alocação (se depois das 17h)
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        // Se alocado após 17h E saída no dia seguinte, início = 08:00 do dia da saída
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular T. Entrega Prof (Alocado -> Finalizado da OS)
    // Este é o tempo que o profissional leva desde que é alocado até finalizar
    // Regra: Se dias diferentes, início = 08:00 do dia do finalizado
    // NOTA: Os dados vêm em horário de Brasília, tratamos como strings para evitar problemas de timezone
    // ============================================
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      
      // Extrair data e hora como strings para evitar problemas de timezone
      // Aceita formatos: "2025-12-01T18:12:19" ou "2025-12-01 18:12:19"
      const parseDateTime = (str) => {
        if (!str) return null;
        const s = String(str);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      const alocado = parseDateTime(dataHoraAlocado);
      const fim = parseDateTime(finalizado);
      
      if (!alocado || !fim) return null;
      
      const mesmaData = alocado.dataStr === fim.dataStr;
      
      let inicioMinutos, fimMinutos;
      
      // Fim sempre é a hora real do fim
      fimMinutos = fim.hora * 60 + fim.min + fim.seg / 60;
      
      if (!mesmaData) {
        // Dias diferentes - começa às 8h do dia do fim
        inicioMinutos = 8 * 60; // 8:00 = 480 minutos
      } else {
        inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
      }
      
      const difMinutos = fimMinutos - inicioMinutos;
      
      // Se negativo, algo está errado
      if (difMinutos < 0) return null;
      
      return difMinutos;
    };
    
    // LÓGICA DE CONTAGEM:
    // Cliente SEM regra: 1 OS = 1 entrega (conta OS únicas)
    // Cliente COM regra: conta pontos > 1 (cada ponto de entrega conta, exclui coleta)
    
    // Agrupar por cliente/OS
    const osPorCliente = {};
    dados.forEach(row => {
      const codStr = String(row.cod_cliente);
      const os = row.os;
      if (!osPorCliente[codStr]) osPorCliente[codStr] = {};
      if (!osPorCliente[codStr][os]) osPorCliente[codStr][os] = [];
      osPorCliente[codStr][os].push(row);
    });
    
    // Log de debug por cliente
    Object.keys(osPorCliente).forEach(codCliente => {
      const totalOS = Object.keys(osPorCliente[codCliente]).length;
      const temRegra = clientesComRegra.has(codCliente);
      console.log(`📊 Cliente ${codCliente}: ${totalOS} OS distintas, tem regra: ${temRegra}`);
    });
    
    // Função para calcular entregas de uma OS
    // REGRA UNIVERSAL: conta apenas pontos >= 2 (ponto 1 é coleta, não conta)
    const calcularEntregasOS = (linhasOS) => {
      const entregasCount = linhasOS.filter(l => {
        const pontoNum = parseInt(l.ponto) || 1;
        return pontoNum >= 2;
      }).length;
      
      // Se não encontrou pontos >= 2, usa fallback: linhas - 1
      if (entregasCount === 0 && linhasOS.length > 1) {
        return linhasOS.length - 1;
      }
      
      // Mínimo 1 entrega se só tem 1 linha
      return entregasCount > 0 ? entregasCount : 1;
    };
    
    // Calcular métricas gerais - usando a lógica por OS
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0, semPrazo = 0;
    let dentroPrazoProf = 0, foraPrazoProf = 0; // Prazo Prof (baseado em Alocado -> Finalizado)
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0; // Tempo de entrega (Ponto >= 2)
    let somaTempoAlocacao = 0, countTempoAlocacao = 0; // Tempo de alocação (Ponto = 1)
    let somaTempoColeta = 0, countTempoColeta = 0; // Tempo de coleta (Ponto = 1)
    let somaTempoEntregaProf = 0, countTempoEntregaProf = 0; // T. Entrega Prof (Alocado -> Finalizado)
    let profissionais = new Set();
    let totalRetornos = 0;
    let ultimaEntrega = null;
    
    // Função para verificar se é retorno baseado na Ocorrência
    const isRetorno = (ocorrencia) => {
      if (!ocorrencia) return false;
      const oc = ocorrencia.toLowerCase().trim();
      return oc.includes('cliente fechado') || 
             oc.includes('clienteaus') ||
             oc.includes('cliente ausente') ||
             oc.includes('loja fechada') ||
             oc.includes('produto incorreto');
    };
    
    // Processar por cliente/OS
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        totalOS.add(os);
        
        // Contar entregas desta OS (pontos >= 2)
        const entregasOS = calcularEntregasOS(linhasOS);
        totalEntregas += entregasOS;
        
        // Contagem de profissionais e RETORNOS (em todas as linhas)
        linhasOS.forEach((row) => {
          profissionais.add(row.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetorno(row.ocorrencia)) {
            totalRetornos++;
          }
          
          // Última entrega
          if (row.finalizado) {
            const dataFin = new Date(row.finalizado);
            if (!ultimaEntrega || dataFin > ultimaEntrega) {
              ultimaEntrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação (apenas para Ponto 1)
          const tempoAloc = calcularTempoAlocacao(row.data_hora, row.data_hora_alocado, row.ponto);
          if (tempoAloc !== null) {
            somaTempoAlocacao += tempoAloc;
            countTempoAlocacao++;
          }
          
          // Calcular tempo de entrega (apenas para Ponto <> 1)
          const tempoEnt = calcularTempoEntrega(row);
          if (tempoEnt !== null) {
            somaTempoEntrega += tempoEnt;
            countTempoEntrega++;
          }
          
          // Calcular tempo de coleta (apenas para Ponto = 1)
          const tempoCol = calcularTempoColeta(row);
          if (tempoCol !== null) {
            somaTempoColeta += tempoCol;
            countTempoColeta++;
          }
        });
        
        // REGRA UNIVERSAL: métricas apenas das linhas com ponto >= 2 (entregas)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        
        // Para prazo: processa todas as linhas de entrega
        const processarPrazo = (l) => {
          if (l.dentro_prazo === true) dentroPrazo++;
          else if (l.dentro_prazo === false) foraPrazo++;
          else semPrazo++; // null ou undefined
        };
        
        // ===== CALCULAR T. ENTREGA PROF E PRAZO PROF POR ENTREGA =====
        // Para cada linha de entrega (ponto >= 2), calcular o tempo prof
        // T. Entrega Prof = data_hora_alocado (ponto 1) → finalizado (desta entrega)
        // Com regra: se dias diferentes, começa às 8h do dia do finalizado
        const primeiroReg = linhasOS[0]; // Ponto 1 - tem o data_hora_alocado
        
        // Função para extrair data/hora (aceita string ou objeto Date)
        const parseDateTime = (valor) => {
          if (!valor) return null;
          
          // Se for objeto Date
          if (valor instanceof Date) {
            return {
              dataStr: valor.toISOString().split('T')[0],
              hora: valor.getHours(),
              min: valor.getMinutes(),
              seg: valor.getSeconds()
            };
          }
          
          // Se for string
          const s = String(valor);
          const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
          if (!match) return null;
          return {
            dataStr: match[1] + '-' + match[2] + '-' + match[3],
            hora: parseInt(match[4]),
            min: parseInt(match[5]),
            seg: parseInt(match[6])
          };
        };
        
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTime(alocadoStr);
        
        // Determinar quais linhas processar para Prazo Prof
        // Se tem linhas com ponto >= 2, usa elas. Senão, usa todas exceto a primeira (coleta)
        const linhasParaPrazoProf = linhasEntrega.length > 0 
          ? linhasEntrega 
          : (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Processar CADA ENTREGA para o Prazo Prof
        linhasParaPrazoProf.forEach((entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTime(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            
            let inicioMinutos, fimMinutos;
            
            // Fim sempre é a hora real do finalizado
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            
            if (!mesmaData) {
              // Dias diferentes - começa às 8h do dia do finalizado
              inicioMinutos = 8 * 60; // 8:00 = 480 minutos
            } else {
              inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
            }
            
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              somaTempoEntregaProf += tempoEntProf;
              countTempoEntregaProf++;
              
              // Prazo Prof: calcular baseado no CLIENTE/CENTRO e DISTÂNCIA desta entrega
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              // Log de debug (primeiras 5 entregas)
              if (countTempoEntregaProf <= 5) {
                console.log(`📊 DEBUG Prazo Prof - OS ${entrega.os}: dist=${distanciaEntrega.toFixed(1)}km, tempo=${tempoEntProf.toFixed(0)}min, prazo=${prazoMinutos}min, ${tempoEntProf <= prazoMinutos ? '✅ DENTRO' : '❌ FORA'}`);
              }
              
              if (tempoEntProf <= prazoMinutos) {
                dentroPrazoProf++;
              } else {
                foraPrazoProf++;
              }
            } else {
              // Tempo negativo = dados inconsistentes = fora do prazo
              foraPrazoProf++;
            }
          } else {
            // Sem dados de alocado ou finalizado = conta como fora do prazo
            foraPrazoProf++;
          }
        });
        // ===== FIM CALCULAR T. ENTREGA PROF =====
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto, que tem o valor da OS)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        somaValor += parseFloat(linhaValor?.valor) || 0;
        somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
        
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(processarPrazo);
        } else if (linhasOS.length > 1) {
          linhasOS.slice(1).forEach(processarPrazo);
        } else {
          processarPrazo(linhasOS[0]);
        }
      });
    });
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // USAR TEMPOS DA QUERY SQL (igual ao Acompanhamento)
    // Frontend espera minutos como número, ele mesmo formata para HH:MM:SS
    // DEBUG: Log dos tempos para verificar
    console.log('📊 DEBUG Tempos SQL:', {
      tempo_medio_entrega: temposSQL.tempo_medio_entrega,
      tempo_medio_alocacao: temposSQL.tempo_medio_alocacao,
      tempo_medio_coleta: temposSQL.tempo_medio_coleta
    });
    
    // Se SQL não retornar tempos válidos, usar os cálculos JS como fallback
    const tempoMedioEntrega = parseFloat(temposSQL.tempo_medio_entrega) || 
      (countTempoEntrega > 0 ? somaTempoEntrega / countTempoEntrega : 0);
    const tempoMedioAlocacao = parseFloat(temposSQL.tempo_medio_alocacao) || 
      (countTempoAlocacao > 0 ? somaTempoAlocacao / countTempoAlocacao : 0);
    const tempoMedioColeta = parseFloat(temposSQL.tempo_medio_coleta) || 
      (countTempoColeta > 0 ? somaTempoColeta / countTempoColeta : 0);
    
    console.log('📊 DEBUG Tempos Finais (minutos):', {
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      countTempoEntrega,
      countTempoAlocacao,
      countTempoColeta
    });
    
    // Calcular tempo médio de entrega do profissional
    const tempoMedioEntregaProf = countTempoEntregaProf > 0 
      ? somaTempoEntregaProf / countTempoEntregaProf 
      : 0;
    
    console.log('📊 DEBUG T. Entrega Prof:', {
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      countTempoEntregaProf,
      totalEntregas,
      diferenca: totalEntregas - (dentroPrazoProf + foraPrazoProf)
    });
    
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      sem_prazo: semPrazo,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalEntregas > 0 ? (somaValor / totalEntregas).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      incentivo: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      ultima_entrega: ultimaEntrega ? ultimaEntrega.toISOString() : null
    };
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR CLIENTE
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorClienteQuery = await pool.query(`
      SELECT 
        cod_cliente,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_cliente
    `, params);
    
    // Criar mapa de tempos por cliente
    const temposPorClienteMap = {};
    temposPorClienteQuery.rows.forEach(row => {
      temposPorClienteMap[row.cod_cliente] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    // Agrupar por cliente - usando mesma lógica
    const porClienteMap = {};
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      if (!porClienteMap[codCliente]) {
        const primeiraLinha = Object.values(osDoCliente)[0][0];
        porClienteMap[codCliente] = {
          cod_cliente: primeiraLinha.cod_cliente,
          nome_cliente: primeiraLinha.nome_cliente,
          nome_display: mapMascaras[codCliente] || primeiraLinha.nome_cliente,
          tem_mascara: !!mapMascaras[codCliente],
          os_set: new Set(),
          profissionais_set: new Set(),
          centros_custo_map: {}, // Mapa de centros de custo com dados
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo profissional
          soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0, soma_dist: 0,
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0, // Novo: tempo de alocação
          total_retornos: 0, ultima_entrega: null
        };
      }
      
      const c = porClienteMap[codCliente];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoCliente = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para extrair data/hora (para cálculo do prazo prof)
      const parseDateTimeCliente = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        c.os_set.add(os);
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const primeiroReg = linhasOS[0];
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTimeCliente(alocadoStr);
        
        // Coletar profissionais, última entrega e RETORNOS (em todas as linhas)
        linhasOS.forEach(l => {
          c.profissionais_set.add(l.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetornoCliente(l.ocorrencia)) {
            c.total_retornos++;
          }
          
          if (l.finalizado) {
            const dataFin = new Date(l.finalizado);
            if (!c.ultima_entrega || dataFin > c.ultima_entrega) {
              c.ultima_entrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação por cliente (apenas para Ponto 1)
          const tempoAlocCliente = calcularTempoAlocacao(l.data_hora, l.data_hora_alocado, l.ponto);
          if (tempoAlocCliente !== null) {
            c.soma_tempo_alocacao += tempoAlocCliente;
            c.count_tempo_alocacao++;
          }
        });
        
        const entregasOS = calcularEntregasOS(linhasOS);
        c.total_entregas += entregasOS;
        
        // REGRA UNIVERSAL: métricas apenas das entregas (ponto >= 2)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        const linhasParaProcessar = linhasEntrega.length > 0 ? linhasEntrega : 
          (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        c.soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.soma_dist += parseFloat(linhaValor?.distancia) || 0;
        
        // Centro de custo para valores - pega do linhaValor
        const ccValor = linhaValor?.centro_custo || 'Sem Centro';
        if (!c.centros_custo_map[ccValor]) {
          c.centros_custo_map[ccValor] = {
            centro_custo: ccValor,
            os_set: new Set(),
            total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
            dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo prof por centro
            soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
          };
        }
        c.centros_custo_map[ccValor].soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.centros_custo_map[ccValor].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.centros_custo_map[ccValor].os_set.add(os);
        
        linhasParaProcessar.forEach(l => {
          // Métricas do cliente total (prazo e tempo)
          if (l.dentro_prazo === true) c.dentro_prazo++;
          else if (l.dentro_prazo === false) c.fora_prazo++;
          else c.sem_prazo++;
          
          // ===== CALCULAR PRAZO PROF POR CLIENTE =====
          const finalizadoStr = l.finalizado;
          const finalizado = parseDateTimeCliente(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                c.dentro_prazo_prof++;
              } else {
                c.fora_prazo_prof++;
              }
            } else {
              c.fora_prazo_prof++;
            }
          } else {
            c.fora_prazo_prof++;
          }
          // ===== FIM PRAZO PROF =====
          
          // Usar cálculo manual de tempo de entrega (conforme DAX)
          const tempoEntCalc = calcularTempoEntrega(l);
          if (tempoEntCalc !== null) {
            c.soma_tempo += tempoEntCalc;
            c.count_tempo++;
          }
          
          // Agrupar por centro de custo (prazo e entregas)
          const cc = l.centro_custo || 'Sem Centro';
          if (!c.centros_custo_map[cc]) {
            c.centros_custo_map[cc] = {
              centro_custo: cc,
              os_set: new Set(),
              total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
              dentro_prazo_prof: 0, fora_prazo_prof: 0,
              soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
            };
          }
          const ccData = c.centros_custo_map[cc];
          ccData.total_entregas++;
          if (l.dentro_prazo === true) ccData.dentro_prazo++;
          else if (l.dentro_prazo === false) ccData.fora_prazo++;
          else ccData.sem_prazo++;
          
          // Prazo prof por centro de custo
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                ccData.dentro_prazo_prof++;
              } else {
                ccData.fora_prazo_prof++;
              }
            } else {
              ccData.fora_prazo_prof++;
            }
          } else {
            ccData.fora_prazo_prof++;
          }
          
          if (tempoEntCalc !== null) {
            ccData.soma_tempo += tempoEntCalc;
            ccData.count_tempo++;
          }
        });
        
        // Contar retornos por centro de custo (em TODAS as linhas da OS)
        linhasOS.forEach(l => {
          const cc = l.centro_custo || 'Sem Centro';
          if (c.centros_custo_map[cc] && isRetornoCliente(l.ocorrencia)) {
            c.centros_custo_map[cc].total_retornos++;
          }
        });
      });
    });
    
    const porCliente = Object.values(porClienteMap).map(c => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposCliente = temposPorClienteMap[c.cod_cliente] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioCliente = temposCliente.tempo_entrega || 
        (c.count_tempo > 0 ? c.soma_tempo / c.count_tempo : 0);
      const tempoAlocacaoCliente = temposCliente.tempo_alocacao || 0;
      
      // Converter centros_custo_map em array com dados
      const centros_custo_dados = Object.values(c.centros_custo_map).map(cc => ({
        centro_custo: cc.centro_custo,
        total_os: cc.os_set.size,
        total_entregas: cc.total_entregas,
        total_retornos: cc.total_retornos,
        dentro_prazo: cc.dentro_prazo,
        fora_prazo: cc.fora_prazo,
        sem_prazo: cc.sem_prazo,
        dentro_prazo_prof: cc.dentro_prazo_prof || 0,
        fora_prazo_prof: cc.fora_prazo_prof || 0,
        tempo_medio: cc.count_tempo > 0 ? cc.soma_tempo / cc.count_tempo : 0,
        valor_total: cc.soma_valor.toFixed(2),
        valor_prof: cc.soma_valor_prof.toFixed(2)
      })).sort((a, b) => b.total_entregas - a.total_entregas);
      
      const totalProfs = c.profissionais_set.size;
      const ticketMedio = c.total_entregas > 0 ? (c.soma_valor / c.total_entregas) : 0;
      const incentivo = totalProfs > 0 ? (c.total_entregas / totalProfs) : 0;
      
      return {
        cod_cliente: c.cod_cliente, nome_cliente: c.nome_cliente,
        nome_display: c.nome_display, tem_mascara: c.tem_mascara,
        total_os: c.os_set.size, total_entregas: c.total_entregas,
        centros_custo: centros_custo_dados,
        dentro_prazo: c.dentro_prazo, fora_prazo: c.fora_prazo, sem_prazo: c.sem_prazo,
        dentro_prazo_prof: c.dentro_prazo_prof, fora_prazo_prof: c.fora_prazo_prof,
        tempo_medio: tempoMedioCliente,
        tempo_medio_alocacao: tempoAlocacaoCliente,
        valor_total: c.soma_valor.toFixed(2), valor_prof: c.soma_valor_prof.toFixed(2),
        distancia_total: c.soma_dist ? c.soma_dist.toFixed(2) : "0.00",
        ticket_medio: ticketMedio.toFixed(2),
        total_profissionais: totalProfs,
        entregas_por_prof: incentivo.toFixed(2),
        incentivo: incentivo.toFixed(2),
        total_retornos: c.total_retornos,
        retornos: c.total_retornos,
        ultima_entrega: c.ultima_entrega ? c.ultima_entrega.toISOString() : null
      };
    });
    
    // ============================================
    // ADICIONAR CLIENTES QUE NÃO TÊM ENTREGAS NO PERÍODO
    // (apenas se não houver filtro de cliente específico)
    // ============================================
    if (!cod_cliente || cod_cliente.length === 0) {
      const clientesComDados = new Set(porCliente.map(c => String(c.cod_cliente)));
      
      todosClientes.forEach(tc => {
        const codCli = String(tc.cod_cliente);
        if (!clientesComDados.has(codCli)) {
          porCliente.push({
            cod_cliente: tc.cod_cliente,
            nome_cliente: tc.nome_cliente,
            nome_display: mapMascaras[codCli] || tc.nome_cliente,
            tem_mascara: !!mapMascaras[codCli],
            total_os: 0,
            total_entregas: 0,
            centros_custo: [],
            dentro_prazo: 0,
            fora_prazo: 0,
            sem_prazo: 0,
            tempo_medio: null,
            tempo_medio_alocacao: "0.00",
            valor_total: "0.00",
            valor_prof: "0.00",
            distancia_total: "0.00",
            ticket_medio: "0.00",
            total_profissionais: 0,
            entregas_por_prof: "0.00",
            incentivo: "0.00",
            total_retornos: 0,
            retornos: 0,
            dentro_prazo_prof: 0,
            fora_prazo_prof: 0,
            ultima_entrega: null
          });
        }
      });
    }
    
    // Ordenar por total de entregas (decrescente)
    porCliente.sort((a, b) => b.total_entregas - a.total_entregas);
    
    // Log centros de custo encontrados
    console.log('📁 CENTROS DE CUSTO POR CLIENTE:');
    porCliente.slice(0, 10).forEach(c => {
      console.log(`   - ${c.cod_cliente}: ${c.centros_custo?.length || 0} centros`);
    });
    
    // Log resultado por cliente
    console.log('📊 RESULTADO POR CLIENTE (total:', porCliente.length, '):');
    porCliente.slice(0, 5).forEach(c => {
      const temRegra = clientesComRegra.has(String(c.cod_cliente));
      console.log(`   - ${c.cod_cliente} (${c.nome_display}): ${c.total_os} OS, ${c.total_entregas} entregas, regra: ${temRegra}`);
    });
    console.log('📊 TOTAL GERAL: ', metricas.total_os, 'OS,', metricas.total_entregas, 'entregas');
    
    // Agrupar por profissional - também precisa respeitar a regra
    const porProfMap = {};
    
    // Agrupar por profissional/OS para aplicar regra corretamente
    const osPorProf = {};
    dados.forEach(row => {
      const codProf = String(row.cod_prof);
      const codCliente = String(row.cod_cliente);
      const os = row.os;
      const chave = `${codProf}-${os}`;
      
      if (!osPorProf[codProf]) osPorProf[codProf] = {};
      if (!osPorProf[codProf][os]) osPorProf[codProf][os] = { codCliente, linhas: [] };
      osPorProf[codProf][os].linhas.push(row);
    });
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR PROFISSIONAL
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorProfQuery = await pool.query(`
      SELECT 
        cod_prof,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_prof
    `, params);
    
    // Criar mapa de tempos por profissional
    const temposPorProfMap = {};
    temposPorProfQuery.rows.forEach(row => {
      temposPorProfMap[row.cod_prof] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    Object.keys(osPorProf).forEach(codProf => {
      const osDoProf = osPorProf[codProf];
      
      if (!porProfMap[codProf]) {
        const primeiraLinha = Object.values(osDoProf)[0].linhas[0];
        porProfMap[codProf] = {
          cod_prof: primeiraLinha.cod_prof,
          nome_prof: primeiraLinha.nome_prof,
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0,
          soma_tempo: 0, count_tempo: 0, 
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0,
          soma_tempo_coleta: 0, count_tempo_coleta: 0,
          soma_dist: 0, soma_valor_prof: 0, retornos: 0
        };
      }
      
      const p = porProfMap[codProf];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoProf = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para parsear data/hora
      const parseDateTimeProf = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoProf).forEach(os => {
        const { codCliente, linhas } = osDoProf[os];
        const entregasOS = calcularEntregasOS(linhas);
        p.total_entregas += entregasOS;
        
        // Contagem de retornos (ocorrência indica problema) - TODAS as linhas
        linhas.forEach(l => {
          if (isRetornoProf(l.ocorrencia)) p.retornos++;
        });
        
        // Separar linhas por tipo
        const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
        const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
        
        // Tempo de alocação e coleta (do ponto 1)
        if (linhaPonto1) {
          const tempoAloc = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
          if (tempoAloc !== null) {
            p.soma_tempo_alocacao += tempoAloc;
            p.count_tempo_alocacao++;
          }
          
          const tempoCol = calcularTempoColeta(linhaPonto1);
          if (tempoCol !== null) {
            p.soma_tempo_coleta += tempoCol;
            p.count_tempo_coleta++;
          }
        }
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const alocadoStr = linhaPonto1?.data_hora_alocado;
        const alocado = parseDateTimeProf(alocadoStr);
        
        // Função para calcular prazo prof de uma entrega
        const calcularPrazoProfEntrega = (entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTimeProf(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              if (tempoEntProf <= prazoMinutos) {
                p.dentro_prazo_prof++;
              } else {
                p.fora_prazo_prof++;
              }
            } else {
              p.fora_prazo_prof++;
            }
          } else {
            p.fora_prazo_prof++;
          }
        };
        
        // Métricas das entregas (ponto >= 2)
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            // Tempo de entrega
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else if (linhas.length > 1) {
          linhas.slice(1).forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else {
          const l = linhas[0];
          if (l.dentro_prazo === true) p.dentro_prazo++;
          else if (l.dentro_prazo === false) p.fora_prazo++;
          p.soma_dist += parseFloat(l.distancia) || 0;
          p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
          
          const tempoEnt = calcularTempoEntrega(l);
          if (tempoEnt !== null) {
            p.soma_tempo += tempoEnt;
            p.count_tempo++;
          }
          
          // Prazo profissional
          calcularPrazoProfEntrega(l);
        }
      });
    });
    
    const porProfissional = Object.values(porProfMap).map(p => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposProf = temposPorProfMap[p.cod_prof] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioProf = temposProf.tempo_entrega || 
        (p.count_tempo > 0 ? p.soma_tempo / p.count_tempo : 0);
      const tempoAlocadoProf = temposProf.tempo_alocacao || 
        (p.count_tempo_alocacao > 0 ? p.soma_tempo_alocacao / p.count_tempo_alocacao : 0);
      const tempoColetaProf = temposProf.tempo_coleta || 
        (p.count_tempo_coleta > 0 ? p.soma_tempo_coleta / p.count_tempo_coleta : 0);
      
      return {
        cod_prof: p.cod_prof, nome_prof: p.nome_prof,
        total_entregas: p.total_entregas, dentro_prazo: p.dentro_prazo, fora_prazo: p.fora_prazo,
        dentro_prazo_prof: p.dentro_prazo_prof, fora_prazo_prof: p.fora_prazo_prof,
        tempo_medio: tempoMedioProf,
        tempo_alocado: tempoAlocadoProf,
        tempo_coleta: tempoColetaProf,
        distancia_total: p.soma_dist.toFixed(2), valor_prof: p.soma_valor_prof.toFixed(2),
        retornos: p.retornos
      };
    }).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // DEBUG: Log dos primeiros profissionais para verificar tempos
    if (porProfissional.length > 0) {
      console.log('📊 DEBUG - Primeiro profissional:', {
        cod_prof: porProfissional[0].cod_prof,
        nome_prof: porProfissional[0].nome_prof,
        tempo_medio: porProfissional[0].tempo_medio,
        tempo_alocado: porProfissional[0].tempo_alocado,
        tempo_coleta: porProfissional[0].tempo_coleta,
        temposSQL: temposPorProfMap[porProfissional[0].cod_prof]
      });
    }
    
    // Gráficos - retorna dados brutos para o frontend agrupar nas faixas que quiser
    const dadosGraficos = await pool.query(`
      SELECT 
        tempo_execucao_minutos as tempo,
        distancia as km
      FROM bi_entregas 
      ${where}
    `, params);
    
    res.json({ 
      metricas, 
      porCliente, 
      porProfissional, 
      dadosGraficos: dadosGraficos.rows 
    });
  } catch (err) {
    console.error('❌ Erro dashboard-completo:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard', details: err.message });
  }
});

// ============================================
// ENDPOINT: OS por Profissional (para expandir na aba profissionais)
// ============================================
app.get('/api/bi/os-profissional/:cod_prof', async (req, res) => {
  try {
    const { cod_prof } = req.params;
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let whereClause = 'WHERE cod_prof = $1';
    const params = [cod_prof];
    let paramIndex = 2;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria ILIKE $${paramIndex}`;
      params.push(`%${categoria}%`);
      paramIndex++;
    }
    if (status_prazo === 'dentro') {
      whereClause += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      whereClause += ` AND dentro_prazo = false`;
    }
    if (cidade) {
      whereClause += ` AND cidade ILIKE $${paramIndex}`;
      params.push(`%${cidade}%`);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar TODAS as linhas do profissional (incluindo ponto 1 para calcular tempos)
    const query = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        distancia,
        valor,
        valor_prof,
        dentro_prazo,
        data_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        finalizado,
        ocorrencia,
        motivo
      FROM bi_entregas
      ${whereClause}
      ORDER BY data_solicitado DESC, os DESC
    `, params);
    
    // Funções de cálculo (mesmas das outras abas)
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1;
      if (pontoNum !== 1) return null; // Só calcula para ponto 1
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      if (alocado < solicitado || isNaN(alocado.getTime()) || isNaN(solicitado.getTime())) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null;
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {}
      }
      
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {}
      }
      
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Agrupar por OS
    const osPorNumero = {};
    query.rows.forEach(row => {
      const osNum = row.os;
      if (!osPorNumero[osNum]) {
        osPorNumero[osNum] = {
          os: osNum,
          linhas: [],
          cod_cliente: row.cod_cliente,
          cliente: row.cliente,
          centro_custo: row.centro_custo,
          data_solicitado: row.data_solicitado
        };
      }
      osPorNumero[osNum].linhas.push(row);
    });
    
    // Processar cada OS
    const oss = Object.values(osPorNumero).map(osData => {
      const { os, linhas, cod_cliente, cliente, centro_custo, data_solicitado } = osData;
      
      // Separar linhas por tipo
      const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
      const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
      
      // Calcular tempos
      let tempoAlocacao = null;
      let tempoColeta = null;
      let tempoEntrega = null;
      let dentroPrazo = null;
      let distancia = 0;
      let valorProf = 0;
      
      // Tempo de alocação (do ponto 1)
      if (linhaPonto1) {
        tempoAlocacao = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
        tempoColeta = calcularTempoColeta(linhaPonto1);
      }
      
      // Tempo de entrega e demais dados (das entregas)
      if (linhasEntrega.length > 0) {
        // Pegar a primeira entrega para calcular tempo
        const primeiraEntrega = linhasEntrega[0];
        tempoEntrega = calcularTempoEntrega(primeiraEntrega);
        
        // Somar valores de todas as entregas
        linhasEntrega.forEach(l => {
          distancia += parseFloat(l.distancia) || 0;
          valorProf += parseFloat(l.valor_prof) || 0;
          if (l.dentro_prazo !== null) dentroPrazo = l.dentro_prazo;
        });
      }
      
      return {
        os,
        cod_cliente,
        cliente,
        centro_custo,
        data_solicitado,
        tempo_alocacao: tempoAlocacao,
        tempo_coleta: tempoColeta,
        tempo_entrega: tempoEntrega,
        distancia,
        dentro_prazo: dentroPrazo,
        valor_prof: valorProf
      };
    })
    .filter(os => os.tempo_entrega !== null || os.tempo_alocacao !== null) // Apenas OS com algum tempo calculado
    .sort((a, b) => new Date(b.data_solicitado) - new Date(a.data_solicitado))
    .slice(0, 100); // Limitar a 100 OS
    
    res.json({ oss, total: oss.length });
    
  } catch (error) {
    console.error('Erro OS profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar OS do profissional', details: error.message });
  }
});


// Lista de entregas detalhada (para análise por OS)
app.get('/api/bi/entregas-lista', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Clientes que não devem ter filtro de centro de custo
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    if (cod_cliente) { 
      // Suporta múltiplos clientes separados por vírgula
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
        params.push(clientes);
      }
    }
    if (centro_custo) { 
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        if (clientesSemFiltroCC.length > 0) {
          // Filtrar por CC OU ser um cliente sem filtro de CC
          where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
          params.push(centros);
          params.push(clientesSemFiltroCC);
        } else {
          where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
          params.push(centros);
        }
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    
    // Filtro de retorno - usar mesma lógica da função isRetorno
    let retornoFilter = '';
    if (status_retorno === 'com_retorno') {
      retornoFilter = ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      retornoFilter = ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    const result = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_prof,
        nome_prof,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        endereco,
        cidade,
        data_solicitado,
        hora_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        data_saida,
        hora_saida,
        finalizado,
        distancia,
        dentro_prazo,
        tempo_execucao_minutos,
        prazo_minutos,
        dentro_prazo_prof,
        prazo_prof_minutos,
        tempo_entrega_prof_minutos,
        valor,
        valor_prof,
        categoria,
        ocorrencia,
        motivo,
        status
      FROM bi_entregas ${where}${retornoFilter}
      ORDER BY os DESC, COALESCE(ponto, 1) ASC
      LIMIT 2000
    `, params);
    
    // Retornar direto - campos já calculados no banco durante upload/recálculo
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar entregas:', err);
    res.status(500).json({ error: 'Erro ao listar entregas' });
  }
});

// Lista de cidades disponíveis
app.get('/api/bi/cidades', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cidade, COUNT(*) as total
      FROM bi_entregas
      WHERE cidade IS NOT NULL AND cidade != ''
      GROUP BY cidade
      ORDER BY total DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar cidades:', err);
    res.json([]);
  }
});

// Relação Cliente -> Centros de Custo
app.get('/api/bi/cliente-centros', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cod_cliente, centro_custo
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, centro_custo
    `);
    // Agrupa por cliente
    const mapa = {};
    result.rows.forEach(r => {
      const cod = String(r.cod_cliente);
      if (!mapa[cod]) mapa[cod] = [];
      mapa[cod].push(r.centro_custo);
    });
    res.json(mapa);
  } catch (err) {
    console.error('❌ Erro ao listar cliente-centros:', err);
    res.json({});
  }
});

// ===== MÁSCARAS DE CLIENTES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_mascaras (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    mascara VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_mascaras já existe ou erro:', err.message));

// Listar máscaras
app.get('/api/bi/mascaras', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_mascaras ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar máscaras:', err);
    res.json([]);
  }
});

// Criar/Atualizar máscara
app.post('/api/bi/mascaras', async (req, res) => {
  try {
    const { cod_cliente, mascara } = req.body;
    if (!cod_cliente || !mascara) {
      return res.status(400).json({ error: 'cod_cliente e mascara são obrigatórios' });
    }
    
    // Upsert - atualiza se existir, insere se não
    const result = await pool.query(`
      INSERT INTO bi_mascaras (cod_cliente, mascara) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO UPDATE SET mascara = $2
      RETURNING *
    `, [cod_cliente, mascara]);
    
    res.json({ success: true, mascara: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar máscara:', err);
    res.status(500).json({ error: 'Erro ao salvar máscara' });
  }
});

// Excluir máscara
app.delete('/api/bi/mascaras/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_mascaras WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir máscara:', err);
    res.status(500).json({ error: 'Erro ao excluir máscara' });
  }
});

// ===== LOCALIZAÇÃO DE CLIENTES (Ponto 1) =====
// Endpoint para listar clientes com seus endereços de coleta (Ponto 1) e coordenadas
app.get('/api/bi/localizacao-clientes', async (req, res) => {
  try {
    // Clientes que devem ter endereços separados por centro de custo
    const clientesSeparadosPorCC = ['767', '1046', '713'];
    
    // Query para clientes NORMAIS - retorna apenas o endereço com mais entregas
    const resultNormal = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text NOT IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente
      cliente_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente)
          cod_cliente,
          nome_cliente,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        NULL as centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', NULL
          )
        ) as enderecos
      FROM cliente_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Query para clientes ESPECIAIS (767, 1046, 713) - separados por centro de custo, 1 endereço por CC
    const resultEspecial = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          centro_custo,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, centro_custo, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente + centro de custo
      cliente_cc_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente, centro_custo)
          cod_cliente,
          nome_cliente,
          centro_custo,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, centro_custo, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        ce.centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', ce.centro_custo
          )
        ) as enderecos
      FROM cliente_cc_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Combina os resultados e ordena
    const todosClientes = [...resultNormal.rows, ...resultEspecial.rows]
      .sort((a, b) => parseInt(a.cod_cliente) - parseInt(b.cod_cliente));
    
    res.json(todosClientes);
  } catch (err) {
    console.error('❌ Erro ao buscar localização clientes:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// ===== SISTEMA DE SETORES =====

// Listar todos os setores
app.get('/api/setores', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM users u WHERE u.setor_id = s.id) as total_usuarios
      FROM setores s 
      ORDER BY s.nome ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar setores:', err);
    res.status(500).json({ error: 'Erro ao listar setores' });
  }
});

// Criar setor
app.post('/api/setores', async (req, res) => {
  try {
    const { nome, descricao, cor } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO setores (nome, descricao, cor)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [nome, descricao || '', cor || '#6366f1']);
    
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um setor com este nome' });
    }
    console.error('❌ Erro ao criar setor:', err);
    res.status(500).json({ error: 'Erro ao criar setor' });
  }
});

// Atualizar setor
app.put('/api/setores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, cor, ativo } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    const result = await pool.query(`
      UPDATE setores 
      SET nome = $1, descricao = $2, cor = $3, ativo = $4, updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [nome, descricao || '', cor || '#6366f1', ativo !== false, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setor não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um setor com este nome' });
    }
    console.error('❌ Erro ao atualizar setor:', err);
    res.status(500).json({ error: 'Erro ao atualizar setor' });
  }
});

// Excluir setor
app.delete('/api/setores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se há usuários vinculados
    const usuarios = await pool.query('SELECT COUNT(*) FROM users WHERE setor_id = $1', [id]);
    if (parseInt(usuarios.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: `Não é possível excluir. Existem ${usuarios.rows[0].count} usuário(s) vinculado(s) a este setor.` 
      });
    }
    
    const result = await pool.query('DELETE FROM setores WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setor não encontrado' });
    }
    
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao excluir setor:', err);
    res.status(500).json({ error: 'Erro ao excluir setor' });
  }
});

// Atualizar setor do usuário
app.patch('/api/users/:codProfissional/setor', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    const { setor_id } = req.body;
    
    const result = await pool.query(`
      UPDATE users 
      SET setor_id = $1, updated_at = NOW()
      WHERE LOWER(cod_profissional) = LOWER($2)
      RETURNING id, cod_profissional, full_name, setor_id
    `, [setor_id || null, codProfissional]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar setor do usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar setor' });
  }
});

// ===== RELATÓRIOS DIÁRIOS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_diarios (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL,
    conteudo TEXT,
    usuario_id VARCHAR(100),
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    imagem_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela relatorios_diarios já existe ou erro:', err.message));

// Criar tabela de visualizações
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_visualizacoes (
    id SERIAL PRIMARY KEY,
    relatorio_id INTEGER NOT NULL REFERENCES relatorios_diarios(id) ON DELETE CASCADE,
    usuario_id VARCHAR(100) NOT NULL,
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    visualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(relatorio_id, usuario_id)
  )
`).catch(err => console.log('Tabela relatorios_visualizacoes já existe ou erro:', err.message));

// Listar relatórios diários com visualizações
app.get('/api/relatorios-diarios', async (req, res) => {
  try {
    const { setor_id, usuario_id } = req.query;
    
    // Se passar setor_id, filtra relatórios que o usuário pode ver
    // Se não passar, retorna todos (para admin ver tudo)
    let query;
    let params = [];
    
    if (setor_id || usuario_id) {
      // Usuário comum: só vê relatórios para todos OU para seu setor
      query = `
        SELECT 
          r.*,
          COALESCE(
            json_agg(
              json_build_object(
                'usuario_id', rv.usuario_id,
                'usuario_nome', rv.usuario_nome,
                'usuario_foto', rv.usuario_foto,
                'visualizado_em', rv.visualizado_em
              )
            ) FILTER (WHERE rv.id IS NOT NULL),
            '[]'
          ) as visualizacoes
        FROM relatorios_diarios r
        LEFT JOIN relatorios_visualizacoes rv ON r.id = rv.relatorio_id
        WHERE (
          r.para_todos = true 
          OR ($1::integer IS NOT NULL AND $1 = ANY(r.setores_destino))
          OR r.usuario_id = $2
        )
        GROUP BY r.id
        ORDER BY r.created_at DESC 
        LIMIT 100
      `;
      params = [setor_id || null, usuario_id || ''];
    } else {
      // Admin sem filtro: vê todos os relatórios
      query = `
        SELECT 
          r.*,
          COALESCE(
            json_agg(
              json_build_object(
                'usuario_id', rv.usuario_id,
                'usuario_nome', rv.usuario_nome,
                'usuario_foto', rv.usuario_foto,
                'visualizado_em', rv.visualizado_em
              )
            ) FILTER (WHERE rv.id IS NOT NULL),
            '[]'
          ) as visualizacoes
        FROM relatorios_diarios r
        LEFT JOIN relatorios_visualizacoes rv ON r.id = rv.relatorio_id
        GROUP BY r.id
        ORDER BY r.created_at DESC 
        LIMIT 100
      `;
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar relatórios:', err);
    res.status(500).json({ error: 'Erro ao listar relatórios' });
  }
});

// Buscar relatórios não lidos por um usuário (filtrado por setor)
app.get('/api/relatorios-diarios/nao-lidos/:usuario_id', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { setor_id } = req.query;
    
    // Query que considera:
    // 1. Relatórios para todos (para_todos = true)
    // 2. Relatórios onde o setor do usuário está na lista de setores_destino
    const result = await pool.query(`
      SELECT r.* 
      FROM relatorios_diarios r
      WHERE NOT EXISTS (
        SELECT 1 FROM relatorios_visualizacoes rv 
        WHERE rv.relatorio_id = r.id AND rv.usuario_id = $1
      )
      AND r.usuario_id != $1
      AND (
        r.para_todos = true 
        OR ($2::integer IS NOT NULL AND $2 = ANY(r.setores_destino))
      )
      ORDER BY r.created_at DESC
    `, [usuario_id, setor_id || null]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar relatórios não lidos:', err);
    res.status(500).json({ error: 'Erro ao buscar relatórios não lidos' });
  }
});

// Marcar relatório como lido
app.post('/api/relatorios-diarios/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, usuario_nome, usuario_foto } = req.body;
    
    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id é obrigatório' });
    }
    
    // Inserir ou ignorar se já existe
    await pool.query(`
      INSERT INTO relatorios_visualizacoes (relatorio_id, usuario_id, usuario_nome, usuario_foto)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (relatorio_id, usuario_id) DO NOTHING
    `, [id, usuario_id, usuario_nome, usuario_foto]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar como lido:', err);
    res.status(500).json({ error: 'Erro ao marcar como lido' });
  }
});

// Criar relatório diário
app.post('/api/relatorios-diarios', async (req, res) => {
  try {
    const { titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_base64, setores_destino, para_todos } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    // Converter array de setores para formato PostgreSQL
    const setoresArray = Array.isArray(setores_destino) ? setores_destino : [];
    
    const result = await pool.query(`
      INSERT INTO relatorios_diarios (titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_url, setores_destino, para_todos)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [titulo, conteudo || '', usuario_id, usuario_nome, usuario_foto, imagem_base64 || null, setoresArray, para_todos !== false]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar relatório:', err);
    res.status(500).json({ error: 'Erro ao criar relatório' });
  }
});

// Atualizar relatório diário
app.put('/api/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, conteudo, imagem_base64 } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    let updateQuery, params;
    
    if (imagem_base64) {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, imagem_url = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
      `;
      params = [titulo, conteudo || '', imagem_base64, id];
    } else {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `;
      params = [titulo, conteudo || '', id];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar relatório:', err);
    res.status(500).json({ error: 'Erro ao atualizar relatório' });
  }
});

// Excluir relatório diário
app.delete('/api/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM relatorios_diarios WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json({ success: true, message: 'Relatório excluído' });
  } catch (err) {
    console.error('❌ Erro ao excluir relatório:', err);
    res.status(500).json({ error: 'Erro ao excluir relatório' });
  }
});

// ===== REGRAS DE CONTAGEM DE ENTREGAS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regras_contagem (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    nome_cliente VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regras_contagem já existe ou erro:', err.message));

// Listar regras de contagem
app.get('/api/bi/regras-contagem', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regras_contagem ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regras de contagem:', err);
    res.json([]);
  }
});

// Criar regra de contagem
app.post('/api/bi/regras-contagem', async (req, res) => {
  try {
    const { cod_cliente, nome_cliente } = req.body;
    if (!cod_cliente) {
      return res.status(400).json({ error: 'cod_cliente é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regras_contagem (cod_cliente, nome_cliente) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO NOTHING
      RETURNING *
    `, [cod_cliente, nome_cliente || null]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Cliente já possui regra de contagem' });
    }
    
    res.json({ success: true, regra: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar regra de contagem:', err);
    res.status(500).json({ error: 'Erro ao salvar regra' });
  }
});

// Excluir regra de contagem
app.delete('/api/bi/regras-contagem/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regras_contagem WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir regra:', err);
    res.status(500).json({ error: 'Erro ao excluir regra' });
  }
});

// Resumo por Cliente (tabela detalhada)
app.get('/api/bi/resumo-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_cliente,
        nome_cliente,
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_prof,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento
      FROM bi_entregas ${where}
      GROUP BY cod_cliente, nome_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo clientes:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por cliente' });
  }
});

// Resumo por Profissional (tabela detalhada)
app.get('/api/bi/resumo-profissionais', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_entrega,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_total,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo profissionais:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por profissional' });
  }
});

// Análise por OS (detalhamento)
app.get('/api/bi/analise-os', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, os } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (os) { where += ` AND os = $${paramIndex++}`; params.push(os); }
    
    const result = await pool.query(`
      SELECT 
        os, nome_prof, endereco, cidade, 
        data_solicitado, hora_solicitado,
        hora_chegada, hora_saida,
        tempo_execucao_minutos, distancia, 
        dentro_prazo, prazo_minutos,
        finalizado, status, ocorrencia, categoria
      FROM bi_entregas ${where}
      ORDER BY data_solicitado DESC, os DESC
      LIMIT 500
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro análise OS:', err);
    res.status(500).json({ error: 'Erro ao carregar análise por OS' });
  }
});

// Gráficos - Faixas de tempo e KM
app.get('/api/bi/graficos', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    // Faixas de tempo
    const faixasTempo = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE tempo_execucao_minutos IS NULL) as nao_atribuida,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 45) as ate_45,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 45 AND tempo_execucao_minutos <= 60) as ate_60,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 60 AND tempo_execucao_minutos <= 75) as ate_75,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 75 AND tempo_execucao_minutos <= 90) as ate_90,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 90 AND tempo_execucao_minutos <= 120) as ate_120,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 120) as mais_120
      FROM bi_entregas ${where}
    `, params);
    
    // Faixas de KM
    const faixasKm = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE distancia > 100) as mais_100,
        COUNT(*) FILTER (WHERE distancia >= 0 AND distancia <= 10) as km_0_10,
        COUNT(*) FILTER (WHERE distancia > 10 AND distancia <= 15) as km_11_15,
        COUNT(*) FILTER (WHERE distancia > 15 AND distancia <= 20) as km_16_20,
        COUNT(*) FILTER (WHERE distancia > 20 AND distancia <= 25) as km_21_25,
        COUNT(*) FILTER (WHERE distancia > 25 AND distancia <= 30) as km_26_30,
        COUNT(*) FILTER (WHERE distancia > 30 AND distancia <= 35) as km_31_35,
        COUNT(*) FILTER (WHERE distancia > 35 AND distancia <= 40) as km_36_40,
        COUNT(*) FILTER (WHERE distancia > 40 AND distancia <= 50) as km_41_50,
        COUNT(*) FILTER (WHERE distancia > 50 AND distancia <= 60) as km_51_60,
        COUNT(*) FILTER (WHERE distancia > 60 AND distancia <= 70) as km_61_70,
        COUNT(*) FILTER (WHERE distancia > 70 AND distancia <= 80) as km_71_80,
        COUNT(*) FILTER (WHERE distancia > 80 AND distancia <= 90) as km_81_90,
        COUNT(*) FILTER (WHERE distancia > 90 AND distancia <= 100) as km_91_100
      FROM bi_entregas ${where}
    `, params);
    
    res.json({
      faixasTempo: faixasTempo.rows[0] || {},
      faixasKm: faixasKm.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ Erro gráficos:', err);
    res.status(500).json({ error: 'Erro ao carregar gráficos' });
  }
});

// Listar clientes únicos (para dropdown)
app.get('/api/bi/clientes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_cliente 
      FROM bi_entregas 
      WHERE cod_cliente IS NOT NULL
      ORDER BY nome_cliente
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Listar centros de custo únicos (para dropdown)
app.get('/api/bi/centros-custo', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros:', err);
    res.status(500).json({ error: 'Erro ao listar centros' });
  }
});

// Listar centros de custo de um cliente específico
app.get('/api/bi/centros-custo/:cod_cliente', async (req, res) => {
  try {
    const { cod_cliente } = req.params;
    const result = await pool.query(`
      SELECT DISTINCT centro_custo, COUNT(*) as total_entregas
      FROM bi_entregas 
      WHERE cod_cliente = $1 AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY centro_custo
      ORDER BY centro_custo
    `, [cod_cliente]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros do cliente:', err);
    res.status(500).json({ error: 'Erro ao listar centros do cliente' });
  }
});

// Listar profissionais únicos (para dropdown)
app.get('/api/bi/profissionais', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_prof, nome_prof 
      FROM bi_entregas 
      WHERE cod_prof IS NOT NULL
      ORDER BY nome_prof
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar profissionais' });
  }
});

// Listar datas disponíveis (apenas datas com dados)
app.get('/api/bi/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_solicitado as data, COUNT(*) as total
      FROM bi_entregas 
      WHERE data_solicitado IS NOT NULL
      GROUP BY data_solicitado
      ORDER BY data_solicitado DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar datas:', err);
    res.status(500).json({ error: 'Erro ao listar datas' });
  }
});

// Listar uploads realizados
// Listar histórico de uploads
app.get('/api/bi/uploads', async (req, res) => {
  try {
    // Primeiro tenta buscar do histórico novo
    const historico = await pool.query(`
      SELECT 
        id,
        usuario_id,
        usuario_nome,
        nome_arquivo,
        total_linhas,
        linhas_inseridas,
        linhas_ignoradas,
        os_novas,
        os_ignoradas,
        data_upload
      FROM bi_upload_historico
      ORDER BY data_upload DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    
    if (historico.rows.length > 0) {
      res.json(historico.rows);
    } else {
      // Fallback para o método antigo (agregado por data_upload)
      const result = await pool.query(`
        SELECT data_upload, COUNT(*) as total_registros, 
               MIN(data_solicitado) as data_inicial,
               MAX(data_solicitado) as data_final
        FROM bi_entregas 
        WHERE data_upload IS NOT NULL
        GROUP BY data_upload
        ORDER BY data_upload DESC
      `);
      res.json(result.rows);
    }
  } catch (err) {
    console.error('❌ Erro ao listar uploads:', err);
    res.status(500).json({ error: 'Erro ao listar uploads' });
  }
});

// Excluir upload por data
app.delete('/api/bi/uploads/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(`DELETE FROM bi_entregas WHERE data_upload = $1`, [data]);
    // Também remove do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE DATE(data_upload) = $1`, [data]).catch(() => {});
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao excluir upload:', err);
    res.status(500).json({ error: 'Erro ao excluir upload' });
  }
});

// Excluir upload por ID do histórico
app.delete('/api/bi/uploads/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Buscar info do histórico
    const hist = await pool.query(`SELECT data_upload FROM bi_upload_historico WHERE id = $1`, [id]);
    if (hist.rows.length > 0) {
      const dataUpload = hist.rows[0].data_upload;
      // Deletar entregas dessa data
      await pool.query(`DELETE FROM bi_entregas WHERE data_upload = DATE($1)`, [dataUpload]);
    }
    // Deletar do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir histórico:', err);
    res.status(500).json({ error: 'Erro ao excluir histórico' });
  }
});

// Limpar entregas por período
app.delete('/api/bi/entregas', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    let query = 'DELETE FROM bi_entregas WHERE 1=1';
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND data_solicitado >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND data_solicitado <= $${params.length}`;
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao limpar entregas:', err);
    res.status(500).json({ error: 'Erro ao limpar entregas' });
  }
});

// ============================================
// ROTAS TO-DO - GRUPOS
// ============================================

// Listar grupos (filtrado por permissão)
app.get('/api/todo/grupos', async (req, res) => {
  try {
    const { user_cod, role } = req.query;
    
    let query = `
      SELECT * FROM todo_grupos 
      WHERE ativo = TRUE
    `;
    
    if (role !== 'admin_master') {
      query += ` AND (
        tipo = 'compartilhado' 
        OR criado_por = '${user_cod}'
        OR visivel_para @> '"${user_cod}"'
      )`;
    }
    
    query += ' ORDER BY ordem, nome';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar grupos:', err);
    res.status(500).json({ error: 'Erro ao listar grupos' });
  }
});

// Criar grupo
app.post('/api/todo/grupos', async (req, res) => {
  try {
    const { nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_grupos (nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [nome, descricao, icone || '📋', cor || '#7c3aed', tipo || 'compartilhado', criado_por, criado_por_nome, JSON.stringify(visivel_para || [])]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar grupo:', err);
    res.status(500).json({ error: 'Erro ao criar grupo' });
  }
});

// Atualizar grupo
app.put('/api/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, icone, cor, visivel_para } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_grupos 
      SET nome = COALESCE($1, nome),
          descricao = COALESCE($2, descricao),
          icone = COALESCE($3, icone),
          cor = COALESCE($4, cor),
          visivel_para = COALESCE($5, visivel_para),
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [nome, descricao, icone, cor, JSON.stringify(visivel_para), id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar grupo:', err);
    res.status(500).json({ error: 'Erro ao atualizar grupo' });
  }
});

// Excluir grupo (soft delete)
app.delete('/api/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE todo_grupos SET ativo = FALSE WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir grupo:', err);
    res.status(500).json({ error: 'Erro ao excluir grupo' });
  }
});

// ============================================
// ROTAS TO-DO - TAREFAS
// ============================================

// Listar tarefas (com filtros)
app.get('/api/todo/tarefas', async (req, res) => {
  try {
    const { user_cod, role, grupo_id, status, responsavel, coluna_kanban } = req.query;
    
    let query = `
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor,
             (SELECT COUNT(*) FROM todo_anexos WHERE tarefa_id = t.id) as qtd_anexos,
             (SELECT COUNT(*) FROM todo_comentarios WHERE tarefa_id = t.id) as qtd_comentarios,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id) as qtd_subtarefas,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id AND concluida = true) as qtd_subtarefas_concluidas,
             (SELECT COUNT(*) FROM todo_dependencias WHERE tarefa_id = t.id) as qtd_dependencias
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    // Se um grupo específico for selecionado, mostra TODAS as tarefas desse grupo
    if (grupo_id) {
      query += ` AND t.grupo_id = $${paramIndex}`;
      params.push(grupo_id);
      paramIndex++;
      // Não aplica filtro de usuário quando visualizando um grupo específico
    } else {
      // Se não for admin_master e não tiver grupo específico, filtra por permissões
      if (role !== 'admin_master') {
        query += ` AND (
          t.tipo = 'compartilhado' 
          OR t.criado_por = '${user_cod}'
          OR t.responsaveis @> '[{"user_cod":"${user_cod}"}]'
          OR t.responsaveis::text LIKE '%${user_cod}%'
        )`;
      }
    }
    
    if (status && status !== 'todas') {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (coluna_kanban) {
      query += ` AND t.coluna_kanban = $${paramIndex}`;
      params.push(coluna_kanban);
      paramIndex++;
    }
    
    if (responsavel) {
      query += ` AND t.responsaveis @> $${paramIndex}::jsonb`;
      params.push(JSON.stringify([{ user_cod: responsavel }]));
      paramIndex++;
    }
    
    query += ' ORDER BY t.ordem ASC, CASE t.prioridade WHEN \'urgente\' THEN 1 WHEN \'alta\' THEN 2 WHEN \'media\' THEN 3 ELSE 4 END, t.data_prazo ASC NULLS LAST, t.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar tarefas:', err);
    res.status(500).json({ error: 'Erro ao listar tarefas' });
  }
});

// Buscar tarefa específica com detalhes
app.get('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const tarefa = await pool.query(`
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.id = $1
    `, [id]);
    
    const anexos = await pool.query('SELECT * FROM todo_anexos WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const comentarios = await pool.query('SELECT * FROM todo_comentarios WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const historico = await pool.query('SELECT * FROM todo_historico WHERE tarefa_id = $1 ORDER BY created_at DESC LIMIT 20', [id]);
    
    res.json({
      ...tarefa.rows[0],
      anexos: anexos.rows,
      comentarios: comentarios.rows,
      historico: historico.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar tarefa:', err);
    res.status(500).json({ error: 'Erro ao buscar tarefa' });
  }
});

// Função para calcular próxima data de recorrência
function calcularProximaRecorrencia(dataBase, tipoRecorrencia, intervalo = 1) {
  const data = new Date(dataBase);
  data.setHours(0, 0, 0, 0);
  
  switch (tipoRecorrencia) {
    case 'diaria':
    case 'diario':
      data.setDate(data.getDate() + intervalo);
      break;
    case 'semanal':
      data.setDate(data.getDate() + (7 * intervalo));
      break;
    case 'mensal':
      data.setMonth(data.getMonth() + intervalo);
      break;
    case 'personalizado':
      data.setDate(data.getDate() + intervalo);
      break;
    default:
      data.setDate(data.getDate() + 1);
  }
  
  return data;
}

// Endpoint para processar tarefas recorrentes (chamado por cron ou manualmente)
app.post('/api/todo/processar-recorrencias', async (req, res) => {
  try {
    const agora = new Date();
    
    // Buscar tarefas recorrentes concluídas que precisam ser reabertas
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      // Calcular próxima recorrência
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
      // Reabrir a tarefa
      await pool.query(`
        UPDATE todo_tarefas 
        SET status = 'pendente',
            data_conclusao = NULL,
            concluido_por = NULL,
            concluido_por_nome = NULL,
            proxima_recorrencia = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [proximaData, tarefa.id]);
      
      // Registrar no histórico
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    console.log(`✅ Processamento de recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    res.json({ success: true, reabertas });
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
    res.status(500).json({ error: 'Erro ao processar recorrências' });
  }
});

// Criar tarefa
app.post('/api/todo/tarefas', async (req, res) => {
  try {
    const { 
      grupo_id, titulo, descricao, prioridade, data_prazo, 
      recorrente, tipo_recorrencia, intervalo_recorrencia, tipo, 
      criado_por, criado_por_nome, criado_por_foto, responsaveis 
    } = req.body;
    
    // Calcular próxima recorrência se for recorrente
    let proxima_recorrencia = null;
    if (recorrente && tipo_recorrencia) {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      proxima_recorrencia = calcularProximaRecorrencia(hoje, tipo_recorrencia, intervalo_recorrencia || 1);
    }
    
    const result = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        recorrente, tipo_recorrencia, intervalo_recorrencia, proxima_recorrencia, tipo,
        criado_por, criado_por_nome, criado_por_foto, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      grupo_id, titulo, descricao, prioridade || 'media', data_prazo,
      recorrente || false, tipo_recorrencia, intervalo_recorrencia || 1, proxima_recorrencia, tipo || 'compartilhado',
      criado_por, criado_por_nome, criado_por_foto || null, JSON.stringify(responsaveis || [])
    ]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'criada', 'Tarefa criada', $2, $3)
    `, [result.rows[0].id, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// Atualizar tarefa
app.put('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia, responsaveis,
      user_cod, user_name
    } = req.body;
    
    const anterior = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    const tarefaAnterior = anterior.rows[0];
    
    let concluido_por = null;
    let concluido_por_nome = null;
    let data_conclusao = null;
    let proxima_recorrencia = tarefaAnterior?.proxima_recorrencia;
    
    // Se está sendo concluída
    if (status === 'concluida' && tarefaAnterior?.status !== 'concluida') {
      concluido_por = user_cod;
      concluido_por_nome = user_name;
      data_conclusao = new Date();
      
      // Se é recorrente, calcular próxima data
      if (tarefaAnterior?.recorrente) {
        proxima_recorrencia = calcularProximaRecorrencia(
          new Date(), 
          tarefaAnterior.tipo_recorrencia, 
          tarefaAnterior.intervalo_recorrencia || 1
        );
      }
    }
    
    const result = await pool.query(`
      UPDATE todo_tarefas 
      SET titulo = COALESCE($1, titulo),
          descricao = COALESCE($2, descricao),
          status = COALESCE($3, status),
          prioridade = COALESCE($4, prioridade),
          data_prazo = COALESCE($5, data_prazo),
          recorrente = COALESCE($6, recorrente),
          tipo_recorrencia = COALESCE($7, tipo_recorrencia),
          intervalo_recorrencia = COALESCE($8, intervalo_recorrencia),
          responsaveis = COALESCE($9, responsaveis),
          concluido_por = COALESCE($10, concluido_por),
          concluido_por_nome = COALESCE($11, concluido_por_nome),
          data_conclusao = COALESCE($12, data_conclusao),
          proxima_recorrencia = $13,
          updated_at = NOW()
      WHERE id = $14
      RETURNING *
    `, [
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia,
      responsaveis ? JSON.stringify(responsaveis) : null,
      concluido_por, concluido_por_nome, data_conclusao, proxima_recorrencia, id
    ]);
    
    let acaoDesc = 'Tarefa atualizada';
    if (status && status !== anterior.rows[0]?.status) {
      acaoDesc = `Status alterado: ${anterior.rows[0]?.status || 'pendente'} → ${status}`;
    }
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name, dados_anteriores, dados_novos)
      VALUES ($1, 'atualizada', $2, $3, $4, $5, $6)
    `, [id, acaoDesc, user_cod, user_name, JSON.stringify(anterior.rows[0]), JSON.stringify(result.rows[0])]);
    
    // Se tarefa recorrente foi concluída, criar próxima
    if (status === 'concluida' && result.rows[0].recorrente && result.rows[0].tipo_recorrencia) {
      const tarefa = result.rows[0];
      let proximoPrazo = new Date();
      proximoPrazo.setHours(0, 0, 0, 0); // Começa à meia-noite
      
      const intervalo = tarefa.intervalo_recorrencia || 1;
      
      switch (tarefa.tipo_recorrencia) {
        case 'diario':
          proximoPrazo.setDate(proximoPrazo.getDate() + 1); // Próximo dia às 00:00
          break;
        case 'semanal':
          proximoPrazo.setDate(proximoPrazo.getDate() + (7 * intervalo));
          break;
        case 'mensal':
          proximoPrazo.setMonth(proximoPrazo.getMonth() + intervalo);
          break;
        case 'personalizado':
          proximoPrazo.setDate(proximoPrazo.getDate() + intervalo);
          break;
      }
      
      await pool.query(`
        INSERT INTO todo_tarefas (
          grupo_id, titulo, descricao, prioridade, data_prazo,
          recorrente, tipo_recorrencia, intervalo_recorrencia, tipo,
          criado_por, criado_por_nome, criado_por_foto, responsaveis
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        tarefa.grupo_id, tarefa.titulo, tarefa.descricao, tarefa.prioridade, proximoPrazo,
        true, tarefa.tipo_recorrencia, intervalo, tarefa.tipo,
        tarefa.criado_por, tarefa.criado_por_nome, tarefa.criado_por_foto, tarefa.responsaveis
      ]);
      console.log('✅ Tarefa recorrente criada para:', proximoPrazo);
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar tarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// Excluir tarefa
app.delete('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_tarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir tarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - COMENTÁRIOS
// ============================================

app.post('/api/todo/tarefas/:id/comentarios', async (req, res) => {
  try {
    const { id } = req.params;
    const { texto, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_comentarios (tarefa_id, texto, user_cod, user_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, texto, user_cod, user_name]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'comentario', 'Comentário adicionado', $2, $3)
    `, [id, user_cod, user_name]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar comentário:', err);
    res.status(500).json({ error: 'Erro ao adicionar comentário' });
  }
});

// ============================================
// ROTAS TO-DO - ANEXOS
// ============================================

app.post('/api/todo/tarefas/:id/anexos', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_anexos (tarefa_id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'anexo', $2, $3, $4)
    `, [id, `Anexo adicionado: ${nome_arquivo}`, enviado_por, enviado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar anexo:', err);
    res.status(500).json({ error: 'Erro ao adicionar anexo' });
  }
});

app.delete('/api/todo/anexos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_anexos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir anexo:', err);
    res.status(500).json({ error: 'Erro ao excluir anexo' });
  }
});

// ============================================
// ROTAS TO-DO - MÉTRICAS (Admin Master)
// ============================================

app.get('/api/todo/metricas', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    const dias = parseInt(periodo);
    
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY status
    `);
    
    const conclusaoResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'concluida' AND (data_conclusao <= data_prazo OR data_prazo IS NULL)) as no_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida' AND data_conclusao > data_prazo) as fora_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida') as total_concluidas,
        COUNT(*) FILTER (WHERE status != 'concluida' AND data_prazo < NOW()) as atrasadas,
        COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
    `);
    
    const porResponsavelResult = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        COUNT(*) FILTER (WHERE data_conclusao > data_prazo) as fora_prazo,
        AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${dias} days'
      GROUP BY concluido_por, concluido_por_nome
      ORDER BY total_concluidas DESC
    `);
    
    const porGrupoResult = await pool.query(`
      SELECT 
        g.id,
        g.nome,
        g.icone,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE t.status = 'concluida') as concluidas,
        COUNT(*) FILTER (WHERE t.status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE t.status = 'em_andamento') as em_andamento
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY g.id, g.nome, g.icone
      ORDER BY total DESC
    `);
    
    const conclusao = conclusaoResult.rows[0];
    const taxaNoPrazo = conclusao.total_concluidas > 0 
      ? ((conclusao.no_prazo / conclusao.total_concluidas) * 100).toFixed(1) 
      : 0;
    
    res.json({
      totais: {
        total: parseInt(conclusao.total),
        concluidas: parseInt(conclusao.total_concluidas),
        atrasadas: parseInt(conclusao.atrasadas),
        no_prazo: parseInt(conclusao.no_prazo),
        vencidas: parseInt(conclusao.atrasadas),
        taxaNoPrazo: parseFloat(taxaNoPrazo)
      },
      porStatus: statusResult.rows,
      porResponsavel: porResponsavelResult.rows,
      porGrupo: porGrupoResult.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

app.get('/api/todo/metricas/ranking', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    const result = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        ROUND(
          (COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL)::DECIMAL / 
           NULLIF(COUNT(*), 0) * 100), 1
        ) as taxa_prazo,
        ROUND(AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600)::DECIMAL, 1) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${periodo} days'
      GROUP BY concluido_por, concluido_por_nome
      HAVING COUNT(*) >= 1
      ORDER BY taxa_prazo DESC, total_concluidas DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// Listar admins para o TO-DO
app.get('/api/todo/admins', async (req, res) => {
  try {
    // Retorna apenas ADMINS e ADMIN_MASTER com foto do perfil social
    const result = await pool.query(`
      SELECT 
        u.cod_profissional as cod, 
        u.full_name as nome,
        u.role,
        sp.profile_photo as foto
      FROM users u
      LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
      WHERE u.role IN ('admin', 'admin_master')
      ORDER BY u.full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar admins para TODO:', err);
    res.json([]);
  }
});

// ============================================
// ROTAS TO-DO - SUBTAREFAS/CHECKLIST
// ============================================

// Listar subtarefas de uma tarefa
app.get('/api/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_subtarefas WHERE tarefa_id = $1 ORDER BY ordem, id',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao listar subtarefas' });
  }
});

// Criar subtarefa
app.post('/api/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, ordem } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, titulo, ordem || 0]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao criar subtarefa' });
  }
});

// Atualizar subtarefa (toggle concluída)
app.put('/api/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, concluida, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_subtarefas 
      SET titulo = COALESCE($1, titulo),
          concluida = COALESCE($2, concluida),
          concluida_por = CASE WHEN $2 = true THEN $3 ELSE NULL END,
          concluida_por_nome = CASE WHEN $2 = true THEN $4 ELSE NULL END,
          concluida_em = CASE WHEN $2 = true THEN NOW() ELSE NULL END
      WHERE id = $5
      RETURNING *
    `, [titulo, concluida, user_cod, user_name, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar subtarefa' });
  }
});

// Excluir subtarefa
app.delete('/api/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_subtarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir subtarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir subtarefa' });
  }
});

// Reordenar subtarefas
app.put('/api/todo/tarefas/:id/subtarefas/reordenar', async (req, res) => {
  try {
    const { id } = req.params;
    const { subtarefas } = req.body; // Array de {id, ordem}
    
    for (const sub of subtarefas) {
      await pool.query('UPDATE todo_subtarefas SET ordem = $1 WHERE id = $2', [sub.ordem, sub.id]);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao reordenar subtarefas' });
  }
});

// ============================================
// ROTAS TO-DO - TIME TRACKING
// ============================================

// Iniciar timer
app.post('/api/todo/tarefas/:id/timer/iniciar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name } = req.body;
    
    // Verificar se já tem timer ativo
    const tarefaAtual = await pool.query('SELECT timer_ativo FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaAtual.rows[0]?.timer_ativo) {
      return res.status(400).json({ error: 'Timer já está ativo para esta tarefa' });
    }
    
    // Parar qualquer outro timer do usuário
    const outrosTimers = await pool.query(
      'SELECT id, timer_inicio FROM todo_tarefas WHERE timer_ativo = true AND timer_user_cod = $1',
      [user_cod]
    );
    
    for (const tarefa of outrosTimers.rows) {
      const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.timer_inicio).getTime()) / 1000);
      await pool.query(`
        UPDATE todo_tarefas 
        SET timer_ativo = false, 
            timer_inicio = NULL, 
            timer_user_cod = NULL,
            tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
        WHERE id = $2
      `, [duracaoSegundos, tarefa.id]);
      
      // Registrar no histórico de time tracking
      await pool.query(`
        INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos)
        VALUES ($1, $2, $3, $4, NOW(), $5)
      `, [tarefa.id, user_cod, user_name, tarefa.timer_inicio, duracaoSegundos]);
    }
    
    // Iniciar novo timer
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = true, timer_inicio = NOW(), timer_user_cod = $1, status = 'em_andamento'
      WHERE id = $2
    `, [user_cod, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao iniciar timer:', err);
    res.status(500).json({ error: 'Erro ao iniciar timer' });
  }
});

// Parar timer
app.post('/api/todo/tarefas/:id/timer/parar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, descricao } = req.body;
    
    const tarefa = await pool.query('SELECT timer_inicio, tempo_gasto_segundos FROM todo_tarefas WHERE id = $1', [id]);
    if (!tarefa.rows[0]?.timer_inicio) {
      return res.status(400).json({ error: 'Nenhum timer ativo para esta tarefa' });
    }
    
    const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.rows[0].timer_inicio).getTime()) / 1000);
    const tempoTotal = (tarefa.rows[0].tempo_gasto_segundos || 0) + duracaoSegundos;
    
    // Registrar no histórico
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6)
    `, [id, user_cod, user_name, tarefa.rows[0].timer_inicio, duracaoSegundos, descricao]);
    
    // Atualizar tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = false, 
          timer_inicio = NULL, 
          timer_user_cod = NULL,
          tempo_gasto_segundos = $1
      WHERE id = $2
    `, [tempoTotal, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao parar timer:', err);
    res.status(500).json({ error: 'Erro ao parar timer' });
  }
});

// Histórico de tempo de uma tarefa
app.get('/api/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_time_tracking WHERE tarefa_id = $1 ORDER BY inicio DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de tempo:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Adicionar tempo manual
app.post('/api/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, duracao_minutos, descricao, data } = req.body;
    
    const duracaoSegundos = duracao_minutos * 60;
    const dataRegistro = data ? new Date(data) : new Date();
    
    // Inserir registro
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, $4, $5, $6)
    `, [id, user_cod, user_name, dataRegistro, duracaoSegundos, descricao]);
    
    // Atualizar tempo total da tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
      WHERE id = $2
    `, [duracaoSegundos, id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao adicionar tempo:', err);
    res.status(500).json({ error: 'Erro ao adicionar tempo' });
  }
});

// ============================================
// ROTAS TO-DO - KANBAN
// ============================================

// Atualizar coluna kanban de uma tarefa
app.put('/api/todo/tarefas/:id/kanban', async (req, res) => {
  try {
    const { id } = req.params;
    const { coluna_kanban, ordem, user_cod, user_name } = req.body;
    
    console.log('🔄 Movendo tarefa no kanban:', { id, coluna_kanban, user_cod });
    
    if (!coluna_kanban) {
      return res.status(400).json({ error: 'coluna_kanban é obrigatório' });
    }
    
    // Verificar se a tarefa existe
    const tarefaCheck = await pool.query('SELECT id FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    
    // Mapear coluna para status
    let status = 'pendente';
    if (coluna_kanban === 'doing') status = 'em_andamento';
    else if (coluna_kanban === 'done') status = 'concluida';
    
    // Atualizar tarefa
    const updateQuery = status === 'concluida' 
      ? `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2, 
             concluido_por = $3,
             concluido_por_nome = $4,
             data_conclusao = NOW(),
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`
      : `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`;
    
    const params = status === 'concluida' 
      ? [coluna_kanban, status, user_cod, user_name, id]
      : [coluna_kanban, status, id];
    
    const result = await pool.query(updateQuery, params);
    
    // Registrar no histórico (ignorar erro se tabela não existir)
    try {
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'movida', $2, $3, $4)
      `, [id, `Movida para ${coluna_kanban}`, user_cod || 'sistema', user_name || 'Sistema']);
    } catch (histErr) {
      console.log('⚠️ Histórico não registrado:', histErr.message);
    }
    
    console.log('✅ Tarefa movida com sucesso:', result.rows[0]?.id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao mover tarefa no kanban:', err);
    res.status(500).json({ error: 'Erro ao mover tarefa', details: err.message });
  }
});

// Reordenar tarefas dentro de uma coluna
app.put('/api/todo/kanban/reordenar', async (req, res) => {
  try {
    const { tarefas } = req.body; // Array de {id, ordem, coluna_kanban}
    
    for (const tarefa of tarefas) {
      await pool.query(
        'UPDATE todo_tarefas SET ordem = $1, coluna_kanban = $2 WHERE id = $3',
        [tarefa.ordem, tarefa.coluna_kanban, tarefa.id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar kanban:', err);
    res.status(500).json({ error: 'Erro ao reordenar' });
  }
});

// ============================================
// ROTAS TO-DO - DEPENDÊNCIAS
// ============================================

// Listar dependências de uma tarefa
app.get('/api/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Tarefas das quais esta depende
    const dependeDe = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.depende_de = t.id
      WHERE d.tarefa_id = $1
    `, [id]);
    
    // Tarefas que dependem desta
    const dependentes = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.tarefa_id = t.id
      WHERE d.depende_de = $1
    `, [id]);
    
    res.json({
      depende_de: dependeDe.rows,
      dependentes: dependentes.rows
    });
  } catch (err) {
    console.error('❌ Erro ao listar dependências:', err);
    res.status(500).json({ error: 'Erro ao listar dependências' });
  }
});

// Adicionar dependência
app.post('/api/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    const { depende_de, tipo } = req.body;
    
    // Verificar se não cria dependência circular
    const circular = await pool.query(`
      WITH RECURSIVE dep_chain AS (
        SELECT tarefa_id, depende_de FROM todo_dependencias WHERE tarefa_id = $1
        UNION
        SELECT d.tarefa_id, d.depende_de 
        FROM todo_dependencias d
        JOIN dep_chain c ON d.tarefa_id = c.depende_de
      )
      SELECT * FROM dep_chain WHERE depende_de = $2
    `, [depende_de, id]);
    
    if (circular.rows.length > 0) {
      return res.status(400).json({ error: 'Dependência circular detectada!' });
    }
    
    const result = await pool.query(`
      INSERT INTO todo_dependencias (tarefa_id, depende_de, tipo)
      VALUES ($1, $2, $3)
      ON CONFLICT (tarefa_id, depende_de) DO NOTHING
      RETURNING *
    `, [id, depende_de, tipo || 'finish_to_start']);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar dependência:', err);
    res.status(500).json({ error: 'Erro ao adicionar dependência' });
  }
});

// Remover dependência
app.delete('/api/todo/dependencias/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_dependencias WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover dependência:', err);
    res.status(500).json({ error: 'Erro ao remover dependência' });
  }
});

// ============================================
// ROTAS TO-DO - TEMPLATES
// ============================================

// Listar templates
app.get('/api/todo/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM todo_templates WHERE ativo = true ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar templates:', err);
    res.json([]);
  }
});

// Criar template
app.post('/api/todo/templates', async (req, res) => {
  try {
    const { grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_templates (grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [grupo_id, nome, titulo_tarefa, descricao, prioridade, JSON.stringify(checklist || []), tempo_estimado_minutos, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar template:', err);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// Criar tarefa a partir de template
app.post('/api/todo/templates/:id/criar-tarefa', async (req, res) => {
  try {
    const { id } = req.params;
    const { grupo_id, data_prazo, responsaveis, criado_por, criado_por_nome } = req.body;
    
    const template = await pool.query('SELECT * FROM todo_templates WHERE id = $1', [id]);
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    const t = template.rows[0];
    
    // Criar tarefa
    const tarefa = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        tempo_estimado_minutos, template_id, tipo,
        criado_por, criado_por_nome, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'compartilhado', $8, $9, $10)
      RETURNING *
    `, [
      grupo_id || t.grupo_id, t.titulo_tarefa, t.descricao, t.prioridade, data_prazo,
      t.tempo_estimado_minutos, id,
      criado_por, criado_por_nome, JSON.stringify(responsaveis || [])
    ]);
    
    // Criar subtarefas do checklist
    const checklist = t.checklist || [];
    for (let i = 0; i < checklist.length; i++) {
      await pool.query(`
        INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
        VALUES ($1, $2, $3)
      `, [tarefa.rows[0].id, checklist[i], i]);
    }
    
    res.json(tarefa.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa do template:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - RELATÓRIO DE TEMPO
// ============================================

app.get('/api/todo/relatorio-tempo', async (req, res) => {
  try {
    const { periodo = '30', user_cod } = req.query;
    const dias = parseInt(periodo);
    
    let query = `
      SELECT 
        t.id as tarefa_id,
        t.titulo,
        t.tempo_estimado_minutos,
        t.tempo_gasto_segundos,
        g.nome as grupo_nome,
        COALESCE(SUM(tt.duracao_segundos), 0) as tempo_registrado
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      LEFT JOIN todo_time_tracking tt ON t.id = tt.tarefa_id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
    `;
    
    const params = [];
    if (user_cod) {
      query += ` AND tt.user_cod = $1`;
      params.push(user_cod);
    }
    
    query += ` GROUP BY t.id, t.titulo, t.tempo_estimado_minutos, t.tempo_gasto_segundos, g.nome ORDER BY tempo_registrado DESC`;
    
    const result = await pool.query(query, params);
    
    // Calcular totais
    const totais = result.rows.reduce((acc, row) => ({
      tempo_estimado: acc.tempo_estimado + (row.tempo_estimado_minutos || 0) * 60,
      tempo_gasto: acc.tempo_gasto + (row.tempo_gasto_segundos || 0),
      tempo_registrado: acc.tempo_registrado + parseInt(row.tempo_registrado || 0)
    }), { tempo_estimado: 0, tempo_gasto: 0, tempo_registrado: 0 });
    
    res.json({
      tarefas: result.rows,
      totais
    });
  } catch (err) {
    console.error('❌ Erro ao gerar relatório de tempo:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// ==================== ROTAS DO MÓDULO SOCIAL ====================

// Obter perfil social do usuário
app.get('/api/social/profile/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM social_profiles WHERE user_cod = $1',
      [userCod]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json(null);
    }
  } catch (err) {
    console.error('Erro ao buscar perfil social:', err);
    res.status(500).json({ error: err.message });
  }
});

// Criar ou atualizar perfil social
app.put('/api/social/profile/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const { display_name, profile_photo } = req.body;
    
    const result = await pool.query(`
      INSERT INTO social_profiles (user_cod, display_name, profile_photo, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (user_cod) 
      DO UPDATE SET 
        display_name = COALESCE($2, social_profiles.display_name),
        profile_photo = COALESCE($3, social_profiles.profile_photo),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userCod, display_name, profile_photo]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar perfil social:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status online
app.post('/api/social/status', async (req, res) => {
  try {
    const { user_cod, is_online } = req.body;
    
    await pool.query(`
      INSERT INTO social_status (user_cod, is_online, last_seen)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_cod) 
      DO UPDATE SET 
        is_online = $2,
        last_seen = CURRENT_TIMESTAMP
    `, [user_cod, is_online]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao atualizar status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar todos os usuários com status e perfil social
app.get('/api/social/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.cod_profissional,
        u.full_name,
        u.role,
        COALESCE(sp.display_name, u.full_name) as display_name,
        sp.profile_photo,
        COALESCE(ss.is_online, false) as is_online,
        ss.last_seen
      FROM users u
      LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
      LEFT JOIN social_status ss ON u.cod_profissional = ss.user_cod
      WHERE u.role IN ('user', 'admin', 'admin_financeiro', 'admin_master')
      ORDER BY ss.is_online DESC NULLS LAST, COALESCE(sp.display_name, u.full_name) ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar usuários:', err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem ou reação
app.post('/api/social/messages', async (req, res) => {
  try {
    const { from_user_cod, from_user_name, to_user_cod, message_type, content } = req.body;
    
    const result = await pool.query(`
      INSERT INTO social_messages (from_user_cod, from_user_name, to_user_cod, message_type, content)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [from_user_cod, from_user_name, to_user_cod, message_type, content]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar mensagens recebidas por um usuário
app.get('/api/social/messages/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(`
      SELECT * FROM social_messages 
      WHERE to_user_cod = $1 
      ORDER BY created_at DESC 
      LIMIT 50
    `, [userCod]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar mensagens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Marcar mensagens como lidas
app.patch('/api/social/messages/read', async (req, res) => {
  try {
    const { user_cod } = req.body;
    await pool.query(
      'UPDATE social_messages SET is_read = true WHERE to_user_cod = $1 AND is_read = false',
      [user_cod]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao marcar como lido:', err);
    res.status(500).json({ error: err.message });
  }
});

// Contar mensagens não lidas
app.get('/api/social/messages/unread/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM social_messages WHERE to_user_cod = $1 AND is_read = false',
      [userCod]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Erro ao contar não lidas:', err);
    res.json({ count: 0 });
  }
});

// ==================== ROTAS MENSAGENS DA LIDERANÇA ====================

// Criar nova mensagem da liderança (apenas admin_master)
app.post('/api/lideranca/mensagens', async (req, res) => {
  try {
    const { 
      titulo, conteudo, tipo_conteudo, midia_url, midia_tipo,
      criado_por_cod, criado_por_nome, criado_por_foto,
      recorrente, tipo_recorrencia, intervalo_recorrencia
    } = req.body;
    
    // Calcular próxima exibição se for recorrente
    let proxima_exibicao = null;
    if (recorrente && tipo_recorrencia) {
      const agora = new Date();
      switch (tipo_recorrencia) {
        case 'diaria':
          proxima_exibicao = new Date(agora.getTime() + (intervalo_recorrencia || 1) * 24 * 60 * 60 * 1000);
          break;
        case 'semanal':
          proxima_exibicao = new Date(agora.getTime() + (intervalo_recorrencia || 1) * 7 * 24 * 60 * 60 * 1000);
          break;
        case 'mensal':
          proxima_exibicao = new Date(agora);
          proxima_exibicao.setMonth(proxima_exibicao.getMonth() + (intervalo_recorrencia || 1));
          break;
      }
    }
    
    const result = await pool.query(`
      INSERT INTO lideranca_mensagens (
        titulo, conteudo, tipo_conteudo, midia_url, midia_tipo,
        criado_por_cod, criado_por_nome, criado_por_foto,
        recorrente, tipo_recorrencia, intervalo_recorrencia, proxima_exibicao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      titulo, conteudo, tipo_conteudo || 'texto', midia_url, midia_tipo,
      criado_por_cod, criado_por_nome, criado_por_foto,
      recorrente || false, tipo_recorrencia, intervalo_recorrencia || 1, proxima_exibicao
    ]);
    
    console.log('📢 Nova mensagem da liderança criada:', result.rows[0].id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar mensagem da liderança:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar todas as mensagens da liderança (para admin_master gerenciar)
app.get('/api/lideranca/mensagens', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
        (SELECT COUNT(*) FROM lideranca_visualizacoes WHERE mensagem_id = m.id) as total_visualizacoes
      FROM lideranca_mensagens m
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar mensagens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar mensagens não visualizadas pelo usuário (para notificação)
app.get('/api/lideranca/mensagens/pendentes/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(`
      SELECT m.* FROM lideranca_mensagens m
      WHERE m.ativo = true
        AND m.id NOT IN (
          SELECT mensagem_id FROM lideranca_visualizacoes WHERE user_cod = $1
        )
      ORDER BY m.created_at DESC
    `, [userCod]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar mensagens pendentes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Marcar mensagem como visualizada
app.post('/api/lideranca/mensagens/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_nome, user_foto } = req.body;
    
    await pool.query(`
      INSERT INTO lideranca_visualizacoes (mensagem_id, user_cod, user_nome, user_foto)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (mensagem_id, user_cod) DO UPDATE SET visualizado_em = CURRENT_TIMESTAMP
    `, [id, user_cod, user_nome, user_foto]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar como visualizado:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar quem visualizou uma mensagem específica
app.get('/api/lideranca/mensagens/:id/visualizacoes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM lideranca_visualizacoes
      WHERE mensagem_id = $1
      ORDER BY visualizado_em DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar visualizações:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar mensagens já visualizadas pelo usuário (histórico)
app.get('/api/lideranca/mensagens/historico/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(`
      SELECT m.*, v.visualizado_em
      FROM lideranca_mensagens m
      INNER JOIN lideranca_visualizacoes v ON m.id = v.mensagem_id
      WHERE v.user_cod = $1
      ORDER BY v.visualizado_em DESC
    `, [userCod]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar mensagem da liderança
app.put('/api/lideranca/mensagens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, conteudo, tipo_conteudo, midia_url, midia_tipo, recorrente, tipo_recorrencia, intervalo_recorrencia, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE lideranca_mensagens SET
        titulo = COALESCE($1, titulo),
        conteudo = COALESCE($2, conteudo),
        tipo_conteudo = COALESCE($3, tipo_conteudo),
        midia_url = COALESCE($4, midia_url),
        midia_tipo = COALESCE($5, midia_tipo),
        recorrente = COALESCE($6, recorrente),
        tipo_recorrencia = COALESCE($7, tipo_recorrencia),
        intervalo_recorrencia = COALESCE($8, intervalo_recorrencia),
        ativo = COALESCE($9, ativo),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
    `, [titulo, conteudo, tipo_conteudo, midia_url, midia_tipo, recorrente, tipo_recorrencia, intervalo_recorrencia, ativo, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar mensagem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deletar mensagem da liderança
app.delete('/api/lideranca/mensagens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM lideranca_mensagens WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao deletar mensagem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Processar recorrências (endpoint para ser chamado por cron ou manualmente)
app.post('/api/lideranca/processar-recorrencias', async (req, res) => {
  try {
    const agora = new Date();
    
    // Buscar mensagens recorrentes que precisam ser reexibidas
    const mensagens = await pool.query(`
      SELECT * FROM lideranca_mensagens
      WHERE recorrente = true AND ativo = true AND proxima_exibicao <= $1
    `, [agora]);
    
    for (const msg of mensagens.rows) {
      // Limpar visualizações antigas para reexibir
      await pool.query('DELETE FROM lideranca_visualizacoes WHERE mensagem_id = $1', [msg.id]);
      
      // Calcular próxima exibição
      let proxima = new Date(agora);
      switch (msg.tipo_recorrencia) {
        case 'diaria':
          proxima.setDate(proxima.getDate() + (msg.intervalo_recorrencia || 1));
          break;
        case 'semanal':
          proxima.setDate(proxima.getDate() + (msg.intervalo_recorrencia || 1) * 7);
          break;
        case 'mensal':
          proxima.setMonth(proxima.getMonth() + (msg.intervalo_recorrencia || 1));
          break;
      }
      
      await pool.query('UPDATE lideranca_mensagens SET proxima_exibicao = $1 WHERE id = $2', [proxima, msg.id]);
    }
    
    res.json({ processadas: mensagens.rows.length });
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar reação a uma mensagem
app.post('/api/lideranca/mensagens/:id/reagir', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_nome, user_foto, emoji } = req.body;
    
    await pool.query(`
      INSERT INTO lideranca_reacoes (mensagem_id, user_cod, user_nome, user_foto, emoji)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (mensagem_id, user_cod, emoji) DO NOTHING
    `, [id, user_cod, user_nome, user_foto, emoji]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao enviar reação:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar reações de uma mensagem
app.get('/api/lideranca/mensagens/:id/reacoes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM lideranca_reacoes
      WHERE mensagem_id = $1
      ORDER BY created_at DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar reações:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remover reação (toggle)
app.delete('/api/lideranca/mensagens/:id/reagir', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, emoji } = req.body;
    
    await pool.query(`
      DELETE FROM lideranca_reacoes 
      WHERE mensagem_id = $1 AND user_cod = $2 AND emoji = $3
    `, [id, user_cod, emoji]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover reação:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FIM ROTAS MENSAGENS DA LIDERANÇA ====================

// ==================== FIM ROTAS MÓDULO SOCIAL ====================

// ==================== ROTAS DO MÓDULO AVISOS OPERACIONAL ====================

// Listar todas as regiões (cidades) da planilha
app.get('/api/avisos-op/regioes', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    const regioes = new Set();
    lines.forEach(line => {
      const cols = line.split(',');
      const cidade = cols[3]?.trim(); // coluna Cidade
      if (cidade && cidade.length > 0 && cidade !== '') {
        regioes.add(cidade);
      }
    });
    
    res.json([...regioes].sort());
  } catch (err) {
    console.error('❌ Erro ao buscar regiões:', err);
    res.json([]);
  }
});

// Listar todos os avisos (para admin)
app.get('/api/avisos-op', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, 
        (SELECT COUNT(*) FROM avisos_visualizacoes WHERE aviso_id = a.id) as total_visualizacoes
      FROM avisos a 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.json([]);
  }
});

// Criar novo aviso
app.post('/api/avisos-op', async (req, res) => {
  try {
    const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by } = req.body;
    
    const result = await pool.query(`
      INSERT INTO avisos (titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [titulo, regioes || [], todas_regioes || false, data_inicio, data_fim, recorrencia_tipo || 'uma_vez', recorrencia_intervalo || 0, imagem_url, created_by]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar aviso
app.put('/api/avisos-op/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE avisos 
      SET titulo = $1, regioes = $2, todas_regioes = $3, data_inicio = $4, data_fim = $5, 
          recorrencia_tipo = $6, recorrencia_intervalo = $7, imagem_url = $8, ativo = $9, updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `, [titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deletar aviso
app.delete('/api/avisos-op/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao deletar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar avisos para um usuário específico (baseado na região)
app.get('/api/avisos-op/usuario/:cod', async (req, res) => {
  try {
    const { cod } = req.params;
    
    // Buscar região do usuário na planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1);
    
    let userRegiao = null;
    for (const line of lines) {
      const cols = line.split(',');
      if (cols[0]?.trim() === cod) {
        userRegiao = cols[3]?.trim(); // coluna Cidade
        break;
      }
    }
    
    const now = new Date();
    
    // Buscar avisos ativos para a região do usuário
    const result = await pool.query(`
      SELECT a.* FROM avisos a
      WHERE a.ativo = true
        AND a.data_inicio <= $1
        AND a.data_fim >= $1
        AND (a.todas_regioes = true OR $2 = ANY(a.regioes) OR $2 IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM avisos_visualizacoes av 
          WHERE av.aviso_id = a.id AND av.user_cod = $3
          AND (
            a.recorrencia_tipo = 'uma_vez'
            OR (a.recorrencia_tipo = 'diario' AND av.visualizado_em > NOW() - INTERVAL '1 day')
            OR (a.recorrencia_tipo = 'intervalo_horas' AND av.visualizado_em > NOW() - (a.recorrencia_intervalo || ' hours')::INTERVAL)
          )
        )
      ORDER BY a.created_at DESC
      LIMIT 1
    `, [now, userRegiao, cod]);
    
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('❌ Erro ao buscar avisos do usuário:', err);
    res.json(null);
  }
});

// Marcar aviso como visualizado
app.post('/api/avisos-op/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod } = req.body;
    
    await pool.query(`
      INSERT INTO avisos_visualizacoes (aviso_id, user_cod, visualizado_em)
      VALUES ($1, $2, NOW())
      ON CONFLICT (aviso_id, user_cod) DO UPDATE SET visualizado_em = NOW()
    `, [id, user_cod]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar visualização:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FIM ROTAS MÓDULO AVISOS ====================

// Função para processar recorrências
async function processarRecorrenciasInterno() {
  try {
    const agora = new Date();
    
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
      await pool.query(`
        UPDATE todo_tarefas 
        SET status = 'pendente',
            data_conclusao = NULL,
            concluido_por = NULL,
            concluido_por_nome = NULL,
            proxima_recorrencia = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [proximaData, tarefa.id]);
      
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    if (reabertas > 0) {
      console.log(`🔄 Recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    }
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
  }
}

// ============================================
// ROTAS DE RECRUTAMENTO
// ============================================

// ============================================
// ROTAS DO MÓDULO GARANTIDO (BI)
// ============================================

// Criar tabela de status do garantido (se não existir)
pool.query(`
  CREATE TABLE IF NOT EXISTS garantido_status (
    id SERIAL PRIMARY KEY,
    cod_prof VARCHAR(20) NOT NULL,
    data DATE NOT NULL,
    cod_cliente VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'analise',
    motivo_reprovado TEXT,
    alterado_por VARCHAR(100),
    alterado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cod_prof, data, cod_cliente)
  )
`).then(() => console.log('✅ Tabela garantido_status verificada'))
  .catch(err => console.log('Erro ao criar tabela garantido_status:', err.message));

// GET /api/bi/garantido - Análise de mínimo garantido
app.get('/api/bi/garantido', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, cod_prof, filtro_status } = req.query;
    
    console.log('📊 Garantido - Filtros recebidos:', { data_inicio, data_fim, cod_cliente, cod_prof, filtro_status });
    
    // 1. Buscar dados da planilha de garantido
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente (lida com campos entre aspas)
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) {
            lines.push(currentLine.replace(/\r/g, ''));
          }
          currentLine = '';
          // Pular \r\n como uma única quebra
          if (char === '\r' && text[i + 1] === '\n') {
            i++;
          }
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) {
        lines.push(currentLine.replace(/\r/g, ''));
      }
      
      return lines;
    };
    
    // Parsear CSV corretamente (lidar com campos multiline)
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1); // pular header
    
    console.log(`📊 Garantido: ${sheetLines.length} linhas na planilha (sem header)`);
    
    // Parsear dados da planilha
    const garantidoPlanilha = [];
    const chavesProcessadas = new Set();
    let valorTotalNaoRodouPlanilha = 0; // Para o card - soma dos status "Não rodou" da planilha
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      
      const cols = parseCSVLine(line);
      const codClientePlan = cols[0];
      const dataStr = cols[1];
      const profissional = cols[2] || '(Vazio)';
      const codProfPlan = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      const statusPlanilha = (cols[5] || '').trim().toLowerCase();
      
      // Aceitar linhas mesmo sem cod_prof (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      // Converter data DD/MM/YYYY para YYYY-MM-DD
      let dataFormatada = null;
      if (dataStr && dataStr.includes('/')) {
        const partes = dataStr.split('/');
        if (partes.length === 3) {
          dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
      }
      
      if (!dataFormatada) continue;
      
      // Aplicar filtros de data
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Verificar se é "Não rodou" para somar no card separado
      const isNaoRodou = statusPlanilha.includes('rodou') && (statusPlanilha.includes('não') || statusPlanilha.includes('nao'));
      if (isNaoRodou) {
        valorTotalNaoRodouPlanilha += valorNegociado;
      }
      
      // Chave única: cod_prof + data + cod_cliente (ou profissional se cod_prof vazio)
      const chaveUnica = `${codProfPlan || profissional}_${dataFormatada}_${codClientePlan}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      garantidoPlanilha.push({
        cod_cliente: codClientePlan,
        data: dataFormatada,
        profissional: profissional,
        cod_prof: codProfPlan,
        valor_negociado: valorNegociado
      });
    }
    
    console.log(`📊 Garantido: ${garantidoPlanilha.length} registros únicos na planilha`);
    if (garantidoPlanilha.length > 0) {
      console.log(`📊 Exemplo primeiro registro:`, garantidoPlanilha[0]);
    }
    
    // 2. Buscar nome do cliente da planilha (onde tem garantido)
    const clientesGarantido = {};
    try {
      const clientesResult = await pool.query(`
        SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
        FROM bi_entregas 
        WHERE cod_cliente IS NOT NULL
      `);
      clientesResult.rows.forEach(c => {
        clientesGarantido[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
      });
    } catch (e) {
      console.log('Erro ao buscar nomes de clientes:', e.message);
    }
    
    // 2.1 Buscar máscaras configuradas
    const mascaras = {};
    try {
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
      mascarasResult.rows.forEach(m => {
        mascaras[String(m.cod_cliente)] = m.mascara;
      });
    } catch (e) {
      console.log('Erro ao buscar máscaras:', e.message);
    }
    
    // 3. Para cada registro da planilha, buscar TODA produção do profissional no dia
    const resultados = [];
    
    for (const g of garantidoPlanilha) {
      // Aplicar filtros
      if (data_inicio && g.data < data_inicio) continue;
      if (data_fim && g.data > data_fim) continue;
      if (cod_cliente && g.cod_cliente !== cod_cliente) continue;
      if (cod_prof && g.cod_prof !== cod_prof) continue;
      
      // Buscar TODA produção do profissional nessa data (soma de TODOS os clientes/centros)
      // IMPORTANTE: valor_prof é por OS, não por ponto. Cada OS tem várias linhas com o mesmo valor_prof.
      // Precisamos somar apenas uma vez por OS (usar MAX para pegar o valor da OS).
      
      let prod = { total_os: 0, total_entregas: 0, distancia_total: 0, valor_produzido: 0, tempo_medio_entrega: null, locais_rodou: null, cod_cliente_rodou: null, centro_custo_rodou: null };
      
      // Se tem cod_prof, buscar produção
      if (g.cod_prof) {
        const codProfNum = parseInt(g.cod_prof);
        
        const producaoResult = await pool.query(`
        WITH os_dados AS (
          SELECT 
            os,
            MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
            MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END) as distancia_os,
            MAX(cod_cliente) as cod_cliente_os,
            MAX(centro_custo) as centro_custo_os,
            COUNT(*) FILTER (WHERE COALESCE(ponto, 1) >= 2) as entregas_os,
            AVG(CASE 
              WHEN COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL AND data_hora IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 
            END) as tempo_os
          FROM bi_entregas
          WHERE cod_prof = $1 AND data_solicitado::date = $2::date
          GROUP BY os
        )
        SELECT 
          COUNT(os) as total_os,
          COALESCE(SUM(entregas_os), 0) as total_entregas,
          COALESCE(SUM(distancia_os), 0) as distancia_total,
          COALESCE(SUM(valor_os), 0) as valor_produzido,
          AVG(tempo_os) as tempo_medio_entrega,
          STRING_AGG(DISTINCT cod_cliente_os::text, ', ') as cod_clientes_rodou,
          STRING_AGG(DISTINCT centro_custo_os, ', ') as centros_custo_rodou
        FROM os_dados
      `, [codProfNum, g.data]);
        
        prod = producaoResult.rows[0] || prod;
      }
      // Se não tem cod_prof, prod fica zerado (linha vazia/não rodou)
      
      const valorProduzido = parseFloat(prod?.valor_produzido) || 0;
      const totalEntregas = parseInt(prod?.total_entregas) || 0;
      const distanciaTotal = parseFloat(prod?.distancia_total) || 0;
      
      // Calcular complemento
      const complemento = Math.max(0, g.valor_negociado - valorProduzido);
      
      // Determinar status
      let status;
      if (totalEntregas === 0) {
        status = 'nao_rodou';
      } else if (valorProduzido < g.valor_negociado) {
        status = 'abaixo';
      } else {
        status = 'acima';
      }
      
      // Aplicar filtro de status
      if (filtro_status === 'nao_rodou' && status !== 'nao_rodou') continue;
      if (filtro_status === 'abaixo' && status !== 'abaixo') continue;
      if (filtro_status === 'acima' && status !== 'acima') continue;
      if (filtro_status === 'rodou' && status === 'nao_rodou') continue;
      
      // Formatar tempo de entrega
      let tempoEntregaFormatado = null;
      if (prod?.tempo_medio_entrega) {
        const minutos = Math.round(prod.tempo_medio_entrega);
        const horas = Math.floor(minutos / 60);
        const mins = minutos % 60;
        const segs = 0;
        tempoEntregaFormatado = `${String(horas).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(segs).padStart(2, '0')}`;
      }
      
      // "Onde Rodou" - Formato: cod_cliente + nome (com máscara) + centro de custo
      // Exceção: cliente 949 não mostra centro de custo
      let ondeRodou = '- NÃO RODOU';
      if (totalEntregas > 0 && prod?.cod_clientes_rodou) {
        const codClienteRodou = prod.cod_clientes_rodou.split(',')[0]?.trim(); // Pega o primeiro se houver vários
        const centroCusto = prod.centros_custo_rodou?.split(',')[0]?.trim() || '';
        
        // Buscar nome do cliente (máscara tem prioridade)
        const nomeCliente = mascaras[codClienteRodou] || clientesGarantido[codClienteRodou] || `Cliente ${codClienteRodou}`;
        
        // Cliente 949: apenas cod + nome
        // Outros clientes: cod + nome + centro de custo
        if (codClienteRodou === '949') {
          ondeRodou = `${codClienteRodou} - ${nomeCliente}`;
        } else {
          ondeRodou = centroCusto 
            ? `${codClienteRodou} - ${nomeCliente} / ${centroCusto}`
            : `${codClienteRodou} - ${nomeCliente}`;
        }
      }
      
      resultados.push({
        data: g.data,
        cod_prof: g.cod_prof,
        profissional: g.profissional,
        cod_cliente_garantido: g.cod_cliente,
        onde_rodou: ondeRodou,
        entregas: totalEntregas,
        tempo_entrega: tempoEntregaFormatado,
        distancia: distanciaTotal,
        valor_negociado: g.valor_negociado,
        valor_produzido: valorProduzido,
        complemento: complemento,
        status: status
      });
    }
    
    console.log(`📊 Garantido: ${resultados.length} resultados após filtros`);
    
    // Ordenar por data desc, depois por profissional
    resultados.sort((a, b) => {
      if (b.data !== a.data) return b.data.localeCompare(a.data);
      return a.profissional.localeCompare(b.profissional);
    });
    
    // Calcular totais
    const totais = {
      total_registros: resultados.length,
      total_entregas: resultados.reduce((sum, r) => sum + r.entregas, 0),
      total_negociado: resultados.reduce((sum, r) => sum + r.valor_negociado, 0),
      total_produzido: resultados.reduce((sum, r) => sum + r.valor_produzido, 0),
      total_complemento: resultados.reduce((sum, r) => sum + r.complemento, 0),
      total_distancia: resultados.reduce((sum, r) => sum + r.distancia, 0),
      qtd_abaixo: resultados.filter(r => r.status === 'abaixo').length,
      qtd_acima: resultados.filter(r => r.status === 'acima').length,
      qtd_nao_rodou: resultados.filter(r => r.status === 'nao_rodou').length,
      qtd_rodou: resultados.filter(r => r.status !== 'nao_rodou').length,
      // Valor total dos profissionais com status "Não rodou" NA PLANILHA
      valor_nao_rodou: valorTotalNaoRodouPlanilha
    };
    
    // Calcular tempo médio geral (formatado)
    const temposValidos = resultados.filter(r => r.tempo_entrega).map(r => {
      const [h, m, s] = r.tempo_entrega.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    });
    let tempoMedioGeral = null;
    if (temposValidos.length > 0) {
      const mediaSegs = temposValidos.reduce((a, b) => a + b, 0) / temposValidos.length;
      const h = Math.floor(mediaSegs / 3600);
      const m = Math.floor((mediaSegs % 3600) / 60);
      const s = Math.floor(mediaSegs % 60);
      tempoMedioGeral = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    totais.tempo_medio_geral = tempoMedioGeral;
    
    res.json({ dados: resultados, totais });
  } catch (error) {
    console.error('Erro ao buscar dados garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar dados de garantido', details: error.message });
  }
});

// GET /api/bi/garantido/semanal - Análise semanal por cliente do garantido
app.get('/api/bi/garantido/semanal', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    // Buscar dados da planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else { current += char; }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
          currentLine = '';
          if (char === '\r' && text[i + 1] === '\n') i++;
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
      return lines;
    };
    
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1);
    
    // Buscar nomes de clientes
    const clientesResult = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
      FROM bi_entregas WHERE cod_cliente IS NOT NULL
    `);
    const clientesNomes = {};
    clientesResult.rows.forEach(c => {
      clientesNomes[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
    });
    
    // Buscar máscaras configuradas
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Agrupar por cliente do garantido + semana
    const porClienteSemana = {};
    const chavesProcessadas = new Set();
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const codCliente = cols[0];
      const dataStr = cols[1];
      const codProf = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      
      // Aceitar linhas mesmo sem codProf (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      const partes = dataStr.split('/');
      if (partes.length !== 3) continue;
      const dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
      
      // Verificar duplicata
      const chaveUnica = `${codProf || cols[2] || 'vazio'}_${dataFormatada}_${codCliente}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Calcular início e fim da semana (segunda a domingo)
      const dataObj = new Date(dataFormatada + 'T12:00:00');
      const diaSemana = dataObj.getDay(); // 0 = domingo, 1 = segunda...
      
      // Calcular segunda-feira da semana
      const inicioSemana = new Date(dataObj);
      const offsetSegunda = diaSemana === 0 ? -6 : 1 - diaSemana; // Se domingo, volta 6 dias
      inicioSemana.setDate(dataObj.getDate() + offsetSegunda);
      
      // Calcular domingo da semana
      const fimSemana = new Date(inicioSemana);
      fimSemana.setDate(inicioSemana.getDate() + 6);
      
      // Formato da chave: "01 a 07/11"
      const diaInicio = inicioSemana.getDate().toString().padStart(2, '0');
      const diaFim = fimSemana.getDate().toString().padStart(2, '0');
      const mesFim = (fimSemana.getMonth() + 1).toString().padStart(2, '0');
      const semanaKey = `${diaInicio} a ${diaFim}/${mesFim}`;
      const semanaSort = inicioSemana.toISOString().split('T')[0]; // Para ordenação
      
      // Buscar produção TOTAL do profissional no dia
      // E também o centro de custo onde rodou (para cliente 767)
      let valorProduzido = 0;
      let centroCusto = null;
      
      if (codProf) {
        const producaoResult = await pool.query(`
          SELECT 
            COALESCE(SUM(valor_os), 0) as valor_produzido,
            MAX(centro_custo) as centro_custo
          FROM (
            SELECT 
              os, 
              MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
              MAX(centro_custo) as centro_custo
            FROM bi_entregas
            WHERE cod_prof = $1 AND data_solicitado::date = $2::date
            GROUP BY os
          ) os_dados
        `, [parseInt(codProf), dataFormatada]);
        valorProduzido = parseFloat(producaoResult.rows[0]?.valor_produzido) || 0;
        centroCusto = producaoResult.rows[0]?.centro_custo;
      }
      
      const complemento = Math.max(0, valorNegociado - valorProduzido);
      
      // Determinar a chave de agrupamento
      // Cliente 949: agrupa apenas pelo cliente (exceção)
      // Todos os outros: cod_cliente - nome_cliente (ou máscara) - centro_custo
      let clienteKey;
      const nomeCliente = mascaras[codCliente] || clientesNomes[codCliente] || `Cliente ${codCliente}`;
      
      if (codCliente === '949') {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      } else if (centroCusto) {
        clienteKey = `${codCliente} - ${nomeCliente} - ${centroCusto}`;
      } else {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      }
      
      if (!porClienteSemana[clienteKey]) {
        porClienteSemana[clienteKey] = {};
      }
      if (!porClienteSemana[clienteKey][semanaKey]) {
        porClienteSemana[clienteKey][semanaKey] = { negociado: 0, produzido: 0, complemento: 0, sort: semanaSort };
      }
      
      porClienteSemana[clienteKey][semanaKey].negociado += valorNegociado;
      porClienteSemana[clienteKey][semanaKey].produzido += valorProduzido;
      porClienteSemana[clienteKey][semanaKey].complemento += complemento;
    }
    
    // Formatar resultado - normalizar semanas para todos os clientes terem as mesmas
    const todasSemanas = new Map(); // Map para guardar semanaKey -> sort
    Object.values(porClienteSemana).forEach(semanas => {
      Object.entries(semanas).forEach(([semanaKey, dados]) => {
        if (!todasSemanas.has(semanaKey)) {
          todasSemanas.set(semanaKey, dados.sort);
        }
      });
    });
    
    // Ordenar semanas por data
    const semanasOrdenadas = Array.from(todasSemanas.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([key]) => key);
    
    // Formatar resultado garantindo que todos tenham todas as semanas
    const resultado = Object.entries(porClienteSemana).map(([cliente, semanas]) => ({
      onde_rodou: cliente,
      semanas: semanasOrdenadas.map(semanaKey => ({
        semana: semanaKey,
        negociado: semanas[semanaKey]?.negociado || 0,
        produzido: semanas[semanaKey]?.produzido || 0,
        complemento: semanas[semanaKey]?.complemento || 0
      }))
    })).sort((a, b) => a.onde_rodou.localeCompare(b.onde_rodou));
    
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao buscar análise semanal garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar análise semanal' });
  }
});

// GET /api/bi/garantido/por-cliente - Resumo por cliente do garantido
app.get('/api/bi/garantido/por-cliente', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    // Buscar dados da planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    let sheetText = await sheetResponse.text();
    
    // Função para parsear CSV corretamente
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) {
          result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
          current = '';
        } else { current += char; }
      }
      result.push(current.replace(/[\r\n]/g, '').replace(/^"|"$/g, '').trim());
      return result;
    };
    
    // Função para juntar linhas que foram quebradas por campos com aspas
    const parseCSVWithMultilineFields = (text) => {
      const lines = [];
      let currentLine = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
          inQuotes = !inQuotes;
          currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
          if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
          currentLine = '';
          if (char === '\r' && text[i + 1] === '\n') i++;
        } else if (char !== '\r') {
          currentLine += char;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.replace(/\r/g, ''));
      return lines;
    };
    
    const sheetLines = parseCSVWithMultilineFields(sheetText).slice(1);
    
    // Buscar nomes de clientes
    const clientesResult = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_fantasia, nome_cliente 
      FROM bi_entregas WHERE cod_cliente IS NOT NULL
    `);
    const clientesNomes = {};
    clientesResult.rows.forEach(c => {
      clientesNomes[c.cod_cliente] = c.nome_fantasia || c.nome_cliente || `Cliente ${c.cod_cliente}`;
    });
    
    // Buscar máscaras configuradas
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Agrupar por cliente do garantido
    const porCliente = {};
    const chavesProcessadas = new Set();
    
    for (const line of sheetLines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const codCliente = cols[0];
      const dataStr = cols[1];
      const codProf = cols[3] || '';
      const valorNegociado = parseFloat(cols[4]?.replace(',', '.')) || 0;
      const statusPlanilha = (cols[5] || '').trim().toLowerCase();
      
      // Na aba "Por Cliente" ignorar status "Não rodou" - mostrar apenas quem rodou
      if (statusPlanilha.includes('rodou') && (statusPlanilha.includes('não') || statusPlanilha.includes('nao'))) continue;
      
      // Aceitar linhas mesmo sem codProf (linhas vazias) - igual BI atual
      if (!dataStr || valorNegociado <= 0) continue;
      
      const partes = dataStr.split('/');
      if (partes.length !== 3) continue;
      const dataFormatada = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
      
      // Verificar duplicata
      const chaveUnica = `${codProf || cols[2] || 'vazio'}_${dataFormatada}_${codCliente}`;
      if (chavesProcessadas.has(chaveUnica)) continue;
      chavesProcessadas.add(chaveUnica);
      
      if (data_inicio && dataFormatada < data_inicio) continue;
      if (data_fim && dataFormatada > data_fim) continue;
      
      // Buscar produção TOTAL do profissional no dia
      // E também o centro de custo onde rodou (para cliente 767)
      let valorProduzido = 0;
      let centroCusto = null;
      
      if (codProf) {
        const producaoResult = await pool.query(`
          SELECT 
            COALESCE(SUM(valor_os), 0) as valor_produzido,
            MAX(centro_custo) as centro_custo
          FROM (
            SELECT 
              os, 
              MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os,
              MAX(centro_custo) as centro_custo
            FROM bi_entregas
            WHERE cod_prof = $1 AND data_solicitado::date = $2::date
            GROUP BY os
          ) os_dados
        `, [parseInt(codProf), dataFormatada]);
        valorProduzido = parseFloat(producaoResult.rows[0]?.valor_produzido) || 0;
        centroCusto = producaoResult.rows[0]?.centro_custo;
      }
      
      const complemento = Math.max(0, valorNegociado - valorProduzido);
      
      // Determinar a chave de agrupamento
      // Cliente 949: agrupa apenas pelo cliente (exceção)
      // Todos os outros: cod_cliente - nome_cliente (ou máscara) - centro_custo
      let clienteKey;
      const nomeCliente = mascaras[codCliente] || clientesNomes[codCliente] || `Cliente ${codCliente}`;
      
      if (codCliente === '949') {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      } else if (centroCusto) {
        clienteKey = `${codCliente} - ${nomeCliente} - ${centroCusto}`;
      } else {
        clienteKey = `${codCliente} - ${nomeCliente}`;
      }
      
      if (!porCliente[clienteKey]) {
        porCliente[clienteKey] = { negociado: 0, produzido: 0, complemento: 0 };
      }
      
      porCliente[clienteKey].negociado += valorNegociado;
      porCliente[clienteKey].produzido += valorProduzido;
      porCliente[clienteKey].complemento += complemento;
    }
    
    // Formatar e calcular totais
    const resultado = Object.entries(porCliente)
      .map(([cliente, valores]) => ({
        onde_rodou: cliente,
        ...valores
      }))
      .sort((a, b) => b.complemento - a.complemento);
    
    const totais = {
      total_negociado: resultado.reduce((sum, r) => sum + r.negociado, 0),
      total_produzido: resultado.reduce((sum, r) => sum + r.produzido, 0),
      total_complemento: resultado.reduce((sum, r) => sum + r.complemento, 0)
    };
    
    res.json({ dados: resultado, totais });
  } catch (error) {
    console.error('Erro ao buscar garantido por cliente:', error);
    res.status(500).json({ error: 'Erro ao buscar dados por cliente' });
  }
});

// GET /api/bi/garantido/meta - Retorna metadados do garantido (última data, etc)
app.get('/api/bi/garantido/meta', async (req, res) => {
  try {
    // Buscar última data disponível na tabela bi_entregas
    const result = await pool.query(`
      SELECT MAX(data_solicitado::date) as ultima_data,
             MIN(data_solicitado::date) as primeira_data
      FROM bi_entregas
    `);
    
    res.json({
      ultima_data: result.rows[0]?.ultima_data,
      primeira_data: result.rows[0]?.primeira_data
    });
  } catch (error) {
    console.error('Erro ao buscar meta garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar metadados' });
  }
});

// PUT /api/bi/garantido/status - Atualizar status de um registro de garantido
app.put('/api/bi/garantido/status', async (req, res) => {
  try {
    const { cod_prof, data, cod_cliente, status, motivo_reprovado, alterado_por } = req.body;
    
    if (!cod_prof || !data || !cod_cliente || !status) {
      return res.status(400).json({ error: 'Campos obrigatórios: cod_prof, data, cod_cliente, status' });
    }
    
    if (status === 'reprovado' && !motivo_reprovado) {
      return res.status(400).json({ error: 'Motivo é obrigatório quando status é reprovado' });
    }
    
    // Upsert - inserir ou atualizar
    const result = await pool.query(`
      INSERT INTO garantido_status (cod_prof, data, cod_cliente, status, motivo_reprovado, alterado_por, alterado_em)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (cod_prof, data, cod_cliente)
      DO UPDATE SET 
        status = $4,
        motivo_reprovado = $5,
        alterado_por = $6,
        alterado_em = CURRENT_TIMESTAMP
      RETURNING *
    `, [cod_prof, data, cod_cliente, status, status === 'reprovado' ? motivo_reprovado : null, alterado_por]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar status garantido:', error);
    res.status(500).json({ error: 'Erro ao atualizar status', details: error.message });
  }
});

// GET /api/bi/garantido/status - Buscar todos os status salvos
app.get('/api/bi/garantido/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cod_prof, data::text, cod_cliente, status, motivo_reprovado, alterado_por, alterado_em
      FROM garantido_status
    `);
    
    // Criar um mapa para fácil acesso: cod_prof_data_cod_cliente -> status
    const statusMap = {};
    result.rows.forEach(row => {
      const key = `${row.cod_prof}_${row.data}_${row.cod_cliente}`;
      statusMap[key] = row;
    });
    
    res.json(statusMap);
  } catch (error) {
    console.error('Erro ao buscar status garantido:', error);
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

// GET /api/recrutamento - Listar todas as necessidades
app.get('/api/recrutamento', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT n.*, 
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'titular'),
          0
        ) as motos_atribuidas,
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'backup'),
          0
        ) as backups_atribuidos
      FROM recrutamento_necessidades n
    `;
    
    const params = [];
    if (status) {
      params.push(status);
      query += ` WHERE n.status = $1`;
    }
    
    query += ` ORDER BY n.data_conclusao ASC, n.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    // Para cada necessidade, buscar as atribuições
    const necessidades = [];
    for (const nec of result.rows) {
      const atribuicoes = await pool.query(
        `SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 ORDER BY tipo, created_at`,
        [nec.id]
      );
      necessidades.push({
        ...nec,
        atribuicoes: atribuicoes.rows
      });
    }
    
    res.json(necessidades);
  } catch (error) {
    console.error('Erro ao listar recrutamento:', error);
    res.status(500).json({ error: 'Erro ao listar necessidades de recrutamento' });
  }
});

// POST /api/recrutamento - Criar nova necessidade
app.post('/api/recrutamento', async (req, res) => {
  try {
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por } = req.body;
    
    if (!nome_cliente || !data_conclusao || !quantidade_motos) {
      return res.status(400).json({ error: 'Nome do cliente, data de conclusão e quantidade de motos são obrigatórios' });
    }
    
    const result = await pool.query(
      `INSERT INTO recrutamento_necessidades 
        (nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup || 0, observacao || null, criado_por]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar necessidade:', error);
    res.status(500).json({ error: 'Erro ao criar necessidade de recrutamento' });
  }
});

// PUT /api/recrutamento/:id - Atualizar necessidade
app.put('/api/recrutamento/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status } = req.body;
    
    const result = await pool.query(
      `UPDATE recrutamento_necessidades 
       SET nome_cliente = COALESCE($1, nome_cliente),
           data_conclusao = COALESCE($2, data_conclusao),
           quantidade_motos = COALESCE($3, quantidade_motos),
           quantidade_backup = COALESCE($4, quantidade_backup),
           observacao = $5,
           status = COALESCE($6, status),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar necessidade:', error);
    res.status(500).json({ error: 'Erro ao atualizar necessidade' });
  }
});

// DELETE /api/recrutamento/:id - Deletar necessidade
app.delete('/api/recrutamento/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM recrutamento_necessidades WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Erro ao deletar necessidade:', error);
    res.status(500).json({ error: 'Erro ao deletar necessidade' });
  }
});

// POST /api/recrutamento/:id/atribuir - Atribuir moto a uma necessidade
app.post('/api/recrutamento/:id/atribuir', async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, tipo, atribuido_por } = req.body;
    
    if (!cod_profissional) {
      return res.status(400).json({ error: 'Código do profissional é obrigatório' });
    }
    
    // Verificar se a necessidade existe
    const necessidade = await pool.query(
      'SELECT * FROM recrutamento_necessidades WHERE id = $1',
      [id]
    );
    
    if (necessidade.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    // Verificar se já está atribuído nesta necessidade
    const jaAtribuido = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 AND cod_profissional = $2',
      [id, cod_profissional]
    );
    
    if (jaAtribuido.rows.length > 0) {
      return res.status(400).json({ error: 'Este profissional já está atribuído a esta necessidade' });
    }
    
    // Buscar nome do profissional na planilha do Google Sheets
    let nome_profissional = null;
    try {
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1);
      
      for (const line of lines) {
        const cols = line.split(',');
        if (cols[0]?.trim() === cod_profissional) {
          nome_profissional = cols[1]?.trim() || null;
          break;
        }
      }
    } catch (sheetErr) {
      console.log('Erro ao buscar na planilha, tentando fallback:', sheetErr.message);
    }
    
    // Fallback: buscar na tabela de disponibilidade se não achou na planilha
    if (!nome_profissional) {
      const profResult = await pool.query(
        `SELECT DISTINCT nome_profissional 
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod_profissional]
      );
      nome_profissional = profResult.rows[0]?.nome_profissional || null;
    }
    
    // Inserir atribuição
    const result = await pool.query(
      `INSERT INTO recrutamento_atribuicoes 
        (necessidade_id, tipo, cod_profissional, nome_profissional, atribuido_por)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, tipo || 'titular', cod_profissional, nome_profissional, atribuido_por]
    );
    
    // Verificar se a necessidade foi completada
    const atribuicoes = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE tipo = 'titular') as titulares,
        COUNT(*) FILTER (WHERE tipo = 'backup') as backups
       FROM recrutamento_atribuicoes 
       WHERE necessidade_id = $1`,
      [id]
    );
    
    const nec = necessidade.rows[0];
    const stats = atribuicoes.rows[0];
    
    // Se atingiu o total necessário, atualizar status para concluído
    if (parseInt(stats.titulares) >= nec.quantidade_motos && 
        parseInt(stats.backups) >= nec.quantidade_backup) {
      await pool.query(
        `UPDATE recrutamento_necessidades SET status = 'concluido', updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }
    
    res.json({ 
      atribuicao: result.rows[0],
      nome_profissional: nome_profissional
    });
  } catch (error) {
    console.error('Erro ao atribuir profissional:', error);
    res.status(500).json({ error: 'Erro ao atribuir profissional' });
  }
});

// DELETE /api/recrutamento/atribuicao/:id - Remover atribuição
app.delete('/api/recrutamento/atribuicao/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar a atribuição para saber qual necessidade
    const atribuicao = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE id = $1',
      [id]
    );
    
    if (atribuicao.rows.length === 0) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }
    
    const necessidadeId = atribuicao.rows[0].necessidade_id;
    
    // Deletar atribuição
    await pool.query('DELETE FROM recrutamento_atribuicoes WHERE id = $1', [id]);
    
    // Atualizar status da necessidade para em_andamento se estava concluída
    await pool.query(
      `UPDATE recrutamento_necessidades 
       SET status = 'em_andamento', updated_at = NOW() 
       WHERE id = $1 AND status = 'concluido'`,
      [necessidadeId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover atribuição:', error);
    res.status(500).json({ error: 'Erro ao remover atribuição' });
  }
});

// GET /api/recrutamento/buscar-profissional/:cod - Buscar profissional por código
app.get('/api/recrutamento/buscar-profissional/:cod', async (req, res) => {
  try {
    const { cod } = req.params;
    
    // Buscar na planilha do Google Sheets (mesma usada no módulo de disponibilidade)
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    let profissional = null;
    for (const line of lines) {
      const cols = line.split(',');
      const codigo = cols[0]?.trim();
      if (codigo === cod) {
        profissional = {
          cod_profissional: codigo,
          nome_profissional: cols[1]?.trim() || null,
          cidade: cols[3]?.trim() || null
        };
        break;
      }
    }
    
    if (!profissional) {
      // Fallback: tentar buscar na tabela de disponibilidade
      const dispResult = await pool.query(
        `SELECT DISTINCT cod_profissional, nome_profissional
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod]
      );
      
      if (dispResult.rows.length > 0) {
        return res.json(dispResult.rows[0]);
      }
      
      // Fallback 2: tentar buscar na tabela de usuários
      const userResult = await pool.query(
        'SELECT cod_profissional, full_name as nome_profissional FROM users WHERE cod_profissional = $1',
        [cod]
      );
      
      if (userResult.rows.length > 0) {
        return res.json(userResult.rows[0]);
      }
      
      return res.status(404).json({ error: 'Profissional não encontrado' });
    }
    
    res.json(profissional);
  } catch (error) {
    console.error('Erro ao buscar profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar profissional' });
  }
});

// GET /api/recrutamento/estatisticas - Estatísticas gerais de recrutamento
app.get('/api/recrutamento/estatisticas', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_necessidades,
        COUNT(*) FILTER (WHERE status = 'em_andamento') as em_andamento,
        COUNT(*) FILTER (WHERE status = 'concluido') as concluidas,
        COUNT(*) FILTER (WHERE status = 'cancelado') as canceladas,
        SUM(quantidade_motos) as total_motos_necessarias,
        SUM(quantidade_backup) as total_backups_necessarios,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'titular') as total_motos_atribuidas,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'backup') as total_backups_atribuidos
      FROM recrutamento_necessidades
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// ===== REGIÕES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regioes (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    clientes JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regioes já existe ou erro:', err.message));

// Listar regiões
app.get('/api/bi/regioes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regioes ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regiões:', err);
    res.json([]);
  }
});

// Criar região - Suporta novo formato com cliente + centro de custo
app.post('/api/bi/regioes', async (req, res) => {
  try {
    const { nome, clientes, itens } = req.body;
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      // Novo formato: array de {cod_cliente, centro_custo}
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      // Formato antigo: array de cod_cliente
      // Converte para novo formato (sem centro_custo especificado = todos)
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regioes (nome, clientes) 
      VALUES ($1, $2)
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar)]);
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar região:', err);
    res.status(500).json({ error: 'Erro ao salvar região' });
  }
});

// Atualizar região existente
app.put('/api/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    if (!itens || itens.length === 0) {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(itens), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// Excluir região
app.delete('/api/bi/regioes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regioes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir região:', err);
    res.status(500).json({ error: 'Erro ao excluir região' });
  }
});

// Atualizar região existente
app.put('/api/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, clientes, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// ===== CATEGORIAS (da planilha) =====
app.get('/api/bi/categorias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT categoria
      FROM bi_entregas
      WHERE categoria IS NOT NULL AND categoria != ''
      ORDER BY categoria
    `);
    res.json(result.rows.map(r => r.categoria));
  } catch (err) {
    console.error('❌ Erro ao listar categorias:', err);
    res.json([]);
  }
});

// ===== DADOS PARA FILTROS INTELIGENTES =====
app.get('/api/bi/dados-filtro', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_cliente, centro_custo, categoria
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar dados de filtro:', err);
    res.json([]);
  }
});

// ============================================
// MÓDULO OPERAÇÕES - Novas Operações
// ============================================

// GET - Listar todas as operações
app.get('/api/operacoes', async (req, res) => {
  try {
    const { status, regiao } = req.query;
    
    let query = `
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }
    
    if (regiao) {
      params.push(regiao);
      query += ` AND o.regiao = $${params.length}`;
    }
    
    query += ` ORDER BY o.criado_em DESC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar operações:', error);
    res.status(500).json({ error: 'Erro ao listar operações' });
  }
});

// GET - Buscar operação por ID
app.get('/api/operacoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const operacao = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [id]);
    
    if (operacao.rows.length === 0) {
      return res.status(404).json({ error: 'Operação não encontrada' });
    }
    
    res.json(operacao.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar operação:', error);
    res.status(500).json({ error: 'Erro ao buscar operação' });
  }
});

// POST - Criar nova operação
app.post('/api/operacoes', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      regiao,
      nome_cliente,
      endereco,
      modelo,
      quantidade_motos,
      obrigatoriedade_bau,
      possui_garantido,
      valor_garantido,
      data_inicio,
      observacoes,
      faixas_km,
      criado_por
    } = req.body;
    
    // Inserir operação
    const operacaoResult = await client.query(`
      INSERT INTO operacoes (
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, criado_por
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      regiao, nome_cliente, endereco, modelo, quantidade_motos || 1,
      obrigatoriedade_bau || false, possui_garantido || false, valor_garantido || 0,
      data_inicio, observacoes, criado_por
    ]);
    
    const operacaoId = operacaoResult.rows[0].id;
    
    // Inserir faixas de KM
    if (faixas_km && faixas_km.length > 0) {
      for (const faixa of faixas_km) {
        if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
          await client.query(`
            INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
            VALUES ($1, $2, $3, $4)
          `, [operacaoId, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Buscar operação completa
    const operacaoCompleta = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [operacaoId]);
    
    res.status(201).json(operacaoCompleta.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar operação:', error);
    res.status(500).json({ error: 'Erro ao criar operação' });
  } finally {
    client.release();
  }
});

// PUT - Atualizar operação
app.put('/api/operacoes/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      regiao,
      nome_cliente,
      endereco,
      modelo,
      quantidade_motos,
      obrigatoriedade_bau,
      possui_garantido,
      valor_garantido,
      data_inicio,
      observacoes,
      status,
      faixas_km
    } = req.body;
    
    // Atualizar operação
    await client.query(`
      UPDATE operacoes SET
        regiao = COALESCE($1, regiao),
        nome_cliente = COALESCE($2, nome_cliente),
        endereco = COALESCE($3, endereco),
        modelo = COALESCE($4, modelo),
        quantidade_motos = COALESCE($5, quantidade_motos),
        obrigatoriedade_bau = COALESCE($6, obrigatoriedade_bau),
        possui_garantido = COALESCE($7, possui_garantido),
        valor_garantido = COALESCE($8, valor_garantido),
        data_inicio = COALESCE($9, data_inicio),
        observacoes = COALESCE($10, observacoes),
        status = COALESCE($11, status),
        atualizado_em = NOW()
      WHERE id = $12
    `, [
      regiao, nome_cliente, endereco, modelo, quantidade_motos,
      obrigatoriedade_bau, possui_garantido, valor_garantido,
      data_inicio, observacoes, status, id
    ]);
    
    // Atualizar faixas de KM (deletar antigas e inserir novas)
    if (faixas_km) {
      await client.query('DELETE FROM operacoes_faixas_km WHERE operacao_id = $1', [id]);
      
      for (const faixa of faixas_km) {
        if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
          await client.query(`
            INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
            VALUES ($1, $2, $3, $4)
          `, [id, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Buscar operação atualizada
    const operacaoAtualizada = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [id]);
    
    res.json(operacaoAtualizada.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar operação:', error);
    res.status(500).json({ error: 'Erro ao atualizar operação' });
  } finally {
    client.release();
  }
});

// DELETE - Excluir operação
app.delete('/api/operacoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM operacoes WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Operação não encontrada' });
    }
    
    res.json({ message: 'Operação excluída com sucesso', operacao: result.rows[0] });
  } catch (error) {
    console.error('Erro ao excluir operação:', error);
    res.status(500).json({ error: 'Erro ao excluir operação' });
  }
});

// GET - Listar regiões das operações
app.get('/api/operacoes-regioes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT regiao FROM operacoes WHERE regiao IS NOT NULL ORDER BY regiao
    `);
    res.json(result.rows.map(r => r.regiao));
  } catch (error) {
    console.error('Erro ao listar regiões:', error);
    res.status(500).json({ error: 'Erro ao listar regiões' });
  }
});

// ============================================
// FIM MÓDULO OPERAÇÕES
// ============================================
// ============================================
// NOVOS ENDPOINTS BI - MAPA DE CALOR COM COORDENADAS REAIS
// Adicione isso ao final do seu server.js
// ============================================

// MIGRATION: Adicionar colunas de latitude e longitude na tabela bi_entregas
// Execute isso uma vez para adicionar as colunas
const migrateCoordenadas = async () => {
  try {
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_coords ON bi_entregas(latitude, longitude)`).catch(() => {});
    console.log('✅ Colunas latitude/longitude adicionadas na bi_entregas');
  } catch (err) {
    console.log('Colunas de coordenadas já existem ou erro:', err.message);
  }
};
migrateCoordenadas();

// GET - Mapa de Calor usando COORDENADAS REAIS do banco
app.get('/api/bi/mapa-calor', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria } = req.query;
    
    let whereClause = 'WHERE ponto >= 2'; // REGRA: apenas entregas (ponto >= 2), não conta coleta (ponto 1)
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    
    // BUSCAR PONTOS COM COORDENADAS REAIS DO BANCO (apenas ponto >= 2)
    // Agrupa por coordenadas aproximadas (arredonda para 3 casas decimais ~111m de precisão)
    const pontosQuery = await pool.query(`
      SELECT 
        ROUND(latitude::numeric, 3) as lat_group,
        ROUND(longitude::numeric, 3) as lng_group,
        AVG(latitude) as latitude,
        AVG(longitude) as longitude,
        COALESCE(bairro, 'N/A') as bairro,
        COALESCE(cidade, 'N/A') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      AND latitude IS NOT NULL 
      AND longitude IS NOT NULL
      AND latitude != 0 
      AND longitude != 0
      GROUP BY lat_group, lng_group, bairro, cidade
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por cidade (para o ranking lateral)
    const cidadesQuery = await pool.query(`
      SELECT 
        COALESCE(cidade, 'Não informado') as cidade,
        COALESCE(estado, 'GO') as estado,
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(valor), 0) as valor_total,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cidade, estado
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por bairro (top 50)
    const bairrosQuery = await pool.query(`
      SELECT 
        COALESCE(bairro, 'Não informado') as bairro,
        COALESCE(cidade, 'Não informado') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause}
      GROUP BY bairro, cidade
      ORDER BY total_entregas DESC
      LIMIT 50
    `, params);
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        COUNT(DISTINCT cidade) as total_cidades,
        COUNT(DISTINCT bairro) as total_bairros,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        SUM(CASE WHEN latitude IS NOT NULL AND latitude != 0 THEN 1 ELSE 0 END) as com_coordenadas
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Horários de pico (heatmap por hora)
    const horariosQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        EXTRACT(DOW FROM data_hora) as dia_semana,
        COUNT(*) as total
      FROM bi_entregas
      ${whereClause}
      AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora), EXTRACT(DOW FROM data_hora)
      ORDER BY dia_semana, hora
    `, params);
    
    // Converter pontos do banco para o formato do mapa
    const pontos = pontosQuery.rows.map(p => ({
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      bairro: p.bairro,
      cidade: p.cidade,
      count: parseInt(p.total_entregas),
      taxaPrazo: parseFloat(p.taxa_prazo) || 0,
      noPrazo: parseInt(p.no_prazo) || 0,
      foraPrazo: parseInt(p.fora_prazo) || 0,
      totalProfissionais: parseInt(p.total_profissionais) || 0
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lng) && p.lat !== 0 && p.lng !== 0);
    
    console.log(`🗺️ Mapa de calor: ${pontos.length} pontos com coordenadas reais`);
    
    res.json({
      totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
      totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
      totalPontos: pontos.length,
      totalCidades: parseInt(resumoQuery.rows[0]?.total_cidades) || 0,
      totalBairros: parseInt(resumoQuery.rows[0]?.total_bairros) || 0,
      totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
      taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
      comCoordenadas: parseInt(resumoQuery.rows[0]?.com_coordenadas) || 0,
      pontos: pontos,
      cidadesRanking: cidadesQuery.rows.slice(0, 15).map(c => ({
        cidade: c.cidade,
        estado: c.estado,
        total: parseInt(c.total_entregas),
        noPrazo: parseInt(c.no_prazo) || 0,
        foraPrazo: parseInt(c.fora_prazo) || 0,
        taxaPrazo: parseFloat(c.taxa_prazo) || 0,
        totalProfissionais: parseInt(c.total_profissionais) || 0
      })),
      bairrosRanking: bairrosQuery.rows.slice(0, 20).map(b => ({
        bairro: b.bairro,
        cidade: b.cidade,
        total: parseInt(b.total_entregas),
        noPrazo: parseInt(b.no_prazo) || 0,
        foraPrazo: parseInt(b.fora_prazo) || 0,
        taxaPrazo: parseFloat(b.taxa_prazo) || 0
      })),
      horariosHeatmap: horariosQuery.rows.map(h => ({
        hora: parseInt(h.hora),
        diaSemana: parseInt(h.dia_semana),
        total: parseInt(h.total)
      }))
    });
    
  } catch (error) {
    console.error('Erro mapa de calor:', error);
    res.status(500).json({ error: 'Erro ao gerar mapa de calor', details: error.message });
  }
});

// GET - Acompanhamento Periódico (evolução temporal)
app.get('/api/bi/acompanhamento-periodico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Dados por data
    // REGRA ALOCAÇÃO: Se solicitado após 17h E alocação no dia seguinte, início = 08:00 do dia da alocação
    const porDataQuery = await pool.query(`
      SELECT 
        data_solicitado,
        TO_CHAR(data_solicitado, 'DD/MM') as data_formatada,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_motoboy,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Calcular evolução semanal
    const porData = porDataQuery.rows.map((d, idx, arr) => {
      let evolucaoSemanal = null;
      if (idx >= 7) {
        const entregas7DiasAtras = arr[idx - 7]?.total_entregas;
        if (entregas7DiasAtras > 0) {
          evolucaoSemanal = ((d.total_entregas - entregas7DiasAtras) / entregas7DiasAtras * 100).toFixed(1);
        }
      }
      return {
        ...d,
        total_os: parseInt(d.total_os) || 0,
        total_entregas: parseInt(d.total_entregas) || 0,
        dentro_prazo: parseInt(d.dentro_prazo) || 0,
        fora_prazo: parseInt(d.fora_prazo) || 0,
        taxa_prazo: parseFloat(d.taxa_prazo) || 0,
        retornos: parseInt(d.retornos) || 0,
        valor_total: parseFloat(d.valor_total) || 0,
        valor_motoboy: parseFloat(d.valor_motoboy) || 0,
        ticket_medio: parseFloat(d.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(d.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(d.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(d.tempo_medio_coleta) || 0,
        total_entregadores: parseInt(d.total_entregadores) || 0,
        media_ent_profissional: parseFloat(d.media_ent_profissional) || 0,
        evolucao_semanal: evolucaoSemanal
      };
    });
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as total_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COALESCE(SUM(valor), 0) as valor_total,
        ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        COUNT(DISTINCT data_solicitado) as total_dias
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    res.json({
      porData: porData,
      resumo: {
        totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
        totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
        totalPrazo: parseInt(resumoQuery.rows[0]?.total_prazo) || 0,
        taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
        valorTotal: parseFloat(resumoQuery.rows[0]?.valor_total) || 0,
        tempoMedioGeral: parseFloat(resumoQuery.rows[0]?.tempo_medio_geral) || 0,
        totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
        totalDias: parseInt(resumoQuery.rows[0]?.total_dias) || 0
      }
    });
    
  } catch (error) {
    console.error('Erro acompanhamento periódico:', error);
    res.status(500).json({ error: 'Erro ao gerar acompanhamento', details: error.message });
  }
});

// GET - Comparativo Semanal para aba Acompanhamento
// Agrupa dados por semana e calcula variações entre semanas
app.get('/api/bi/comparativo-semanal', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    
    // Agrupa por semana do ano
    const semanalQuery = await pool.query(`
      SELECT 
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0)::numeric, 1) as km_total
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY ano DESC, semana DESC
    `, params);
    
    // Processar dados para calcular variações
    const semanas = semanalQuery.rows.map((row, idx, arr) => {
      const semanaAnterior = arr[idx + 1]; // próximo no array é a semana anterior (ordenado DESC)
      
      // Calcular variações percentuais
      const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return null;
        return ((atual - anterior) / anterior * 100).toFixed(1);
      };
      
      return {
        ano: parseInt(row.ano),
        semana: parseInt(row.semana),
        periodo: row.periodo,
        data_inicio_semana: row.data_inicio_semana,
        data_fim_semana: row.data_fim_semana,
        total_os: parseInt(row.total_os) || 0,
        total_entregas: parseInt(row.total_entregas) || 0,
        dentro_prazo: parseInt(row.dentro_prazo) || 0,
        fora_prazo: parseInt(row.fora_prazo) || 0,
        dentro_prazo_prof: parseInt(row.dentro_prazo_prof) || 0,
        fora_prazo_prof: parseInt(row.fora_prazo_prof) || 0,
        taxa_prazo: parseFloat(row.taxa_prazo) || 0,
        taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
        retornos: parseInt(row.retornos) || 0,
        valor_total: parseFloat(row.valor_total) || 0,
        valor_prof: parseFloat(row.valor_prof) || 0,
        ticket_medio: parseFloat(row.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
        tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
        total_entregadores: parseInt(row.total_entregadores) || 0,
        media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
        km_total: parseFloat(row.km_total) || 0,
        // Variações em relação à semana anterior
        var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
        var_os: calcVariacao(parseInt(row.total_os), semanaAnterior ? parseInt(semanaAnterior.total_os) : null),
        var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
        var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
        var_prazo_prof: semanaAnterior ? (parseFloat(row.taxa_prazo_prof) - parseFloat(semanaAnterior.taxa_prazo_prof)).toFixed(1) : null,
        var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null),
        // Dados da semana anterior para comparativo lado a lado
        anterior: semanaAnterior ? {
          total_entregas: parseInt(semanaAnterior.total_entregas) || 0,
          total_os: parseInt(semanaAnterior.total_os) || 0,
          taxa_prazo: parseFloat(semanaAnterior.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(semanaAnterior.taxa_prazo_prof) || 0,
          valor_total: parseFloat(semanaAnterior.valor_total) || 0,
          retornos: parseInt(semanaAnterior.retornos) || 0
        } : null
      };
    });
    
    // Resumo geral (todas as semanas)
    const totalSemanas = semanas.length;
    const mediaEntregasSemana = totalSemanas > 0 ? Math.round(semanas.reduce((a, s) => a + s.total_entregas, 0) / totalSemanas) : 0;
    const melhorSemana = semanas.reduce((best, s) => (!best || s.total_entregas > best.total_entregas) ? s : best, null);
    const piorSemana = semanas.reduce((worst, s) => (!worst || s.total_entregas < worst.total_entregas) ? s : worst, null);
    
    res.json({
      semanas: semanas,
      resumo: {
        total_semanas: totalSemanas,
        media_entregas_semana: mediaEntregasSemana,
        melhor_semana: melhorSemana ? { periodo: melhorSemana.periodo, entregas: melhorSemana.total_entregas } : null,
        pior_semana: piorSemana ? { periodo: piorSemana.periodo, entregas: piorSemana.total_entregas } : null
      }
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal', details: error.message });
  }
});

// GET - Comparativo semanal POR CLIENTE (detalhado)
app.get('/api/bi/comparativo-semanal-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    
    // Agrupa por nome_fantasia E semana do ano (como Power BI)
    const semanalQuery = await pool.query(`
      SELECT 
        nome_fantasia,
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia, EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY nome_fantasia, ano DESC, semana DESC
    `, params);
    
    // Agrupar por nome_fantasia (não por cod_cliente)
    const clientesMap = {};
    semanalQuery.rows.forEach(row => {
      const key = row.nome_fantasia;
      if (!clientesMap[key]) {
        clientesMap[key] = {
          nome_fantasia: row.nome_fantasia,
          semanas: []
        };
      }
      clientesMap[key].semanas.push(row);
    });
    
    // Processar dados para calcular variações por cliente
    const clientes = Object.values(clientesMap).map(cliente => {
      const semanas = cliente.semanas.map((row, idx, arr) => {
        const semanaAnterior = arr[idx + 1];
        
        const calcVariacao = (atual, anterior) => {
          if (!anterior || anterior === 0) return null;
          return ((atual - anterior) / anterior * 100).toFixed(1);
        };
        
        return {
          ano: parseInt(row.ano),
          semana: parseInt(row.semana),
          periodo: row.periodo,
          total_os: parseInt(row.total_os) || 0,
          total_entregas: parseInt(row.total_entregas) || 0,
          dentro_prazo: parseInt(row.dentro_prazo) || 0,
          fora_prazo: parseInt(row.fora_prazo) || 0,
          taxa_prazo: parseFloat(row.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
          retornos: parseInt(row.retornos) || 0,
          valor_total: parseFloat(row.valor_total) || 0,
          valor_prof: parseFloat(row.valor_prof) || 0,
          ticket_medio: parseFloat(row.ticket_medio) || 0,
          tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
          tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
          tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
          tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
          total_entregadores: parseInt(row.total_entregadores) || 0,
          media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
          var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
          var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
          var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
          var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null)
        };
      });
      
      // Calcular totais do cliente
      const totalEntregas = semanas.reduce((a, s) => a + s.total_entregas, 0);
      const mediaEntregas = semanas.length > 0 ? Math.round(totalEntregas / semanas.length) : 0;
      const mediaPrazo = semanas.length > 0 ? (semanas.reduce((a, s) => a + s.taxa_prazo, 0) / semanas.length).toFixed(1) : 0;
      
      return {
        nome_fantasia: cliente.nome_fantasia,
        semanas: semanas,
        resumo: {
          total_semanas: semanas.length,
          total_entregas: totalEntregas,
          media_entregas_semana: mediaEntregas,
          media_taxa_prazo: parseFloat(mediaPrazo)
        }
      };
    });
    
    // Ordenar por total de entregas (maiores primeiro)
    clientes.sort((a, b) => b.resumo.total_entregas - a.resumo.total_entregas);
    
    res.json({
      clientes: clientes,
      total_clientes: clientes.length
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal por cliente:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal por cliente', details: error.message });
  }
});

// GET - Dados agrupados por cliente para tabela de acompanhamento
// IMPORTANTE: Agrupa por NOME_FANTASIA (como o Power BI) e não por cod_cliente
// IMPORTANTE: Calcula média de tempo POR OS (não por linha/ponto)
// IMPORTANTE: Tempo de entrega usa Data Chegada + Hora Chegada (não Finalizado)
app.get('/api/bi/acompanhamento-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Não filtramos por Ponto aqui para incluir coletas (Ponto 1) e entregas (Ponto >= 2)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar dados agrupados por COD_CLIENTE - Média direta de todas as linhas (igual ao Dashboard)
    const clientesQuery = await pool.query(`
      SELECT 
        cod_cliente,
        MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente)) as nome_display,
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO: média direta de todas as linhas (Ponto = 1)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA: média direta de todas as linhas (Ponto = 1)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cod_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    // Calcular totais com média direta (igual ao Dashboard)
    const totaisQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Formatar tempo em HH:MM:SS
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    const clientes = clientesQuery.rows.map(c => ({
      cliente: c.nome_display,
      cod_cliente: parseInt(c.cod_cliente),
      os: parseInt(c.total_os) || 0,
      entregas: parseInt(c.total_entregas) || 0,
      entregasNoPrazo: parseInt(c.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(c.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(c.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(c.taxa_fora_prazo) || 0,
      retornos: parseInt(c.retornos) || 0,
      valorTotal: parseFloat(c.valor_total) || 0,
      valorProf: parseFloat(c.valor_prof) || 0,
      faturamentoTotal: parseFloat(c.faturamento_total) || 0,
      ticketMedio: parseFloat(c.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(c.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(c.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(c.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(c.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(c.total_entregas) || 0) / Math.max(parseInt(c.total_profissionais) || 1, 1)).toFixed(1),
      centros_custo: [] // Será preenchido abaixo
    }));
    
    // Buscar centros de custo por cliente
    const centrosCustoQuery = await pool.query(`
      WITH tempo_por_os AS (
        SELECT 
          os,
          cod_cliente,
          centro_custo,
          -- Métricas de ENTREGA (Ponto >= 2)
          MIN(CASE WHEN COALESCE(ponto, 1) >= 2 THEN dentro_prazo::int END) as dentro_prazo,
          MAX(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as eh_retorno,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END) as valor_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_prof_os,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas_os,
          AVG(
            CASE 
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND data_chegada IS NOT NULL 
                   AND hora_chegada IS NOT NULL
              THEN
                EXTRACT(EPOCH FROM (
                  (data_chegada + hora_chegada) - 
                  CASE 
                    WHEN DATE(data_chegada) <> DATE(data_hora)
                    THEN DATE(data_chegada) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND finalizado IS NOT NULL
                   AND finalizado >= data_hora
              THEN
                EXTRACT(EPOCH FROM (
                  finalizado - 
                  CASE 
                    WHEN DATE(finalizado) <> DATE(data_hora)
                    THEN DATE(finalizado) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              ELSE NULL
            END
          ) as tempo_entrega_min
        FROM bi_entregas
        ${whereClause}
        AND centro_custo IS NOT NULL AND centro_custo != ''
        GROUP BY os, cod_cliente, centro_custo
      )
      SELECT 
        cod_cliente,
        centro_custo,
        COUNT(DISTINCT os) as total_os,
        SUM(total_entregas_os) as total_entregas,
        SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_fora_prazo,
        SUM(eh_retorno) as retornos,
        COALESCE(SUM(valor_os), 0) as valor_total,
        COALESCE(SUM(valor_prof_os), 0) as valor_prof,
        ROUND(AVG(tempo_entrega_min), 2) as tempo_medio_entrega_min
      FROM tempo_por_os
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, total_entregas DESC
    `, params);
    
    // Mapear centros de custo para os clientes
    centrosCustoQuery.rows.forEach(cc => {
      const codCliente = parseInt(cc.cod_cliente);
      const cliente = clientes.find(c => c.cod_cliente === codCliente);
      if (cliente) {
        cliente.centros_custo.push({
          centro_custo: cc.centro_custo,
          total_os: parseInt(cc.total_os) || 0,
          total_entregas: parseInt(cc.total_entregas) || 0,
          dentro_prazo: parseInt(cc.entregas_no_prazo) || 0,
          fora_prazo: parseInt(cc.entregas_fora_prazo) || 0,
          taxa_no_prazo: parseFloat(cc.taxa_no_prazo) || 0,
          taxa_fora_prazo: parseFloat(cc.taxa_fora_prazo) || 0,
          retornos: parseInt(cc.retornos) || 0,
          valor_total: parseFloat(cc.valor_total) || 0,
          valor_prof: parseFloat(cc.valor_prof) || 0,
          tempo_medio: formatarTempo(parseFloat(cc.tempo_medio_entrega_min))
        });
      }
    });
    
    const totais = {
      os: parseInt(totaisQuery.rows[0]?.total_os) || 0,
      entregas: parseInt(totaisQuery.rows[0]?.total_entregas) || 0,
      entregasNoPrazo: parseInt(totaisQuery.rows[0]?.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(totaisQuery.rows[0]?.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(totaisQuery.rows[0]?.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(totaisQuery.rows[0]?.taxa_fora_prazo) || 0,
      retornos: parseInt(totaisQuery.rows[0]?.retornos) || 0,
      valorTotal: parseFloat(totaisQuery.rows[0]?.valor_total) || 0,
      valorProf: parseFloat(totaisQuery.rows[0]?.valor_prof) || 0,
      faturamentoTotal: parseFloat(totaisQuery.rows[0]?.faturamento_total) || 0,
      ticketMedio: parseFloat(totaisQuery.rows[0]?.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(totaisQuery.rows[0]?.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(totaisQuery.rows[0]?.total_entregas) || 0) / Math.max(parseInt(totaisQuery.rows[0]?.total_profissionais) || 1, 1)).toFixed(1)
    };
    
    res.json({ clientes, totais });
    
  } catch (error) {
    console.error('Erro acompanhamento clientes:', error);
    res.status(500).json({ error: 'Erro ao buscar dados de clientes', details: error.message });
  }
});

// ============================================
// ENDPOINT ESPECIAL: Cliente 767 com prazo de 120 minutos
// ============================================
app.get('/api/bi/cliente-767', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const PRAZO_767 = 120; // Prazo específico de 120 minutos para cliente 767
    
    // Primeiro, buscar todos os centros de custo disponíveis para o cliente 767
    const centrosCustoQuery = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE cod_cliente = 767 AND centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    const centrosCustoDisponiveis = centrosCustoQuery.rows.map(r => r.centro_custo);
    
    let whereClause = 'WHERE cod_cliente = 767';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Filtro por centro de custo (pode ser um ou vários separados por vírgula)
    const { centro_custo } = req.query;
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo IN (${centros.map((_, i) => `$${paramIndex + i}`).join(',')})`;
        params.push(...centros);
        paramIndex += centros.length;
      }
    }
    
    // Buscar dados do cliente 767
    const dadosQuery = await pool.query(`
      SELECT 
        os, 
        COALESCE(ponto, 1) as ponto, 
        cod_cliente, 
        nome_cliente,
        nome_fantasia,
        cod_prof, 
        nome_prof, 
        valor, 
        valor_prof, 
        distancia,
        ocorrencia, 
        centro_custo, 
        motivo, 
        finalizado,
        data_hora, 
        data_hora_alocado, 
        data_chegada, 
        hora_chegada,
        data_solicitado
      FROM bi_entregas 
      ${whereClause}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Cliente 767: Total registros:', dados.length);
    
    // Função para calcular tempo de entrega
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null;
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {}
      }
      
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Função para calcular tempo de coleta (Alocado -> Saída conforme DAX)
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {}
      }
      
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Função para calcular tempo de alocação
    const calcularTempoAlocacao = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora || !row.data_hora_alocado) return null;
      
      const solicitado = new Date(row.data_hora);
      const alocado = new Date(row.data_hora_alocado);
      
      if (alocado < solicitado) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem = solicitado;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      return difMinutos >= 0 ? difMinutos : null;
    };
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // Agrupar por OS
    const osPorOS = {};
    dados.forEach(row => {
      const os = row.os;
      if (!osPorOS[os]) osPorOS[os] = [];
      osPorOS[os].push(row);
    });
    
    // Calcular métricas com prazo de 120 minutos
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0;
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0;
    let somaTempoAlocacao = 0, countTempoAlocacao = 0;
    let somaTempoColeta = 0, countTempoColeta = 0;
    let profissionais = new Set();
    let totalRetornos = 0;
    
    // Dados por data para gráfico
    const porDataMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      totalOS.add(os);
      
      // Contagem de entregas (pontos >= 2)
      const entregasOS = linhasOS.filter(l => (parseInt(l.ponto) || 1) >= 2).length || 1;
      totalEntregas += entregasOS;
      
      linhasOS.forEach(row => {
        profissionais.add(row.cod_prof);
        
        const ocorrencia = (row.ocorrencia || '').toLowerCase();
        if (ocorrencia.includes('cliente fechado') || ocorrencia.includes('cliente ausente') || 
            ocorrencia.includes('loja fechada') || ocorrencia.includes('produto incorreto')) {
          totalRetornos++;
        }
        
        // Calcular tempos
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          somaTempoEntrega += tempoEnt;
          countTempoEntrega++;
          
          // Verificar prazo de 120 minutos
          if (tempoEnt <= PRAZO_767) {
            dentroPrazo++;
          } else {
            foraPrazo++;
          }
        }
        
        const tempoAloc = calcularTempoAlocacao(row);
        if (tempoAloc !== null) {
          somaTempoAlocacao += tempoAloc;
          countTempoAlocacao++;
        }
        
        const tempoCol = calcularTempoColeta(row);
        if (tempoCol !== null) {
          somaTempoColeta += tempoCol;
          countTempoColeta++;
        }
        
        // Agrupar por data
        const data = row.data_solicitado;
        if (data) {
          if (!porDataMap[data]) {
            porDataMap[data] = {
              data_solicitado: data,
              total_os: new Set(),
              total_entregas: 0,
              dentro_prazo: 0,
              fora_prazo: 0,
              soma_tempo_entrega: 0,
              count_tempo_entrega: 0,
              soma_tempo_alocacao: 0,
              count_tempo_alocacao: 0,
              soma_tempo_coleta: 0,
              count_tempo_coleta: 0,
              soma_valor: 0,
              soma_valor_prof: 0,
              retornos: 0,
              profissionais: new Set()
            };
          }
          porDataMap[data].total_os.add(os);
          porDataMap[data].profissionais.add(row.cod_prof);
          
          if ((parseInt(row.ponto) || 1) >= 2) {
            porDataMap[data].total_entregas++;
          }
          
          if (tempoEnt !== null) {
            porDataMap[data].soma_tempo_entrega += tempoEnt;
            porDataMap[data].count_tempo_entrega++;
            if (tempoEnt <= PRAZO_767) {
              porDataMap[data].dentro_prazo++;
            } else {
              porDataMap[data].fora_prazo++;
            }
          }
          
          if (tempoAloc !== null) {
            porDataMap[data].soma_tempo_alocacao += tempoAloc;
            porDataMap[data].count_tempo_alocacao++;
          }
          
          if (tempoCol !== null) {
            porDataMap[data].soma_tempo_coleta += tempoCol;
            porDataMap[data].count_tempo_coleta++;
          }
        }
      });
      
      // Valores (1x por OS)
      const linhaValor = linhasOS.reduce((maior, atual) => {
        return (parseInt(atual.ponto) || 0) > (parseInt(maior?.ponto) || 0) ? atual : maior;
      }, linhasOS[0]);
      
      somaValor += parseFloat(linhaValor?.valor) || 0;
      somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
      
      // Valor por data
      const data = linhaValor?.data_solicitado;
      if (data && porDataMap[data]) {
        porDataMap[data].soma_valor += parseFloat(linhaValor?.valor) || 0;
        porDataMap[data].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
      }
    });
    
    // Formatar dados por data
    const porData = Object.keys(porDataMap).sort().map(data => {
      const d = porDataMap[data];
      const totalEnt = d.total_entregas || 1;
      return {
        data_solicitado: data,
        data_formatada: new Date(data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total_os: d.total_os.size,
        total_entregas: d.total_entregas,
        dentro_prazo: d.dentro_prazo,
        fora_prazo: d.fora_prazo,
        taxa_prazo: d.count_tempo_entrega > 0 ? ((d.dentro_prazo / d.count_tempo_entrega) * 100).toFixed(1) : 0,
        tempo_medio_entrega: d.count_tempo_entrega > 0 ? formatarTempo(d.soma_tempo_entrega / d.count_tempo_entrega) : '00:00:00',
        tempo_medio_alocacao: d.count_tempo_alocacao > 0 ? formatarTempo(d.soma_tempo_alocacao / d.count_tempo_alocacao) : '00:00:00',
        tempo_medio_coleta: d.count_tempo_coleta > 0 ? formatarTempo(d.soma_tempo_coleta / d.count_tempo_coleta) : '00:00:00',
        valor_total: d.soma_valor,
        valor_motoboy: d.soma_valor_prof,
        ticket_medio: d.total_os.size > 0 ? (d.soma_valor / d.total_os.size).toFixed(2) : 0,
        total_entregadores: d.profissionais.size
      };
    });
    
    // =============================================
    // DADOS POR CENTRO DE CUSTO
    // =============================================
    const porCentroCustoMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      
      linhasOS.forEach(row => {
        const centroCusto = row.centro_custo || 'Sem Centro de Custo';
        
        if (!porCentroCustoMap[centroCusto]) {
          porCentroCustoMap[centroCusto] = {
            centro_custo: centroCusto,
            total_os: new Set(),
            total_entregas: 0,
            dentro_prazo: 0,
            fora_prazo: 0,
            count_tempo: 0
          };
        }
        
        porCentroCustoMap[centroCusto].total_os.add(os);
        
        if ((parseInt(row.ponto) || 1) >= 2) {
          porCentroCustoMap[centroCusto].total_entregas++;
        }
        
        // Calcular tempo de entrega para verificar prazo
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          porCentroCustoMap[centroCusto].count_tempo++;
          if (tempoEnt <= PRAZO_767) {
            porCentroCustoMap[centroCusto].dentro_prazo++;
          } else {
            porCentroCustoMap[centroCusto].fora_prazo++;
          }
        }
      });
    });
    
    // Formatar dados por centro de custo
    const porCentroCusto = Object.values(porCentroCustoMap).map(cc => ({
      centro_custo: cc.centro_custo,
      total_os: cc.total_os.size,
      total_entregas: cc.total_entregas,
      dentro_prazo: cc.dentro_prazo,
      fora_prazo: cc.fora_prazo,
      taxa_prazo: cc.count_tempo > 0 ? ((cc.dentro_prazo / cc.count_tempo) * 100).toFixed(1) : 0
    })).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // =============================================
    // CÁLCULO DE META MENSAL (95%)
    // =============================================
    const META_MENSAL = 95; // Meta de 95%
    
    // Usar sempre a data atual para o cálculo de dias restantes
    const hoje = new Date();
    const diaAtual = hoje.getDate();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    
    // Determinar o mês de referência (do filtro ou mês atual)
    let mesReferencia, anoReferencia;
    if (data_inicio) {
      const dataRef = new Date(data_inicio);
      mesReferencia = dataRef.getMonth();
      anoReferencia = dataRef.getFullYear();
    } else {
      mesReferencia = mesAtual;
      anoReferencia = anoAtual;
    }
    
    // Calcular dias do mês
    const ultimoDiaMes = new Date(anoReferencia, mesReferencia + 1, 0).getDate();
    
    // Dias passados baseado no dia atual do mês
    let diasPassados;
    const mesmoMesAno = (mesReferencia === mesAtual && anoReferencia === anoAtual);
    
    if (mesmoMesAno) {
      // Estamos no mês atual - usar o dia de hoje
      diasPassados = diaAtual;
    } else if (anoReferencia < anoAtual || (anoReferencia === anoAtual && mesReferencia < mesAtual)) {
      // Mês passado - todos os dias já passaram
      diasPassados = ultimoDiaMes;
    } else {
      // Mês futuro - nenhum dia passou
      diasPassados = 0;
    }
    
    // Dias restantes = total de dias do mês - dia atual
    const diasRestantes = Math.max(0, ultimoDiaMes - diasPassados);
    
    // Total de entregas e dentro do prazo até agora
    const totalEntregasAteAgora = countTempoEntrega;
    const dentroPrazoAteAgora = dentroPrazo;
    const taxaAtual = totalEntregasAteAgora > 0 ? (dentroPrazoAteAgora / totalEntregasAteAgora) * 100 : 0;
    
    // Estimar média de entregas por dia (baseado nos dias que tiveram entregas)
    const diasComDados = porData.length || 1;
    const mediaEntregasPorDia = diasComDados > 0 ? totalEntregasAteAgora / diasComDados : 0;
    const entregasEstimadasRestantes = Math.round(mediaEntregasPorDia * diasRestantes);
    const totalEntregasEstimadoMes = totalEntregasAteAgora + entregasEstimadasRestantes;
    
    // Calcular quantas entregas no prazo são necessárias para atingir 95%
    const entregasNoPrazoNecessariasMes = Math.ceil(totalEntregasEstimadoMes * (META_MENSAL / 100));
    const entregasNoPrazoFaltam = Math.max(0, entregasNoPrazoNecessariasMes - dentroPrazoAteAgora);
    
    // Calcular a taxa mínima necessária nos dias restantes
    let taxaMinimaRestante = 0;
    let metaAtingivel = true;
    let mensagemMeta = '';
    
    if (diasRestantes > 0 && entregasEstimadasRestantes > 0) {
      taxaMinimaRestante = (entregasNoPrazoFaltam / entregasEstimadasRestantes) * 100;
      
      if (taxaMinimaRestante > 100) {
        metaAtingivel = false;
        mensagemMeta = 'Meta de 95% não é mais atingível este mês';
      } else if (taxaMinimaRestante <= 0) {
        taxaMinimaRestante = 0;
        mensagemMeta = 'Meta de 95% já foi atingida!';
      } else {
        mensagemMeta = `Precisa de ${taxaMinimaRestante.toFixed(1)}% nos próximos ${diasRestantes} dias`;
      }
    } else if (diasRestantes === 0) {
      mensagemMeta = taxaAtual >= META_MENSAL ? 'Meta atingida!' : 'Mês encerrado - meta não atingida';
      metaAtingivel = taxaAtual >= META_MENSAL;
    }
    
    const indicadorMeta = {
      meta_mensal: META_MENSAL,
      mes_referencia: new Date(anoReferencia, mesReferencia, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      dia_atual: diaAtual,
      dias_mes: ultimoDiaMes,
      dias_passados: diasPassados,
      dias_restantes: diasRestantes,
      taxa_atual: parseFloat(taxaAtual.toFixed(1)),
      total_entregas_ate_agora: totalEntregasAteAgora,
      dentro_prazo_ate_agora: dentroPrazoAteAgora,
      media_entregas_dia: parseFloat(mediaEntregasPorDia.toFixed(1)),
      entregas_estimadas_restantes: entregasEstimadasRestantes,
      total_estimado_mes: totalEntregasEstimadoMes,
      entregas_no_prazo_necessarias: entregasNoPrazoNecessariasMes,
      entregas_no_prazo_faltam: entregasNoPrazoFaltam,
      taxa_minima_restante: parseFloat(taxaMinimaRestante.toFixed(1)),
      meta_atingivel: metaAtingivel,
      mensagem: mensagemMeta
    };
    
    // Métricas gerais
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      taxa_prazo: countTempoEntrega > 0 ? ((dentroPrazo / countTempoEntrega) * 100).toFixed(1) : 0,
      tempo_medio: countTempoEntrega > 0 ? formatarTempo(somaTempoEntrega / countTempoEntrega) : '00:00:00',
      tempo_medio_alocacao: countTempoAlocacao > 0 ? formatarTempo(somaTempoAlocacao / countTempoAlocacao) : '00:00:00',
      tempo_medio_coleta: countTempoColeta > 0 ? formatarTempo(somaTempoColeta / countTempoColeta) : '00:00:00',
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalOS.size > 0 ? (somaValor / totalOS.size).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      prazo_minutos: PRAZO_767
    };
    
    res.json({
      metricas,
      porData,
      porCentroCusto,
      indicadorMeta,
      centrosCustoDisponiveis,
      prazo: PRAZO_767,
      cliente: {
        cod_cliente: 767,
        nome: dados[0]?.nome_cliente || dados[0]?.nome_fantasia || 'Cliente 767'
      }
    });
    
  } catch (error) {
    console.error('Erro cliente 767:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do cliente 767', details: error.message });
  }
});
// =====================================================
// MÓDULO DE SCORE E GAMIFICAÇÃO - ENDPOINTS
// Adicionar no final do server.js, ANTES da última linha
// =====================================================

// Função para calcular pontos de uma OS
function calcularPontosOS(dentroPrazo, horaSolicitacao) {
  let pontoPrazo = 0;
  let pontoBonus = 0;
  let janelaBonus = null;
  let detalhes = [];

  // 1. Pontuação por prazo
  if (dentroPrazo === true) {
    pontoPrazo = 0.75;
    detalhes.push('No prazo (+0,75)');
  } else if (dentroPrazo === false) {
    pontoPrazo = -1.00;
    detalhes.push('Fora do prazo (-1,00)');
  }

  // 2. Bônus por janela de horário (apenas se entregou no prazo)
  if (dentroPrazo === true && horaSolicitacao) {
    const hora = typeof horaSolicitacao === 'string' 
      ? parseInt(horaSolicitacao.split(':')[0]) 
      : (horaSolicitacao instanceof Date ? horaSolicitacao.getHours() : null);
    
    if (hora !== null) {
      if (hora >= 10 && hora < 12) {
        pontoBonus = 0.50;
        janelaBonus = '10h-12h';
        detalhes.push('Bônus janela 10-12h (+0,50)');
      }
      else if (hora >= 16 && hora < 18) {
        pontoBonus = 0.75;
        janelaBonus = '16h-18h';
        detalhes.push('Bônus janela 16-18h (+0,75)');
      }
    }
  }

  return {
    ponto_prazo: pontoPrazo,
    ponto_bonus_janela: pontoBonus,
    ponto_total: pontoPrazo + pontoBonus,
    janela_bonus: janelaBonus,
    detalhamento: detalhes.join(' | ')
  };
}

// Função auxiliar para verificar conquistas
async function verificarConquistas(cod_prof) {
  try {
    const scoreResult = await pool.query('SELECT score_total FROM score_totais WHERE cod_prof = $1', [cod_prof]);
    if (scoreResult.rows.length === 0) return;
    
    const scoreAtual = parseFloat(scoreResult.rows[0].score_total) || 0;
    
    // PRIMEIRO: Remover conquistas que o profissional não deveria ter (score insuficiente)
    await pool.query(`
      DELETE FROM score_conquistas 
      WHERE cod_prof = $1 
      AND milestone_id IN (
        SELECT id FROM score_milestones WHERE pontos_necessarios > $2
      )
    `, [cod_prof, scoreAtual]);
    
    // DEPOIS: Adicionar conquistas que o profissional alcançou
    const milestonesDisponiveis = await pool.query(`
      SELECT m.* FROM score_milestones m
      WHERE m.ativo = true
      AND m.id NOT IN (SELECT milestone_id FROM score_conquistas WHERE cod_prof = $1)
      AND m.pontos_necessarios <= $2
      ORDER BY m.pontos_necessarios ASC
    `, [cod_prof, scoreAtual]);
    
    for (const milestone of milestonesDisponiveis.rows) {
      await pool.query(`
        INSERT INTO score_conquistas (cod_prof, milestone_id)
        VALUES ($1, $2) ON CONFLICT (cod_prof, milestone_id) DO NOTHING
      `, [cod_prof, milestone.id]);
    }
  } catch (error) {
    console.error('Erro ao verificar conquistas:', error);
  }
}

// POST /api/score/recalcular - Recalcula scores
app.post('/api/score/recalcular', async (req, res) => {
  try {
    const { cod_prof, data_inicio, data_fim } = req.body;
    
    // DATA MÍNIMA: Só contabiliza entregas a partir de 01/12/2025
    const DATA_MINIMA_SCORE = '2025-12-01';
    
    // Buscar entregas que têm dentro_prazo_prof calculado
    let whereClause = `WHERE COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof IS NOT NULL AND data_solicitado >= '${DATA_MINIMA_SCORE}'`;
    const params = [];
    let paramIndex = 1;
    
    if (cod_prof) {
      whereClause += ` AND cod_prof = $${paramIndex}`;
      params.push(cod_prof);
      paramIndex++;
    }
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Limpar histórico antigo antes de recalcular
    if (!cod_prof) {
      await pool.query(`DELETE FROM score_historico WHERE data_os < '${DATA_MINIMA_SCORE}'`);
      await pool.query(`TRUNCATE score_totais`);
      await pool.query(`TRUNCATE score_conquistas`); // Limpar conquistas para recalcular
    } else {
      await pool.query(`DELETE FROM score_historico WHERE cod_prof = $1 AND data_os < '${DATA_MINIMA_SCORE}'`, [cod_prof]);
    }
    
    // Adicionar coluna distancia se não existir
    await pool.query(`ALTER TABLE score_historico ADD COLUMN IF NOT EXISTS distancia_km DECIMAL(10,2)`).catch(() => {});
    
    const entregasQuery = await pool.query(`
      SELECT DISTINCT ON (os, cod_prof) os, cod_prof, nome_prof, data_solicitado, hora_solicitado,
        tempo_entrega_prof_minutos, prazo_prof_minutos, dentro_prazo_prof, distancia
      FROM bi_entregas ${whereClause}
      ORDER BY os, cod_prof, data_solicitado DESC
    `, params);
    
    let processadas = 0, erros = 0;
    
    for (const entrega of entregasQuery.rows) {
      try {
        // Usar dentro_prazo_prof diretamente do banco (já calculado)
        const dentroPrazo = entrega.dentro_prazo_prof;
        const tempoEntrega = parseFloat(entrega.tempo_entrega_prof_minutos) || 0;
        const prazoMinutos = parseFloat(entrega.prazo_prof_minutos) || 0;
        const distanciaKm = parseFloat(entrega.distancia) || 0;
        
        const pontos = calcularPontosOS(dentroPrazo, entrega.hora_solicitado);
        
        await pool.query(`
          INSERT INTO score_historico (cod_prof, nome_prof, os, data_os, hora_solicitacao,
            tempo_entrega_minutos, prazo_minutos, ponto_prazo, ponto_bonus_janela, ponto_total,
            dentro_prazo, janela_bonus, detalhamento, distancia_km)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (cod_prof, os) DO UPDATE SET
            nome_prof = EXCLUDED.nome_prof, data_os = EXCLUDED.data_os,
            hora_solicitacao = EXCLUDED.hora_solicitacao, tempo_entrega_minutos = EXCLUDED.tempo_entrega_minutos,
            prazo_minutos = EXCLUDED.prazo_minutos, ponto_prazo = EXCLUDED.ponto_prazo,
            ponto_bonus_janela = EXCLUDED.ponto_bonus_janela, ponto_total = EXCLUDED.ponto_total,
            dentro_prazo = EXCLUDED.dentro_prazo, janela_bonus = EXCLUDED.janela_bonus,
            detalhamento = EXCLUDED.detalhamento, distancia_km = EXCLUDED.distancia_km
        `, [entrega.cod_prof, entrega.nome_prof, entrega.os, entrega.data_solicitado,
            entrega.hora_solicitado, tempoEntrega, prazoMinutos,
            pontos.ponto_prazo, pontos.ponto_bonus_janela, pontos.ponto_total,
            dentroPrazo, pontos.janela_bonus, pontos.detalhamento, distanciaKm]);
        processadas++;
      } catch (err) {
        erros++;
        console.error('Erro ao processar OS:', entrega.os, err.message);
      }
    }
    
    // Atualizar totais
    const profissionais = cod_prof ? [{ cod_prof }] : (await pool.query('SELECT DISTINCT cod_prof FROM score_historico')).rows;
    
    for (const prof of profissionais) {
      await pool.query(`
        INSERT INTO score_totais (cod_prof, nome_prof, score_total, total_os, os_no_prazo, os_fora_prazo, bonus_janela_total)
        SELECT cod_prof, MAX(nome_prof), COALESCE(SUM(ponto_total), 0), COUNT(*),
          SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END),
          COALESCE(SUM(ponto_bonus_janela), 0)
        FROM score_historico WHERE cod_prof = $1 GROUP BY cod_prof
        ON CONFLICT (cod_prof) DO UPDATE SET
          nome_prof = EXCLUDED.nome_prof, score_total = EXCLUDED.score_total,
          total_os = EXCLUDED.total_os, os_no_prazo = EXCLUDED.os_no_prazo,
          os_fora_prazo = EXCLUDED.os_fora_prazo, bonus_janela_total = EXCLUDED.bonus_janela_total,
          ultimo_calculo = NOW(), updated_at = NOW()
      `, [prof.cod_prof]);
      await verificarConquistas(prof.cod_prof);
    }
    
    res.json({ success: true, message: `Score recalculado: ${processadas} OS processadas a partir de ${DATA_MINIMA_SCORE}, ${erros} erros`, processadas, erros, dataMinima: DATA_MINIMA_SCORE });
  } catch (error) {
    console.error('Erro ao recalcular score:', error);
    res.status(500).json({ error: 'Erro ao recalcular score', details: error.message });
  }
});

// GET /api/score/profissional/:cod_prof - Dados completos de um profissional
app.get('/api/score/profissional/:cod_prof', async (req, res) => {
  try {
    const { cod_prof } = req.params;
    const { data_inicio, data_fim, limite } = req.query;
    
    // Buscar totais
    const totaisResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
    let totais = totaisResult.rows[0] || { cod_prof: parseInt(cod_prof), nome_prof: null, score_total: 0, total_os: 0, os_no_prazo: 0, os_fora_prazo: 0, bonus_janela_total: 0 };
    
    if (!totais.nome_prof) {
      const nomeResult = await pool.query('SELECT DISTINCT nome_prof FROM bi_entregas WHERE cod_prof = $1 AND nome_prof IS NOT NULL LIMIT 1', [cod_prof]);
      if (nomeResult.rows.length > 0) totais.nome_prof = nomeResult.rows[0].nome_prof;
    }
    
    // Buscar extrato
    let extratoWhere = 'WHERE cod_prof = $1';
    const extratoParams = [cod_prof];
    let paramIndex = 2;
    
    if (data_inicio) { extratoWhere += ` AND data_os >= $${paramIndex}`; extratoParams.push(data_inicio); paramIndex++; }
    if (data_fim) { extratoWhere += ` AND data_os <= $${paramIndex}`; extratoParams.push(data_fim); paramIndex++; }
    
    const extratoResult = await pool.query(`
      SELECT os, data_os, hora_solicitacao, tempo_entrega_minutos, prazo_minutos,
        ponto_prazo, ponto_bonus_janela, ponto_total, dentro_prazo, janela_bonus, detalhamento, distancia_km
      FROM score_historico ${extratoWhere}
      ORDER BY data_os DESC, os DESC LIMIT ${parseInt(limite) || 100}
    `, extratoParams);
    
    // Buscar milestones com status de prêmios físicos
    const milestonesResult = await pool.query(`
      SELECT m.*, c.conquistado_em, 
             CASE WHEN c.id IS NOT NULL THEN true ELSE false END as conquistado,
             pf.status as premio_status,
             pf.confirmado_em as premio_confirmado_em,
             CASE WHEN pf.status = 'entregue' THEN true ELSE false END as premio_recebido
      FROM score_milestones m
      LEFT JOIN score_conquistas c ON m.id = c.milestone_id AND c.cod_prof = $1
      LEFT JOIN score_premios_fisicos pf ON m.id = pf.milestone_id AND pf.cod_prof = $1
      WHERE m.ativo = true ORDER BY m.ordem ASC
    `, [cod_prof]);
    
    // Calcular próximo milestone
    const scoreAtual = parseFloat(totais.score_total) || 0;
    const proximoMilestone = milestonesResult.rows.find(m => !m.conquistado);
    let progressoProximo = null;
    
    if (proximoMilestone) {
      const milestoneAnterior = milestonesResult.rows.filter(m => m.conquistado).sort((a, b) => b.pontos_necessarios - a.pontos_necessarios)[0];
      const pontoInicial = milestoneAnterior ? milestoneAnterior.pontos_necessarios : 0;
      const pontoFinal = proximoMilestone.pontos_necessarios;
      const progresso = ((scoreAtual - pontoInicial) / (pontoFinal - pontoInicial)) * 100;
      
      progressoProximo = {
        milestone: proximoMilestone,
        pontos_atuais: scoreAtual,
        pontos_faltam: Math.max(0, pontoFinal - scoreAtual),
        progresso_percentual: Math.min(100, Math.max(0, progresso))
      };
    }
    
    const taxaNoPrazo = totais.total_os > 0 ? ((totais.os_no_prazo / totais.total_os) * 100).toFixed(1) : 0;
    
    res.json({
      profissional: { cod_prof: parseInt(cod_prof), nome: totais.nome_prof || `Profissional ${cod_prof}` },
      score: {
        total: parseFloat(totais.score_total) || 0,
        total_os: parseInt(totais.total_os) || 0,
        os_no_prazo: parseInt(totais.os_no_prazo) || 0,
        os_fora_prazo: parseInt(totais.os_fora_prazo) || 0,
        bonus_janela_total: parseFloat(totais.bonus_janela_total) || 0,
        taxa_no_prazo: parseFloat(taxaNoPrazo)
      },
      extrato: extratoResult.rows,
      milestones: milestonesResult.rows,
      proximo_milestone: progressoProximo
    });
  } catch (error) {
    console.error('Erro ao buscar score do profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar score', details: error.message });
  }
});

// GET /api/score/ranking - Ranking geral
app.get('/api/score/ranking', async (req, res) => {
  try {
    const { limite, data_inicio, data_fim, ordem } = req.query;
    let query, params = [];
    
    if (data_inicio || data_fim) {
      let whereClause = 'WHERE 1=1';
      let paramIndex = 1;
      if (data_inicio) { whereClause += ` AND data_os >= $${paramIndex}`; params.push(data_inicio); paramIndex++; }
      if (data_fim) { whereClause += ` AND data_os <= $${paramIndex}`; params.push(data_fim); paramIndex++; }
      
      query = `SELECT cod_prof, MAX(nome_prof) as nome_prof, COALESCE(SUM(ponto_total), 0) as score_total,
        COUNT(*) as total_os, SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as os_no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as os_fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo
        FROM score_historico ${whereClause} GROUP BY cod_prof
        ORDER BY score_total ${ordem === 'asc' ? 'ASC' : 'DESC'} LIMIT $${paramIndex}`;
      params.push(parseInt(limite) || 10000);
    } else {
      query = `SELECT cod_prof, nome_prof, score_total, total_os, os_no_prazo, os_fora_prazo,
        ROUND(os_no_prazo::numeric / NULLIF(total_os, 0) * 100, 1) as taxa_prazo, ultimo_calculo
        FROM score_totais ORDER BY score_total ${ordem === 'asc' ? 'ASC' : 'DESC'} LIMIT $1`;
      params.push(parseInt(limite) || 10000);
    }
    
    const result = await pool.query(query, params);
    const ranking = result.rows.map((prof, index) => ({
      posicao: index + 1, cod_prof: prof.cod_prof, nome: prof.nome_prof || `Profissional ${prof.cod_prof}`,
      score_total: parseFloat(prof.score_total) || 0, total_os: parseInt(prof.total_os) || 0,
      os_no_prazo: parseInt(prof.os_no_prazo) || 0, os_fora_prazo: parseInt(prof.os_fora_prazo) || 0,
      taxa_prazo: parseFloat(prof.taxa_prazo) || 0
    }));
    
    res.json({ ranking, total_profissionais: ranking.length, filtros: { data_inicio, data_fim, limite, ordem } });
  } catch (error) {
    console.error('Erro ao buscar ranking:', error);
    res.status(500).json({ error: 'Erro ao buscar ranking', details: error.message });
  }
});

// GET /api/score/milestones - Listar milestones
app.get('/api/score/milestones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM score_milestones ORDER BY ordem ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar milestones' });
  }
});

// POST /api/score/milestones - Criar milestone
app.post('/api/score/milestones', async (req, res) => {
  try {
    const { nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem } = req.body;
    const result = await pool.query(`
      INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [nome, descricao, pontos_necessarios, icone || '🏆', cor || '#7c3aed', beneficio, ordem || 0]);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar milestone' });
  }
});

// PUT /api/score/milestones/:id - Atualizar milestone
app.put('/api/score/milestones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, pontos_necessarios, icone, cor, beneficio, ativo, ordem } = req.body;
    const result = await pool.query(`
      UPDATE score_milestones SET nome = COALESCE($1, nome), descricao = COALESCE($2, descricao),
        pontos_necessarios = COALESCE($3, pontos_necessarios), icone = COALESCE($4, icone),
        cor = COALESCE($5, cor), beneficio = COALESCE($6, beneficio), ativo = COALESCE($7, ativo),
        ordem = COALESCE($8, ordem) WHERE id = $9 RETURNING *
    `, [nome, descricao, pontos_necessarios, icone, cor, beneficio, ativo, ordem, id]);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar milestone' });
  }
});

// DELETE /api/score/milestones/:id - Deletar milestone
app.delete('/api/score/milestones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM score_conquistas WHERE milestone_id = $1', [id]);
    await pool.query('DELETE FROM score_milestones WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar milestone' });
  }
});

// POST /api/score/milestones/reset - Resetar milestones para os valores padrão
app.post('/api/score/milestones/reset', async (req, res) => {
  try {
    // Limpar conquistas e milestones existentes
    await pool.query('TRUNCATE score_conquistas');
    await pool.query('TRUNCATE score_milestones RESTART IDENTITY CASCADE');
    
    // Inserir novos milestones
    await pool.query(`
      INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem) VALUES
      ('Bronze', '2 saques gratuitos de R$500/mês', 80, '🥉', '#cd7f32', '2 saques gratuitos de R$500 por mês', 1),
      ('Prata', '+2 saques gratuitos/mês (total: 4)', 100, '🥈', '#c0c0c0', '+2 saques gratuitos de R$500 por mês (total: 4)', 2),
      ('Ouro', '1 Camisa Tutts', 250, '🥇', '#ffd700', '1 Camisa Tutts (Retirada única)', 3),
      ('Platina', '1 Óleo de motor', 300, '💎', '#e5e4e2', '1 Óleo de motor (Retirada única)', 4),
      ('Diamante', 'Sorteio Vale Combustível', 500, '👑', '#b9f2ff', 'Participação em sorteio de Vale Combustível R$100 por mês', 5)
    `);
    
    // Recalcular conquistas de todos os profissionais
    const profissionais = await pool.query('SELECT DISTINCT cod_prof FROM score_totais');
    for (const prof of profissionais.rows) {
      const scoreResult = await pool.query('SELECT score_total FROM score_totais WHERE cod_prof = $1', [prof.cod_prof]);
      if (scoreResult.rows.length > 0) {
        const scoreAtual = parseFloat(scoreResult.rows[0].score_total) || 0;
        const milestonesAlcancados = await pool.query(
          'SELECT id FROM score_milestones WHERE pontos_necessarios <= $1',
          [scoreAtual]
        );
        for (const m of milestonesAlcancados.rows) {
          await pool.query(
            'INSERT INTO score_conquistas (cod_prof, milestone_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [prof.cod_prof, m.id]
          );
        }
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Milestones resetados com sucesso!',
      milestones: [
        { pontos: 80, premio: '2 saques gratuitos de R$500/mês' },
        { pontos: 100, premio: '+2 saques gratuitos/mês (total: 4)' },
        { pontos: 250, premio: '1 Camisa Tutts' },
        { pontos: 300, premio: '1 Óleo de motor' },
        { pontos: 500, premio: 'Sorteio Vale Combustível R$100/mês' }
      ]
    });
  } catch (error) {
    console.error('Erro ao resetar milestones:', error);
    res.status(500).json({ error: 'Erro ao resetar milestones', details: error.message });
  }
});

// POST /api/score/aplicar-gratuidades - Aplica gratuidades do mês baseado no score
app.post('/api/score/aplicar-gratuidades', async (req, res) => {
  try {
    const mesReferencia = req.body.mes || new Date().toISOString().slice(0, 7); // YYYY-MM
    console.log(`🎁 Aplicando gratuidades do Score para ${mesReferencia}...`);
    
    // Buscar todos os profissionais com score
    const profissionais = await pool.query(`
      SELECT cod_prof, nome_prof, score_total 
      FROM score_totais 
      WHERE score_total >= 80
      ORDER BY score_total DESC
    `);
    
    let aplicados = 0, atualizados = 0, erros = 0;
    const detalhes = [];
    
    for (const prof of profissionais.rows) {
      try {
        const score = parseFloat(prof.score_total) || 0;
        let quantidadeSaques = 0;
        let nivel = null;
        
        // Determinar quantidade de saques baseado no score
        if (score >= 100) {
          quantidadeSaques = 4; // Bronze (2) + Prata (+2) = 4
          nivel = 'Prata';
        } else if (score >= 80) {
          quantidadeSaques = 2; // Bronze = 2
          nivel = 'Bronze';
        }
        
        if (quantidadeSaques === 0) continue;
        
        // Verificar se já tem gratuidade neste mês
        const existente = await pool.query(
          'SELECT * FROM score_gratuidades WHERE cod_prof = $1 AND mes_referencia = $2',
          [prof.cod_prof, mesReferencia]
        );
        
        if (existente.rows.length > 0) {
          // Já existe - verificar se precisa atualizar
          const atual = existente.rows[0];
          if (atual.quantidade_saques !== quantidadeSaques) {
            // Atualizar gratuidade existente
            const diferenca = quantidadeSaques - atual.quantidade_saques;
            
            if (diferenca > 0 && atual.gratuidade_id) {
              // Aumentar quantidade na gratuidade
              await pool.query(
                'UPDATE gratuities SET quantity = quantity + $1, remaining = remaining + $1 WHERE id = $2',
                [diferenca, atual.gratuidade_id]
              );
            }
            
            await pool.query(
              'UPDATE score_gratuidades SET quantidade_saques = $1, nivel = $2, score_no_momento = $3 WHERE id = $4',
              [quantidadeSaques, nivel, score, atual.id]
            );
            atualizados++;
            detalhes.push({ cod_prof: prof.cod_prof, nome: prof.nome_prof, acao: 'atualizado', saques: quantidadeSaques });
          }
        } else {
          // Criar nova gratuidade
          const gratuidade = await pool.query(`
            INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
            VALUES ($1, $2, $3, $3, 500.00, $4, 'ativa', 'Sistema Score')
            RETURNING id
          `, [prof.cod_prof, prof.nome_prof, quantidadeSaques, `Score ${nivel} - ${mesReferencia}`]);
          
          // Registrar na tabela de controle
          await pool.query(`
            INSERT INTO score_gratuidades (cod_prof, nome_prof, mes_referencia, score_no_momento, nivel, quantidade_saques, gratuidade_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [prof.cod_prof, prof.nome_prof, mesReferencia, score, nivel, quantidadeSaques, gratuidade.rows[0].id]);
          
          aplicados++;
          detalhes.push({ cod_prof: prof.cod_prof, nome: prof.nome_prof, acao: 'criado', saques: quantidadeSaques });
        }
      } catch (err) {
        erros++;
        console.error(`Erro ao aplicar gratuidade para ${prof.cod_prof}:`, err.message);
      }
    }
    
    console.log(`✅ Gratuidades aplicadas: ${aplicados} novos, ${atualizados} atualizados, ${erros} erros`);
    
    res.json({
      success: true,
      mes_referencia: mesReferencia,
      resumo: {
        novos: aplicados,
        atualizados: atualizados,
        erros: erros,
        total_processados: profissionais.rows.length
      },
      detalhes: detalhes.slice(0, 20) // Limitar a 20 para não sobrecarregar
    });
  } catch (error) {
    console.error('Erro ao aplicar gratuidades:', error);
    res.status(500).json({ error: 'Erro ao aplicar gratuidades', details: error.message });
  }
});

// GET /api/score/gratuidades - Listar gratuidades do score
app.get('/api/score/gratuidades', async (req, res) => {
  try {
    const { mes, cod_prof } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (mes) { whereClause += ` AND mes_referencia = $${paramIndex}`; params.push(mes); paramIndex++; }
    if (cod_prof) { whereClause += ` AND cod_prof = $${paramIndex}`; params.push(cod_prof); paramIndex++; }
    
    const result = await pool.query(`
      SELECT sg.*, g.remaining as saques_restantes, g.status as gratuidade_status
      FROM score_gratuidades sg
      LEFT JOIN gratuities g ON sg.gratuidade_id = g.id
      ${whereClause}
      ORDER BY sg.created_at DESC
      LIMIT 100
    `, params);
    
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar gratuidades do score' });
  }
});

// POST /api/score/resetar-gratuidades-mes - Resetar e reaplicar gratuidades do mês
app.post('/api/score/resetar-gratuidades-mes', async (req, res) => {
  try {
    const mesReferencia = req.body.mes || new Date().toISOString().slice(0, 7);
    console.log(`🔄 Resetando gratuidades do Score para ${mesReferencia}...`);
    
    // Buscar gratuidades do mês
    const gratuidadesDoMes = await pool.query(
      'SELECT * FROM score_gratuidades WHERE mes_referencia = $1',
      [mesReferencia]
    );
    
    // Deletar gratuidades antigas
    for (const sg of gratuidadesDoMes.rows) {
      if (sg.gratuidade_id) {
        await pool.query('DELETE FROM gratuities WHERE id = $1', [sg.gratuidade_id]);
      }
    }
    await pool.query('DELETE FROM score_gratuidades WHERE mes_referencia = $1', [mesReferencia]);
    
    console.log(`🗑️ ${gratuidadesDoMes.rows.length} gratuidades removidas`);
    
    // Reaplicar gratuidades chamando o endpoint
    const response = await new Promise((resolve) => {
      const mockReq = { body: { mes: mesReferencia } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (data) => resolve(data) })
      };
      // Simular chamada interna
      resolve({ precisaReaplicar: true });
    });
    
    // Reaplicar manualmente
    const profissionais = await pool.query(`
      SELECT cod_prof, nome_prof, score_total 
      FROM score_totais 
      WHERE score_total >= 80
    `);
    
    let aplicados = 0;
    for (const prof of profissionais.rows) {
      const score = parseFloat(prof.score_total) || 0;
      let quantidadeSaques = 0;
      let nivel = null;
      
      if (score >= 100) {
        quantidadeSaques = 4;
        nivel = 'Prata';
      } else if (score >= 80) {
        quantidadeSaques = 2;
        nivel = 'Bronze';
      }
      
      if (quantidadeSaques > 0) {
        const gratuidade = await pool.query(`
          INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
          VALUES ($1, $2, $3, $3, 500.00, $4, 'ativa', 'Sistema Score')
          RETURNING id
        `, [prof.cod_prof, prof.nome_prof, quantidadeSaques, `Score ${nivel} - ${mesReferencia}`]);
        
        await pool.query(`
          INSERT INTO score_gratuidades (cod_prof, nome_prof, mes_referencia, score_no_momento, nivel, quantidade_saques, gratuidade_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [prof.cod_prof, prof.nome_prof, mesReferencia, score, nivel, quantidadeSaques, gratuidade.rows[0].id]);
        
        aplicados++;
      }
    }
    
    res.json({
      success: true,
      mes_referencia: mesReferencia,
      removidos: gratuidadesDoMes.rows.length,
      reaplicados: aplicados
    });
  } catch (error) {
    console.error('Erro ao resetar gratuidades:', error);
    res.status(500).json({ error: 'Erro ao resetar gratuidades', details: error.message });
  }
});

// ==================== PRÊMIOS FÍSICOS (Camisa, Óleo) ====================

// GET /api/score/premios-fisicos - Listar prêmios físicos pendentes e entregues
app.get('/api/score/premios-fisicos', async (req, res) => {
  try {
    const { status, cod_prof } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (status) { whereClause += ` AND pf.status = $${paramIndex}`; params.push(status); paramIndex++; }
    if (cod_prof) { whereClause += ` AND pf.cod_prof = $${paramIndex}`; params.push(cod_prof); paramIndex++; }
    
    const result = await pool.query(`
      SELECT pf.*, m.nome as milestone_nome, m.icone as milestone_icone, m.pontos_necessarios,
             st.score_total
      FROM score_premios_fisicos pf
      JOIN score_milestones m ON pf.milestone_id = m.id
      LEFT JOIN score_totais st ON pf.cod_prof = st.cod_prof
      ${whereClause}
      ORDER BY pf.status ASC, pf.created_at DESC
    `, params);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar prêmios físicos:', error);
    res.status(500).json({ error: 'Erro ao listar prêmios físicos' });
  }
});

// GET /api/score/premios-pendentes - Dashboard de prêmios pendentes para admin
app.get('/api/score/premios-pendentes', async (req, res) => {
  try {
    // Buscar todos que alcançaram milestones de prêmios físicos (Ouro=250, Platina=300)
    const result = await pool.query(`
      SELECT 
        st.cod_prof, st.nome_prof, st.score_total,
        m.id as milestone_id, m.nome as milestone_nome, m.icone, m.pontos_necessarios, m.beneficio,
        pf.id as premio_id, pf.status as premio_status, pf.confirmado_em, pf.confirmado_por
      FROM score_totais st
      JOIN score_milestones m ON st.score_total >= m.pontos_necessarios
      LEFT JOIN score_premios_fisicos pf ON st.cod_prof = pf.cod_prof AND m.id = pf.milestone_id
      WHERE m.pontos_necessarios IN (250, 300)
      ORDER BY st.score_total DESC, m.pontos_necessarios ASC
    `);
    
    // Agrupar por profissional
    const porProfissional = {};
    for (const row of result.rows) {
      if (!porProfissional[row.cod_prof]) {
        porProfissional[row.cod_prof] = {
          cod_prof: row.cod_prof,
          nome_prof: row.nome_prof,
          score_total: parseFloat(row.score_total),
          premios: []
        };
      }
      porProfissional[row.cod_prof].premios.push({
        milestone_id: row.milestone_id,
        milestone_nome: row.milestone_nome,
        icone: row.icone,
        pontos_necessarios: row.pontos_necessarios,
        beneficio: row.beneficio,
        premio_id: row.premio_id,
        status: row.premio_status || 'disponivel',
        confirmado_em: row.confirmado_em,
        confirmado_por: row.confirmado_por
      });
    }
    
    res.json(Object.values(porProfissional));
  } catch (error) {
    console.error('Erro ao listar prêmios pendentes:', error);
    res.status(500).json({ error: 'Erro ao listar prêmios pendentes' });
  }
});

// POST /api/score/premios-fisicos/confirmar - Admin confirma entrega do prêmio
app.post('/api/score/premios-fisicos/confirmar', async (req, res) => {
  try {
    const { cod_prof, milestone_id, confirmado_por, observacao } = req.body;
    
    if (!cod_prof || !milestone_id) {
      return res.status(400).json({ error: 'cod_prof e milestone_id são obrigatórios' });
    }
    
    // Verificar se o profissional realmente alcançou esse milestone
    const scoreResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
    if (scoreResult.rows.length === 0) {
      return res.status(400).json({ error: 'Profissional não encontrado' });
    }
    
    const milestoneResult = await pool.query('SELECT * FROM score_milestones WHERE id = $1', [milestone_id]);
    if (milestoneResult.rows.length === 0) {
      return res.status(400).json({ error: 'Milestone não encontrado' });
    }
    
    const score = parseFloat(scoreResult.rows[0].score_total);
    const pontosNecessarios = milestoneResult.rows[0].pontos_necessarios;
    
    if (score < pontosNecessarios) {
      return res.status(400).json({ error: 'Profissional não atingiu pontuação necessária' });
    }
    
    // Inserir ou atualizar registro de prêmio
    const result = await pool.query(`
      INSERT INTO score_premios_fisicos (cod_prof, nome_prof, milestone_id, tipo_premio, status, confirmado_por, confirmado_em, observacao)
      VALUES ($1, $2, $3, $4, 'entregue', $5, NOW(), $6)
      ON CONFLICT (cod_prof, milestone_id) DO UPDATE SET
        status = 'entregue',
        confirmado_por = $5,
        confirmado_em = NOW(),
        observacao = $6
      RETURNING *
    `, [cod_prof, scoreResult.rows[0].nome_prof, milestone_id, milestoneResult.rows[0].beneficio, confirmado_por || 'Admin', observacao]);
    
    res.json({ 
      success: true, 
      message: 'Prêmio confirmado com sucesso!',
      premio: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao confirmar prêmio:', error);
    res.status(500).json({ error: 'Erro ao confirmar prêmio', details: error.message });
  }
});

// GET /api/score/profissional/:cod_prof/premios - Prêmios do profissional (para tela do usuário)
app.get('/api/score/profissional/:cod_prof/premios', async (req, res) => {
  try {
    const { cod_prof } = req.params;
    
    // Buscar score do profissional
    const scoreResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
    const score = scoreResult.rows.length > 0 ? parseFloat(scoreResult.rows[0].score_total) : 0;
    
    // Buscar todos os milestones com status de prêmios físicos
    const milestones = await pool.query(`
      SELECT m.*, 
             c.conquistado_em,
             CASE WHEN c.id IS NOT NULL THEN true ELSE false END as conquistado,
             pf.status as premio_status,
             pf.confirmado_em as premio_confirmado_em
      FROM score_milestones m
      LEFT JOIN score_conquistas c ON m.id = c.milestone_id AND c.cod_prof = $1
      LEFT JOIN score_premios_fisicos pf ON m.id = pf.milestone_id AND pf.cod_prof = $1
      WHERE m.ativo = true
      ORDER BY m.ordem ASC
    `, [cod_prof]);
    
    res.json({
      score_atual: score,
      milestones: milestones.rows.map(m => ({
        ...m,
        premio_fisico: m.pontos_necessarios === 250 || m.pontos_necessarios === 300,
        premio_recebido: m.premio_status === 'entregue'
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar prêmios do profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar prêmios' });
  }
});

// GET /api/score/estatisticas - Dashboard administrativo
app.get('/api/score/estatisticas', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { whereClause += ` AND data_os >= $${paramIndex}`; params.push(data_inicio); paramIndex++; }
    if (data_fim) { whereClause += ` AND data_os <= $${paramIndex}`; params.push(data_fim); paramIndex++; }
    
    const geraisResult = await pool.query(`
      SELECT COUNT(DISTINCT cod_prof) as total_profissionais, COUNT(*) as total_os,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as os_no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as os_fora_prazo,
        COALESCE(SUM(ponto_total), 0) as pontos_distribuidos,
        COALESCE(SUM(ponto_bonus_janela), 0) as bonus_janelas_total,
        ROUND(AVG(ponto_total), 2) as media_pontos_por_os
      FROM score_historico ${whereClause}
    `, params);
    
    const top10Result = await pool.query(`
      SELECT cod_prof, MAX(nome_prof) as nome_prof, COALESCE(SUM(ponto_total), 0) as score_total, COUNT(*) as total_os
      FROM score_historico ${whereClause} GROUP BY cod_prof ORDER BY score_total DESC LIMIT 10
    `, params);
    
    const conquistasResult = await pool.query(`
      SELECT c.cod_prof, t.nome_prof, m.nome as milestone_nome, m.icone, c.conquistado_em
      FROM score_conquistas c JOIN score_milestones m ON c.milestone_id = m.id
      LEFT JOIN score_totais t ON c.cod_prof = t.cod_prof
      ORDER BY c.conquistado_em DESC LIMIT 10
    `);
    
    const gerais = geraisResult.rows[0];
    res.json({
      resumo: {
        total_profissionais: parseInt(gerais.total_profissionais) || 0,
        total_os: parseInt(gerais.total_os) || 0,
        os_no_prazo: parseInt(gerais.os_no_prazo) || 0,
        os_fora_prazo: parseInt(gerais.os_fora_prazo) || 0,
        taxa_prazo: gerais.total_os > 0 ? ((gerais.os_no_prazo / gerais.total_os) * 100).toFixed(1) : 0,
        pontos_distribuidos: parseFloat(gerais.pontos_distribuidos) || 0,
        bonus_janelas_total: parseFloat(gerais.bonus_janelas_total) || 0,
        media_pontos_por_os: parseFloat(gerais.media_pontos_por_os) || 0
      },
      top_10: top10Result.rows.map((p, i) => ({
        posicao: i + 1, cod_prof: p.cod_prof, nome: p.nome_prof || `Profissional ${p.cod_prof}`,
        score_total: parseFloat(p.score_total), total_os: parseInt(p.total_os)
      })),
      conquistas_recentes: conquistasResult.rows
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas', details: error.message });
  }
});

// GET /api/score/buscar - Buscar profissional
app.get('/api/score/buscar', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    
    const result = await pool.query(`
      SELECT cod_prof, nome_prof, score_total, total_os FROM score_totais
      WHERE cod_prof::text ILIKE $1 OR nome_prof ILIKE $1
      ORDER BY score_total DESC LIMIT 20
    `, [`%${q}%`]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar profissional' });
  }
});

console.log('✅ Módulo de Score e Gamificação carregado!');

// ==================== MÓDULO DE AUDITORIA ====================

// GET /api/audit/logs - Listar logs de auditoria (apenas admin)
app.get('/api/audit/logs', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      category, 
      action, 
      user_cod, 
      status,
      data_inicio, 
      data_fim,
      search
    } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }
    
    if (action) {
      whereClause += ` AND action ILIKE $${paramIndex}`;
      params.push(`%${action}%`);
      paramIndex++;
    }
    
    if (user_cod) {
      whereClause += ` AND user_cod ILIKE $${paramIndex}`;
      params.push(`%${user_cod}%`);
      paramIndex++;
    }
    
    if (status) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (data_inicio) {
      whereClause += ` AND created_at >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      whereClause += ` AND created_at <= $${paramIndex}`;
      params.push(data_fim + ' 23:59:59');
      paramIndex++;
    }
    
    if (search) {
      whereClause += ` AND (user_cod ILIKE $${paramIndex} OR user_name ILIKE $${paramIndex} OR action ILIKE $${paramIndex} OR resource ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    // Contar total
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM audit_logs ${whereClause}
    `, params);
    
    // Buscar logs
    const result = await pool.query(`
      SELECT * FROM audit_logs 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, parseInt(limit), offset]);
    
    res.json({
      logs: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Erro ao listar logs de auditoria:', error);
    res.status(500).json({ error: 'Erro ao listar logs' });
  }
});

// GET /api/audit/stats - Estatísticas de auditoria
app.get('/api/audit/stats', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { dias = 7 } = req.query;
    
    // Total por categoria
    const categoriaResult = await pool.query(`
      SELECT category, COUNT(*) as total
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      GROUP BY category
      ORDER BY total DESC
    `);
    
    // Total por ação
    const acaoResult = await pool.query(`
      SELECT action, COUNT(*) as total
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      GROUP BY action
      ORDER BY total DESC
      LIMIT 10
    `);
    
    // Usuários mais ativos
    const usuariosResult = await pool.query(`
      SELECT user_cod, user_name, COUNT(*) as total
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      AND user_cod IS NOT NULL AND user_cod != 'anonymous'
      GROUP BY user_cod, user_name
      ORDER BY total DESC
      LIMIT 10
    `);
    
    // Logs por dia
    const porDiaResult = await pool.query(`
      SELECT DATE(created_at) as data, COUNT(*) as total
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      GROUP BY DATE(created_at)
      ORDER BY data DESC
    `);
    
    // Falhas de login
    const falhasResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM audit_logs
      WHERE action = 'LOGIN_FAILED'
      AND created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
    `);
    
    // Total geral no período
    const totalResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
    `);
    
    res.json({
      periodo_dias: parseInt(dias),
      total_acoes: parseInt(totalResult.rows[0].total),
      falhas_login: parseInt(falhasResult.rows[0].total),
      por_categoria: categoriaResult.rows,
      top_acoes: acaoResult.rows,
      usuarios_ativos: usuariosResult.rows,
      por_dia: porDiaResult.rows
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// GET /api/audit/export - Exportar logs (CSV)
app.get('/api/audit/export', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { data_inicio, data_fim, category } = req.query;
    
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND created_at >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      whereClause += ` AND created_at <= $${paramIndex}`;
      params.push(data_fim + ' 23:59:59');
      paramIndex++;
    }
    
    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }
    
    const result = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI:SS') as data_hora,
        user_cod as usuario,
        user_name as nome,
        user_role as perfil,
        action as acao,
        category as categoria,
        resource as recurso,
        resource_id as recurso_id,
        status,
        ip_address as ip
      FROM audit_logs 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 10000
    `, params);
    
    // Registrar exportação
    await registrarAuditoria(req, 'EXPORT_AUDIT_LOGS', AUDIT_CATEGORIES.ADMIN, 'audit_logs', null, { 
      registros: result.rows.length,
      filtros: { data_inicio, data_fim, category }
    });
    
    // Gerar CSV
    const headers = ['Data/Hora', 'Usuário', 'Nome', 'Perfil', 'Ação', 'Categoria', 'Recurso', 'ID Recurso', 'Status', 'IP'];
    const csvRows = [headers.join(';')];
    
    for (const row of result.rows) {
      csvRows.push([
        row.data_hora,
        row.usuario,
        row.nome,
        row.perfil,
        row.acao,
        row.categoria,
        row.recurso || '',
        row.recurso_id || '',
        row.status,
        row.ip
      ].join(';'));
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=audit_logs_${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csvRows.join('\n')); // BOM para UTF-8
  } catch (error) {
    console.error('Erro ao exportar logs:', error);
    res.status(500).json({ error: 'Erro ao exportar logs' });
  }
});

// ==================== INTEGRAÇÃO PLIFIC ====================
// Consulta de saldo e lançamento de débito na plataforma Plific
// SEGURANÇA: Token DEVE ser configurado via variável de ambiente

const PLIFIC_CONFIG = {
    BASE_URL_TESTE: 'https://mototaxionline.com/sem/v1/rotas.php/integracao-plific-saldo-prof',
    BASE_URL_PRODUCAO: 'https://tutts.com.br/sem/v1/rotas.php/integracao-plific-saldo-prof',
    RATE_LIMIT: 10,
    RATE_LIMIT_WINDOW: 1000,
    CACHE_TTL: 1 * 60 * 1000
};

const PLIFIC_AMBIENTE = process.env.PLIFIC_AMBIENTE || 'teste';
const PLIFIC_BASE_URL = PLIFIC_AMBIENTE === 'producao' ? PLIFIC_CONFIG.BASE_URL_PRODUCAO : PLIFIC_CONFIG.BASE_URL_TESTE;
const PLIFIC_TOKEN = process.env.PLIFIC_TOKEN;

if (!PLIFIC_TOKEN) {
  console.warn('⚠️ AVISO: PLIFIC_TOKEN não configurado! Integração com Plific não funcionará.');
}

console.log(`🔗 Plific configurado para ambiente: ${PLIFIC_AMBIENTE.toUpperCase()}`);

const plificSaldoCache = new Map();

const limparCachePlific = () => {
    const agora = Date.now();
    for (const [key, value] of plificSaldoCache.entries()) {
        if (agora - value.timestamp > PLIFIC_CONFIG.CACHE_TTL) {
            plificSaldoCache.delete(key);
        }
    }
};

setInterval(limparCachePlific, PLIFIC_CONFIG.CACHE_TTL);

// Buscar Saldo Individual
app.get('/api/plific/saldo/:idProf', verificarToken, async (req, res) => {
    try {
        const { idProf } = req.params;
        const forceRefresh = req.query.refresh === 'true';
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }

        const cacheKey = `saldo_${idProf}`;
        if (!forceRefresh && plificSaldoCache.has(cacheKey)) {
            const cached = plificSaldoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                console.log(`📦 Plific: Saldo do profissional ${idProf} retornado do cache`);
                return res.json({ ...cached.data, fromCache: true, cacheAge: Math.round((Date.now() - cached.timestamp) / 1000) });
            }
        }

        const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
        console.log(`🔍 Plific: Consultando saldo do profissional ${idProf}...`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados && data.dados.status === false) {
            return res.status(404).json({ error: 'Profissional não encontrado', details: data.dados.msg || 'ID não existe na base Plific' });
        }

        // Converter saldo de formato brasileiro (1.000,00) para número
        const profissionalData = data.dados?.profissional || null;
        if (profissionalData && profissionalData.saldo) {
            // Remove pontos de milhar e troca vírgula por ponto
            const saldoStr = String(profissionalData.saldo);
            profissionalData.saldoOriginal = saldoStr;
            profissionalData.saldo = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
        }
        
        const resultado = {
            success: true,
            profissional: profissionalData,
            ambiente: PLIFIC_AMBIENTE,
            consultadoEm: new Date().toISOString()
        };

        plificSaldoCache.set(cacheKey, { data: resultado, timestamp: Date.now() });
        console.log(`✅ Plific: Saldo do profissional ${idProf} = R$ ${resultado.profissional?.saldo || 0}`);
        
        await registrarAuditoria(req, 'CONSULTA_SALDO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo', idProf, { saldo: resultado.profissional?.saldo, ambiente: PLIFIC_AMBIENTE });

        res.json(resultado);
    } catch (error) {
        console.error('❌ Erro ao consultar saldo Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldo', details: error.message });
    }
});

// Buscar Saldos em Lote
app.post('/api/plific/saldos-lote', verificarToken, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Lista de IDs inválida', details: 'Envie um array de IDs no corpo da requisição' });
        }

        if (ids.length > 100) {
            return res.status(400).json({ error: 'Limite excedido', details: 'Máximo de 100 profissionais por requisição' });
        }

        console.log(`🔍 Plific: Consultando saldo de ${ids.length} profissionais em lote...`);

        const resultados = [];
        const BATCH_SIZE = PLIFIC_CONFIG.RATE_LIMIT;
        
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (idProf) => {
                const cacheKey = `saldo_${idProf}`;
                if (plificSaldoCache.has(cacheKey)) {
                    const cached = plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                        return { idProf, ...cached.data.profissional, fromCache: true };
                    }
                }

                try {
                    const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
                    const response = await fetch(url, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                    });

                    const data = await response.json();

                    if (data.status === '200' && data.dados?.status === true) {
                        plificSaldoCache.set(cacheKey, { data: { profissional: data.dados.profissional }, timestamp: Date.now() });
                        return { idProf, ...data.dados.profissional, fromCache: false };
                    } else {
                        return { idProf, erro: data.dados?.msg || 'Não encontrado', saldo: null };
                    }
                } catch (err) {
                    return { idProf, erro: err.message, saldo: null };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            resultados.push(...batchResults);

            if (i + BATCH_SIZE < ids.length) {
                await new Promise(resolve => setTimeout(resolve, PLIFIC_CONFIG.RATE_LIMIT_WINDOW));
            }
        }

        const sucessos = resultados.filter(r => r.saldo !== null && !r.erro);
        const falhas = resultados.filter(r => r.saldo === null || r.erro);

        console.log(`✅ Plific: Lote concluído - ${sucessos.length} sucesso(s), ${falhas.length} falha(s)`);
        await registrarAuditoria(req, 'CONSULTA_SALDOS_LOTE_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo_lote', null, { total: ids.length, sucessos: sucessos.length, falhas: falhas.length, ambiente: PLIFIC_AMBIENTE });

        res.json({ success: true, total: ids.length, sucessos: sucessos.length, falhas: falhas.length, resultados, ambiente: PLIFIC_AMBIENTE, consultadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao consultar saldos em lote Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldos em lote', details: error.message });
    }
});

// Lançar Débito
app.post('/api/plific/lancar-debito', verificarToken, async (req, res) => {
    try {
        const { idProf, valor, descricao } = req.body;
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }
        if (!valor || isNaN(parseFloat(valor)) || parseFloat(valor) <= 0) {
            return res.status(400).json({ error: 'Valor inválido', details: 'O valor deve ser um número positivo' });
        }
        if (!descricao || descricao.trim().length === 0) {
            return res.status(400).json({ error: 'Descrição obrigatória', details: 'Informe uma descrição para o débito' });
        }

        const url = `${PLIFIC_BASE_URL}/lancarDebitoProfissional`;
        console.log(`💳 Plific: Lançando débito de R$ ${valor} para profissional ${idProf}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ idProf: parseInt(idProf), valor: parseFloat(valor), descricao: descricao.trim() })
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido ao lançar débito');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados?.status === 'erro') {
            console.error('❌ Plific: Erro ao lançar débito:', data.dados.mensagem);
            return res.status(400).json({ error: 'Erro ao lançar débito', details: data.dados.mensagem || 'Erro na validação dos parâmetros', erros: data.dados.erros });
        }

        const cacheKey = `saldo_${idProf}`;
        plificSaldoCache.delete(cacheKey);

        console.log(`✅ Plific: Débito de R$ ${valor} lançado com sucesso para profissional ${idProf}`);
        await registrarAuditoria(req, 'LANCAR_DEBITO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_debito', idProf, { valor: parseFloat(valor), descricao: descricao.trim(), ambiente: PLIFIC_AMBIENTE });

        res.json({ success: true, mensagem: data.dados?.mensagem || 'Débito lançado com sucesso', ambiente: PLIFIC_AMBIENTE, lancadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao lançar débito Plific:', error.message);
        res.status(500).json({ error: 'Erro ao lançar débito', details: error.message });
    }
});

// Buscar Profissionais para Consulta
app.get('/api/plific/profissionais', verificarToken, async (req, res) => {
    try {
        const { regiao, limite } = req.query;
        
        let query = `SELECT DISTINCT s.user_cod as id, s.user_name as nome, s.regiao FROM withdrawal_requests s WHERE s.user_cod IS NOT NULL`;
        const params = [];
        let paramIndex = 1;

        if (regiao) {
            query += ` AND s.regiao = $${paramIndex++}`;
            params.push(regiao);
        }

        query += ` ORDER BY s.user_name ASC`;
        
        if (limite) {
            query += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limite));
        }

        const result = await pool.query(query, params);
        res.json({ success: true, total: result.rows.length, profissionais: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar profissionais:', error.message);
        res.status(500).json({ error: 'Erro ao buscar profissionais', details: error.message });
    }
});

// Listar todos os profissionais com saldo (do banco local + API Plific)
app.get('/api/plific/saldos-todos', verificarToken, async (req, res) => {
    try {
        const { pagina = 1, porPagina = 20 } = req.query;
        const paginaNum = parseInt(pagina);
        const porPaginaNum = Math.min(parseInt(porPagina), 50); // máximo 50 por página
        
        // Buscar todos os profissionais únicos que já fizeram saque
        const queryProfs = `
            SELECT s.user_cod as codigo, MAX(s.user_name) as nome 
            FROM withdrawal_requests s 
            WHERE s.user_cod IS NOT NULL AND s.user_name IS NOT NULL
            GROUP BY s.user_cod
            ORDER BY MAX(s.user_name) ASC
        `;
        const resultProfs = await pool.query(queryProfs);
        const profissionais = resultProfs.rows;
        
        if (profissionais.length === 0) {
            return res.json({ 
                success: true, 
                profissionais: [], 
                total: 0, 
                pagina: paginaNum, 
                porPagina: porPaginaNum, 
                totalPaginas: 0 
            });
        }
        
        // Buscar saldos de todos os profissionais na API Plific
        const resultados = [];
        for (const prof of profissionais) {
            try {
                // Verificar cache primeiro
                const cacheKey = `saldo_${prof.codigo}`;
                if (plificSaldoCache.has(cacheKey)) {
                    const cached = plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                        const saldoCached = cached.data.profissional?.saldo;
                        const saldoNum = typeof saldoCached === 'string' 
                            ? parseFloat(saldoCached.replace(/\./g, '').replace(',', '.')) || 0
                            : parseFloat(saldoCached || 0);
                        resultados.push({
                            codigo: prof.codigo,
                            nome: prof.nome,
                            saldo: saldoNum,
                            cpf: cached.data.profissional?.cpf || null
                        });
                        continue;
                    }
                }
                
                // Buscar da API
                const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${prof.codigo}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                
                if (data.status === '200' || data.status === 200) {
                    const profData = data.dados?.profissional || null;
                    let saldoNum = 0;
                    if (profData && profData.saldo) {
                        const saldoStr = String(profData.saldo);
                        saldoNum = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
                    }
                    
                    resultados.push({
                        codigo: prof.codigo,
                        nome: profData?.nome || prof.nome,
                        saldo: saldoNum,
                        cpf: profData?.cpf || null
                    });
                    
                    // Cachear resultado
                    plificSaldoCache.set(cacheKey, { 
                        data: { profissional: { ...profData, saldo: saldoNum } }, 
                        timestamp: Date.now() 
                    });
                }
                
                // Rate limit - pequena pausa entre requisições
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                console.error(`Erro ao buscar saldo do prof ${prof.codigo}:`, err.message);
            }
        }
        
        // Ordenar por saldo (maior para menor)
        resultados.sort((a, b) => b.saldo - a.saldo);
        
        // Paginação
        const total = resultados.length;
        const totalPaginas = Math.ceil(total / porPaginaNum);
        const inicio = (paginaNum - 1) * porPaginaNum;
        const fim = inicio + porPaginaNum;
        const profissionaisPaginados = resultados.slice(inicio, fim);
        
        res.json({ 
            success: true, 
            profissionais: profissionaisPaginados, 
            total, 
            pagina: paginaNum, 
            porPagina: porPaginaNum, 
            totalPaginas,
            somaTotal: resultados.reduce((acc, p) => acc + p.saldo, 0)
        });
        
    } catch (error) {
        console.error('❌ Erro ao buscar saldos:', error.message);
        res.status(500).json({ error: 'Erro ao buscar saldos', details: error.message });
    }
});

// Status da Integração
app.get('/api/plific/status', verificarToken, async (req, res) => {
    try {
        const testId = PLIFIC_AMBIENTE === 'teste' ? '8888' : '1';
        const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${testId}`;
        
        const startTime = Date.now();
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });
        const latency = Date.now() - startTime;

        const data = await response.json();
        const tokenValido = data.status !== '401';
        const apiOnline = response.ok;

        res.json({
            success: true,
            status: { apiOnline, tokenValido, latencia: `${latency}ms`, ambiente: PLIFIC_AMBIENTE, baseUrl: PLIFIC_BASE_URL, cacheSize: plificSaldoCache.size, cacheTTL: `${PLIFIC_CONFIG.CACHE_TTL / 1000}s` }
        });
    } catch (error) {
        res.json({ success: false, status: { apiOnline: false, tokenValido: false, erro: error.message, ambiente: PLIFIC_AMBIENTE } });
    }
});

console.log('✅ Módulo Plific carregado!');

// ==================== FIM INTEGRAÇÃO PLIFIC ====================


console.log('✅ Módulo de Auditoria carregado!');

// ==================== ROTEIRIZADOR PÚBLICO - API ====================

// Middleware para verificar token do roteirizador
const verificarTokenRoteirizador = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.tipo !== 'roteirizador') {
      return res.status(401).json({ error: 'Token inválido para roteirizador' });
    }
    
    // Verificar se usuário ainda está ativo
    const usuario = await pool.query(
      'SELECT id, nome, email, ativo FROM usuarios_roteirizador WHERE id = $1',
      [decoded.id]
    );
    
    if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
      return res.status(401).json({ error: 'Usuário inativo ou não encontrado' });
    }
    
    req.usuarioRoteirizador = usuario.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

// Login do roteirizador
app.post('/api/roteirizador/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    
    if (!email || !senha) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    
    const result = await pool.query(
      'SELECT id, nome, email, senha_hash, ativo, empresa FROM usuarios_roteirizador WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    
    const usuario = result.rows[0];
    
    if (!usuario.ativo) {
      return res.status(401).json({ error: 'Usuário inativo. Entre em contato com o suporte.' });
    }
    
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
    
    if (!senhaValida) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    
    // Atualizar último acesso
    await pool.query(
      'UPDATE usuarios_roteirizador SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1',
      [usuario.id]
    );
    
    // Gerar token
    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, tipo: 'roteirizador' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    console.log('✅ Login roteirizador:', usuario.email);
    
    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        empresa: usuario.empresa
      }
    });
  } catch (err) {
    console.error('❌ Erro login roteirizador:', err);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Verificar token (para manter sessão)
app.get('/api/roteirizador/verificar', verificarTokenRoteirizador, (req, res) => {
  res.json({ 
    valido: true, 
    usuario: req.usuarioRoteirizador 
  });
});

// Salvar rota no histórico
app.post('/api/roteirizador/rotas', verificarTokenRoteirizador, async (req, res) => {
  try {
    const { nome_rota, ponto_partida, pontos_entrega, rotas_geradas, config, total_km, total_min, num_rotas, num_paradas } = req.body;
    
    const result = await pool.query(`
      INSERT INTO rotas_historico 
      (usuario_id, nome_rota, ponto_partida, pontos_entrega, rotas_geradas, config, total_km, total_min, num_rotas, num_paradas)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, criado_em
    `, [
      req.usuarioRoteirizador.id,
      nome_rota || null,
      JSON.stringify(ponto_partida),
      JSON.stringify(pontos_entrega),
      JSON.stringify(rotas_geradas),
      JSON.stringify(config),
      total_km || null,
      total_min || null,
      num_rotas || null,
      num_paradas || null
    ]);
    
    console.log('💾 Rota salva:', result.rows[0].id, 'usuário:', req.usuarioRoteirizador.id);
    
    res.json({ 
      sucesso: true, 
      id: result.rows[0].id,
      criado_em: result.rows[0].criado_em
    });
  } catch (err) {
    console.error('❌ Erro ao salvar rota:', err);
    res.status(500).json({ error: 'Erro ao salvar rota' });
  }
});

// Listar histórico de rotas
app.get('/api/roteirizador/rotas', verificarTokenRoteirizador, async (req, res) => {
  try {
    const { limite = 20, pagina = 1 } = req.query;
    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    
    const result = await pool.query(`
      SELECT id, nome_rota, ponto_partida, num_rotas, num_paradas, total_km, total_min, criado_em
      FROM rotas_historico 
      WHERE usuario_id = $1 
      ORDER BY criado_em DESC 
      LIMIT $2 OFFSET $3
    `, [req.usuarioRoteirizador.id, parseInt(limite), offset]);
    
    const total = await pool.query(
      'SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = $1',
      [req.usuarioRoteirizador.id]
    );
    
    res.json({
      rotas: result.rows,
      total: parseInt(total.rows[0].count),
      pagina: parseInt(pagina),
      limite: parseInt(limite)
    });
  } catch (err) {
    console.error('❌ Erro ao listar rotas:', err);
    res.status(500).json({ error: 'Erro ao listar rotas' });
  }
});

// Buscar rota específica (para recarregar)
app.get('/api/roteirizador/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM rotas_historico 
      WHERE id = $1 AND usuario_id = $2
    `, [req.params.id, req.usuarioRoteirizador.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rota não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar rota:', err);
    res.status(500).json({ error: 'Erro ao buscar rota' });
  }
});

// Deletar rota do histórico
app.delete('/api/roteirizador/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM rotas_historico WHERE id = $1 AND usuario_id = $2 RETURNING id',
      [req.params.id, req.usuarioRoteirizador.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rota não encontrada' });
    }
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao deletar rota:', err);
    res.status(500).json({ error: 'Erro ao deletar rota' });
  }
});

// Salvar endereço favorito
app.post('/api/roteirizador/favoritos', verificarTokenRoteirizador, async (req, res) => {
  try {
    const { endereco, apelido, latitude, longitude } = req.body;
    
    if (!endereco) {
      return res.status(400).json({ error: 'Endereço é obrigatório' });
    }
    
    // Verificar se já existe
    const existe = await pool.query(
      'SELECT id FROM enderecos_favoritos WHERE usuario_id = $1 AND endereco = $2',
      [req.usuarioRoteirizador.id, endereco]
    );
    
    if (existe.rows.length > 0) {
      // Atualizar uso
      await pool.query(`
        UPDATE enderecos_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP, latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude)
        WHERE id = $1
      `, [existe.rows[0].id, latitude, longitude]);
      
      return res.json({ sucesso: true, id: existe.rows[0].id, atualizado: true });
    }
    
    const result = await pool.query(`
      INSERT INTO enderecos_favoritos (usuario_id, endereco, apelido, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [req.usuarioRoteirizador.id, endereco, apelido || null, latitude, longitude]);
    
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar favorito:', err);
    res.status(500).json({ error: 'Erro ao salvar favorito' });
  }
});

// Listar endereços favoritos
app.get('/api/roteirizador/favoritos', verificarTokenRoteirizador, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, endereco, apelido, latitude, longitude, vezes_usado
      FROM enderecos_favoritos 
      WHERE usuario_id = $1 
      ORDER BY vezes_usado DESC, ultimo_uso DESC
      LIMIT 50
    `, [req.usuarioRoteirizador.id]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar favoritos:', err);
    res.status(500).json({ error: 'Erro ao listar favoritos' });
  }
});

// ==================== PROXY PARA OPENROUTESERVICE (ANTIGO - REMOVIDO) ====================
// SEGURANÇA: O proxy antigo foi removido. Usar /api/routing/* que já está protegido

// ==================== CENTRAL - Gerenciar usuários do roteirizador ====================

// Criar usuário do roteirizador (só admin da central)
app.post('/api/admin/roteirizador/usuarios', verificarToken, async (req, res) => {
  try {
    const { nome, email, senha, telefone, empresa, observacoes } = req.body;
    
    if (!nome || !email || !senha) {
      return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
    }
    
    // Verificar se email já existe
    const existe = await pool.query(
      'SELECT id FROM usuarios_roteirizador WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    
    const senha_hash = await bcrypt.hash(senha, 10);
    
    const result = await pool.query(`
      INSERT INTO usuarios_roteirizador (nome, email, senha_hash, telefone, empresa, observacoes, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, nome, email, empresa, criado_em
    `, [nome, email.toLowerCase().trim(), senha_hash, telefone, empresa, observacoes, req.user.id || null]);
    
    console.log('✅ Usuário roteirizador criado:', result.rows[0].email, 'por:', req.user.email);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar usuário roteirizador:', err);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// Listar usuários do roteirizador (só admin)
app.get('/api/admin/roteirizador/usuarios', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nome, email, telefone, empresa, ativo, criado_em, ultimo_acesso,
             (SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = usuarios_roteirizador.id) as total_rotas
      FROM usuarios_roteirizador 
      ORDER BY criado_em DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar usuários:', err);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Ativar/Desativar usuário do roteirizador
app.patch('/api/admin/roteirizador/usuarios/:id/ativo', verificarToken, async (req, res) => {
  try {
    const { ativo } = req.body;
    
    const result = await pool.query(
      'UPDATE usuarios_roteirizador SET ativo = $1 WHERE id = $2 RETURNING id, nome, email, ativo',
      [ativo, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('✅ Usuário roteirizador', ativo ? 'ativado' : 'desativado', ':', result.rows[0].email);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

// Resetar senha do usuário do roteirizador
app.patch('/api/admin/roteirizador/usuarios/:id/senha', verificarToken, async (req, res) => {
  try {
    const { nova_senha } = req.body;
    
    // Admin pode resetar com senha simples (usuário deve trocar depois)
    const validacaoSenha = validarSenhaSimples(nova_senha);
    if (!validacaoSenha.valido) {
      return res.status(400).json({ error: validacaoSenha.erro });
    }
    
    const senha_hash = await bcrypt.hash(nova_senha, 10);
    
    const result = await pool.query(
      'UPDATE usuarios_roteirizador SET senha_hash = $1 WHERE id = $2 RETURNING id, nome, email',
      [senha_hash, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('✅ Senha resetada para:', result.rows[0].email);
    
    res.json({ sucesso: true, usuario: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao resetar senha:', err);
    res.status(500).json({ error: 'Erro ao resetar senha' });
  }
});

console.log('🗺️ API do Roteirizador Público carregada!');

// ==================== API DE GEOCODIFICAÇÃO ====================

// Função para normalizar endereço (para comparação no cache)
function normalizarEndereco(endereco) {
  let texto = (endereco || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    
    // ========================================
    // ABREVIAÇÕES DE LOGRADOUROS
    // ========================================
    .replace(/\b(avenida|aven|avda)\b/g, 'av')
    .replace(/\b(rua)\b/g, 'r')
    .replace(/\b(travessa|trav)\b/g, 'tv')
    .replace(/\b(alameda)\b/g, 'al')
    .replace(/\b(praca|pca)\b/g, 'pc')
    .replace(/\b(rodovia|rod)\b/g, 'rod')
    .replace(/\b(estrada|estr)\b/g, 'est')
    .replace(/\b(largo)\b/g, 'lg')
    .replace(/\b(beco)\b/g, 'bc')
    .replace(/\b(viela)\b/g, 'vl')
    .replace(/\b(ladeira)\b/g, 'ld')
    .replace(/\b(passagem|pass)\b/g, 'pas')
    .replace(/\b(quadra|qd)\b/g, 'q')
    .replace(/\b(lote|lt)\b/g, 'lt')
    .replace(/\b(bloco|bl)\b/g, 'bl')
    .replace(/\b(conjunto|conj|cj)\b/g, 'cj')
    .replace(/\b(edificio|edif|ed)\b/g, 'ed')
    .replace(/\b(apartamento|apto|apt|ap)\b/g, 'ap')
    .replace(/\b(casa)\b/g, 'cs')
    .replace(/\b(sala|sl)\b/g, 'sl')
    .replace(/\b(loja|lj)\b/g, 'lj')
    .replace(/\b(sobreloja|slj)\b/g, 'slj')
    .replace(/\b(andar)\b/g, 'and')
    .replace(/\b(galeria|gal)\b/g, 'gal')
    .replace(/\b(chacara|chac)\b/g, 'ch')
    .replace(/\b(fazenda|faz)\b/g, 'faz')
    .replace(/\b(sitio)\b/g, 'sit')
    .replace(/\b(vila|vl)\b/g, 'vl')
    .replace(/\b(jardim|jd|jard)\b/g, 'jd')
    .replace(/\b(parque|pq|pque)\b/g, 'pq')
    .replace(/\b(residencial|resid|res)\b/g, 'res')
    .replace(/\b(setor|set)\b/g, 'st')
    .replace(/\b(centro)\b/g, 'ctr')
    
    // ========================================
    // TÍTULOS E PATENTES
    // ========================================
    .replace(/\b(doutor|dr)\b/g, 'dr')
    .replace(/\b(doutora|dra)\b/g, 'dra')
    .replace(/\b(professor|prof)\b/g, 'prof')
    .replace(/\b(professora|profa)\b/g, 'profa')
    .replace(/\b(engenheiro|eng)\b/g, 'eng')
    .replace(/\b(engenheira|enga)\b/g, 'enga')
    .replace(/\b(general|gen)\b/g, 'gen')
    .replace(/\b(coronel|cel)\b/g, 'cel')
    .replace(/\b(tenente|ten)\b/g, 'ten')
    .replace(/\b(capitao|cap)\b/g, 'cap')
    .replace(/\b(sargento|sgt)\b/g, 'sgt')
    .replace(/\b(soldado|sd)\b/g, 'sd')
    .replace(/\b(almirante|alm)\b/g, 'alm')
    .replace(/\b(brigadeiro|brig)\b/g, 'brig')
    .replace(/\b(marechal|mal)\b/g, 'mal')
    .replace(/\b(presidente|pres)\b/g, 'pres')
    .replace(/\b(governador|gov)\b/g, 'gov')
    .replace(/\b(prefeito|pref)\b/g, 'pref')
    .replace(/\b(deputado|dep)\b/g, 'dep')
    .replace(/\b(senador|sen)\b/g, 'sen')
    .replace(/\b(vereador|ver)\b/g, 'ver')
    .replace(/\b(padre|pe)\b/g, 'pe')
    .replace(/\b(frei)\b/g, 'fr')
    .replace(/\b(irma|irm)\b/g, 'irm')
    .replace(/\b(santo|sto)\b/g, 'sto')
    .replace(/\b(santa|sta)\b/g, 'sta')
    .replace(/\b(sao)\b/g, 'sao')
    .replace(/\b(nossa senhora|ns)\b/g, 'ns')
    .replace(/\b(dom)\b/g, 'dom')
    .replace(/\b(dona|dna)\b/g, 'dna')
    .replace(/\b(senhor|sr)\b/g, 'sr')
    .replace(/\b(senhora|sra)\b/g, 'sra')
    
    // ========================================
    // DIREÇÕES E POSIÇÕES
    // ========================================
    .replace(/\b(norte|n)\b/g, 'n')
    .replace(/\b(sul|s)\b/g, 's')
    .replace(/\b(leste|l)\b/g, 'l')
    .replace(/\b(oeste|o)\b/g, 'o')
    
    // ========================================
    // ESTADOS (para remover redundância)
    // ========================================
    .replace(/\bgoias\b/g, 'go')
    .replace(/\b(goiania)\b/g, 'gyn')
    .replace(/\b(brasilia)\b/g, 'bsb')
    .replace(/\b(sao paulo)\b/g, 'sp')
    .replace(/\b(rio de janeiro)\b/g, 'rj')
    .replace(/\b(belo horizonte)\b/g, 'bh')
    .replace(/\b(brasil|brazil|br)\b/g, '')
    
    // ========================================
    // LIMPEZA FINAL
    // ========================================
    .replace(/[^a-z0-9\s]/g, ' ') // Remove caracteres especiais
    .replace(/\s+/g, ' ') // Normaliza múltiplos espaços
    .trim();
    
  // Remover palavras muito comuns que não agregam na busca
  const stopWords = ['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'nas', 'nos', 'a', 'o', 'as', 'os', 'um', 'uma', 'para', 'com'];
  texto = texto.split(' ').filter(p => !stopWords.includes(p) && p.length > 0).join(' ');
  
  return texto;
}

// Endpoint Google Geocoding (COM CACHE)
app.get('/api/geocode/google', async (req, res) => {
  try {
    const { endereco } = req.query;
    const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
    
    if (!endereco) {
      return res.status(400).json({ error: 'Informe o endereço' });
    }
    
    if (!GOOGLE_API_KEY) {
      console.log('⚠️ GOOGLE_GEOCODING_API_KEY não configurada');
      return res.status(500).json({ error: 'API Key não configurada no servidor' });
    }
    
    const enderecoNormalizado = normalizarEndereco(endereco);
    
    // ========================================
    // ETAPA 1: Verificar cache no banco
    // ========================================
    try {
      const cacheResult = await pool.query(
        `SELECT id, endereco_formatado, latitude, longitude, fonte 
         FROM enderecos_geocodificados 
         WHERE endereco_busca_normalizado = $1 
         LIMIT 1`,
        [enderecoNormalizado]
      );
      
      if (cacheResult.rows.length > 0) {
        const cached = cacheResult.rows[0];
        console.log('✅ Cache HIT:', endereco, '→', cached.latitude, cached.longitude);
        
        // Atualizar contador de acessos (async, não bloqueia)
        pool.query(
          `UPDATE enderecos_geocodificados 
           SET acessos = acessos + 1, ultimo_acesso = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [cached.id]
        ).catch(e => console.log('⚠️ Erro ao atualizar acessos:', e.message));
        
        return res.json({
          results: [{
            endereco: cached.endereco_formatado,
            latitude: parseFloat(cached.latitude),
            longitude: parseFloat(cached.longitude),
            fonte: cached.fonte + '-cache'
          }],
          fonte: 'cache'
        });
      }
    } catch (dbErr) {
      console.log('⚠️ Erro ao consultar cache:', dbErr.message);
      // Continua para buscar no Google
    }
    
    // ========================================
    // ETAPA 2: Buscar no Google (cache MISS)
    // ========================================
    console.log('🔍 Cache MISS, buscando no Google:', endereco);
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR`;
    
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      console.log('✅ Google sucesso:', data.results.length, 'resultados');
      
      // Salvar o primeiro resultado no cache (async, não bloqueia)
      const primeiro = data.results[0];
      pool.query(
        `INSERT INTO enderecos_geocodificados 
         (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          endereco,
          enderecoNormalizado,
          primeiro.formatted_address,
          primeiro.geometry.location.lat,
          primeiro.geometry.location.lng,
          'google'
        ]
      ).then(() => {
        console.log('💾 Salvo no cache:', endereco);
      }).catch(e => {
        console.log('⚠️ Erro ao salvar cache:', e.message);
      });
      
      return res.json({
        results: data.results.map(r => ({
          endereco: r.formatted_address,
          latitude: r.geometry.location.lat,
          longitude: r.geometry.location.lng,
          tipos: r.types,
          componentes: r.address_components,
          fonte: 'google'
        })),
        fonte: 'google'
      });
    } else if (data.status === 'ZERO_RESULTS') {
      return res.status(404).json({ error: 'Endereço não encontrado' });
    } else {
      console.log('⚠️ Google erro:', data.status, data.error_message);
      return res.status(500).json({ error: 'Erro na API Google', status: data.status });
    }
  } catch (err) {
    console.error('❌ Erro Google Geocoding:', err);
    res.status(500).json({ error: 'Erro ao geocodificar' });
  }
});

// Endpoint para estatísticas do cache de geocodificação
app.get('/api/geocode/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_enderecos,
        SUM(acessos) as total_acessos,
        SUM(acessos) - COUNT(*) as requisicoes_economizadas,
        ROUND(((SUM(acessos) - COUNT(*))::numeric / NULLIF(SUM(acessos), 0)) * 100, 2) as percentual_cache,
        MAX(criado_em) as ultimo_cadastro,
        (SELECT COUNT(*) FROM enderecos_geocodificados WHERE criado_em > CURRENT_DATE - INTERVAL '30 days') as novos_ultimo_mes
      FROM enderecos_geocodificados
    `);
    
    const topEnderecos = await pool.query(`
      SELECT endereco_formatado, acessos, criado_em
      FROM enderecos_geocodificados
      ORDER BY acessos DESC
      LIMIT 10
    `);
    
    const row = stats.rows[0];
    const economiaDolares = ((parseInt(row.requisicoes_economizadas) || 0) / 1000) * 5;
    
    res.json({
      cache: {
        total_enderecos: parseInt(row.total_enderecos) || 0,
        total_acessos: parseInt(row.total_acessos) || 0,
        requisicoes_economizadas: parseInt(row.requisicoes_economizadas) || 0,
        percentual_cache: parseFloat(row.percentual_cache) || 0,
        novos_ultimo_mes: parseInt(row.novos_ultimo_mes) || 0
      },
      economia: {
        dolares: economiaDolares.toFixed(2),
        reais: (economiaDolares * 6).toFixed(2)
      },
      top_enderecos: topEnderecos.rows
    });
  } catch (err) {
    console.error('❌ Erro stats cache:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// Endpoint para buscar CEP com coordenadas
app.get('/api/geocode/cep/:cep', async (req, res) => {
  try {
    const cep = req.params.cep.replace(/\D/g, '');
    if (cep.length !== 8) {
      return res.status(400).json({ error: 'CEP inválido' });
    }
    
    console.log('📮 Geocode CEP:', cep);
    
    // Tentar BrasilAPI primeiro (tem coordenadas)
    try {
      const respBrasil = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
      if (respBrasil.ok) {
        const data = await respBrasil.json();
        const lat = data.location?.coordinates?.latitude;
        const lng = data.location?.coordinates?.longitude;
        
        console.log('✅ BrasilAPI sucesso:', { lat, lng });
        return res.json({
          cep: cep,
          endereco: `${data.street || ''}, ${data.neighborhood || ''}, ${data.city} - ${data.state}`.replace(/^,\s*/, ''),
          logradouro: data.street,
          bairro: data.neighborhood,
          cidade: data.city,
          estado: data.state,
          latitude: lat ? parseFloat(lat) : null,
          longitude: lng ? parseFloat(lng) : null,
          fonte: lat ? 'brasilapi' : 'brasilapi-sem-coord'
        });
      }
    } catch (e) {
      console.log('⚠️ BrasilAPI falhou:', e.message);
    }
    
    // Fallback: ViaCEP + Nominatim
    try {
      const respViaCep = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      if (respViaCep.ok) {
        const data = await respViaCep.json();
        if (!data.erro) {
          // Tentar geocodificar com Nominatim
          let lat = null, lng = null;
          try {
            const query = `${data.logradouro}, ${data.bairro}, ${data.localidade}, ${data.uf}, Brasil`;
            const respNominatim = await fetch(
              `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=br`,
              { headers: { 'User-Agent': 'TuttsRoteirizador/2.0' } }
            );
            const nominatimData = await respNominatim.json();
            if (nominatimData[0]) {
              lat = parseFloat(nominatimData[0].lat);
              lng = parseFloat(nominatimData[0].lon);
            }
          } catch (e) {
            console.log('⚠️ Nominatim falhou:', e.message);
          }
          
          console.log('✅ ViaCEP + Nominatim:', { lat, lng });
          return res.json({
            cep: data.cep,
            endereco: `${data.logradouro}, ${data.bairro}, ${data.localidade} - ${data.uf}`,
            logradouro: data.logradouro,
            bairro: data.bairro,
            cidade: data.localidade,
            estado: data.uf,
            latitude: lat,
            longitude: lng,
            fonte: lat ? 'viacep-nominatim' : 'viacep'
          });
        }
      }
    } catch (e) {
      console.log('⚠️ ViaCEP falhou:', e.message);
    }
    
    res.status(404).json({ error: 'CEP não encontrado' });
  } catch (err) {
    console.error('❌ Erro geocode CEP:', err);
    res.status(500).json({ error: 'Erro ao buscar CEP' });
  }
});

// Endpoint para geocodificar endereço (texto livre)
app.get('/api/geocode/endereco', async (req, res) => {
  try {
    const { endereco, bairro, cidade, estado } = req.query;
    
    if (!endereco && !bairro && !cidade) {
      return res.status(400).json({ error: 'Informe pelo menos um campo' });
    }
    
    console.log('🔍 Geocode endereço:', { endereco, bairro, cidade, estado });
    
    // Montar queries em ordem de especificidade
    const queries = [];
    if (endereco && cidade) {
      queries.push(`${endereco}, ${bairro ? bairro + ', ' : ''}${cidade}, ${estado || 'GO'}, Brasil`);
    }
    if (bairro && cidade) {
      queries.push(`${bairro}, ${cidade}, ${estado || 'GO'}, Brasil`);
    }
    if (cidade) {
      queries.push(`${cidade}, ${estado || 'GO'}, Brasil`);
    }
    
    const cidadeLower = (cidade || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // Tentar Nominatim
    for (const query of queries) {
      try {
        console.log('🌍 Nominatim:', query);
        const resp = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=3&countrycodes=br&addressdetails=1`,
          { headers: { 'User-Agent': 'TuttsRoteirizador/2.0' } }
        );
        const data = await resp.json();
        
        if (data && data.length > 0) {
          for (const result of data) {
            const displayName = (result.display_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (displayName.includes(cidadeLower) || !cidade) {
              console.log('✅ Nominatim sucesso:', result.lat, result.lon);
              return res.json({
                latitude: parseFloat(result.lat),
                longitude: parseFloat(result.lon),
                endereco_encontrado: result.display_name,
                fonte: 'nominatim'
              });
            }
          }
        }
      } catch (e) {
        console.log('⚠️ Nominatim falhou:', e.message);
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // Fallback: Photon
    const queryPhoton = `${endereco || bairro}, ${cidade}, ${estado || 'GO'}`;
    try {
      console.log('💡 Photon:', queryPhoton);
      const resp = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(queryPhoton)}&limit=3&lang=pt`
      );
      const data = await resp.json();
      
      if (data.features && data.features.length > 0) {
        for (const feature of data.features) {
          const props = feature.properties || {};
          const featureCidade = (props.city || props.county || props.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          if (featureCidade.includes(cidadeLower) || cidadeLower.includes(featureCidade) || !cidade) {
            const coords = feature.geometry.coordinates;
            console.log('✅ Photon sucesso:', coords[1], coords[0]);
            return res.json({
              latitude: coords[1],
              longitude: coords[0],
              endereco_encontrado: `${props.name || ''}, ${props.city || ''}, ${props.state || ''}`,
              fonte: 'photon'
            });
          }
        }
      }
    } catch (e) {
      console.log('⚠️ Photon falhou:', e.message);
    }
    
    res.status(404).json({ error: 'Endereço não encontrado' });
  } catch (err) {
    console.error('❌ Erro geocode endereço:', err);
    res.status(500).json({ error: 'Erro ao geocodificar' });
  }
});

console.log('🗺️ API de Geocodificação carregada!');

// =====================================================
// SISTEMA DE SOLICITAÇÃO DE CORRIDAS - INTEGRAÇÃO TUTTS
// =====================================================

// Middleware de autenticação para clientes de solicitação
const verificarTokenSolicitacao = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.tipo !== 'solicitacao') {
      return res.status(401).json({ error: 'Token inválido para solicitação' });
    }
    
    const cliente = await pool.query(
      'SELECT * FROM clientes_solicitacao WHERE id = $1',
      [decoded.id]
    );
    
    if (cliente.rows.length === 0 || !cliente.rows[0].ativo) {
      return res.status(401).json({ error: 'Cliente inativo ou não encontrado' });
    }
    
    req.clienteSolicitacao = cliente.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

// Login do cliente de solicitação
app.post('/api/solicitacao/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    
    if (!email || !senha) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    
    const cliente = await pool.query(
      'SELECT * FROM clientes_solicitacao WHERE email = $1',
      [email.toLowerCase()]
    );
    
    if (cliente.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    
    const clienteData = cliente.rows[0];
    
    if (!clienteData.ativo) {
      return res.status(401).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
    }
    
    const senhaValida = await bcrypt.compare(senha, clienteData.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    
    // Atualizar último acesso
    await pool.query(
      'UPDATE clientes_solicitacao SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1',
      [clienteData.id]
    );
    
    const token = jwt.sign(
      { id: clienteData.id, email: clienteData.email, tipo: 'solicitacao' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      cliente: {
        id: clienteData.id,
        nome: clienteData.nome,
        email: clienteData.email,
        empresa: clienteData.empresa,
        forma_pagamento_padrao: clienteData.forma_pagamento_padrao,
        endereco_partida_padrao: clienteData.endereco_partida_padrao,
        centro_custo_padrao: clienteData.centro_custo_padrao
      }
    });
  } catch (err) {
    console.error('❌ Erro no login solicitação:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar token
app.get('/api/solicitacao/verificar', verificarTokenSolicitacao, (req, res) => {
  res.json({
    valido: true,
    cliente: {
      id: req.clienteSolicitacao.id,
      nome: req.clienteSolicitacao.nome,
      email: req.clienteSolicitacao.email,
      empresa: req.clienteSolicitacao.empresa,
      forma_pagamento_padrao: req.clienteSolicitacao.forma_pagamento_padrao,
      endereco_partida_padrao: req.clienteSolicitacao.endereco_partida_padrao,
      centro_custo_padrao: req.clienteSolicitacao.centro_custo_padrao
    }
  });
});

// Atualizar configurações do cliente (partida padrão, etc)
app.patch('/api/solicitacao/configuracoes', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { forma_pagamento_padrao, endereco_partida_padrao, centro_custo_padrao } = req.body;
    
    console.log('💾 Salvando configurações para cliente:', req.clienteSolicitacao.id);
    console.log('📍 Endereço partida:', endereco_partida_padrao);
    
    await pool.query(`
      UPDATE clientes_solicitacao 
      SET forma_pagamento_padrao = COALESCE($1, forma_pagamento_padrao),
          endereco_partida_padrao = COALESCE($2, endereco_partida_padrao),
          centro_custo_padrao = COALESCE($3, centro_custo_padrao)
      WHERE id = $4
    `, [forma_pagamento_padrao, endereco_partida_padrao ? JSON.stringify(endereco_partida_padrao) : null, centro_custo_padrao, req.clienteSolicitacao.id]);
    
    console.log('✅ Configurações salvas com sucesso');
    res.json({ sucesso: true, endereco_partida_padrao });
  } catch (err) {
    console.error('❌ Erro ao atualizar configurações:', err);
    res.status(500).json({ error: 'Erro ao atualizar configurações' });
  }
});

// Solicitar corrida (enviar para API Tutts)
app.post('/api/solicitacao/corrida', verificarTokenSolicitacao, async (req, res) => {
  try {
    const {
      numero_pedido,
      centro_custo,
      usuario_solicitante,
      data_retirada,
      forma_pagamento,
      ponto_receber,
      retorno,
      obs_retorno,
      ordenar,
      codigo_profissional,
      profissional_nome,      // NOVO - Nome do profissional selecionado
      profissional_foto,      // NOVO - Foto do profissional selecionado
      profissional_telefone,  // NOVO - Telefone do profissional selecionado
      profissional_placa,     // NOVO - Placa do profissional selecionado
      valor_rota_profissional,
      valor_rota_servico,
      sem_profissional,  // NOVO - Modo teste (não dispara para motoboys)
      pontos // Array de pontos
    } = req.body;
    
    if (!pontos || pontos.length < 1) {
      return res.status(400).json({ error: 'Informe pelo menos 1 ponto de entrega' });
    }
    
    console.log('📍 Pontos recebidos do frontend:', JSON.stringify(pontos, null, 2));
    
    if (pontos.length > 80) {
      return res.status(400).json({ error: 'Máximo de 80 pontos permitido' });
    }
    
    // NOVO - Validação: ordenar só permite até 20 pontos
    if (ordenar && pontos.length > 20) {
      return res.status(400).json({ error: 'Ordenação automática permite máximo de 20 pontos' });
    }
    
    // Montar payload para API Tutts - MÍNIMO conforme documentação
    const pontosFormatados = pontos.map(p => {
      // Se rua estiver vazia, usar endereco_completo como fallback
      let rua = p.rua || '';
      if (!rua && p.endereco_completo) {
        rua = p.endereco_completo;
      }
      if (!rua && p.latitude && p.longitude) {
        rua = `Coordenadas: ${p.latitude}, ${p.longitude}`;
      }
      
      const ponto = {
        rua: rua,
        numero: p.numero || '',
        bairro: p.bairro || '',
        cidade: p.cidade || '',
        uf: p.uf || '',
        obs: p.observacao || ''
      };
      
      // Adicionar coordenadas se existirem
      if (p.latitude) ponto.la = String(p.latitude);
      if (p.longitude) ponto.lo = String(p.longitude);
      if (p.cep) ponto.cep = p.cep;
      if (p.complemento) ponto.complemento = p.complemento;
      if (p.telefone) ponto.telefone = p.telefone;
      if (p.procurar_por) ponto.procurarPor = p.procurar_por;
      if (p.numero_nota) ponto.numeroNota = p.numero_nota;
      if (p.codigo_finalizar) ponto.codigoFinalizarEnd = p.codigo_finalizar;
      
      return ponto;
    });
    
    const payloadTutts = {
      token: req.clienteSolicitacao.tutts_token_api,
      codCliente: req.clienteSolicitacao.tutts_codigo_cliente,
      Usuario: usuario_solicitante || req.clienteSolicitacao.nome,
      centroCusto: centro_custo || req.clienteSolicitacao.centro_custo_padrao || req.clienteSolicitacao.nome || 'Central',
      pontos: pontosFormatados,
      retorno: retorno ? 'S' : 'N',
      formaPagamento: forma_pagamento || req.clienteSolicitacao.forma_pagamento_padrao || 'F'
    };
    
    // Adicionar campos opcionais apenas se tiverem valor
    if (numero_pedido) payloadTutts.numeroPedido = numero_pedido;
    if (data_retirada) payloadTutts.DataRetirada = data_retirada;
    if (codigo_profissional) payloadTutts.codigoProf = codigo_profissional;
    if (obs_retorno) payloadTutts.obsRetorno = obs_retorno;
    if (ponto_receber) payloadTutts.pontoReceber = String(ponto_receber);
    if (valor_rota_profissional) payloadTutts.valorRotaProfissional = String(valor_rota_profissional);
    if (valor_rota_servico) payloadTutts.valorRotaServico = String(valor_rota_servico);
    if (ordenar) payloadTutts.ordenar = 'true';
    if (sem_profissional) payloadTutts.semProfissional = 'S';
    
    console.log('📤 Enviando solicitação para API Tutts:', JSON.stringify(payloadTutts, null, 2));
    console.log('🔧 Modo teste (semProfissional):', sem_profissional ? 'ATIVADO' : 'desativado');
    console.log('🔑 Token usado:', payloadTutts.token);
    console.log('🏢 Código cliente usado:', payloadTutts.codCliente);
    
    // Enviar para API Tutts
    const response = await httpRequest('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadTutts)
    });
    
    const resultado = await response.json();
    console.log('📥 Resposta da API Tutts:', resultado);
    
    // Salvar no banco independente do resultado
    const solicitacao = await pool.query(`
      INSERT INTO solicitacoes_corrida (
        cliente_id, numero_pedido, centro_custo, usuario_solicitante,
        data_retirada, forma_pagamento, ponto_receber, retorno, obs_retorno,
        ordenar, codigo_profissional, valor_rota_profissional, valor_rota_servico,
        tutts_os_numero, tutts_distancia, tutts_duracao, tutts_valor, tutts_url_rastreamento,
        status, erro_mensagem,
        profissional_nome, profissional_foto, profissional_telefone, profissional_placa
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id
    `, [
      req.clienteSolicitacao.id,
      numero_pedido,
      centro_custo,
      usuario_solicitante || req.clienteSolicitacao.nome,
      data_retirada || null,
      forma_pagamento || req.clienteSolicitacao.forma_pagamento_padrao || 'F',
      ponto_receber,
      retorno || false,
      obs_retorno,
      ordenar || false,
      codigo_profissional,
      valor_rota_profissional,
      valor_rota_servico,
      resultado.Sucesso || null,
      resultado.detalhes?.distancia || null,
      resultado.detalhes?.duracao || null,
      resultado.detalhes?.valor ? parseFloat(resultado.detalhes.valor) : null,
      resultado.detalhes?.urlRastreamento || null,
      resultado.Sucesso ? 'enviado' : 'erro',
      resultado.Erro || null,
      profissional_nome || null,
      profissional_foto || null,
      profissional_telefone || null,
      profissional_placa || null
    ]);
    
    const solicitacaoId = solicitacao.rows[0].id;
    
    // Salvar pontos
    for (let i = 0; i < pontos.length; i++) {
      const p = pontos[i];
      // Montar endereco_completo se não vier do frontend
      const enderecoCompleto = p.endereco_completo || [p.rua, p.numero, p.bairro, p.cidade, p.uf].filter(x => x && x.trim()).join(', ');
      await pool.query(`
        INSERT INTO solicitacoes_pontos (
          solicitacao_id, ordem, rua, numero, complemento, bairro, cidade, uf, cep,
          latitude, longitude, observacao, telefone, procurar_por, numero_nota, codigo_finalizar,
          status, endereco_completo
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        solicitacaoId, i + 1, p.rua, p.numero, p.complemento, p.bairro, p.cidade, p.uf, p.cep,
        p.latitude, p.longitude, p.observacao, p.telefone, p.procurar_por, p.numero_nota, p.codigo_finalizar,
        'pendente', enderecoCompleto
      ]);
    }
    
    if (resultado.Erro) {
      return res.status(400).json({ 
        error: resultado.Erro,
        solicitacao_id: solicitacaoId 
      });
    }
    
    // NOVO: Se enviou para profissional específico, consultar status para pegar foto
    if (codigo_profissional && resultado.Sucesso) {
      try {
        // Montar token de status
        let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
        if (tokenStatus && tokenStatus.includes('-gravar')) {
          tokenStatus = tokenStatus.replace('-gravar', '-status');
        } else if (tokenStatus && !tokenStatus.includes('-status')) {
          tokenStatus = tokenStatus + '-status';
        }
        
        const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
        
        if (tokenStatus && codCliente) {
          // Aguardar 1 segundo para dar tempo da Tutts processar
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Consultar status da OS recém criada
          const statusData = await consultarStatusTutts(tokenStatus, codCliente, [resultado.Sucesso]);
          
          if (statusData && !statusData.erro) {
            const dadosOS = statusData[resultado.Sucesso] || statusData[resultado.Sucesso.toString()];
            
            if (dadosOS) {
              const dadosProf = dadosOS.dadosProf || dadosOS.dadosProfissional || {};
              
              console.log('📸 [FOTO] Dados do profissional recebidos:', JSON.stringify(dadosProf, null, 2));
              
              // Atualizar com dados do profissional (incluindo foto)
              if (dadosProf.nome || dadosProf.foto || dadosProf.Foto) {
                await pool.query(`
                  UPDATE solicitacoes_corrida SET
                    profissional_nome = COALESCE($1, profissional_nome),
                    profissional_foto = COALESCE($2, profissional_foto),
                    profissional_cpf = COALESCE($3, profissional_cpf),
                    profissional_placa = COALESCE($4, profissional_placa),
                    profissional_telefone = COALESCE($5, profissional_telefone),
                    profissional_email = COALESCE($6, profissional_email),
                    tutts_url_rastreamento = COALESCE($7, tutts_url_rastreamento),
                    atualizado_em = NOW()
                  WHERE id = $8
                `, [
                  dadosProf.nome || dadosProf.Nome || null,
                  dadosProf.foto || dadosProf.Foto || null,
                  dadosProf.cpf || dadosProf.CPF || null,
                  dadosProf.placa || dadosProf.Placa || null,
                  dadosProf.telefone || dadosProf.Telefone || null,
                  dadosProf.email || dadosProf.Email || null,
                  dadosOS.urlRastreamento || dadosOS.UrlRastreamento || null,
                  solicitacaoId
                ]);
                
                console.log('✅ [FOTO] Dados do profissional atualizados para OS', resultado.Sucesso);
              }
            }
          }
        }
      } catch (errStatus) {
        // Não falhar a criação se a consulta de status der erro
        console.log('⚠️ [FOTO] Erro ao consultar status (não crítico):', errStatus.message);
      }
    }
    
    res.json({
      sucesso: true,
      solicitacao_id: solicitacaoId,
      os_numero: resultado.Sucesso,
      detalhes: resultado.detalhes,
      modo_teste: sem_profissional || false  // NOVO - Informa se foi modo teste
    });
    
  } catch (err) {
    console.error('❌ Erro ao solicitar corrida:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao solicitar corrida', detalhe: err.message });
  }
});

// Listar histórico de solicitações
app.get('/api/solicitacao/historico', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { limite = 20, pagina = 1, status } = req.query;
    const offset = (pagina - 1) * limite;
    
    let query = `
      SELECT s.*, 
        (SELECT COUNT(*) FROM solicitacoes_pontos WHERE solicitacao_id = s.id) as total_pontos,
        (SELECT numero_nota FROM solicitacoes_pontos WHERE solicitacao_id = s.id AND numero_nota IS NOT NULL AND numero_nota != '' ORDER BY ordem LIMIT 1) as primeiro_numero_nota
      FROM solicitacoes_corrida s
      WHERE s.cliente_id = $1
    `;
    const params = [req.clienteSolicitacao.id];
    
    if (status) {
      query += ` AND s.status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY s.criado_em DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limite, offset);
    
    const result = await pool.query(query, params);
    
    // Contar total
    const total = await pool.query(
      'SELECT COUNT(*) FROM solicitacoes_corrida WHERE cliente_id = $1' + (status ? ' AND status = $2' : ''),
      status ? [req.clienteSolicitacao.id, status] : [req.clienteSolicitacao.id]
    );
    
    res.json({
      solicitacoes: result.rows,
      total: parseInt(total.rows[0].count),
      pagina: parseInt(pagina),
      limite: parseInt(limite)
    });
  } catch (err) {
    console.error('❌ Erro ao listar histórico:', err);
    res.status(500).json({ error: 'Erro ao listar histórico' });
  }
});

// Buscar detalhes de uma solicitação

// Buscar detalhes de uma solicitação (COM MERGE DE DADOS DO WEBHOOK)
app.get('/api/solicitacao/corrida/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar solicitação incluindo dados_pontos do webhook
    const solicitacao = await pool.query(
      'SELECT * FROM solicitacoes_corrida WHERE id = $1 AND cliente_id = $2',
      [id, req.clienteSolicitacao.id]
    );
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }
    
    const corridaData = solicitacao.rows[0];
    
    // Buscar pontos da tabela solicitacoes_pontos
    const pontosResult = await pool.query(
      'SELECT * FROM solicitacoes_pontos WHERE solicitacao_id = $1 ORDER BY ordem',
      [id]
    );
    
    let pontos = pontosResult.rows;
    
    // Fazer merge com dados_pontos do webhook (se existir)
    // O webhook /api/webhook/tutts salva dados detalhados em dados_pontos
    let dadosPontosWebhook = corridaData.dados_pontos;
    if (dadosPontosWebhook) {
      // Parse se for string
      if (typeof dadosPontosWebhook === 'string') {
        try {
          dadosPontosWebhook = JSON.parse(dadosPontosWebhook);
        } catch (e) {
          dadosPontosWebhook = [];
        }
      }
      
      // Fazer merge: dados do webhook complementam dados da tabela
      if (Array.isArray(dadosPontosWebhook) && dadosPontosWebhook.length > 0) {
        pontos = pontos.map((ponto, idx) => {
          const dadosWebhook = dadosPontosWebhook[idx] || {};
          
          // Priorizar dados do webhook se existirem (são mais atualizados)
          return {
            ...ponto,
            // Status do ponto (webhook pode ter atualização mais recente)
            status: dadosWebhook.status || ponto.status || 'pendente',
            status_codigo: dadosWebhook.status_codigo || ponto.status_codigo,
            status_completo: dadosWebhook.status_completo || ponto.status_completo,
            status_descricao: dadosWebhook.status_descricao || ponto.status_descricao,
            
            // Datas do webhook
            data_evento: dadosWebhook.data_evento || ponto.data_evento,
            data_chegada: dadosWebhook.data_evento && dadosWebhook.status === 'chegou' 
              ? dadosWebhook.data_evento 
              : ponto.data_chegada,
            data_coletado: dadosWebhook.data_coletado || ponto.data_coletado,
            data_finalizado: dadosWebhook.data_evento && dadosWebhook.status === 'finalizado'
              ? dadosWebhook.data_evento
              : ponto.data_finalizado,
            
            // Métricas do webhook
            tempo_espera: dadosWebhook.tempo_espera || ponto.tempo_espera,
            distancia_ultimo_ponto: dadosWebhook.distancia_ultimo_ponto,
            tempo_ultimo_ponto: dadosWebhook.tempo_ultimo_ponto,
            
            // Coordenadas de chegada
            lat_chegada: dadosWebhook.lat_chegada,
            lon_chegada: dadosWebhook.lon_chegada,
            
            // Endereço completo (webhook pode ter versão atualizada)
            endereco_completo: dadosWebhook.endereco_completo || ponto.endereco_completo || 
              [ponto.rua, ponto.numero, ponto.bairro, ponto.cidade].filter(Boolean).join(', '),
            
            // Motivo de finalização
            motivo_finalizacao: dadosWebhook.motivo_tipo || ponto.motivo_finalizacao,
            motivo_descricao: dadosWebhook.motivo_descricao || ponto.motivo_descricao,
            
            // Assinatura e fotos
            assinatura: dadosWebhook.assinatura || (ponto.assinatura ? 
              (typeof ponto.assinatura === 'string' ? JSON.parse(ponto.assinatura) : ponto.assinatura) : null),
            fotos: dadosWebhook.protocolo_fotos || (ponto.fotos ?
              (typeof ponto.fotos === 'string' ? JSON.parse(ponto.fotos) : ponto.fotos) : null),
            
            // Dados de retorno
            is_retorno: dadosWebhook.is_retorno || ponto.is_retorno || false,
            ponto_retorno_de: dadosWebhook.ponto_retorno_de || ponto.ponto_retorno_de || null,
            tipo_ponto: dadosWebhook.tipo_ponto || ponto.tipo_ponto || null,
            
            // Outros dados
            numero_nota: dadosWebhook.numero_nota || ponto.numero_nota,
            observacao: dadosWebhook.observacao || ponto.observacao
          };
        });
        
        // Verificar se existem pontos extras no webhook (pontos de retorno adicionados pela Tutts)
        if (dadosPontosWebhook.length > pontos.length) {
          console.log(`🔄 [GET] Detectados ${dadosPontosWebhook.length - pontos.length} ponto(s) extra(s) (possíveis retornos)`);
          
          // Adicionar pontos extras (retornos)
          for (let i = pontos.length; i < dadosPontosWebhook.length; i++) {
            const dadosWebhook = dadosPontosWebhook[i];
            pontos.push({
              id: null,
              ordem: i + 1,
              status: dadosWebhook.status || 'pendente',
              endereco_completo: dadosWebhook.endereco_completo || 'Ponto de Retorno',
              is_retorno: true,
              ponto_retorno_de: dadosWebhook.ponto_retorno_de,
              tipo_ponto: dadosWebhook.tipo_ponto || 'retorno',
              data_chegada: dadosWebhook.data_evento && dadosWebhook.status === 'chegou' ? dadosWebhook.data_evento : null,
              data_finalizado: dadosWebhook.data_evento && dadosWebhook.status === 'finalizado' ? dadosWebhook.data_evento : null,
              motivo_finalizacao: dadosWebhook.motivo_tipo,
              motivo_descricao: dadosWebhook.motivo_descricao,
              fotos: dadosWebhook.protocolo_fotos
            });
          }
        }
      }
    }
    
    // Retornar dados completos
    res.json({
      ...corridaData,
      pontos: pontos
    });
    
  } catch (err) {
    console.error('❌ Erro ao buscar solicitação:', err);
    res.status(500).json({ error: 'Erro ao buscar solicitação' });
  }
});


// Cancelar corrida - chama API Tutts para cancelar de verdade
app.patch('/api/solicitacao/corrida/:id/cancelar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se a corrida pertence ao cliente
    const solicitacao = await pool.query(
      'SELECT id, status, tutts_os_numero FROM solicitacoes_corrida WHERE id = $1 AND cliente_id = $2',
      [id, req.clienteSolicitacao.id]
    );
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }
    
    const osNumero = solicitacao.rows[0].tutts_os_numero;
    
    // Não permitir cancelar se já finalizada ou cancelada
    if (['finalizado', 'cancelado'].includes(solicitacao.rows[0].status)) {
      return res.status(400).json({ error: 'Esta corrida já está ' + solicitacao.rows[0].status });
    }
    
    // Obter token de cancelamento do cliente
    // O token de cancelamento tem sufixo "-cancelar" em vez de "-gravar"
    let tokenCancelar = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenCancelar && tokenCancelar.includes('-gravar')) {
      tokenCancelar = tokenCancelar.replace('-gravar', '-cancelar');
    } else if (tokenCancelar && !tokenCancelar.includes('-cancelar')) {
      tokenCancelar = tokenCancelar + '-cancelar';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    // Se tem OS na Tutts, tentar cancelar lá também
    let cancelouNaTutts = false;
    let erroTutts = null;
    
    if (osNumero && tokenCancelar && codCliente) {
      try {
        const payloadTutts = {
          token: tokenCancelar,
          codCliente: codCliente,
          OS: osNumero.toString()
        };
        
        console.log('❌ [CANCELAR TUTTS] Enviando cancelamento:', JSON.stringify(payloadTutts, null, 2));
        
        const respTutts = await fetch('https://tutts.com.br/integracao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadTutts)
        });
        
        const dataTutts = await respTutts.json();
        console.log('📥 [CANCELAR TUTTS] Resposta:', dataTutts);
        
        if (dataTutts.Sucesso || dataTutts.sucesso) {
          cancelouNaTutts = true;
          console.log(`✅ [CANCELAR TUTTS] OS ${osNumero} cancelada com sucesso na Tutts`);
        } else if (dataTutts.Erro || dataTutts.erro) {
          erroTutts = dataTutts.Erro || dataTutts.erro;
          console.log(`⚠️ [CANCELAR TUTTS] Erro ao cancelar OS ${osNumero}: ${erroTutts}`);
          
          // Se erro é "Alocado", significa que já está em execução
          if (erroTutts === 'Alocado') {
            return res.status(400).json({ 
              error: 'Não é possível cancelar: serviço em execução ou já finalizado na Tutts',
              erro_tutts: erroTutts
            });
          }
        }
      } catch (errTutts) {
        console.error('❌ [CANCELAR TUTTS] Erro na requisição:', errTutts.message);
        erroTutts = errTutts.message;
      }
    }
    
    // Atualizar status para cancelado no nosso banco
    await pool.query(`
      UPDATE solicitacoes_corrida 
      SET status = 'cancelado', 
          atualizado_em = NOW(),
          ultima_atualizacao = NOW()
      WHERE id = $1
    `, [id]);
    
    console.log(`❌ [CANCELAR] OS ${osNumero || id} cancelada pelo cliente ${req.clienteSolicitacao.nome}`);
    
    res.json({ 
      sucesso: true, 
      mensagem: cancelouNaTutts ? 'Corrida cancelada na Tutts e no sistema' : 'Corrida marcada como cancelada',
      cancelou_tutts: cancelouNaTutts,
      erro_tutts: erroTutts
    });
  } catch (err) {
    console.error('❌ Erro ao cancelar corrida:', err);
    res.status(500).json({ error: 'Erro ao cancelar corrida' });
  }
});

// Sincronizar status das corridas ativas com a Tutts
app.post('/api/solicitacao/sincronizar', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Buscar corridas ativas do cliente que tem OS na Tutts
    const corridasAtivas = await pool.query(`
      SELECT id, tutts_os_numero, status 
      FROM solicitacoes_corrida 
      WHERE cliente_id = $1 
        AND status IN ('enviado', 'aceito', 'em_andamento')
        AND tutts_os_numero IS NOT NULL
      ORDER BY criado_em DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    if (corridasAtivas.rows.length === 0) {
      return res.json({ 
        sucesso: true, 
        mensagem: 'Nenhuma corrida ativa para sincronizar',
        atualizadas: 0 
      });
    }
    
    // Montar token de status
    let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenStatus && tokenStatus.includes('-gravar')) {
      tokenStatus = tokenStatus.replace('-gravar', '-status');
    } else if (tokenStatus && !tokenStatus.includes('-status')) {
      tokenStatus = tokenStatus + '-status';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!tokenStatus || !codCliente) {
      return res.status(400).json({ error: 'Cliente não tem credenciais da Tutts configuradas' });
    }
    
    // Pegar lista de OS para consultar
    const listaOS = corridasAtivas.rows.map(c => c.tutts_os_numero);
    
    console.log(`🔄 [SINCRONIZAR] Consultando ${listaOS.length} OS na Tutts:`, listaOS);
    
    // Chamar API da Tutts
    const payloadTutts = {
      token: tokenStatus,
      codCliente: codCliente,
      servicos: listaOS
    };
    
    const respTutts = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadTutts)
    });
    
    const dataTutts = await respTutts.json();
    console.log('📥 [SINCRONIZAR] Resposta da Tutts recebida');
    
    if (dataTutts.Erro) {
      console.error('❌ [SINCRONIZAR] Erro da Tutts:', dataTutts.Erro);
      return res.status(400).json({ error: dataTutts.Erro });
    }
    
    if (!dataTutts.Sucesso) {
      return res.status(400).json({ error: 'Resposta inválida da Tutts' });
    }
    
    // Mapear status da Tutts para nosso sistema
    const mapearStatus = (statusTutts) => {
      switch (statusTutts) {
        case 'SP': return 'enviado';      // Sem profissional
        case 'A': return 'em_andamento';  // Em execução
        case 'F': return 'finalizado';    // Finalizado
        case 'C': return 'cancelado';     // Cancelado
        case 'V': return 'enviado';       // Aguardando análise
        case 'U': return 'enviado';       // Aguardando autorização
        default: return null;
      }
    };
    
    let atualizadas = 0;
    let finalizadas = 0;
    let canceladas = 0;
    
    // Processar cada OS retornada
    for (const os of listaOS) {
      const dadosOS = dataTutts.Sucesso[os];
      if (!dadosOS) continue;
      
      const novoStatus = mapearStatus(dadosOS.status);
      if (!novoStatus) continue;
      
      // Buscar corrida no nosso banco
      const corrida = corridasAtivas.rows.find(c => c.tutts_os_numero === os || c.tutts_os_numero === os.toString());
      if (!corrida) continue;
      
      // Só atualizar se status mudou
      if (corrida.status !== novoStatus) {
        // Extrair dados do profissional
        const dadosProf = dadosOS.dadosProf || dadosOS.dadosProfissional || {};
        
        await pool.query(`
          UPDATE solicitacoes_corrida SET
            status = $1,
            profissional_nome = COALESCE($2, profissional_nome),
            profissional_cpf = COALESCE($3, profissional_cpf),
            profissional_placa = COALESCE($4, profissional_placa),
            tutts_url_rastreamento = COALESCE($5, tutts_url_rastreamento),
            dados_pontos = COALESCE($6, dados_pontos),
            ultima_atualizacao = NOW(),
            atualizado_em = NOW()
          WHERE id = $7
        `, [
          novoStatus,
          dadosProf.nome || null,
          dadosProf.cpf || null,
          dadosProf.placa || null,
          dadosOS.urlRastreamento || null,
          dadosOS.pontos ? JSON.stringify(dadosOS.pontos) : null,
          corrida.id
        ]);
        
        atualizadas++;
        if (novoStatus === 'finalizado') finalizadas++;
        if (novoStatus === 'cancelado') canceladas++;
        
        console.log(`✅ [SINCRONIZAR] OS ${os}: ${corrida.status} → ${novoStatus}`);
      }
    }
    
    console.log(`🔄 [SINCRONIZAR] Concluído: ${atualizadas} atualizadas, ${finalizadas} finalizadas, ${canceladas} canceladas`);
    
    res.json({ 
      sucesso: true, 
      mensagem: `Sincronização concluída`,
      total_consultadas: listaOS.length,
      atualizadas,
      finalizadas,
      canceladas
    });
    
  } catch (err) {
    console.error('❌ Erro ao sincronizar:', err);
    res.status(500).json({ error: 'Erro ao sincronizar com a Tutts' });
  }
});

// ==================== SINCRONIZAÇÃO DE STATUS COM TUTTS ====================

// Consultar status de uma ou mais OS na Tutts
async function consultarStatusTutts(tokenStatus, codCliente, osNumeros) {
  try {
    const payload = {
      token: tokenStatus,
      codCliente: codCliente,
      servicos: osNumeros.map(os => parseInt(os))
    };
    
    console.log('🔄 [STATUS TUTTS] Consultando:', osNumeros.join(', '));
    
    const resp = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await resp.json();
    
    if (data.Erro) {
      console.log('⚠️ [STATUS TUTTS] Erro:', data.Erro);
      return { erro: data.Erro };
    }
    
    return data.Sucesso || data;
  } catch (err) {
    console.error('❌ [STATUS TUTTS] Erro na requisição:', err.message);
    return { erro: err.message };
  }
}

// Mapear status da Tutts para nosso sistema
function mapearStatusTutts(statusTutts) {
  const mapa = {
    'SP': 'enviado',      // Sem profissional
    'A': 'em_andamento',  // Em execução
    'F': 'finalizado',    // Finalizado
    'C': 'cancelado',     // Cancelado
    'V': 'enviado',       // Aguardando análise
    'U': 'enviado'        // Aguardando autorização
  };
  return mapa[statusTutts] || 'enviado';
}

// Endpoint para sincronizar status das corridas ativas de um cliente
app.post('/api/solicitacao/sincronizar', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Buscar corridas ativas do cliente
    const corridasAtivas = await pool.query(`
      SELECT id, tutts_os_numero, status 
      FROM solicitacoes_corrida 
      WHERE cliente_id = $1 
        AND status IN ('enviado', 'aceito', 'em_andamento')
        AND tutts_os_numero IS NOT NULL
      ORDER BY criado_em DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    if (corridasAtivas.rows.length === 0) {
      return res.json({ sucesso: true, mensagem: 'Nenhuma corrida ativa para sincronizar', atualizadas: 0 });
    }
    
    // Obter token de status do cliente
    let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenStatus && tokenStatus.includes('-gravar')) {
      tokenStatus = tokenStatus.replace('-gravar', '-status');
    } else if (tokenStatus && !tokenStatus.includes('-status')) {
      tokenStatus = tokenStatus + '-status';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!tokenStatus || !codCliente) {
      return res.status(400).json({ error: 'Cliente não tem credenciais Tutts configuradas' });
    }
    
    // Consultar status na Tutts
    const osNumeros = corridasAtivas.rows.map(c => c.tutts_os_numero);
    const statusTutts = await consultarStatusTutts(tokenStatus, codCliente, osNumeros);
    
    if (statusTutts.erro) {
      return res.status(400).json({ error: 'Erro ao consultar Tutts: ' + statusTutts.erro });
    }
    
    // Atualizar cada corrida
    let atualizadas = 0;
    let canceladas = 0;
    let finalizadas = 0;
    
    for (const corrida of corridasAtivas.rows) {
      const osNum = corrida.tutts_os_numero.toString();
      const dadosOS = statusTutts[osNum];
      
      if (dadosOS) {
        const novoStatus = mapearStatusTutts(dadosOS.status);
        
        // Só atualizar se status mudou
        if (novoStatus !== corrida.status) {
          // Extrair dados do profissional
          const dadosProf = dadosOS.dadosProfissional || dadosOS.dadosProf || {};
          
          await pool.query(`
            UPDATE solicitacoes_corrida SET
              status = $1,
              profissional_nome = COALESCE($2, profissional_nome),
              profissional_cpf = COALESCE($3, profissional_cpf),
              profissional_placa = COALESCE($4, profissional_placa),
              tutts_url_rastreamento = COALESCE($5, tutts_url_rastreamento),
              ultima_atualizacao = NOW(),
              atualizado_em = NOW()
            WHERE id = $6
          `, [
            novoStatus,
            dadosProf.nome || null,
            dadosProf.cpf || null,
            dadosProf.placa || null,
            dadosOS.urlRastreamento || null,
            corrida.id
          ]);
          
          atualizadas++;
          if (novoStatus === 'cancelado') canceladas++;
          if (novoStatus === 'finalizado') finalizadas++;
          
          console.log(`🔄 [SYNC] OS ${osNum}: ${corrida.status} → ${novoStatus}`);
        }
      }
    }
    
    console.log(`✅ [SYNC] Cliente ${req.clienteSolicitacao.nome}: ${atualizadas} atualizadas, ${canceladas} canceladas, ${finalizadas} finalizadas`);
    
    res.json({ 
      sucesso: true, 
      total: corridasAtivas.rows.length,
      atualizadas,
      canceladas,
      finalizadas,
      mensagem: atualizadas > 0 
        ? `${atualizadas} corrida(s) atualizada(s)${canceladas > 0 ? `, ${canceladas} cancelada(s)` : ''}${finalizadas > 0 ? `, ${finalizadas} finalizada(s)` : ''}`
        : 'Todas as corridas já estão sincronizadas'
    });
  } catch (err) {
    console.error('❌ Erro ao sincronizar:', err);
    res.status(500).json({ error: 'Erro ao sincronizar status' });
  }
});

// Salvar endereço favorito
app.post('/api/solicitacao/favoritos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { apelido, rua, numero, complemento, bairro, cidade, uf, cep, latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao } = req.body;
    
    if (!rua || !cidade) {
      return res.status(400).json({ error: 'Rua e cidade são obrigatórios' });
    }
    
    // Verificar se já existe
    const existe = await pool.query(
      'SELECT id FROM solicitacao_favoritos WHERE cliente_id = $1 AND rua = $2 AND numero = $3 AND cidade = $4',
      [req.clienteSolicitacao.id, rua, numero, cidade]
    );
    
    if (existe.rows.length > 0) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP,
            latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude)
        WHERE id = $1
      `, [existe.rows[0].id, latitude, longitude]);
      
      return res.json({ sucesso: true, id: existe.rows[0].id, atualizado: true });
    }
    
    const result = await pool.query(`
      INSERT INTO solicitacao_favoritos (
        cliente_id, apelido, rua, numero, complemento, bairro, cidade, uf, cep,
        latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      req.clienteSolicitacao.id, apelido, rua, numero, complemento, bairro, cidade, uf, cep,
      latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
    ]);
    
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar favorito:', err);
    res.status(500).json({ error: 'Erro ao salvar favorito' });
  }
});

// Listar favoritos
app.get('/api/solicitacao/favoritos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM solicitacao_favoritos 
      WHERE cliente_id = $1 
      ORDER BY vezes_usado DESC, ultimo_uso DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar favoritos:', err);
    res.status(500).json({ error: 'Erro ao listar favoritos' });
  }
});

// Deletar favorito
app.delete('/api/solicitacao/favoritos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM solicitacao_favoritos WHERE id = $1 AND cliente_id = $2',
      [req.params.id, req.clienteSolicitacao.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao deletar favorito:', err);
    res.status(500).json({ error: 'Erro ao deletar favorito' });
  }
});

// ==================== ENDEREÇOS SALVOS (novo padrão) ====================

// Salvar endereço
app.post('/api/solicitacao/enderecos-salvos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep, latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao } = req.body;
    
    console.log('📍 Salvando endereço:', { apelido, endereco_completo, rua, cidade });
    
    if (!endereco_completo && !rua) {
      return res.status(400).json({ error: 'Endereço é obrigatório' });
    }
    
    // Verificar se já existe pelo endereço completo ou rua+numero+cidade
    const existe = await pool.query(
      `SELECT id FROM solicitacao_favoritos 
       WHERE cliente_id = $1 AND (
         (endereco_completo = $2 AND $2 IS NOT NULL) OR 
         (rua = $3 AND numero = $4 AND cidade = $5)
       )`,
      [req.clienteSolicitacao.id, endereco_completo, rua, numero, cidade]
    );
    
    if (existe.rows.length > 0) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET apelido = COALESCE($2, apelido),
            vezes_usado = vezes_usado + 1, 
            ultimo_uso = CURRENT_TIMESTAMP,
            latitude = COALESCE($3, latitude), 
            longitude = COALESCE($4, longitude)
        WHERE id = $1
      `, [existe.rows[0].id, apelido, latitude, longitude]);
      
      return res.json({ sucesso: true, id: existe.rows[0].id, atualizado: true });
    }
    
    const result = await pool.query(`
      INSERT INTO solicitacao_favoritos (
        cliente_id, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
        latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [
      req.clienteSolicitacao.id, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
      latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
    ]);
    
    console.log('✅ Endereço salvo com ID:', result.rows[0].id);
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar endereço:', err);
    res.status(500).json({ error: 'Erro ao salvar endereço' });
  }
});

// Buscar endereços salvos
app.get('/api/solicitacao/enderecos-salvos/buscar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { q } = req.query;
    
    let query = `
      SELECT * FROM solicitacao_favoritos 
      WHERE cliente_id = $1
    `;
    let params = [req.clienteSolicitacao.id];
    
    if (q && q.trim()) {
      query += ` AND (
        apelido ILIKE $2 OR 
        endereco_completo ILIKE $2 OR 
        rua ILIKE $2 OR 
        bairro ILIKE $2 OR 
        cidade ILIKE $2
      )`;
      params.push(`%${q.trim()}%`);
    }
    
    query += ` ORDER BY vezes_usado DESC, ultimo_uso DESC LIMIT 50`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar endereços:', err);
    res.status(500).json({ error: 'Erro ao buscar endereços' });
  }
});

// Registrar uso de endereço (POST)
app.post('/api/solicitacao/enderecos-salvos/:id/usar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE solicitacao_favoritos 
      SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
      WHERE id = $1 AND cliente_id = $2
    `, [id, req.clienteSolicitacao.id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao registrar uso:', err);
    res.status(500).json({ error: 'Erro ao registrar uso' });
  }
});

// Registrar uso de endereço (PATCH)
app.patch('/api/solicitacao/enderecos-salvos/:id/usar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE solicitacao_favoritos 
      SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
      WHERE id = $1 AND cliente_id = $2
    `, [id, req.clienteSolicitacao.id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao registrar uso:', err);
    res.status(500).json({ error: 'Erro ao registrar uso' });
  }
});

// Deletar endereço salvo
app.delete('/api/solicitacao/enderecos-salvos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM solicitacao_favoritos WHERE id = $1 AND cliente_id = $2',
      [req.params.id, req.clienteSolicitacao.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao deletar endereço:', err);
    res.status(500).json({ error: 'Erro ao deletar endereço' });
  }
});

// BUSCAR PROFISSIONAIS - Lista motoboys disponíveis para o cliente
app.get('/api/solicitacao/profissionais', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Usar token global de profissionais
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!codCliente) {
      return res.json({ 
        profissionais: [], 
        aviso: 'Código do cliente não configurado.'
      });
    }
    
    // Buscar profissionais na API Tutts
    const payloadTutts = {
      token: TUTTS_TOKENS.PROFISSIONAIS,
      codCliente: codCliente
    };
    
    console.log('📤 Buscando profissionais na Tutts:', JSON.stringify(payloadTutts, null, 2));
    
    const response = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadTutts)
    });
    
    const resultado = await response.json();
    console.log('📥 Resposta profissionais Tutts:', resultado);
    
    if (resultado.Erro) {
      console.log('⚠️ Erro ao buscar profissionais:', resultado.Erro);
      return res.json({ 
        profissionais: [], 
        erro: resultado.Erro 
      });
    }
    
    if (resultado.Sucesso && Array.isArray(resultado.Sucesso)) {
      return res.json({ 
        profissionais: resultado.Sucesso.map(p => ({
          codigo: p.codigo,
          nome: p.nome,
          foto: p.foto || p.Foto || null,
          telefone: p.telefone || null,
          placa: p.placa || null,
          veiculo: p.veiculo || p.modeloVeiculo || null
        }))
      });
    }
    
    res.json({ profissionais: [] });
    
  } catch (err) {
    console.error('❌ Erro ao buscar profissionais:', err.message);
    res.status(500).json({ error: 'Erro ao buscar profissionais', detalhe: err.message });
  }
});

// RASTREIO PÚBLICO - Acompanhar corrida sem login (para compartilhar)
app.get('/api/rastreio/:codigo', async (req, res) => {
  try {
    const { codigo } = req.params;
    
    // Buscar por OS número ou por código de rastreio
    const solicitacao = await pool.query(`
      SELECT 
        s.id, s.tutts_os_numero, s.status, s.status_codigo, s.status_atualizado_em,
        s.tutts_distancia, s.tutts_duracao, s.tutts_valor, s.tutts_url_rastreamento,
        s.profissional_nome, s.profissional_foto, s.profissional_placa, 
        s.profissional_veiculo, s.profissional_cor_veiculo,
        s.criado_em, s.atualizado_em,
        c.empresa as cliente_empresa
      FROM solicitacoes_corrida s
      LEFT JOIN clientes_solicitacao c ON s.cliente_id = c.id
      WHERE s.tutts_os_numero = $1 OR s.codigo_rastreio = $1
    `, [codigo]);
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Corrida não encontrada' });
    }
    
    const dados = solicitacao.rows[0];
    
    // Buscar pontos (sem dados sensíveis)
    const pontos = await pool.query(`
      SELECT 
        ordem, bairro, cidade, uf, status, 
        data_chegada, data_coletado, data_finalizado
      FROM solicitacoes_pontos 
      WHERE solicitacao_id = $1 
      ORDER BY ordem
    `, [dados.id]);
    
    // Retornar dados públicos (sem expor endereços completos, telefones, etc)
    res.json({
      os_numero: dados.tutts_os_numero,
      status: dados.status,
      status_atualizado_em: dados.status_atualizado_em,
      distancia: dados.tutts_distancia,
      duracao: dados.tutts_duracao,
      url_rastreamento_tutts: dados.tutts_url_rastreamento,
      profissional: dados.profissional_nome ? {
        nome: dados.profissional_nome,
        foto: dados.profissional_foto,
        placa: dados.profissional_placa,
        veiculo: dados.profissional_veiculo,
        cor: dados.profissional_cor_veiculo
      } : null,
      empresa: dados.cliente_empresa,
      criado_em: dados.criado_em,
      pontos: pontos.rows.map(p => ({
        ordem: p.ordem,
        local: `${p.bairro || ''}, ${p.cidade || ''}`.replace(/^, |, $/g, ''),
        status: p.status,
        chegou_em: p.data_chegada,
        coletado_em: p.data_coletado,
        finalizado_em: p.data_finalizado
      }))
    });
    
  } catch (err) {
    console.error('❌ Erro ao buscar rastreio:', err);
    res.status(500).json({ error: 'Erro ao buscar rastreio' });
  }
});

// WEBHOOK - Receber notificações da API Tutts
app.post('/api/solicitacao/webhook/tutts', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📨 Webhook Tutts recebido:', JSON.stringify(payload, null, 2));
    
    // Salvar log do webhook
    await pool.query(
      'INSERT INTO solicitacao_webhooks_log (tutts_os_numero, payload) VALUES ($1, $2)',
      [payload.ID, JSON.stringify(payload)]
    );
    
    if (!payload.ID) {
      return res.status(400).json({ error: 'ID da OS não informado' });
    }
    
    // Buscar solicitação pelo número da OS
    const solicitacao = await pool.query(
      'SELECT id FROM solicitacoes_corrida WHERE tutts_os_numero = $1',
      [payload.ID]
    );
    
    if (solicitacao.rows.length === 0) {
      console.log('⚠️ OS não encontrada no sistema:', payload.ID);
      return res.json({ recebido: true, processado: false, motivo: 'OS não encontrada' });
    }
    
    const solicitacaoId = solicitacao.rows[0].id;
    const statusInfo = payload.Status;
    const statusCodigo = statusInfo?.ID;
    
    // Mapear status
    let novoStatus = 'enviado';
    if (statusCodigo === 0) novoStatus = 'aceito';
    else if (statusCodigo === 0.5 || statusCodigo === 0.75) novoStatus = 'em_andamento';
    else if (statusCodigo === 1) novoStatus = 'em_andamento';
    else if (statusCodigo === 2) novoStatus = 'finalizado';
    
    // Atualizar solicitação
    await pool.query(`
      UPDATE solicitacoes_corrida SET
        status = $1,
        status_codigo = $2,
        status_atualizado_em = CURRENT_TIMESTAMP,
        tutts_url_rastreamento = COALESCE($3, tutts_url_rastreamento),
        profissional_nome = COALESCE($4, profissional_nome),
        profissional_email = COALESCE($5, profissional_email),
        profissional_foto = COALESCE($6, profissional_foto),
        profissional_placa = COALESCE($7, profissional_placa),
        profissional_veiculo = COALESCE($8, profissional_veiculo),
        profissional_cor_veiculo = COALESCE($9, profissional_cor_veiculo),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $10
    `, [
      novoStatus,
      statusCodigo,
      payload.UrlRastreamento,
      statusInfo?.Nome,
      statusInfo?.Email,
      statusInfo?.Foto,
      statusInfo?.placa,
      statusInfo?.modeloVeiculo,
      statusInfo?.corVeiculo,
      solicitacaoId
    ]);
    
    // Atualizar ponto específico se informado
    if (payload.statusEndereco) {
      const endInfo = payload.statusEndereco;
      const pontoOrdem = endInfo.endereco?.ponto;
      
      if (pontoOrdem) {
        let statusPonto = 'pendente';
        if (endInfo.codigo === 'CHE') statusPonto = 'chegou';
        else if (endInfo.codigo === 'COL') statusPonto = 'coletado';
        else if (endInfo.codigo === 'FIN') statusPonto = 'finalizado';
        
        await pool.query(`
          UPDATE solicitacoes_pontos SET
            status = $1,
            status_atualizado_em = CURRENT_TIMESTAMP,
            data_chegada = CASE WHEN $1 = 'chegou' THEN CURRENT_TIMESTAMP ELSE data_chegada END,
            data_coletado = CASE WHEN $1 = 'coletado' THEN CURRENT_TIMESTAMP ELSE data_coletado END,
            data_finalizado = CASE WHEN $1 = 'finalizado' THEN CURRENT_TIMESTAMP ELSE data_finalizado END,
            motivo_finalizacao = COALESCE($2, motivo_finalizacao),
            motivo_descricao = COALESCE($3, motivo_descricao),
            tempo_espera = COALESCE($4, tempo_espera),
            fotos = COALESCE($5, fotos),
            assinatura = COALESCE($6, assinatura)
          WHERE solicitacao_id = $7 AND ordem = $8
        `, [
          statusPonto,
          endInfo.endereco?.motivo?.tipo,
          endInfo.endereco?.motivo?.descricao,
          endInfo.endereco?.tempoEspera,
          endInfo.endereco?.protocolo ? JSON.stringify(endInfo.endereco.protocolo) : null,
          endInfo.endereco?.assinatura ? JSON.stringify(endInfo.endereco.assinatura) : null,
          solicitacaoId,
          pontoOrdem
        ]);
      }
    }
    
    // Marcar webhook como processado
    await pool.query(
      'UPDATE solicitacao_webhooks_log SET processado = true WHERE tutts_os_numero = $1 ORDER BY id DESC LIMIT 1',
      [payload.ID]
    );
    
    res.json({ recebido: true, processado: true });
    
  } catch (err) {
    console.error('❌ Erro ao processar webhook:', err);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==================== ADMIN - Gerenciar clientes de solicitação ====================

// Criar cliente de solicitação (só admin da central)
app.post('/api/admin/solicitacao/clientes', verificarToken, async (req, res) => {
  try {
    // Aceita ambos os nomes (novo e antigo) para compatibilidade
    const { nome, email, senha, telefone, empresa, observacoes } = req.body;
    const tutts_token_api = req.body.tutts_token_api || req.body.tutts_token;
    const tutts_codigo_cliente = req.body.tutts_codigo_cliente || req.body.tutts_cod_cliente;
    
    console.log('📝 Criando cliente solicitação:', { nome, email, telefone, empresa, tutts_token_api: tutts_token_api ? '***' : null, tutts_codigo_cliente });
    
    if (!nome || !email || !senha || !tutts_token_api || !tutts_codigo_cliente) {
      return res.status(400).json({ error: 'Nome, email, senha, token Tutts e código cliente são obrigatórios' });
    }
    
    // Verificar se email já existe
    const existe = await pool.query(
      'SELECT id FROM clientes_solicitacao WHERE email = $1',
      [email.toLowerCase()]
    );
    
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    
    const senhaHash = await bcrypt.hash(senha, 10);
    const criado_por = req.user?.id || null;
    
    const result = await pool.query(`
      INSERT INTO clientes_solicitacao (nome, email, senha_hash, telefone, empresa, tutts_token_api, tutts_codigo_cliente, criado_por, observacoes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, nome, email, empresa
    `, [nome, email.toLowerCase(), senhaHash, telefone || null, empresa || null, tutts_token_api, tutts_codigo_cliente, criado_por, observacoes || null]);
    
    console.log('✅ Cliente solicitação criado:', result.rows[0]);
    res.json({ sucesso: true, cliente: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao criar cliente solicitação:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao criar cliente: ' + err.message });
  }
});

// Listar clientes de solicitação
app.get('/api/admin/solicitacao/clientes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.nome, c.email, c.telefone, c.empresa, c.ativo, c.criado_em, c.ultimo_acesso,
        c.tutts_codigo_cliente, c.tutts_codigo_cliente as tutts_cod_cliente, c.observacoes,
        (SELECT COUNT(*) FROM solicitacoes_corrida WHERE cliente_id = c.id) as total_solicitacoes
      FROM clientes_solicitacao c
      ORDER BY c.criado_em DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Ativar/Desativar cliente
app.patch('/api/admin/solicitacao/clientes/:id/ativo', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;
    
    await pool.query(
      'UPDATE clientes_solicitacao SET ativo = $1 WHERE id = $2',
      [ativo, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao atualizar cliente:', err);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// Resetar senha do cliente
app.patch('/api/admin/solicitacao/clientes/:id/senha', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nova_senha } = req.body;
    
    // Cliente pode ter senha simples (mínimo 6 caracteres)
    const validacaoSenha = validarSenhaSimples(nova_senha);
    if (!validacaoSenha.valido) {
      return res.status(400).json({ error: validacaoSenha.erro });
    }
    
    const senhaHash = await bcrypt.hash(nova_senha, 10);
    
    await pool.query(
      'UPDATE clientes_solicitacao SET senha_hash = $1 WHERE id = $2',
      [senhaHash, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao resetar senha:', err);
    res.status(500).json({ error: 'Erro ao resetar senha' });
  }
});

// Atualizar credenciais Tutts do cliente
app.patch('/api/admin/solicitacao/clientes/:id/credenciais', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    // Aceita ambos os nomes (novo e antigo) para compatibilidade
    const tutts_token_api = req.body.tutts_token_api || req.body.tutts_token;
    const tutts_codigo_cliente = req.body.tutts_codigo_cliente || req.body.tutts_cod_cliente;
    
    await pool.query(`
      UPDATE clientes_solicitacao 
      SET tutts_token_api = COALESCE($1, tutts_token_api),
          tutts_codigo_cliente = COALESCE($2, tutts_codigo_cliente)
      WHERE id = $3
    `, [tutts_token_api, tutts_codigo_cliente, id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao atualizar credenciais:', err);
    res.status(500).json({ error: 'Erro ao atualizar credenciais' });
  }
});

// Alterar status (ativo/inativo) do cliente de solicitação
app.patch('/api/admin/solicitacao/clientes/:id/status', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;
    
    await pool.query(
      'UPDATE clientes_solicitacao SET ativo = $1 WHERE id = $2',
      [ativo, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao alterar status:', err);
    res.status(500).json({ error: 'Erro ao alterar status' });
  }
});

// Excluir cliente de solicitação
app.delete('/api/admin/solicitacao/clientes/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se cliente existe
    const cliente = await pool.query('SELECT id, nome FROM clientes_solicitacao WHERE id = $1', [id]);
    if (cliente.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    
    // Excluir (as tabelas relacionadas têm ON DELETE CASCADE)
    await pool.query('DELETE FROM clientes_solicitacao WHERE id = $1', [id]);
    
    console.log(`🗑️ Cliente de solicitação excluído: ${cliente.rows[0].nome} (ID: ${id})`);
    res.json({ sucesso: true, mensagem: 'Cliente excluído com sucesso' });
  } catch (err) {
    console.error('❌ Erro ao excluir cliente:', err);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
});

// ==================== WEBHOOK TUTTS - NOTIFICAÇÕES EM TEMPO REAL ====================
// Endpoint para receber atualizações de status das corridas da Tutts
// URL para configurar na Tutts: https://tutts-backend-production.up.railway.app/api/webhook/tutts

app.post('/api/webhook/tutts', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📥 [WEBHOOK TUTTS] Notificação recebida:', JSON.stringify(payload, null, 2));
    
    // Extrair dados do payload conforme documentação
    const osNumero = payload.ID;
    const status = payload.Status;
    const urlRastreamento = payload.UrlRastreamento;
    const rotaProfissional = payload.rotaprofissional;
    const statusEndereco = payload.statusEndereco;
    
    if (!osNumero) {
      console.log('⚠️ [WEBHOOK] Payload sem ID da OS');
      return res.status(200).json({ recebido: true, mensagem: 'Payload sem ID' });
    }
    
    // Buscar a solicitação pelo número da OS
    const solicitacao = await pool.query(
      'SELECT id, status, dados_pontos FROM solicitacoes_corrida WHERE tutts_os_numero = $1',
      [osNumero]
    );
    
    if (solicitacao.rows.length === 0) {
      console.log(`⚠️ [WEBHOOK] OS ${osNumero} não encontrada no sistema`);
      return res.status(200).json({ recebido: true, mensagem: 'OS não encontrada' });
    }
    
    const solicitacaoId = solicitacao.rows[0].id;
    let dadosPontos = solicitacao.rows[0].dados_pontos || [];
    if (typeof dadosPontos === 'string') dadosPontos = JSON.parse(dadosPontos);
    
    // Mapear status da Tutts para nosso sistema
    let novoStatus = solicitacao.rows[0].status;
    let statusDescricao = '';
    let statusId = status?.ID !== undefined ? parseFloat(status.ID) : null;
    
    if (statusId !== null) {
      switch (statusId) {
        case 0:
          novoStatus = 'aceito';
          statusDescricao = 'Profissional recebeu a OS';
          break;
        case 0.5:
          novoStatus = 'em_andamento';
          statusDescricao = 'Profissional chegou no ponto';
          break;
        case 0.75:
          novoStatus = 'em_andamento';
          statusDescricao = 'Coleta confirmada';
          break;
        case 1:
          novoStatus = 'em_andamento';
          statusDescricao = 'Ponto finalizado';
          break;
        case 2:
          novoStatus = 'finalizado';
          statusDescricao = 'OS finalizada';
          break;
      }
    }
    
    // Dados do profissional
    const profissionalNome = status?.Nome || null;
    const profissionalEmail = status?.Email || null;
    const profissionalFoto = status?.Foto || null;
    const profissionalCpf = status?.cpf || null;
    const profissionalPlaca = status?.placa || null;
    const profissionalTelefone = status?.telefone || null;
    const profissionalCodigo = status?.codProf || null;
    const corVeiculo = status?.corVeiculo || null;
    const modeloVeiculo = status?.modeloVeiculo || null;
    const dataHoraStatus = status?.dataHora || null;
    
    // Se tiver info do endereço, atualizar o ponto específico
    if (statusEndereco?.endereco) {
      const pontoNumero = parseInt(statusEndereco.endereco.ponto);
      const pontoIdx = pontoNumero - 1; // Converter para 0-indexed
      
      // Determinar status do ponto
      let pontoStatus = 'pendente';
      const codigoStatus = statusEndereco.codigo?.toUpperCase();
      if (codigoStatus === 'FIN' || statusEndereco.codigoCompleto?.toUpperCase() === 'FINALIZADO') {
        pontoStatus = 'finalizado';
      } else if (codigoStatus === 'CHE' || statusEndereco.codigoCompleto?.toUpperCase() === 'CHEGOU') {
        pontoStatus = 'chegou';
      } else if (codigoStatus === 'COL' || statusEndereco.codigoCompleto?.toUpperCase() === 'COLETADO') {
        pontoStatus = 'coletado';
      }
      
      // Garantir que o array tem o ponto
      while (dadosPontos.length <= pontoIdx) {
        dadosPontos.push({});
      }
      
      // Atualizar dados do ponto
      dadosPontos[pontoIdx] = {
        ...dadosPontos[pontoIdx],
        status: pontoStatus,
        status_codigo: statusEndereco.codigo,
        status_completo: statusEndereco.codigoCompleto,
        status_descricao: statusEndereco.descricao,
        data_evento: statusEndereco.criadoEm,
        data_coletado: statusEndereco.endereco.dataColetado,
        tempo_espera: statusEndereco.endereco.tempoEspera,
        distancia_ultimo_ponto: statusEndereco.distanciaPercorridaUltimoPonto,
        tempo_ultimo_ponto: statusEndereco.tempoPercorridaUltimoPonto,
        lat_chegada: statusEndereco.endereco.latChegada,
        lon_chegada: statusEndereco.endereco.lonChegada,
        endereco_completo: statusEndereco.endereco.enderecoCompleto,
        // Dados de entrega
        assinatura: statusEndereco.endereco.assinatura || null,
        protocolo_fotos: statusEndereco.endereco.protocolo || null,
        motivo_tipo: statusEndereco.endereco.motivo?.tipo || null,
        motivo_descricao: statusEndereco.endereco.motivo?.descricao || null,
        numero_nota: statusEndereco.endereco.numeroNota || null,
        observacao: statusEndereco.endereco.obs || null,
        // Campos de retorno (quando há insucesso)
        is_retorno: statusEndereco.endereco.retorno === true || statusEndereco.endereco.isRetorno === true || false,
        ponto_retorno_de: statusEndereco.endereco.pontoRetornoDe || statusEndereco.endereco.retornoDe || null,
        tipo_ponto: statusEndereco.endereco.tipoPonto || statusEndereco.endereco.tipo || null
      };
      
      // Log detalhado quando há insucesso ou retorno
      const motivoTipo = statusEndereco.endereco.motivo?.tipo?.toLowerCase();
      if (motivoTipo && motivoTipo !== 'sucesso') {
        console.log(`⚠️ [WEBHOOK] INSUCESSO no ponto ${pontoNumero}: ${statusEndereco.endereco.motivo?.tipo} - ${statusEndereco.endereco.motivo?.descricao}`);
        console.log(`📦 [WEBHOOK] Dados de retorno:`, JSON.stringify({
          retorno: statusEndereco.endereco.retorno,
          isRetorno: statusEndereco.endereco.isRetorno,
          pontoRetornoDe: statusEndereco.endereco.pontoRetornoDe,
          tipoPonto: statusEndereco.endereco.tipoPonto,
          endereco: statusEndereco.endereco
        }, null, 2));
      }
      
      // Verificar se é um ponto de retorno (adicionado automaticamente pela Tutts)
      if (statusEndereco.endereco.retorno || statusEndereco.endereco.isRetorno || statusEndereco.endereco.tipoPonto === 'retorno') {
        console.log(`🔄 [WEBHOOK] Ponto ${pontoNumero} é um PONTO DE RETORNO`);
        dadosPontos[pontoIdx].is_retorno = true;
      }
      
      // Log detalhado das fotos de protocolo
      if (statusEndereco.endereco.protocolo) {
        console.log(`📸 [WEBHOOK] Fotos de protocolo do ponto ${pontoNumero}:`, JSON.stringify(statusEndereco.endereco.protocolo));
      }
      
      console.log(`📍 [WEBHOOK] Ponto ${pontoNumero} atualizado: ${pontoStatus} - ${statusEndereco.descricao || ''}`);
    }
    
    // Atualizar a solicitação com todos os dados
    await pool.query(`
      UPDATE solicitacoes_corrida SET
        status = $1,
        profissional_nome = COALESCE($2, profissional_nome),
        profissional_email = COALESCE($3, profissional_email),
        profissional_foto = COALESCE($4, profissional_foto),
        profissional_cpf = COALESCE($5, profissional_cpf),
        profissional_placa = COALESCE($6, profissional_placa),
        profissional_telefone = COALESCE($7, profissional_telefone),
        profissional_codigo = COALESCE($8, profissional_codigo),
        tutts_url_rastreamento = COALESCE($9, tutts_url_rastreamento),
        dados_pontos = $10,
        rota_profissional = COALESCE($11, rota_profissional),
        cor_veiculo = COALESCE($12, cor_veiculo),
        modelo_veiculo = COALESCE($13, modelo_veiculo),
        ultima_atualizacao = NOW(),
        atualizado_em = NOW()
      WHERE id = $14
    `, [
      novoStatus,
      profissionalNome,
      profissionalEmail,
      profissionalFoto,
      profissionalCpf,
      profissionalPlaca,
      profissionalTelefone,
      profissionalCodigo,
      urlRastreamento,
      JSON.stringify(dadosPontos),
      rotaProfissional ? JSON.stringify(rotaProfissional) : null,
      corVeiculo,
      modeloVeiculo,
      solicitacaoId
    ]);
    
    // Registrar log da notificação
    await pool.query(`
      INSERT INTO webhook_tutts_logs (
        os_numero, solicitacao_id, status_id, status_descricao,
        profissional_nome, ponto_numero, ponto_status, payload_completo, criado_em
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      osNumero,
      solicitacaoId,
      statusId,
      statusDescricao,
      profissionalNome,
      statusEndereco?.endereco?.ponto || null,
      statusEndereco?.codigo || null,
      JSON.stringify(payload)
    ]);
    
    console.log(`✅ [WEBHOOK] OS ${osNumero} atualizada: ${statusDescricao} (${novoStatus})`);
    
    // Responder rapidamente (Tutts espera resposta em até 5 segundos)
    res.status(200).json({ 
      recebido: true, 
      os: osNumero, 
      status: novoStatus,
      mensagem: statusDescricao 
    });
    
  } catch (err) {
    console.error('❌ [WEBHOOK] Erro ao processar notificação:', err);
    // Mesmo com erro, responder 200 para a Tutts não reenviar
    res.status(200).json({ recebido: true, erro: err.message });
  }
});

// ============================================================
// MÓDULO DE FILAS - Sistema de Gerenciamento de Filas Logísticas
// ============================================================

// ========== GESTÃO DE CENTRAIS (ADMIN) ==========

// Listar todas as centrais
app.get('/api/filas/centrais', verificarToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, 
                   COUNT(DISTINCT v.cod_profissional) as total_vinculados,
                   COUNT(DISTINCT CASE WHEN p.status = 'aguardando' THEN p.cod_profissional END) as na_fila,
                   COUNT(DISTINCT CASE WHEN p.status = 'em_rota' THEN p.cod_profissional END) as em_rota
            FROM filas_centrais c
            LEFT JOIN filas_vinculos v ON v.central_id = c.id AND v.ativo = true
            LEFT JOIN filas_posicoes p ON p.central_id = c.id
            GROUP BY c.id
            ORDER BY c.nome
        `);
        res.json({ success: true, centrais: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar centrais:', error);
        res.status(500).json({ error: 'Erro ao listar centrais' });
    }
});

// Criar nova central
app.post('/api/filas/centrais', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { nome, endereco, latitude, longitude, raio_metros } = req.body;
        
        if (!nome || !endereco || !latitude || !longitude) {
            return res.status(400).json({ error: 'Dados obrigatórios: nome, endereco, latitude, longitude' });
        }
        
        const result = await pool.query(`
            INSERT INTO filas_centrais (nome, endereco, latitude, longitude, raio_metros)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [nome, endereco, latitude, longitude, raio_metros || 900]);
        
        await registrarAuditoria(req, 'CRIAR_CENTRAL_FILA', 'admin', 'filas_centrais', result.rows[0].id, { nome, endereco });
        
        res.json({ success: true, central: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao criar central:', error);
        res.status(500).json({ error: 'Erro ao criar central' });
    }
});

// Atualizar central
app.put('/api/filas/centrais/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, endereco, latitude, longitude, raio_metros, ativa } = req.body;
        
        const result = await pool.query(`
            UPDATE filas_centrais 
            SET nome = COALESCE($1, nome),
                endereco = COALESCE($2, endereco),
                latitude = COALESCE($3, latitude),
                longitude = COALESCE($4, longitude),
                raio_metros = COALESCE($5, raio_metros),
                ativa = COALESCE($6, ativa),
                updated_at = NOW()
            WHERE id = $7
            RETURNING *
        `, [nome, endereco, latitude, longitude, raio_metros, ativa, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Central não encontrada' });
        }
        
        await registrarAuditoria(req, 'ATUALIZAR_CENTRAL_FILA', 'admin', 'filas_centrais', id, req.body);
        
        res.json({ success: true, central: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao atualizar central:', error);
        res.status(500).json({ error: 'Erro ao atualizar central' });
    }
});

// Deletar central
app.delete('/api/filas/centrais/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const posicoes = await pool.query('SELECT COUNT(*) FROM filas_posicoes WHERE central_id = $1', [id]);
        if (parseInt(posicoes.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Não é possível excluir central com profissionais na fila' });
        }
        
        await pool.query('DELETE FROM filas_centrais WHERE id = $1', [id]);
        await registrarAuditoria(req, 'EXCLUIR_CENTRAL_FILA', 'admin', 'filas_centrais', id);
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Erro ao deletar central:', error);
        res.status(500).json({ error: 'Erro ao deletar central' });
    }
});

// ========== GESTÃO DE VÍNCULOS (ADMIN) ==========

// Listar profissionais vinculados a uma central
app.get('/api/filas/centrais/:id/vinculos', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT v.*, 
                   p.status as status_fila,
                   p.posicao,
                   p.entrada_fila_at,
                   p.saida_rota_at
            FROM filas_vinculos v
            LEFT JOIN filas_posicoes p ON p.cod_profissional = v.cod_profissional AND p.central_id = v.central_id
            WHERE v.central_id = $1 AND v.ativo = true
            ORDER BY v.nome_profissional
        `, [id]);
        res.json({ success: true, vinculos: result.rows });
    } catch (error) {
        console.error('❌ Erro ao listar vínculos:', error);
        res.status(500).json({ error: 'Erro ao listar vínculos' });
    }
});

// Vincular profissional a uma central
app.post('/api/filas/vinculos', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { central_id, cod_profissional, nome_profissional } = req.body;
        
        if (!central_id || !cod_profissional) {
            return res.status(400).json({ error: 'central_id e cod_profissional são obrigatórios' });
        }
        
        const existente = await pool.query(
            'SELECT * FROM filas_vinculos WHERE cod_profissional = $1 AND ativo = true',
            [cod_profissional]
        );
        
        if (existente.rows.length > 0) {
            return res.status(400).json({ 
                error: 'Profissional já está vinculado a outra central',
                central_atual: existente.rows[0].central_id
            });
        }
        
        const result = await pool.query(`
            INSERT INTO filas_vinculos (central_id, cod_profissional, nome_profissional)
            VALUES ($1, $2, $3)
            ON CONFLICT (cod_profissional) DO UPDATE SET
                central_id = $1,
                nome_profissional = $3,
                ativo = true
            RETURNING *
        `, [central_id, cod_profissional, nome_profissional]);
        
        await registrarAuditoria(req, 'VINCULAR_PROFISSIONAL_CENTRAL', 'admin', 'filas_vinculos', result.rows[0].id, 
            { central_id, cod_profissional, nome_profissional });
        
        res.json({ success: true, vinculo: result.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao vincular profissional:', error);
        res.status(500).json({ error: 'Erro ao vincular profissional' });
    }
});

// Desvincular profissional
app.delete('/api/filas/vinculos/:cod_profissional', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { cod_profissional } = req.params;
        
        await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1', [cod_profissional]);
        await pool.query('UPDATE filas_vinculos SET ativo = false WHERE cod_profissional = $1', [cod_profissional]);
        
        await registrarAuditoria(req, 'DESVINCULAR_PROFISSIONAL_CENTRAL', 'admin', 'filas_vinculos', null, { cod_profissional });
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Erro ao desvincular profissional:', error);
        res.status(500).json({ error: 'Erro ao desvincular profissional' });
    }
});

// ========== OPERAÇÕES DA FILA (ADMIN) ==========

// Obter fila em tempo real de uma central
app.get('/api/filas/centrais/:id/fila', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const aguardando = await pool.query(`
            SELECT *, 
                   EXTRACT(EPOCH FROM (NOW() - entrada_fila_at))/60 as minutos_esperando
            FROM filas_posicoes 
            WHERE central_id = $1 AND status = 'aguardando'
            ORDER BY posicao ASC
        `, [id]);
        
        const emRota = await pool.query(`
            SELECT *,
                   EXTRACT(EPOCH FROM (NOW() - saida_rota_at))/60 as minutos_em_rota
            FROM filas_posicoes 
            WHERE central_id = $1 AND status = 'em_rota'
            ORDER BY saida_rota_at ASC
        `, [id]);
        
        const alertas = emRota.rows.filter(p => p.minutos_em_rota > 90);
        
        res.json({ 
            success: true, 
            aguardando: aguardando.rows,
            em_rota: emRota.rows,
            alertas: alertas,
            total_aguardando: aguardando.rows.length,
            total_em_rota: emRota.rows.length
        });
    } catch (error) {
        console.error('❌ Erro ao obter fila:', error);
        res.status(500).json({ error: 'Erro ao obter fila' });
    }
});

// Enviar profissional para roteiro
app.post('/api/filas/enviar-rota', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { cod_profissional, central_id } = req.body;
        
        const posicao = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
            [cod_profissional, central_id, 'aguardando']
        );
        
        if (posicao.rows.length === 0) {
            return res.status(404).json({ error: 'Profissional não encontrado na fila' });
        }
        
        const prof = posicao.rows[0];
        const tempoEspera = Math.round((Date.now() - new Date(prof.entrada_fila_at).getTime()) / 60000);
        
        await pool.query(`
            UPDATE filas_posicoes 
            SET status = 'em_rota', 
                saida_rota_at = NOW(),
                posicao = NULL,
                updated_at = NOW()
            WHERE cod_profissional = $1 AND central_id = $2
        `, [cod_profissional, central_id]);
        
        await pool.query(`
            UPDATE filas_posicoes 
            SET posicao = posicao - 1 
            WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
        `, [central_id, prof.posicao]);
        
        const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
        
        await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, admin_cod, admin_nome)
            VALUES ($1, $2, $3, $4, 'enviado_rota', $5, $6, $7)
        `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoEspera, req.user.codProfissional, req.user.nome]);
        
        res.json({ success: true, tempo_espera: tempoEspera });
        
        registrarAuditoria(req, 'ENVIAR_PARA_ROTA', 'admin', 'filas_posicoes', null, 
            { cod_profissional, central_id, tempo_espera: tempoEspera }).catch(() => {});
        
    } catch (error) {
        console.error('❌ Erro ao enviar para rota:', error);
        res.status(500).json({ error: 'Erro ao enviar para rota' });
    }
});

// Remover profissional da fila (admin)
app.post('/api/filas/remover', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { cod_profissional, central_id, observacao } = req.body;
        
        const posicao = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2',
            [cod_profissional, central_id]
        );
        
        if (posicao.rows.length === 0) {
            return res.status(404).json({ error: 'Profissional não encontrado na fila' });
        }
        
        const prof = posicao.rows[0];
        const tempoNaFila = Math.round((Date.now() - new Date(prof.entrada_fila_at || prof.saida_rota_at).getTime()) / 60000);
        
        await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2', [cod_profissional, central_id]);
        
        if (prof.status === 'aguardando' && prof.posicao) {
            await pool.query(`
                UPDATE filas_posicoes 
                SET posicao = posicao - 1 
                WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
            `, [central_id, prof.posicao]);
        }
        
        const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
        
        await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, observacao, admin_cod, admin_nome)
            VALUES ($1, $2, $3, $4, 'removido', $5, $6, $7, $8)
        `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoNaFila, observacao, req.user.codProfissional, req.user.nome]);
        
        res.json({ success: true });
        
        registrarAuditoria(req, 'REMOVER_DA_FILA', 'admin', 'filas_posicoes', null, 
            { cod_profissional, central_id, observacao }).catch(() => {});
        
    } catch (error) {
        console.error('❌ Erro ao remover da fila:', error);
        res.status(500).json({ error: 'Erro ao remover da fila' });
    }
});

// ========== OPERAÇÕES DO PROFISSIONAL (USER) ==========

// Verificar central do profissional
app.get('/api/filas/minha-central', verificarToken, async (req, res) => {
    try {
        const cod_profissional = req.user.codProfissional;
        
        const vinculo = await pool.query(`
            SELECT v.*, c.nome as central_nome, c.endereco, c.latitude, c.longitude, c.raio_metros, c.ativa
            FROM filas_vinculos v
            JOIN filas_centrais c ON c.id = v.central_id
            WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true
        `, [cod_profissional]);
        
        if (vinculo.rows.length === 0) {
            return res.json({ success: true, vinculado: false });
        }
        
        const posicao = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
            [cod_profissional]
        );
        
        res.json({ 
            success: true, 
            vinculado: true,
            central: vinculo.rows[0],
            na_fila: posicao.rows.length > 0,
            posicao_atual: posicao.rows[0] || null
        });
    } catch (error) {
        console.error('❌ Erro ao verificar central:', error);
        res.status(500).json({ error: 'Erro ao verificar central' });
    }
});

// Função auxiliar: Calcular distância (Haversine)
function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Entrar na fila (com validação de geolocalização)
app.post('/api/filas/entrar', verificarToken, async (req, res) => {
    try {
        const cod_profissional = req.user.codProfissional;
        const nome_profissional = req.user.nome;
        const { latitude, longitude } = req.body;
        
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Localização GPS é obrigatória' });
        }
        
        const vinculo = await pool.query(`
            SELECT v.*, c.nome as central_nome, c.latitude as central_lat, c.longitude as central_lng, c.raio_metros
            FROM filas_vinculos v
            JOIN filas_centrais c ON c.id = v.central_id
            WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true
        `, [cod_profissional]);
        
        if (vinculo.rows.length === 0) {
            return res.status(403).json({ error: 'Você não está vinculado a nenhuma central' });
        }
        
        const central = vinculo.rows[0];
        
        const distancia = calcularDistanciaHaversine(
            parseFloat(latitude), 
            parseFloat(longitude),
            parseFloat(central.central_lat),
            parseFloat(central.central_lng)
        );
        
        if (distancia > central.raio_metros) {
            return res.status(403).json({ 
                error: 'Você está muito longe da central',
                distancia_atual: Math.round(distancia),
                raio_permitido: central.raio_metros,
                mensagem: `Você está a ${Math.round(distancia)}m da central. Aproxime-se para entrar na fila (máx ${central.raio_metros}m).`
            });
        }
        
        const jaEstaNaFila = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
            [cod_profissional]
        );
        
        if (jaEstaNaFila.rows.length > 0) {
            const posicaoAtual = jaEstaNaFila.rows[0];
            
            if (posicaoAtual.status === 'em_rota') {
                const tempoRota = Math.round((Date.now() - new Date(posicaoAtual.saida_rota_at).getTime()) / 60000);
                
                const ultimaPosicao = await pool.query(
                    'SELECT COALESCE(MAX(posicao), 0) as max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
                    [central.central_id, 'aguardando']
                );
                
                const novaPosicao = parseInt(ultimaPosicao.rows[0].max_pos) + 1;
                
                await pool.query(`
                    UPDATE filas_posicoes 
                    SET status = 'aguardando',
                        posicao = $1,
                        entrada_fila_at = NOW(),
                        retorno_at = NOW(),
                        latitude_checkin = $2,
                        longitude_checkin = $3,
                        updated_at = NOW()
                    WHERE cod_profissional = $4
                `, [novaPosicao, latitude, longitude, cod_profissional]);
                
                await pool.query(`
                    INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_rota_minutos)
                    VALUES ($1, $2, $3, $4, 'retorno', $5)
                `, [central.central_id, central.central_nome, cod_profissional, nome_profissional, tempoRota]);
                
                return res.json({ 
                    success: true, 
                    mensagem: 'Você retornou para a fila',
                    posicao: novaPosicao,
                    tempo_rota: tempoRota
                });
            } else {
                return res.status(400).json({ error: 'Você já está na fila de espera' });
            }
        }
        
        const ultimaPosicao = await pool.query(
            'SELECT COALESCE(MAX(posicao), 0) as max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
            [central.central_id, 'aguardando']
        );
        
        const posicao = parseInt(ultimaPosicao.rows[0].max_pos) + 1;
        
        await pool.query(`
            INSERT INTO filas_posicoes (central_id, cod_profissional, nome_profissional, status, posicao, latitude_checkin, longitude_checkin)
            VALUES ($1, $2, $3, 'aguardando', $4, $5, $6)
        `, [central.central_id, cod_profissional, nome_profissional, posicao, latitude, longitude]);
        
        await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao)
            VALUES ($1, $2, $3, $4, 'entrada')
        `, [central.central_id, central.central_nome, cod_profissional, nome_profissional]);
        
        res.json({ 
            success: true, 
            posicao: posicao,
            central: central.central_nome,
            distancia: Math.round(distancia)
        });
        
        // Auditoria em background (não bloqueia a resposta)
        registrarAuditoria(req, 'ENTRAR_NA_FILA', 'user', 'filas_posicoes', null, 
            { central_id: central.central_id, posicao, distancia: Math.round(distancia) }).catch(() => {});
        
    } catch (error) {
        console.error('❌ Erro ao entrar na fila:', error);
        res.status(500).json({ error: 'Erro ao entrar na fila' });
    }
});

// Sair da fila voluntariamente
app.post('/api/filas/sair', verificarToken, async (req, res) => {
    try {
        const cod_profissional = req.user.codProfissional;
        
        const posicao = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
            [cod_profissional]
        );
        
        if (posicao.rows.length === 0) {
            return res.status(404).json({ error: 'Você não está na fila' });
        }
        
        const prof = posicao.rows[0];
        const central_id = prof.central_id;
        const tempoNaFila = Math.round((Date.now() - new Date(prof.entrada_fila_at || prof.saida_rota_at).getTime()) / 60000);
        
        await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1', [cod_profissional]);
        
        if (prof.status === 'aguardando' && prof.posicao) {
            await pool.query(`
                UPDATE filas_posicoes 
                SET posicao = posicao - 1 
                WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
            `, [central_id, prof.posicao]);
        }
        
        const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
        
        await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos)
            VALUES ($1, $2, $3, $4, 'saida_voluntaria', $5)
        `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoNaFila]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Erro ao sair da fila:', error);
        res.status(500).json({ error: 'Erro ao sair da fila' });
    }
});

// Ver minha posição e quem está na fila
app.get('/api/filas/minha-posicao', verificarToken, async (req, res) => {
    try {
        const cod_profissional = req.user.codProfissional;
        
        const minhaPosicao = await pool.query(
            'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
            [cod_profissional]
        );
        
        if (minhaPosicao.rows.length === 0) {
            return res.json({ success: true, na_fila: false });
        }
        
        const eu = minhaPosicao.rows[0];
        const central_id = eu.central_id;
        
        if (eu.status === 'em_rota') {
            const minutosEmRota = Math.round((Date.now() - new Date(eu.saida_rota_at).getTime()) / 60000);
            return res.json({
                success: true,
                na_fila: true,
                status: 'em_rota',
                minutos_em_rota: minutosEmRota,
                saida_rota_at: eu.saida_rota_at
            });
        }
        
        const naFrente = await pool.query(`
            SELECT cod_profissional, nome_profissional, posicao
            FROM filas_posicoes 
            WHERE central_id = $1 AND status = 'aguardando' AND posicao < $2
            ORDER BY posicao DESC
            LIMIT 3
        `, [central_id, eu.posicao]);
        
        const atras = await pool.query(`
            SELECT cod_profissional, nome_profissional, posicao
            FROM filas_posicoes 
            WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
            ORDER BY posicao ASC
            LIMIT 3
        `, [central_id, eu.posicao]);
        
        const total = await pool.query(
            'SELECT COUNT(*) FROM filas_posicoes WHERE central_id = $1 AND status = $2',
            [central_id, 'aguardando']
        );
        
        const minutosEsperando = Math.round((Date.now() - new Date(eu.entrada_fila_at).getTime()) / 60000);
        
        res.json({
            success: true,
            na_fila: true,
            status: 'aguardando',
            minha_posicao: eu.posicao,
            total_na_fila: parseInt(total.rows[0].count),
            minutos_esperando: minutosEsperando,
            entrada_fila_at: eu.entrada_fila_at,
            na_frente: naFrente.rows.reverse(),
            atras: atras.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar posição:', error);
        res.status(500).json({ error: 'Erro ao buscar posição' });
    }
});

// ========== RELATÓRIOS E MÉTRICAS ==========

// Estatísticas do dia
app.get('/api/filas/estatisticas/:central_id', verificarToken, async (req, res) => {
    try {
        const { central_id } = req.params;
        const { data } = req.query;
        
        const dataFiltro = data || new Date().toISOString().split('T')[0];
        
        const saidas = await pool.query(`
            SELECT COUNT(*) as total
            FROM filas_historico 
            WHERE central_id = $1 
              AND acao = 'enviado_rota'
              AND DATE(created_at) = $2
        `, [central_id, dataFiltro]);
        
        const tempoMedio = await pool.query(`
            SELECT AVG(tempo_espera_minutos) as media
            FROM filas_historico 
            WHERE central_id = $1 
              AND acao = 'enviado_rota'
              AND DATE(created_at) = $2
              AND tempo_espera_minutos IS NOT NULL
        `, [central_id, dataFiltro]);
        
        const ranking = await pool.query(`
            SELECT cod_profissional, nome_profissional, COUNT(*) as total_saidas
            FROM filas_historico 
            WHERE central_id = $1 
              AND acao = 'enviado_rota'
              AND DATE(created_at) = $2
            GROUP BY cod_profissional, nome_profissional
            ORDER BY total_saidas DESC
            LIMIT 10
        `, [central_id, dataFiltro]);
        
        const porHora = await pool.query(`
            SELECT EXTRACT(HOUR FROM created_at) as hora, COUNT(*) as total
            FROM filas_historico 
            WHERE central_id = $1 
              AND acao = 'enviado_rota'
              AND DATE(created_at) = $2
            GROUP BY EXTRACT(HOUR FROM created_at)
            ORDER BY hora
        `, [central_id, dataFiltro]);
        
        res.json({
            success: true,
            data: dataFiltro,
            total_saidas: parseInt(saidas.rows[0].total),
            tempo_medio_espera: Math.round(parseFloat(tempoMedio.rows[0].media) || 0),
            ranking: ranking.rows,
            por_hora: porHora.rows
        });
    } catch (error) {
        console.error('❌ Erro ao buscar estatísticas:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// Histórico detalhado
app.get('/api/filas/historico/:central_id', verificarToken, async (req, res) => {
    try {
        const { central_id } = req.params;
        const { data_inicio, data_fim, limit = 100 } = req.query;
        
        let query = `SELECT * FROM filas_historico WHERE central_id = $1`;
        const params = [central_id];
        
        if (data_inicio) {
            params.push(data_inicio);
            query += ` AND DATE(created_at) >= $${params.length}`;
        }
        
        if (data_fim) {
            params.push(data_fim);
            query += ` AND DATE(created_at) <= $${params.length}`;
        }
        
        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
        
        const result = await pool.query(query, params);
        
        res.json({ success: true, historico: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar histórico:', error);
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

// ==================== FIM MÓDULO DE FILAS ====================


// Endpoint para verificar se webhook está funcionando
app.get('/api/webhook/tutts/status', (req, res) => {
  res.json({ 
    ativo: true, 
    url: 'https://tutts-backend-production.up.railway.app/api/webhook/tutts',
    metodo: 'POST',
    mensagem: 'Configure esta URL no painel da Tutts para receber notificações'
  });
});

// ==================== ERROR HANDLER GLOBAL COM CORS ====================
// Este handler DEVE ser o último middleware antes de app.listen

// 404 - Rota não encontrada
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(404).json({ error: 'Rota não encontrada', path: req.path });
});

// Error handler global - captura todos os erros não tratados
app.use((err, req, res, next) => {
  // SEMPRE adicionar CORS nos erros
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  console.error('❌ Erro não tratado:', err.message);
  
  res.status(err.status || 500).json({ 
    error: 'Erro interno do servidor'
  });
});

// ==================== WEBSOCKET SETUP ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/financeiro' });

// Armazenar conexões ativas
const wsClients = {
  admins: new Set(),
  users: new Map()
};

// Broadcast para admins
function broadcastToAdmins(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wsClients.admins.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
  console.log(`📡 [WS] Broadcast para ${wsClients.admins.size} admins: ${event}`);
}

// Enviar para usuário específico
function sendToUser(userCod, event, data) {
  const userConnections = wsClients.users.get(userCod);
  if (!userConnections) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  userConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
}

// Notificar novo saque
function notifyNewWithdrawal(withdrawal) {
  broadcastToAdmins('NEW_WITHDRAWAL', {
    id: withdrawal.id,
    user_cod: withdrawal.user_cod,
    user_name: withdrawal.user_name,
    cpf: withdrawal.cpf,
    pix_key: withdrawal.pix_key,
    requested_amount: withdrawal.requested_amount,
    final_amount: withdrawal.final_amount,
    has_gratuity: withdrawal.has_gratuity,
    status: withdrawal.status,
    created_at: withdrawal.created_at
  });
}

// Notificar atualização de saque
function notifyWithdrawalUpdate(withdrawal, action) {
  broadcastToAdmins('WITHDRAWAL_UPDATE', {
    id: withdrawal.id,
    user_cod: withdrawal.user_cod,
    status: withdrawal.status,
    action: action
  });
  sendToUser(withdrawal.user_cod, 'MY_WITHDRAWAL_UPDATE', {
    id: withdrawal.id,
    status: withdrawal.status,
    action: action,
    reject_reason: withdrawal.reject_reason
  });
}

// Handler de conexão WebSocket
wss.on('connection', (ws, req) => {
  console.log('🔌 [WS] Nova conexão');
  let clientType = null;
  let userCod = null;
  let authenticated = false;
  
  // Timeout para autenticação (30 segundos)
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log('⚠️ [WS] Conexão fechada por falta de autenticação');
      ws.close(4001, 'Autenticação necessária');
    }
  }, 30000);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'AUTH') {
        const { token, role, cod_profissional } = data;
        
        // Validar token JWT
        if (!token) {
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token não fornecido' }));
          return;
        }
        
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          authenticated = true;
          clearTimeout(authTimeout);
          
          // Verificar se role do token bate com o informado
          if (decoded.role !== role) {
            console.log(`⚠️ [WS] Role mismatch: token=${decoded.role}, informado=${role}`);
          }
          
          if (['admin', 'admin_master', 'admin_financeiro'].includes(decoded.role)) {
            clientType = 'admin';
            wsClients.admins.add(ws);
            ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', role: 'admin', user: decoded.fullName }));
            console.log(`✅ [WS] Admin ${decoded.fullName} autenticado. Total: ${wsClients.admins.size}`);
          } else if (decoded.codProfissional) {
            clientType = 'user';
            userCod = decoded.codProfissional;
            if (!wsClients.users.has(userCod)) wsClients.users.set(userCod, new Set());
            wsClients.users.get(userCod).add(ws);
            ws.send(JSON.stringify({ event: 'AUTH_SUCCESS', role: 'user', userCod }));
            console.log(`✅ [WS] Usuário ${userCod} autenticado`);
          }
        } catch (jwtError) {
          console.log(`❌ [WS] Token inválido: ${jwtError.message}`);
          ws.send(JSON.stringify({ event: 'AUTH_ERROR', error: 'Token inválido ou expirado' }));
          ws.close(4003, 'Token inválido');
        }
      }
      
      if (data.type === 'PING' && authenticated) {
        ws.send(JSON.stringify({ event: 'PONG', timestamp: new Date().toISOString() }));
      }
    } catch (e) {
      console.error('❌ [WS] Erro:', e.message);
    }
  });
  
  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (clientType === 'admin') {
      wsClients.admins.delete(ws);
      console.log(`🔌 [WS] Admin desconectado. Restam: ${wsClients.admins.size}`);
    } else if (clientType === 'user' && userCod) {
      const conns = wsClients.users.get(userCod);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) wsClients.users.delete(userCod);
      }
    }
  });
  
  ws.send(JSON.stringify({ event: 'CONNECTED', message: 'Conectado ao Tutts - Envie AUTH com token' }));
});

// Exportar funções globalmente para uso nos endpoints
global.notifyNewWithdrawal = notifyNewWithdrawal;
global.notifyWithdrawalUpdate = notifyWithdrawalUpdate;
global.broadcastToAdmins = broadcastToAdmins;

// ==================== FIM WEBSOCKET SETUP ====================

// ==================== INICIAR SERVIDOR ====================
server.listen(port, () => {
  logger.info('Servidor iniciado', {
    port,
    version: SERVER_VERSION,
    nodeEnv: process.env.NODE_ENV || 'development',
    railwayEnv: process.env.RAILWAY_ENVIRONMENT || 'local'
  });
  logger.info('Endpoints disponíveis', {
    api: `http://localhost:${port}/api/health`,
    websocket: `ws://localhost:${port}/ws/financeiro`
  });
  
  // Processar recorrências a cada hora
  setInterval(processarRecorrenciasInterno, 60 * 60 * 1000);
  setTimeout(processarRecorrenciasInterno, 10000);
  logger.info('Processamento de recorrências ativado', { intervalo: '1h' });
  
  // ==================== CRON JOBS DO SCORE ====================
  
  // Cron Job: Aplicar gratuidades do Score no dia 1 de cada mês às 00:05
  cron.schedule('5 0 1 * *', async () => {
    console.log('🎁 [CRON] Iniciando aplicação de gratuidades do Score...');
    try {
      const mesReferencia = new Date().toISOString().slice(0, 7);
      
      const profissionais = await pool.query(`
        SELECT cod_prof, nome_prof, score_total 
        FROM score_totais 
        WHERE score_total >= 80
        ORDER BY score_total DESC
      `);
      
      let aplicados = 0;
      
      for (const prof of profissionais.rows) {
        try {
          const score = parseFloat(prof.score_total) || 0;
          let quantidadeSaques = 0;
          let nivel = null;
          
          if (score >= 100) {
            quantidadeSaques = 4;
            nivel = 'Prata';
          } else if (score >= 80) {
            quantidadeSaques = 2;
            nivel = 'Bronze';
          }
          
          if (quantidadeSaques === 0) continue;
          
          const existente = await pool.query(
            'SELECT * FROM score_gratuidades WHERE cod_prof = $1 AND mes_referencia = $2',
            [prof.cod_prof, mesReferencia]
          );
          
          if (existente.rows.length === 0) {
            const gratuidade = await pool.query(`
              INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
              VALUES ($1, $2, $3, $3, 500.00, $4, 'ativa', 'Sistema Score')
              RETURNING id
            `, [prof.cod_prof, prof.nome_prof, quantidadeSaques, `Score ${nivel} - ${mesReferencia}`]);
            
            await pool.query(`
              INSERT INTO score_gratuidades (cod_prof, nome_prof, mes_referencia, score_no_momento, nivel, quantidade_saques, gratuidade_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [prof.cod_prof, prof.nome_prof, mesReferencia, score, nivel, quantidadeSaques, gratuidade.rows[0].id]);
            
            aplicados++;
          }
        } catch (err) {
          console.error(`[CRON] Erro ao aplicar gratuidade para ${prof.cod_prof}:`, err.message);
        }
      }
      
      console.log(`✅ [CRON] Gratuidades do Score aplicadas: ${aplicados} profissionais`);
    } catch (error) {
      console.error('❌ [CRON] Erro ao aplicar gratuidades do Score:', error);
    }
  }, {
    scheduled: true,
    timezone: "America/Sao_Paulo"
  });
  
  console.log('🎁 Cron Job do Score ativado (dia 1 de cada mês às 00:05)');
});
