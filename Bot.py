import asyncio
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from urllib.parse import parse_qsl

from aiogram import Bot, Dispatcher
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)
from aiohttp import web
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("9015686996:AAGrxqF5rHNNwQxsCnnR_AXcNrVPTecmvZM", "")
WEBAPP_URL = os.getenv("WEBAPP_URL", "")
PORT = int(os.getenv("PORT", "8080"))
DEV = os.getenv("DEV") == "1"
BASE = Path(__file__).parent
DB_PATH = os.getenv("DB_PATH", str(BASE / "phone.db"))

logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------- БД
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript(
    """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT DEFAULT '',
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, is_read);
CREATE TABLE IF NOT EXISTS scores (
    user_id INTEGER NOT NULL,
    game TEXT NOT NULL,
    best INTEGER NOT NULL,
    PRIMARY KEY (user_id, game)
);
INSERT OR IGNORE INTO users (id, name, username, created) VALUES (0, 'Оператор', '', 0);
"""
)
db.commit()

GAMES = {"snake", "ttt"}


# ---------------------------------------------------------------- авторизация
def parse_user(init_data: str):
    if DEV and init_data.startswith("dev:"):
        try:
            _, uid, name = init_data.split(":", 2)
            return {"id": int(uid), "first_name": name, "username": ""}
        except ValueError:
            return None
    if not init_data or not BOT_TOKEN:
        return None
    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    got = parsed.pop("hash", None)
    if not got:
        return None
    check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got):
        return None
    try:
        if time.time() - int(parsed.get("auth_date", "0")) > 7 * 86400:
            return None
        return json.loads(parsed["user"])
    except (KeyError, ValueError):
        return None


def current_user(request: web.Request) -> sqlite3.Row:
    tg_user = parse_user(request.headers.get("X-Init-Data", ""))
    if not tg_user or tg_user.get("id", 0) <= 0:
        raise web.HTTPUnauthorized(text="bad init data")
    uid = int(tg_user["id"])
    name = (tg_user.get("first_name") or "Аноним")[:24]
    username = tg_user.get("username") or ""
    row = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if row is None:
        db.execute(
            "INSERT INTO users (id, name, username, created) VALUES (?,?,?,?)",
            (uid, name, username, int(time.time())),
        )
        db.execute(
            "INSERT INTO messages (from_id, to_id, text, ts) VALUES (0,?,?,?)",
            (
                uid,
                f"Добро пожаловать, {name}! Это ваш телефон. "
                "Пишите СМС другим игрокам, играйте в игры и бейте рекорды.",
                int(time.time()),
            ),
        )
    else:
        db.execute("UPDATE users SET name=?, username=? WHERE id=?", (name, username, uid))
    db.commit()
    return db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


# ---------------------------------------------------------------- API
def j(data):
    return web.json_response(data)


async def api_me(request):
    me = current_user(request)
    unread = db.execute(
        "SELECT COUNT(*) FROM messages WHERE to_id=? AND is_read=0", (me["id"],)
    ).fetchone()[0]
    return j({"id": me["id"], "name": me["name"], "unread": unread})


async def api_contacts(request):
    me = current_user(request)
    rows = db.execute(
        "SELECT id, name, username FROM users WHERE id>0 AND id!=? ORDER BY name LIMIT 200",
        (me["id"],),
    ).fetchall()
    return j([dict(r) for r in rows])


async def api_inbox(request):
    me = current_user(request)["id"]
    others = db.execute(
        """SELECT other, MAX(id) AS mid FROM (
               SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS other, id
               FROM messages WHERE from_id=? OR to_id=?
           ) GROUP BY other ORDER BY mid DESC LIMIT 50""",
        (me, me, me),
    ).fetchall()
    out = []
    for o in others:
        u = db.execute("SELECT name FROM users WHERE id=?", (o["other"],)).fetchone()
        last = db.execute("SELECT text, ts FROM messages WHERE id=?", (o["mid"],)).fetchone()
        unread = db.execute(
            "SELECT COUNT(*) FROM messages WHERE to_id=? AND from_id=? AND is_read=0",
            (me, o["other"]),
        ).fetchone()[0]
        out.append(
            {
                "uid": o["other"],
                "name": u["name"] if u else "?",
                "last": last["text"][:40],
                "ts": last["ts"],
                "unread": unread,
            }
        )
    return j(out)


