import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── State ───
let monitorProcess = null;
let isTracking = false;
const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase().replace(/[/\\]+$/, '');

// ─── Broadcast to all WebSocket clients ───
function broadcast(data) {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

// ─── Fast Synchronous Drive Scanner ───
function getConnectedDrives() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const found = [];
  for (let i = 0; i < letters.length; i++) {
    const d = letters[i] + ':\\';
    try {
      if (fs.existsSync(d)) {
        found.push(d);
      }
    } catch (e) {
      // ignore unready/locked drives
    }
  }
  return found;
}

function getNonSystemDrives() {
  return getConnectedDrives().filter((d) => !d.toUpperCase().startsWith(systemDrive));
}

// ─── Background USB & Removable Drive Monitor (Always Running) ───
let knownDrives = new Set();

function checkDriveChanges() {
  const current = getConnectedDrives();
  const currentSet = new Set(current.map((d) => d.toUpperCase()));

  // Check for newly connected drives
  for (const drive of currentSet) {
    const driveLetter = drive.slice(0, 2);
    if (driveLetter.toUpperCase() === systemDrive) {
      continue;
    }

    if (!knownDrives.has(drive)) {
      knownDrives.add(drive);
      // Only broadcast when tracking is ON
      if (isTracking) {
        const ts = new Date().toLocaleString();
        console.log(`[USB Event] Pen drive inserted: ${drive}`);
        broadcast({
          type: 'pen_drive_insert',
          timestamp: ts,
          file: drive,
          destination: drive,
          message: `Pen drive inserted: ${drive}`,
          isExternal: true,
          pen_drive_id: drive,
          device_id: process.env.COMPUTERNAME || 'LAPTOP',
        });
      }
    }
  }

  // Check for removed drives
  for (const drive of [...knownDrives]) {
    const driveLetter = drive.slice(0, 2);
    if (driveLetter.toUpperCase() === systemDrive) {
      continue;
    }

    if (!currentSet.has(drive)) {
      knownDrives.delete(drive);
      // Only broadcast when tracking is ON
      if (isTracking) {
        const ts = new Date().toLocaleString();
        console.log(`[USB Event] Pen drive removed: ${drive}`);
        broadcast({
          type: 'pen_drive_eject',
          timestamp: ts,
          file: drive,
          source: drive,
          message: `Pen drive removed: ${drive}`,
          isExternal: true,
          pen_drive_id: drive,
          device_id: process.env.COMPUTERNAME || 'LAPTOP',
        });
      }
    }
  }
}

function startUsbDriveWatcher() {
  // Silently snapshot all currently connected non-system drives at startup.
  // This prevents them from firing "insert" events just because the server started.
  const initial = getConnectedDrives();
  for (const d of initial) {
    const upper = d.toUpperCase();
    if (!upper.startsWith(systemDrive)) {
      knownDrives.add(upper);
    }
  }
  console.log(`[USB Monitor] Started. Watching for plug/unplug events on non-system drives. Initial drives: ${[...knownDrives].join(', ') || 'none'}`);

  // Poll every 1 second — only broadcasts on actual change
  setInterval(checkDriveChanges, 1000);
}

// Start USB watcher immediately
startUsbDriveWatcher();

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

app.get('/api/drives', (req, res) => {
  const drives = getNonSystemDrives();
  res.json({ drives });
});

app.post('/api/scan-drives', (req, res) => {
  const drives = getNonSystemDrives();
  // Just return the list — no broadcasting, no logging
  res.json({ success: true, drives });
});

// ─── WebSocket connection handling ───
wss.on('connection', (ws) => {
  // Send current tracking status on connect
  ws.send(JSON.stringify({ type: 'STATUS', tracking: isTracking }));

  // Send currently attached non-system drives for display only (not logged as new events)
  const nonSystem = getNonSystemDrives();
  ws.send(JSON.stringify({
    type: 'CURRENT_DRIVES',
    drives: nonSystem,
    displayOnly: true   // frontend uses this to show drive list, never logs to DB
  }));
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
