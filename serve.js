const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8888;
const API_HOST = process.env.API_HOST || 'llm.example.com';

// /redact/* reverse-proxies to the redact-pii FastAPI server (same shape
// as /v1/* but to a localhost service rather than a remote HTTPS host).
// Production nginx applies the same routing on top of llm.example.com so
// the page JS uses one same-origin path everywhere.
const REDACT_HOST = process.env.REDACT_HOST || '127.0.0.1';
const REDACT_PORT = parseInt(process.env.REDACT_PORT || '1327', 10);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.webm': 'audio/webm', '.mp3': 'audio/mpeg',
};

function proxy(req, res, { transport, hostname, port, path: upstreamPath, hostHeader }) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const proxyReq = transport.request({
      hostname, port, path: upstreamPath, method: req.method,
      headers: { ...req.headers, host: hostHeader },
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  // Proxy /v1/* to API_HOST (HTTPS, full path forwarded)
  if (req.url.startsWith('/v1/')) {
    return proxy(req, res, {
      transport: https, hostname: API_HOST, port: 443,
      path: req.url, hostHeader: API_HOST,
    });
  }

  // Proxy /redact/* to speaches-plus PII API (HTTP, /redact -> /v1/pii).
  if (req.url.startsWith('/redact/') || req.url === '/redact') {
    const tail = req.url.replace(/^\/redact/, '') || '/';
    return proxy(req, res, {
      transport: http, hostname: REDACT_HOST, port: REDACT_PORT,
      path: '/v1/pii' + tail, hostHeader: `${REDACT_HOST}:${REDACT_PORT}`,
    });
  }

  // Static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  if (filePath.endsWith('/')) filePath += 'index.html';
  if (!path.extname(filePath)) {
    const withIndex = path.join(filePath, 'index.html');
    if (fs.existsSync(withIndex)) filePath = withIndex;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket proxy for /v1/* (realtime endpoint)
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/v1/')) {
    socket.destroy();
    return;
  }

  const proxyReq = https.request({
    hostname: API_HOST,
    port: 443,
    path: req.url,
    method: 'GET',
    headers: {
      ...req.headers,
      host: API_HOST,
    },
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Forward the 101 Switching Protocols response
    let response = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      response += `${key}: ${value}\r\n`;
    }
    response += '\r\n';
    socket.write(response);
    if (proxyHead.length) socket.write(proxyHead);

    // Bidirectional pipe
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    proxySocket.on('close', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());
  });

  proxyReq.on('response', res => {
    // Server rejected the upgrade -- forward the HTTP response
    let response = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
    for (const [key, value] of Object.entries(res.headers)) {
      response += `${key}: ${value}\r\n`;
    }
    response += '\r\n';
    socket.write(response);
    res.pipe(socket);
  });

  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}/voice/`));
