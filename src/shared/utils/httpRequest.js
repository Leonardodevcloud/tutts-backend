/**
 * src/shared/utils/httpRequest.js
 * Função HTTP/HTTPS que substitui fetch (compatível com Node 18)
 */

const https = require('https');
const http = require('http');

function httpRequest(url, options = {}) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(options.headers || {}),
        },
      };

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
              text: () => data,
            });
          } catch (e) {
            resolve({
              ok: false,
              status: res.statusCode,
              json: () => ({ error: 'Parse error', raw: data.substring(0, 500) }),
              text: () => data,
            });
          }
        });
      });

      req.on('error', (err) => {
        resolve({
          ok: false, status: 0,
          json: () => ({ error: err.message }),
          text: () => err.message,
        });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve({
          ok: false, status: 0,
          json: () => ({ error: 'Timeout' }),
          text: () => 'Timeout',
        });
      });

      if (options.body) req.write(options.body);
      req.end();
    } catch (err) {
      resolve({
        ok: false, status: 0,
        json: () => ({ error: err.message }),
        text: () => err.message,
      });
    }
  });
}

module.exports = httpRequest;
