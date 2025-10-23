// server/events.js
const clients = new Set();
let pingTimer = null;

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  // ping inicial para liberar o stream
  res.write('event: ping\ndata: "hello"\n\n');

  clients.add(res);

  // liga keepalive (a cada 25s, bom p/ proxies)
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      const msg = 'event: ping\ndata: "tick"\n\n';
      for (const c of clients) c.write(msg);
      if (clients.size === 0) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    }, 25000);
  }

  req.on('close', () => {
    clients.delete(res);
    try { res.end(); } catch (_) {}
    if (clients.size === 0 && pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  });
}

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch (_) {}
  }
}

module.exports = { sse, broadcast };
