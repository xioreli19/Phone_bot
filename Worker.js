// Кнопочный телефон: Telegram Mini App на Cloudflare Workers + D1.
// Нужно: секрет BOT_TOKEN и привязка D1-базы с именем DB.
// Необязательно: переменная HTML_URL (откуда брать index.html).

const DEFAULT_HTML_URL =
  "https://raw.githubusercontent.com/xioreli19/Phone_bot/main/index.html";
const GAMES = ["snake", "ttt"];

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT DEFAULT '', created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, is_read)",
  "CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_id)",
  "CREATE TABLE IF NOT EXISTS scores (user_id INTEGER NOT NULL, game TEXT NOT NULL, best INTEGER NOT NULL, PRIMARY KEY (user_id, game))",
  "INSERT OR IGNORE INTO users (id, name, username, created) VALUES (0, 'Оператор', '', 0)",
];

class HttpError extends Error {
  constructor(status, msg) {
    super(msg || String(status));
    this.status = status;
  }
}

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, typeof msg === "string" ? enc.encode(msg) : msg);
}

async function sha256hex(s) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------ авторизация
async function parseUser(initData, token) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  const calc = toHex(await hmac(secret, check));
  if (!safeEqual(calc, hash)) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 7 * 86400)) return null;
  try {
    return JSON.parse(p.get("user"));
  } catch {
    return null;
  }
}

async function currentUser(request, env) {
  const u = await parseUser(request.headers.get("X-Init-Data") || "", env.BOT_TOKEN);
  if (!u || !(Number(u.id) > 0)) throw new HttpError(401, "bad init data");
  const id = Number(u.id);
  const name = String(u.first_name || "Аноним").slice(0, 24);
  const username = String(u.username || "");
  const row = await env.DB.prepare("SELECT name, username FROM users WHERE id=?")
    .bind(id)
    .first();
  if (!row) {
    const r = await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, name, username, created) VALUES (?,?,?,?)"
    )
      .bind(id, name, username, now())
      .run();
    if (r.meta && r.meta.changes === 1) {
      await env.DB.prepare(
        "INSERT INTO messages (from_id, to_id, text, ts) VALUES (0,?,?,?)"
      )
        .bind(
          id,
          `Добро пожаловать, ${name}! Это ваш телефон. Пишите СМС другим игрокам, играйте в игры и бейте рекорды.`,
          now()
        )
        .run();
    }
  } else if (row.name !== name || row.username !== username) {
    await env.DB.prepare("UPDATE users SET name=?, username=? WHERE id=?")
      .bind(name, username, id)
      .run();
  }
  return { id, name };
}

// ------------------------------------------------------------ вспомогательное
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad json");
  }
}

function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const webAppUrl = (env, origin) => env.WEBAPP_URL || origin;

const openKb = (env, origin) => ({
  inline_keyboard: [
    [{ text: "📱 Открыть телефон", web_app: { url: webAppUrl(env, origin) } }],
  ],
});

// ------------------------------------------------------------ API
async function apiMe(request, env) {
  const me = await currentUser(request, env);
  const c = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id=? AND is_read=0"
  )
    .bind(me.id)
    .first("c");
  return json({ id: me.id, name: me.name, unread: c || 0 });
}

async function apiContacts(request, env) {
  const me = await currentUser(request, env);
  const { results } = await env.DB.prepare(
    "SELECT id, name, username FROM users WHERE id>0 AND id!=? ORDER BY name LIMIT 200"
  )
    .bind(me.id)
    .all();
  return json(results);
}

async function apiInbox(request, env) {
  const me = await currentUser(request, env);
  const { results } = await env.DB.prepare(
    `SELECT g.other AS uid, COALESCE(u.name, '?') AS name, m.text AS last, m.ts AS ts,
            (SELECT COUNT(*) FROM messages x WHERE x.to_id=? AND x.from_id=g.other AND x.is_read=0) AS unread
     FROM (SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS other, MAX(id) AS mid
           FROM messages WHERE from_id=? OR to_id=? GROUP BY 1) g
     JOIN messages m ON m.id = g.mid
     LEFT JOIN users u ON u.id = g.other
     ORDER BY g.mid DESC LIMIT 50`
  )
    .bind(me.id, me.id, me.id, me.id)
    .all();
  return json(results.map((r) => ({ ...r, last: String(r.last).slice(0, 40) })));
}