async def api_messages(request):
    me = current_user(request)["id"]
    try:
        other = int(request.query.get("with", ""))
    except ValueError:
        raise web.HTTPBadRequest()
    rows = db.execute(
        """SELECT id, from_id, text, ts FROM messages
           WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
           ORDER BY id DESC LIMIT 60""",
        (me, other, other, me),
    ).fetchall()
    db.execute(
        "UPDATE messages SET is_read=1 WHERE to_id=? AND from_id=?", (me, other)
    )
    db.commit()
    return j(
        [
            {"id": r["id"], "mine": r["from_id"] == me, "text": r["text"], "ts": r["ts"]}
            for r in reversed(rows)
        ]
    )


async def api_send(request):
    me = current_user(request)
    try:
        data = await request.json()
        to = int(data["to"])
        text = str(data["text"]).strip()[:500]
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest()
    if not text or to <= 0 or to == me["id"]:
        raise web.HTTPBadRequest()
    if db.execute("SELECT 1 FROM users WHERE id=?", (to,)).fetchone() is None:
        raise web.HTTPNotFound()
    last = db.execute(
        "SELECT MAX(ts) FROM messages WHERE from_id=?", (me["id"],)
    ).fetchone()[0]
    if last and time.time() - last < 1:
        raise web.HTTPTooManyRequests()
    db.execute(
        "INSERT INTO messages (from_id, to_id, text, ts) VALUES (?,?,?,?)",
        (me["id"], to, text, int(time.time())),
    )
    db.commit()
    bot: Bot = request.app["bot"]
    try:
        await bot.send_message(
            to,
            f"📩 Новое СМС от {me['name']}",
            reply_markup=open_kb(),
        )
    except Exception:
        pass
    return j({"ok": True})


async def api_score(request):
    me = current_user(request)["id"]
    try:
        data = await request.json()
        game = str(data["game"])
        score = int(data["score"])
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest()
    if game not in GAMES or score < 0 or score > 100000:
        raise web.HTTPBadRequest()
    if game == "ttt":
        db.execute(
            """INSERT INTO scores (user_id, game, best) VALUES (?,?,1)
               ON CONFLICT(user_id, game) DO UPDATE SET best = best + 1""",
            (me, game),
        )
    else:
        db.execute(
            """INSERT INTO scores (user_id, game, best) VALUES (?,?,?)
               ON CONFLICT(user_id, game) DO UPDATE SET best = MAX(best, excluded.best)""",
            (me, game, score),
        )
    db.commit()
    return j({"ok": True})


async def api_top(request):
    current_user(request)
    game = request.query.get("game", "")
    if game not in GAMES:
        raise web.HTTPBadRequest()
    rows = db.execute(
        """SELECT u.name, s.best FROM scores s JOIN users u ON u.id=s.user_id
           WHERE s.game=? ORDER BY s.best DESC LIMIT 10""",
        (game,),
    ).fetchall()
    return j([dict(r) for r in rows])


async def index(request):
    return web.FileResponse(BASE / "index.html")


# ---------------------------------------------------------------- бот
def open_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📱 Открыть телефон", web_app=WebAppInfo(url=WEBAPP_URL))]
        ]
    )


dp = Dispatcher()


@dp.message(CommandStart())
@dp.message(Command("phone"))
async def start(message: Message):
    await message.answer(
        "📱 Ваш кнопочный телефон готов!\nСМС, игры, контакты и рекорды — жмите кнопку.",
        reply_markup=open_kb(),
    )


async def main():
    if not BOT_TOKEN or not WEBAPP_URL:
        raise SystemExit("Заполните BOT_TOKEN и WEBAPP_URL")
    bot = Bot(BOT_TOKEN)

    app = web.Application()
    app["bot"] = bot
    app.add_routes(
        [
            web.get("/", index),
            web.get("/api/me", api_me),
            web.get("/api/contacts", api_contacts),
            web.get("/api/inbox", api_inbox),
            web.get("/api/messages", api_messages),
            web.post("/api/send", api_send),
            web.post("/api/score", api_score),
            web.get("/api/top", api_top),
        ]
    )
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    logging.info("Web server on :%s", PORT)

    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Телефон", web_app=WebAppInfo(url=WEBAPP_URL))
    )
    try:
        await dp.start_polling(bot)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
