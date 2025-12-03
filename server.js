import fs from "fs";
import path from "path";
import express from "express";
import session from "express-session";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || "/data/tasks.json";
const USERNAME = process.env.USERNAME || "admin";
const PASSWORD = process.env.PASSWORD || "admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-in-production";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Configurar sesiones
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Cambiar a true si usas HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  }
}));

// Middleware de autenticación
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: "No autenticado" });
}

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

// Página de login
app.get("/login", (req, res) => {
  if (req.session && req.session.authenticated) {
    // Si ya está autenticado, redirigir a la app
    res.redirect("/");
  } else {
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Z - Tasks - Login</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .login-box {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            width: 300px;
          }
          h1 {
            margin-top: 0;
            color: #333;
            text-align: center;
          }
          input {
            width: 100%;
            padding: 10px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 5px;
            box-sizing: border-box;
          }
          button {
            width: 100%;
            padding: 10px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
          }
          button:hover {
            background: #5568d3;
          }
          .error {
            color: red;
            font-size: 14px;
            margin-top: 10px;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="login-box">
          <h1>Z - Tasks</h1>
          <form action="/login" method="POST">
            <input type="text" name="username" placeholder="Usuario" required autofocus>
            <input type="password" name="password" placeholder="Contraseña" required>
            <button type="submit">Iniciar sesión</button>
          </form>
          ${req.query.error ? '<div class="error">Usuario o contraseña incorrectos</div>' : ''}
        </div>
      </body>
      </html>
    `);
  }
});

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === USERNAME && password === PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect("/");
  } else {
    res.redirect("/login?error=1");
  }
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// Verificar estado de autenticación
app.get("/api/auth/status", (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    username: req.session?.username || null
  });
});

// RUTAS PROTEGIDAS
app.get("/api/tasks", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version, tasks });
});

app.post("/api/save", requireAuth, (req, res) => {
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
