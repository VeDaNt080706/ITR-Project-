import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── State ───
let monitorProcess = null;
let isTracking = false;

// ─── Broadcast to all WebSocket clients ───
function broadcast(data) {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

// ─── Start the Go file monitor process ───
function startMonitor() {
  if (monitorProcess) {
    console.log('[Server] Monitor already running');
    return;
  }

  const exePath = path.join(__dirname, 'fsmonitor.exe');
  console.log(`[Server] Spawning file monitor: ${exePath} --json`);

  try {
    monitorProcess = spawn(exePath, ['--json'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    isTracking = true;
    broadcast({ type: 'STATUS', tracking: true });

    // Read stdout line-by-line (each line is a JSON event)
    const rl = createInterface({ input: monitorProcess.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type && parsed.type !== 'INFO') {
          console.log(`[Event] ${parsed.type}: ${parsed.file || parsed.destination || ''}`);
          broadcast(trimmed); // forward event to clients
        }
      } catch (e) {
        console.log(`[Monitor raw] ${trimmed}`);
      }
    });

    // Log stderr
    monitorProcess.stderr.on('data', (chunk) => {
      console.error(`[Monitor stderr] ${chunk.toString().trim()}`);
    });

    monitorProcess.on('error', (err) => {
      console.error(`[Server] Failed to start monitor:`, err.message);
      monitorProcess = null;
      isTracking = false;
      broadcast({ type: 'STATUS', tracking: false });
    });

    monitorProcess.on('exit', (code, signal) => {
      console.log(`[Server] Monitor process exited (code=${code}, signal=${signal})`);
      monitorProcess = null;
      isTracking = false;
      broadcast({ type: 'STATUS', tracking: false });
    });

  } catch (err) {
    console.error('[Server] Exception while starting monitor:', err);
    monitorProcess = null;
    isTracking = false;
    broadcast({ type: 'STATUS', tracking: false });
  }
}

// ─── Stop the Go file monitor process ───
function stopMonitor() {
  if (!monitorProcess) {
    isTracking = false;
    broadcast({ type: 'STATUS', tracking: false });
    return;
  }
  console.log('[Server] Stopping file monitor...');

  const pidToKill = monitorProcess.pid;
  monitorProcess = null;
  isTracking = false;
  broadcast({ type: 'STATUS', tracking: false });

  if (pidToKill) {
    try {
      spawn('taskkill', ['/pid', pidToKill.toString(), '/f', '/t'], {
        windowsHide: true,
      });
    } catch (e) { /* ignore */ }
  }
}

// ─── API Routes ───
app.post('/api/toggle', (req, res) => {
  if (isTracking) {
    stopMonitor();
  } else {
    startMonitor();
  }
  res.json({ tracking: isTracking });
});

app.get('/api/status', (req, res) => {
  res.json({ tracking: isTracking });
});

// ─── WebSocket connection handling ───
wss.on('connection', (ws) => {
  // Send current status on connect
  ws.send(JSON.stringify({ type: 'STATUS', tracking: isTracking }));
});

// ─── Cleanup on exit ───
function cleanup() {
  stopMonitor();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// ─── Start server ───
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`[Server] Backend running on http://localhost:${PORT}`);
  console.log(`[Server] Ready for dashboard toggle.`);
});
