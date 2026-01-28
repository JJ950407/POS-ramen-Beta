const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const clients = new Set();
let orders = [];
let nextOrderId = 1;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function sendFrame(socket, data) {
  const payload = Buffer.from(data);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x81;
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    sendFrame(client, data);
  }
}

function normalizeOrder(raw) {
  return {
    id: raw.id,
    table: raw.table,
    items: raw.items,
    status: raw.status,
    createdAt: raw.createdAt
  };
}

function handleMessage(socket, data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    sendFrame(socket, JSON.stringify({ type: 'error', message: 'Mensaje inválido.' }));
    return;
  }

  if (parsed.type === 'get_state') {
    sendFrame(socket, JSON.stringify({ type: 'state', orders: orders.map(normalizeOrder) }));
    return;
  }

  if (parsed.type === 'new_order') {
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const order = {
      id: nextOrderId,
      table: parsed.table || 'Sin mesa',
      items,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    nextOrderId += 1;
    orders = [...orders, order];
    broadcast({ type: 'state', orders: orders.map(normalizeOrder) });
    return;
  }

  if (parsed.type === 'update_status') {
    orders = orders.map((order) => {
      if (order.id === parsed.id) {
        return { ...order, status: parsed.status || order.status };
      }
      return order;
    });
    broadcast({ type: 'state', orders: orders.map(normalizeOrder) });
    return;
  }

  sendFrame(socket, JSON.stringify({ type: 'error', message: 'Tipo no reconocido.' }));
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      payloadLength = Number(bigLength);
      headerLength = 10;
    }

    const maskKeyLength = masked ? 4 : 0;
    const frameLength = headerLength + maskKeyLength + payloadLength;

    if (offset + frameLength > buffer.length) break;

    if (opcode === 0x8) {
      return { messages, remaining: Buffer.alloc(0), closed: true };
    }

    let payload = buffer.slice(offset + headerLength + maskKeyLength, offset + frameLength);

    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    messages.push(payload.toString('utf8'));
    offset += frameLength;
  }

  return { messages, remaining: buffer.slice(offset), closed: false };
}

const server = http.createServer((req, res) => {
  if (req.url === '/ws') {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Actualiza a WebSocket.');
    return;
  }

  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(requestPath).replace(/^\.+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Acceso denegado.');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No encontrado.');
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
    res.end(content);
  });
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  clients.add(socket);
  sendFrame(socket, JSON.stringify({ type: 'state', orders: orders.map(normalizeOrder) }));

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, remaining, closed } = decodeFrames(buffer);
    buffer = remaining;
    for (const message of messages) {
      handleMessage(socket, message);
    }
    if (closed) {
      socket.end();
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', () => {
    clients.delete(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor POS escuchando en http://localhost:${PORT}`);
});
