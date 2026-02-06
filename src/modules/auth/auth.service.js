/**
 * MÓDULO AUTH - Service
 * Funções puras: TOTP, criptografia, tokens JWT, hashing
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET || (JWT_SECRET + '_refresh');
const JWT_EXPIRES_IN = '1h';
const REFRESH_TOKEN_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

const LOGIN_CONFIG = {
  MAX_ATTEMPTS: 5,
  BLOCK_DURATION_MINUTES: 15,
  ATTEMPT_WINDOW_MINUTES: 30
};

const TOTP_CONFIG = {
  ISSUER: 'Tutts',
  ALGORITHM: 'SHA1',
  DIGITS: 6,
  PERIOD: 30,
  WINDOW: 1
};

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || JWT_SECRET.substring(0, 32).padEnd(32, '0');

// ==================== JWT ====================

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

// ==================== BCRYPT ====================

const hashSenha = async (senha) => {
  return await bcrypt.hash(senha, BCRYPT_ROUNDS);
};

const verificarSenha = async (senha, hash) => {
  return await bcrypt.compare(senha, hash);
};

// ==================== CRIPTOGRAFIA 2FA ====================

const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

const decryptSecret = (encryptedData) => {
  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// ==================== TOTP ====================

const generateTOTPSecret = () => {
  const buffer = crypto.randomBytes(20);
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < buffer.length; i++) {
    secret += base32Chars[buffer[i] % 32];
  }
  return secret;
};

const base32ToBytes = (base32) => {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let char of base32.toUpperCase()) {
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

const generateTOTP = (secret, time = null) => {
  const counter = Math.floor((time || Date.now()) / 1000 / TOTP_CONFIG.PERIOD);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter & 0xffffffff, 4);
  
  const key = base32ToBytes(secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, TOTP_CONFIG.DIGITS);
  
  return code.toString().padStart(TOTP_CONFIG.DIGITS, '0');
};

const verifyTOTP = (secret, code) => {
  const now = Date.now();
  for (let i = -TOTP_CONFIG.WINDOW; i <= TOTP_CONFIG.WINDOW; i++) {
    const time = now + (i * TOTP_CONFIG.PERIOD * 1000);
    const expectedCode = generateTOTP(secret, time);
    if (expectedCode === code.toString().padStart(TOTP_CONFIG.DIGITS, '0')) {
      return true;
    }
  }
  return false;
};

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

const generateBackupCodes = () => {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
  }
  return codes;
};

module.exports = {
  LOGIN_CONFIG,
  TOTP_CONFIG,
  REFRESH_SECRET,
  gerarToken,
  gerarRefreshToken,
  hashSenha,
  verificarSenha,
  encryptSecret,
  decryptSecret,
  generateTOTPSecret,
  generateTOTP,
  verifyTOTP,
  generateTOTPUri,
  generateBackupCodes
};
