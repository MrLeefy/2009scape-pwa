const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const GAME_HOST = process.env.GAME_HOST || 'test.2009scape.org';
const GAME_PORT = parseInt(process.env.GAME_PORT || '43594');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.jar': 'application/java-archive',
    '.css': 'text/css',
    '.webmanifest': 'application/manifest+json'
};

// Health check + static file server
function serveStatic(req, res) {
    // Strip query params
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // SPA fallback: serve index.html for any unknown route
            const indexPath = path.join(__dirname, 'public', 'index.html');
            fs.readFile(indexPath, (err2, indexData) => {
                if (err2) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(indexData);
            });
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

const server = http.createServer(serveStatic);

// WebSocket server using 'ws' library — handles browser handshake properly
const wss = new WebSocketServer({ server, path: '/ws-proxy' });

wss.on('headers', (headers) => {
    headers.push('Access-Control-Allow-Origin: *');
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const targetHost = url.searchParams.get('host') || GAME_HOST;
    const targetPort = parseInt(url.searchParams.get('port') || GAME_PORT);
    
    console.log(`[WS] New connection from ${req.headers.origin || 'unknown'}`);
    console.log(`[WS] Proxying to ${targetHost}:${targetPort}`);

    // Connect to game server via TCP
    const gameSocket = net.createConnection({ host: targetHost, port: targetPort }, () => {
        console.log(`[TCP] Connected to ${targetHost}:${targetPort}`);
    });

    // Game server → WebSocket (send as binary)
    gameSocket.on('data', (data) => {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.send(data);
            }
        } catch (e) {
            console.error('[TCP→WS] Send error:', e.message);
        }
    });

    // WebSocket → Game server (forward binary data)
    ws.on('message', (data) => {
        try {
            gameSocket.write(data);
        } catch (e) {
            console.error('[WS→TCP] Write error:', e.message);
        }
    });

    // Error & close handlers
    gameSocket.on('error', (e) => {
        console.error('[TCP] Error:', e.message);
        ws.close(1011, 'Game server error');
    });

    gameSocket.on('close', () => {
        console.log('[TCP] Connection closed');
        ws.close(1000, 'Game server disconnected');
    });

    ws.on('error', (e) => {
        console.error('[WS] Error:', e.message);
        gameSocket.destroy();
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS] Closed: code=${code} reason=${reason}`);
        gameSocket.destroy();
    });
});

const https = require('https');

server.listen(PORT, () => {
    console.log(`🎮 2009Scape proxy on port ${PORT}`);
    console.log(`   Static: ./public/`);
    console.log(`   WS proxy: /ws-proxy → ${GAME_HOST}:${GAME_PORT}`);

    // Self-ping keepalive for Render free tier
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        setInterval(() => {
            https.get(`${RENDER_URL}/health`, (res) => {
                console.log(`Keepalive: ${res.statusCode}`);
            }).on('error', (e) => {
                console.log('Keepalive failed:', e.message);
            });
        }, 13 * 60 * 1000);
        console.log(`   Keepalive: ${RENDER_URL}/health every 13 min`);
    }
});