async function apiMessages(request, env, url) {
  const me = await currentUser(request, env);
  const other = Number(url.searchParams.get("with"));
  if (!Number.isInteger(other)) throw new HttpError(400);
  const res = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, from_id, text, ts FROM messages
       WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
       ORDER BY id DESC LIMIT 60`
    ).bind(me.id, other, other, me.id),
    env.DB.prepare("UPDATE messages SET is_read=1 WHERE to_id=? AND from_id=?").bind(
      me.id,
      other
    ),
  ]);
  const rows = res[0].results.reverse();
  return json(
    rows.map((r) => ({ id: r.id, mine: r.from_id === me.id, text: r.text, ts: r.ts }))
  );
}

async function apiSend(request, env, ctx, origin) {
  const me = await currentUser(request, env);
  const data = await readJson(request);
  const to = Number(data.to);
  const text = String(data.text ?? "").trim().slice(0, 500);
  if (!Number.isInteger(to) || to <= 0 || to === me.id || !text) throw new HttpError(400);
  const target = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(to).first();
  if (!target) throw new HttpError(404);
  const t = now();
  const last = await env.DB.prepare("SELECT MAX(ts) AS t FROM messages WHERE from_id=?")
    .bind(me.id)
    .first("t");
  if (last && t - last < 1) throw new HttpError(429);
  await env.DB.prepare(
    "INSERT INTO messages (from_id, to_id, text, ts) VALUES (?,?,?,?)"
  )
    .bind(me.id, to, text, t)
    .run();
  ctx.waitUntil(
    tg(env, "sendMessage", {
      chat_id: to,
      text: `📩 Новое СМС от ${me.name}`,
      reply_markup: openKb(env, origin),
    }).catch(() => {})
  );
  return json({ ok: true });
}

async function apiScore(request, env) {
  const me = await currentUser(request, env);
  const data = await readJson(request);
  const game = String(data.game);
  const score = Number(data.score);
  if (!GAMES.includes(game) || !Number.isInteger(score) || score < 0 || score > 100000)
    throw new HttpError(400);
  if (game === "ttt") {
    await env.DB.prepare(
      "INSERT INTO scores (user_id, game, best) VALUES (?,?,1) ON CONFLICT(user_id, game) DO UPDATE SET best = best + 1"
    )
      .bind(me.id, game)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO scores (user_id, game, best) VALUES (?,?,?) ON CONFLICT(user_id, game) DO UPDATE SET best = MAX(best, excluded.best)"
    )
      .bind(me.id, game, score)
      .run();
  }
  return json({ ok: true });
}

async function apiTop(request, env, url) {
  await currentUser(request, env);
  const game = url.searchParams.get("game") || "";
  if (!GAMES.includes(game)) throw new HttpError(400);
  const { results } = await env.DB.prepare(
    `SELECT u.name AS name, s.best AS best FROM scores s JOIN users u ON u.id = s.user_id
     WHERE s.game=? ORDER BY s.best DESC LIMIT 10`
  )
    .bind(game)
    .all();
  return json(results);
}

// ------------------------------------------------------------ страница, вебхук, установка
async function page(env) {
  const src = env.HTML_URL || DEFAULT_HTML_URL;
  let r;
  try {
    r = await fetch(src, { cf: { cacheTtl: 120, cacheEverything: true } });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    return new Response(
      "Не удалось загрузить index.html. Проверьте, что репозиторий на GitHub публичный и файл index.html лежит в ветке main.",
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
  return new Response(await r.text(), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

async function webhook(request, env, ctx, origin) {
  const secret = await sha256hex("wh:" + env.BOT_TOKEN);
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!safeEqual(got, secret)) throw new HttpError(403);
  const update = await readJson(request);
  const m = update.message;
  if (m && m.chat && m.chat.type === "private") {
    ctx.waitUntil(
      tg(env, "sendMessage", {
        chat_id: m.chat.id,
        text: "📱 Ваш кнопочный телефон готов!\nСМС, игры, контакты и рекорды — жмите кнопку.",
        reply_markup: openKb(env, origin),
      }).catch(() => {})
    );
  }
  return new Response("ok");
}

async function setup(env, origin) {
  const out = [];
  if (!env.BOT_TOKEN) return text("Нет секрета BOT_TOKEN. Добавьте его в Settings → Variables and Secrets.");
  if (!env.DB) return text("Не подключена база. Добавьте привязку D1 с именем DB (Settings → Bindings).");
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  out.push("База: таблицы готовы ✓");
  const secret = await sha256hex("wh:" + env.BOT_TOKEN);
  const w = await (
    await tg(env, "setWebhook", {
      url: origin + "/webhook",
      secret_token: secret,
      allowed_updates: ["message"],
    })
  ).json();
  out.push("Вебхук: " + (w.ok ? "установлен ✓" : "ОШИБКА " + w.description));
  const b = await (
    await tg(env, "setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Телефон",
        web_app: { url: webAppUrl(env, origin) },
      },
    })
  ).json();
  out.push("Кнопка меню: " + (b.ok ? "установлена ✓" : "ОШИБКА " + b.description));
  out.push("", "Адрес приложения: " + webAppUrl(env, origin));
  out.push("Теперь напишите боту /start в Telegram.");
  return text(out.join("\n"));
}

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// ------------------------------------------------------------ точка входа
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = request.method;
    try {
      if (path === "/" && m === "GET") return await page(env);
      if (path === "/setup" && m === "GET") return await setup(env, url.origin);
      if (path === "/webhook" && m === "POST") return await webhook(request, env, ctx, url.origin);
      if (path.startsWith("/api/")) {
        if (!env.DB) throw new HttpError(500, "no database binding");
        if (m === "GET" && path === "/api/me") return await apiMe(request, env);
        if (m === "GET" && path === "/api/contacts") return await apiContacts(request, env);
        if (m === "GET" && path === "/api/inbox") return await apiInbox(request, env);
        if (m === "GET" && path === "/api/messages") return await apiMessages(request, env, url);
        if (m === "POST" && path === "/api/send") return await apiSend(request, env, ctx, url.origin);
        if (m === "POST" && path === "/api/score") return await apiScore(request, env);
        if (m === "GET" && path === "/api/top") return await apiTop(request, env, url);
      }
      return text("Not found", 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e && e.stack ? e.stack : e);
      return json({ error: "server error" }, 500);
    }
  },
};
