import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || "/data/tasks.json";

const app = express();
app.use(express.json({ limit: "1mb" }));

let version = 1;
let tasks = [];

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const now = () => Date.now();

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => {
      if (!t || typeof t.id !== "string") return null;
      const mode = t.mode === "time" ? "time" : "manual";
      const percent =
        mode === "manual" ? clamp(parseInt(t.percent || 0, 10), 0, 100) : 0;
      return {
        id: t.id,
        title: String(t.title || "").slice(0, 200),
        desc: String(t.desc || "").slice(0, 2000),
        mode,
        percent,
        start: t.start || null,
        end: t.end || null,
        c1: String(t.c1 || "#00f6a9"),
        c2: String(t.c2 || "#00a7ff"),
        createdAt: t.createdAt || now(),
        updatedAt: now()
      };
    })
    .filter(Boolean);
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      version = raw.version || 1;
      tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    } else {
      tasks = [];
      persist();
    }
  } catch (e) {
    console.error("Failed to load data:", e);
    tasks = [];
  }
}

function persist() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ version, tasks }, null, 2),
    "utf8"
  );
}

let wss;
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

app.get("/api/tasks", (req, res) => {
  res.json({ version, tasks });
});

app.post("/api/save", (req, res) => {
  const incoming = sanitize(req.body?.tasks);
  if (!incoming.length && incoming.length !== 0) {
    return res.status(400).json({ error: "Invalid tasks payload" });
  }
  tasks = incoming;
  version += 1;
  persist();
  broadcast({ type: "set", version, tasks });
  res.json({ ok: true, version });
});

const server = app.listen(PORT, () => {
  console.log(`Task API listening on :${PORT}`);
});

wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.send(JSON.stringify({ type: "init", version, tasks }));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

load();