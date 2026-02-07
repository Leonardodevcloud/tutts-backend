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

// ==================== MÓDULOS EXTRAÍDOS ====================
const { initScoreRoutes, initScoreTables, initScoreCron } = require('./src/modules/score');
const { initAuditRoutes, initAuditTables } = require('./src/modules/audit');
const { initCrmRoutes } = require('./src/modules/crm');
const { initSocialRoutes, initSocialTables } = require('./src/modules/social');
const { initOperacionalRoutes, initOperacionalTables } = require('./src/modules/operacional');
const { initLojaRoutes, initLojaTables } = require('./src/modules/loja');
const { initRoteirizadorRoutes, initRoteirizadorTables } = require('./src/modules/roteirizador');
const { initFilasRoutes, initFilasTables } = require('./src/modules/filas');
const { initConfigRoutes, initConfigTables } = require('./src/modules/config');
const { initAuthRoutes, initAuthTables } = require('./src/modules/auth');
const { initDisponibilidadeRoutes, initDisponibilidadeTables } = require('./src/modules/disponibilidade');
const { initFinancialRoutes, initFinancialTables } = require('./src/modules/financial');
const { initSolicitacaoRoutes, initSolicitacaoTables } = require('./src/modules/solicitacao');

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
    // ==================== MÓDULO FINANCIAL (EXTRAÍDO) ====================
    await initFinancialTables(pool);
    await initSolicitacaoTables(pool);
    // ==================== MÓDULO AUTH (EXTRAÍDO) ====================
    await initAuthTables(pool);

    // ==================== MÓDULO CONFIG (EXTRAÍDO) ====================
    await initConfigTables(pool);

    // ==================== MÓDULO DISPONIBILIDADE (EXTRAÍDO) ====================
    await initDisponibilidadeTables(pool);

    // ============================================
    // TABELAS DE RECRUTAMENTO
    // ============================================

    // ==================== MÓDULO LOJA (EXTRAÍDO) ====================
    await initLojaTables(pool);
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

    // ==================== MÓDULO SOCIAL (EXTRAÍDO) ====================
    await initSocialTables(pool);

    // ==================== MÓDULO OPERACIONAL (EXTRAÍDO) ====================
    await initOperacionalTables(pool);
    // ==================== MÓDULO SCORE (EXTRAÍDO) ====================
    await initScoreTables(pool);

    // ==================== MÓDULO AUDITORIA (EXTRAÍDO) ====================
    await initAuditTables(pool);


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

