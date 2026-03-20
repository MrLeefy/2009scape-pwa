const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

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

// Health check endpoint
function serveStatic(req, res) {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

// WebSocket upgrade handler — bridges WS to game server TCP
function handleUpgrade(req, socket, head) {
    // Accept /ws-proxy or /ws-proxy?host=X&port=Y
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws-proxy') {
        socket.destroy();
        return;
    }

    // Allow client to specify target host/port  
    const targetHost = url.searchParams.get('host') || GAME_HOST;
    const targetPort = parseInt(url.searchParams.get('port') || GAME_PORT);
    console.log(`WS proxy connecting to ${targetHost}:${targetPort}`);

    // WebSocket handshake
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB53DC45B10')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        'Access-Control-Allow-Origin: *\r\n' +
        '\r\n'
    );

    // Connect to game server
    const gameSocket = net.createConnection({ host: targetHost, port: targetPort }, () => {
        console.log(`Proxying to ${targetHost}:${targetPort}`);
    });

    // WS frame parser (simplified for binary frames)
    socket.on('data', (data) => {
        try {
            let offset = 0;
            while (offset < data.length) {
                const byte1 = data[offset++];
                const byte2 = data[offset++];
                const masked = (byte2 & 0x80) !== 0;
                let payloadLen = byte2 & 0x7F;

                if (payloadLen === 126) {
                    payloadLen = data.readUInt16BE(offset);
                    offset += 2;
                } else if (payloadLen === 127) {
                    payloadLen = Number(data.readBigUInt64BE(offset));
                    offset += 8;
                }

                let mask = null;
                if (masked) {
                    mask = data.slice(offset, offset + 4);
                    offset += 4;
                }

                const payload = data.slice(offset, offset + payloadLen);
                offset += payloadLen;

                if (masked) {
                    for (let i = 0; i < payload.length; i++) {
                        payload[i] ^= mask[i & 3];
                    }
                }

                const opcode = byte1 & 0x0F;
                if (opcode === 0x08) {
                    // Close frame
                    socket.end();
                    gameSocket.end();
                    return;
                }
                if (opcode === 0x09) {
                    // Ping -> Pong
                    const pong = Buffer.alloc(2);
                    pong[0] = 0x8A; // fin + pong
                    pong[1] = 0;
                    socket.write(pong);
                    continue;
                }

                // Forward binary data to game server
                gameSocket.write(payload);
            }
        } catch (e) {
            console.error('WS parse error:', e.message);
        }
    });

    // Game server -> WS binary frame
    gameSocket.on('data', (data) => {
        try {
            const header = [];
            header.push(0x82); // fin + binary

            if (data.length < 126) {
                header.push(data.length);
            } else if (data.length < 65536) {
                header.push(126);
                header.push((data.length >> 8) & 0xFF);
                header.push(data.length & 0xFF);
            } else {
                header.push(127);
                const lenBuf = Buffer.alloc(8);
                lenBuf.writeBigUInt64BE(BigInt(data.length));
                header.push(...lenBuf);
            }

            socket.write(Buffer.concat([Buffer.from(header), data]));
        } catch (e) {
            console.error('WS send error:', e.message);
        }
    });

    gameSocket.on('error', (e) => {
        console.error('Game connection error:', e.message);
        socket.end();
    });

    gameSocket.on('close', () => {
        console.log('Game connection closed');
        try {
            const close = Buffer.from([0x88, 0x00]);
            socket.write(close);
        } catch(e) {}
        socket.end();
    });

    socket.on('error', (e) => {
        console.error('WS error:', e.message);
        gameSocket.end();
    });

    socket.on('close', () => {
        gameSocket.end();
    });
}

const https = require('https');

const server = http.createServer(serveStatic);
server.on('upgrade', (req, socket, head) => {
    console.log(`WS upgrade request: ${req.url} from ${req.headers.origin || 'unknown'}`);
    handleUpgrade(req, socket, head);
});

server.listen(PORT, () => {
    console.log(`🎮 2009Scape PWA server running on port ${PORT}`);
    console.log(`   Static files: ./public/`);
    console.log(`   WS proxy: /ws-proxy -> ${GAME_HOST}:${GAME_PORT}`);

    // Self-ping keepalive — prevents Render free tier from spinning down
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        setInterval(() => {
            https.get(`${RENDER_URL}/health`, (res) => {
                console.log(`Keepalive ping: ${res.statusCode}`);
            }).on('error', (e) => {
                console.log('Keepalive ping failed:', e.message);
            });
        }, 13 * 60 * 1000); // Every 13 minutes (Render spins down after 15 min)
        console.log(`   Keepalive: pinging ${RENDER_URL}/health every 13 min`);
    }
});
