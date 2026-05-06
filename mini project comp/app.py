import os
import re
import sqlite3
import uuid
import hashlib
import secrets
import time
import urllib.parse
import random
from functools import wraps
from datetime import datetime

from flask import Flask, render_template, request, jsonify, session, g, redirect, url_for
from dotenv import load_dotenv
from groq import Groq

# ================= ENV =================
load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))

DATABASE = "medical_chatbot.db"
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# ================= DB =================
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exception):
    db = g.pop("db", None)
    if db:
        db.close()

def init_db():
    db = sqlite3.connect(DATABASE)
    c = db.cursor()

    c.execute("""CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        created_at TIMESTAMP,
        last_login TIMESTAMP
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        role TEXT,
        content TEXT,
        message_type TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS search_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        search_type TEXT,
        search_query TEXT,
        maps_link TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS emergency_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        trigger_message TEXT,
        detected_keywords TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")

    db.commit()
    db.close()

# ================= AUTH =================
def hash_password(pw):
    salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100000)
    return f"{salt}${hashed.hex()}"

def verify_password(pw, stored):
    salt, h = stored.split("$")
    new = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100000)
    return new.hex() == h

def login_required(f):
    @wraps(f)
    def wrap(*a, **k):
        if "user_id" not in session:
            return redirect(url_for("login_page"))
        return f(*a, **k)
    return wrap

# ================= MEDICAL LOGIC =================
EMERGENCY_KEYWORDS = [
    "heart attack", "chest pain", "stroke", "unconscious",
    "severe bleeding", "can't breathe", "suicide"
]

SYSTEM_PROMPT = """You are a medical information assistant.
Provide only GENERAL health information.
Do NOT diagnose or prescribe.
Always recommend consulting a professional."""

def check_emergency(msg):
    return [k for k in EMERGENCY_KEYWORDS if k in msg.lower()]

def save_message(uid, role, content, t="chat"):
    db = get_db()
    db.execute(
        "INSERT INTO chat_messages (user_id, role, content, message_type) VALUES (?, ?, ?, ?)",
        (uid, role, content, t),
    )
    db.commit()

def get_history(uid):
    db = get_db()
    rows = db.execute(
        "SELECT role, content FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 6",
        (uid,),
    ).fetchall()
    return list(reversed([dict(r) for r in rows]))

# ================= GROQ CHAT =================
def call_groq_api(message, history):
    if not client:
        raise Exception("Groq API key missing")

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in history:
        messages.append({"role": h["role"], "content": h["content"][:400]})

    messages.append({"role": "user", "content": message})

    resp = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=messages,
        temperature=0.6,
        max_tokens=500
    )

    return resp.choices[0].message.content + \
        "\n\n⚠️ General info only. Consult a doctor."

# ================= ROUTES =================
@app.route("/login")
def login_page():
    return render_template("login.html")

@app.route("/signup")
def signup_page():
    return render_template("signup.html")

@app.route("/api/signup", methods=["POST"])
def signup():
    d = request.get_json()
    uid = str(uuid.uuid4())
    db = get_db()
    db.execute(
        "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
        (uid, d["username"], d["email"], hash_password(d["password"]),
         datetime.now(), None)
    )
    db.commit()
    session["user_id"] = uid
    return jsonify(success=True)

@app.route("/api/login", methods=["POST"])
def login():
    d = request.get_json()
    db = get_db()
    u = db.execute("SELECT * FROM users WHERE email=?", (d["email"],)).fetchone()
    if not u or not verify_password(d["password"], u["password_hash"]):
        return jsonify(error="Invalid login"), 401
    session["user_id"] = u["id"]
    return jsonify(success=True)

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")

@app.route("/")
@login_required
def index():
    return render_template("index.html")

@app.route("/api/chat", methods=["POST"])
@login_required
def chat():
    msg = request.get_json().get("message", "").strip()
    uid = session["user_id"]

    if not msg:
        return jsonify(reply="Enter a message")

    emergency = check_emergency(msg)
    if emergency:
        save_message(uid, "user", msg, "emergency")
        reply = "🚨 EMERGENCY DETECTED 🚨\nCall local emergency services immediately."
        save_message(uid, "assistant", reply, "emergency")
        return jsonify(reply=reply, type="emergency")

    history = get_history(uid)
    reply = call_groq_api(msg, history)

    save_message(uid, "user", msg)
    save_message(uid, "assistant", reply)

    return jsonify(reply=reply, type="chat")

@app.route("/api/history")
@login_required
def history():
    return jsonify(get_history(session["user_id"]))

@app.route("/health")
def health():
    return jsonify(status="ok", groq=bool(GROQ_API_KEY))

# ================= RUN =================
if __name__ == "__main__":
    init_db()
    print("\n🏥 MEDIBOT (GROQ)")
    print("🌐 http://localhost:5000")
    app.run(debug=True, host="0.0.0.0", port=5000)