// ==================== ROTAS DO MÓDULO SCORE (EXTRAÍDO) ====================
app.use('/api/score', initScoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// ==================== ROTAS DOS MÓDULOS EXTRAÍDOS ====================
app.use('/api/audit', initAuditRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
app.use('/api/crm', initCrmRoutes(pool));

// Social retorna 2 routers (social + liderança)
const { socialRouter, liderancaRouter } = initSocialRoutes(pool);
app.use('/api/social', socialRouter);
app.use('/api/lideranca', liderancaRouter);

// Operacional retorna 3 routers (avisos + incentivos + operações)
const { avisosRouter, incentivosRouter, operacoesRouter } = initOperacionalRoutes(pool);
app.use('/api/avisos-op', avisosRouter);
app.use('/api/incentivos-op', incentivosRouter);
app.use('/api/operacoes', operacoesRouter);
// Backward compat: frontend chama /api/operacoes-regioes (path separado)
app.get('/api/operacoes-regioes', (req, res, next) => { req.url = '/regioes'; operacoesRouter(req, res, next); });

// Loja
app.use('/api/loja', initLojaRoutes(pool));

// Roteirizador (4 sub-routers)
const { routingRouter, roteirizadorRouter, adminRoteirizadorRouter, geocodeRouter } = initRoteirizadorRoutes(pool, verificarToken, httpRequest, registrarAuditoria, AUDIT_CATEGORIES);
app.use('/api/routing', routingRouter);
app.use('/api/roteirizador', roteirizadorRouter);
app.use('/api/admin/roteirizador/usuarios', adminRoteirizadorRouter);
app.use('/api/geocode', geocodeRouter);
app.use('/api/filas', initFilasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
app.use('/api', initConfigRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
app.use('/api', initAuthRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter));
app.use('/api', initDisponibilidadeRoutes(pool));
app.use('/api', initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP));
app.use('/api', initSolicitacaoRoutes(pool, verificarToken));


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
    
    // ============================================
    // PASSO 3.5: CRIAR REGISTRO NO HISTÓRICO ANTES (para ter o upload_id)
    // ============================================
    const linhasIgnoradasTotal = entregas.length - entregasNovas.length;
    
    const historicoResult = await pool.query(`
      INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, os_novas, os_ignoradas, data_upload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `, [
      usuario_id, 
      usuario_nome, 
      nome_arquivo, 
      entregas.length, 
      0, // Será atualizado depois
      linhasIgnoradasTotal,
      osDoExcel.length - osIgnoradas.length,
      osIgnoradas.length
    ]);
    
    const uploadId = historicoResult.rows[0].id;
    console.log(`📝 Upload registrado com ID: ${uploadId}`);
    
    if (entregasNovas.length === 0) {
      // Histórico já foi criado acima, apenas retorna
      return res.json({ 
        success: true, 
        inseridos: 0, 
        ignorados: entregas.length,
        os_ignoradas: osIgnoradas.length,
        message: 'Todas as OS já existem no banco de dados',
        upload_id: uploadId
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
            longitude: parseNum(e.longitude || e.Longitude || e.lng || e.Lng || e.LNG || e.LONGITUDE || e.long || e.Long),
            upload_id: uploadId
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
                data_upload, latitude, longitude, upload_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
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
              d.data_upload, d.latitude, d.longitude, d.upload_id
            ]);
            inseridos++;
          } catch (singleErr) {
            erros++;
          }
        }
      }
    }
    
    // ============================================
    // PASSO 6: Atualizar histórico com total inserido
    // ============================================
    await pool.query(`
      UPDATE bi_upload_historico 
      SET linhas_inseridas = $1
      WHERE id = $2
    `, [inseridos, uploadId]);
    
    console.log(`✅ Upload concluído: ${inseridos} inseridos, ${linhasIgnoradasTotal} ignorados (OS duplicada), ${erros} erros`);
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
      ignorados: linhasIgnoradasTotal,
      erros,
      os_novas: osDoExcel.length - osIgnoradas.length,
      os_ignoradas: osIgnoradas.length,
      dentro_prazo: dentroPrazoCount,
      fora_prazo: foraPrazoCount,
      upload_id: uploadId
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

// Listar clientes por região com máscaras (para promoções novatos)
app.get('/api/bi/clientes-por-regiao', async (req, res) => {
  try {
    // Buscar máscaras
    const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mascaras = {};
    mascarasResult.rows.forEach(m => {
      mascaras[String(m.cod_cliente)] = m.mascara;
    });
    
    // Buscar clientes agrupados por cod_cliente (evita duplicatas por centro de custo)
    const result = await pool.query(`
      SELECT 
        cod_cliente,
        MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text)) as nome_cliente,
        COUNT(*) as total_entregas
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL
      GROUP BY cod_cliente
      ORDER BY MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text))
    `);
    
    // Adicionar máscaras aos resultados
    const clientesComMascara = result.rows.map(c => ({
      cod_cliente: c.cod_cliente,
      nome_original: c.nome_cliente,
      mascara: mascaras[String(c.cod_cliente)] || null,
      nome_display: mascaras[String(c.cod_cliente)] || c.nome_cliente,
      total_entregas: parseInt(c.total_entregas)
    }));
    
    console.log(`📋 Clientes carregados: ${clientesComMascara.length}`);
    res.json(clientesComMascara);
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
// Excluir upload por data (FALLBACK para dados antigos sem upload_id)
app.delete('/api/bi/uploads/:data', async (req, res) => {
  try {
    const { data } = req.params;
    
    // Para dados antigos (sem upload_id), ainda permite deletar por data
    // MAS só deleta registros SEM upload_id (dados antigos)
    console.log(`⚠️ Exclusão por data (legado): ${data}`);
    
    const result = await pool.query(`DELETE FROM bi_entregas WHERE data_upload = $1 AND upload_id IS NULL`, [data]);
    
    // Também remove do histórico onde a data coincide
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
    
    // ✅ CORRIGIDO: Deletar APENAS entregas vinculadas a este upload_id específico
    const deleteResult = await pool.query(`DELETE FROM bi_entregas WHERE upload_id = $1`, [id]);
    console.log(`🗑️ Deletadas ${deleteResult.rowCount} entregas do upload ID ${id}`);
    
    // Deletar do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE id = $1`, [id]);
    
    res.json({ success: true, deletados: deleteResult.rowCount });
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


console.log('✅ Módulo de Auditoria carregado!');

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
  
  // ==================== CRON JOBS DO SCORE (EXTRAÍDO) ====================
  initScoreCron(cron, pool);
});
