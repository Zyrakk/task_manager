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

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const safeColor = (v, fallback) =>
  typeof v === "string" && HEX_COLOR.test(v.trim()) ? v.trim() : fallback;

function toIsoOrNull(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d) ? null : d.toISOString();
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => {
      if (!t || typeof t.id !== "string") return null;

      const mode = t.mode === "time" ? "time" : "manual";
      const title = String(t.title || "").slice(0, 200);
      const desc = String(t.desc || "").slice(0, 2000);

      const c1 = safeColor(t.c1, "#00f6a9");
      const c2 = safeColor(t.c2, "#00a7ff");

      let start = null;
      let end = null;
      let percent = 0;

      if (mode === "time") {
        const s = toIsoOrNull(t.start);
        const e = toIsoOrNull(t.end);
        // Si end < start, las intercambiamos para evitar 100% instantáneo
        if (s && e && new Date(e).getTime() < new Date(s).getTime()) {
          start = e;
          end = s;
        } else {
          start = s;
          end = e;
        }
        percent = 0;
      } else {
        percent = clamp(parseInt(t.percent || 0, 10), 0, 100);
      }

      const createdAt =
        typeof t.createdAt === "number" && t.createdAt > 0
          ? t.createdAt
          : now();

      return {
        id: t.id,
        title,
        desc,
        mode,
        percent,
        start,
        end,
        c1,
        c2,
        focused: !!t.focused,
        createdAt,
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
      // Saneamos por si el fichero fue editado a mano
      tasks = sanitize(Array.isArray(raw.tasks) ? raw.tasks : []);
      persist();
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
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

app.get("/api/tasks", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version, tasks });
});

app.post("/api/save", (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.tasks)) {
    return res.status(400).json({ error: "Invalid tasks payload" });
  }
  const incoming = sanitize(body.tasks);

  // Aceptamos listas vacías (borrado total)
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
  // keepalive
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