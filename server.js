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
const { initBiRoutes, initBiTables } = require('./src/modules/bi');
const { initTodoRoutes, initTodoTables, initTodoCron } = require('./src/modules/todo');
const { initMiscRoutes, initMiscTables } = require('./src/modules/misc');

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
    // ==================== MÓDULO BI (EXTRAÍDO) ====================
    await initBiTables(pool);
    // ==================== MÓDULO TODO (EXTRAÍDO) ====================
    await initTodoTables(pool);
    // ==================== MÓDULO MISC (EXTRAÍDO) ====================
    await initMiscTables(pool);
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
app.use('/api', initBiRoutes(pool));
app.use('/api', initTodoRoutes(pool));
app.use('/api', initMiscRoutes(pool));



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
  
  // Processar recorrências Todo
  initTodoCron(pool);
  
  // ==================== CRON JOBS DO SCORE (EXTRAÍDO) ====================
  initScoreCron(cron, pool);
});
