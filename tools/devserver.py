"""개발용 서버: web/ 화면을 브라우저에서 앱과 똑같이 돌려 보기 위한 것 (EXE에는 들어가지 않는다).

- /__invoke/<명령>  : Rust 명령(저장소·설정 파일 등)을 흉내 낸다. 저장소는 tools/dev-data/market.db (앱 데이터와 따로)
- /__proxy?url=...  : 브라우저 CORS를 피해서 시세 주소를 대신 부른다 (앱의 허용 목록과 같은 주소만)
알파카는 개발 서버에서 쓰지 않는다(키를 파일·환경변수에 두지 않기 위해) → 분봉 미국 주식은 EXE에서 확인.

실행: python tools/devserver.py 5280
  (FAKE TRADING은 5280. 원본 POWER CHART AND BACKTEST는 5180 — 같은 주소를 쓰면 브라우저 저장이 섞인다)
"""
import json
import os
import sqlite3
import struct
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "tools" / "dev-data"
DATA.mkdir(parents=True, exist_ok=True)
ALLOWED_HOSTS = {
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "fapi.binance.com",
    "api.hyperliquid.xyz",
    "cdn.cboe.com",
    "production.dataviz.cnn.io",
    "api.nasdaq.com",
    "nfs.faireconomy.media",
    "markets.newyorkfed.org",
    "www.federalreserve.gov",
    "www.clevelandfed.org",
}

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bars (sym TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL, PRIMARY KEY (sym, tf, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (sym TEXT NOT NULL, kind TEXT NOT NULL, t INTEGER NOT NULL, a REAL NOT NULL, b REAL NOT NULL,
  PRIMARY KEY (sym, kind, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""
lock = threading.Lock()
conn = sqlite3.connect(DATA / "market.db", check_same_thread=False)
conn.executescript(SCHEMA)


def safe(name):
    ok = name and not name.startswith(".") and all(c.isalnum() or c in "_-." for c in name)
    if not ok:
        raise ValueError(f"잘못된 파일 이름: {name}")
    return DATA / name


def cmd(name, a, raw=None, headers=None):
    """명령 실행 → (값, 바이너리 여부)"""
    if name == "append_log":
        (DATA / "logs").mkdir(exist_ok=True)
        with open(DATA / "logs" / "app.log", "a", encoding="utf-8") as f:
            f.write(a["line"] + "\n")
        print(a["line"][:200])
        return None, False
    if name == "load_json":
        p = safe(a["name"])
        return (p.read_text(encoding="utf-8") if p.exists() else None), False
    if name == "save_json":
        safe(a["name"]).write_text(a["data"], encoding="utf-8")
        return None, False
    if name == "load_market_board_stocklist":
        p = Path(os.environ.get("APPDATA", "")) / "market-board" / "stocks_all.json"
        return (p.read_text(encoding="utf-8") if p.exists() else None), False
    if name in ("set_fullscreen", "set_zoom", "open_folder"):
        return None, False
    if name == "save_export":
        n = a["name"]
        safe(n).write_bytes(a["text"].encode("utf-8-sig"))
        return str(DATA / n), False
    if name == "save_capture":
        n = headers.get("name", "chart.png")
        safe(n).write_bytes(raw)
        return str(DATA / n), False
    if name.startswith("alpaca_"):
        if name == "alpaca_key_status":
            return {"saved": False, "hint": None}, False
        raise RuntimeError("no_key: 개발 서버에서는 알파카를 쓰지 않아요")
    with lock:
        if name == "db_put":
            rows = [(a["sym"], a["tf"], int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in a["rows"]]
            conn.executemany("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)", rows)
            conn.commit()
            return len(rows), False
        if name == "db_get":
            before = a.get("before")
            before = 2**62 if before is None else before
            limit = a.get("limit") or 5000
            if a.get("after") is not None:
                cur = conn.execute("SELECT t,o,h,l,c,v FROM bars WHERE sym=? AND tf=? AND t>=? AND t<? ORDER BY t ASC LIMIT ?", (a["sym"], a["tf"], a["after"], before, limit))
                rows = cur.fetchall()
            else:
                cur = conn.execute("SELECT t,o,h,l,c,v FROM bars WHERE sym=? AND tf=? AND t<? ORDER BY t DESC LIMIT ?", (a["sym"], a["tf"], before, limit))
                rows = cur.fetchall()[::-1]
            flat = [float(x) for r in rows for x in r]
            return struct.pack(f"<{len(flat)}d", *flat), True
        if name == "db_range":
            r = conn.execute("SELECT MIN(t), MAX(t), COUNT(*) FROM bars WHERE sym=? AND tf=?", (a["sym"], a["tf"])).fetchone()
            return ({"first": r[0], "last": r[1], "count": r[2]} if r[2] else None), False
        if name == "db_coverage":
            rows = conn.execute("SELECT sym, tf, MIN(t), MAX(t), COUNT(*) FROM bars GROUP BY sym, tf ORDER BY sym, tf").fetchall()
            return [{"sym": r[0], "tf": r[1], "first": r[2], "last": r[3], "count": r[4]} for r in rows], False
        if name == "db_put_events":
            conn.executemany("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?)", [(a["sym"], r[0], r[1], r[2], r[3]) for r in a["rows"]])
            conn.commit()
            return len(a["rows"]), False
        if name == "db_get_events":
            return [list(r) for r in conn.execute("SELECT kind, t, a, b FROM events WHERE sym=? ORDER BY t", (a["sym"],))], False
        if name == "db_delete":
            if a.get("tf"):
                conn.execute("DELETE FROM bars WHERE sym=? AND tf=?", (a["sym"], a["tf"]))
            else:
                for t in ("bars", "events"):
                    conn.execute(f"DELETE FROM {t} WHERE sym=?", (a["sym"],))
                conn.execute("DELETE FROM meta WHERE k LIKE ?", (a["sym"] + "|%",))
            conn.commit()
            return None, False
        if name == "db_meta_get":
            r = conn.execute("SELECT v FROM meta WHERE k=?", (a["k"],)).fetchone()
            return (r[0] if r else None), False
        if name == "db_meta_set":
            if a.get("v") is None:
                conn.execute("DELETE FROM meta WHERE k=?", (a["k"],))
            else:
                conn.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (a["k"], a["v"]))
            conn.commit()
            return None, False
        if name == "db_size":
            return sum(p.stat().st_size for p in DATA.glob("market.db*")), False
        if name == "db_vacuum":
            conn.execute("VACUUM")
            return None, False
        if name == "db_gaps":
            rows = conn.execute(
                "SELECT t, nt FROM (SELECT t, LEAD(t) OVER (ORDER BY t) AS nt FROM bars WHERE sym=? AND tf=?) WHERE nt - t > ? LIMIT 500",
                (a["sym"], a["tf"], a["minGap"]),
            ).fetchall()
            return [list(r) for r in rows], False
    if name == "update_check":
        # 🆕 새 버전 받기 흉내 (0.15.0): GitHub에 진짜로 물어본다 (Rust update.rs와 같은 저장소·같은 모양). 지금 버전은 tauri.conf.json
        current = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
        req = urllib.request.Request("https://api.github.com/repos/rlagustn92/fake-trading-power-chart/releases/latest",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": f"fake-trading-power-chart/{current} (devserver)"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, False
            raise
        asset = next((x for x in j.get("assets", []) if x.get("name") == "FAKE-TRADING-POWER-CHART.exe"), None)
        if not asset:
            return None, False
        version = j["tag_name"].lstrip("v")
        num = lambda v: tuple(int(x) for x in v.split("."))
        return {"version": version, "notes": (j.get("body") or "")[:4000], "size": asset["size"], "digest": asset.get("digest"),
                "current": current, "newer": num(version) > num(current)}, False
    if name in ("update_install", "update_restart"):
        raise RuntimeError("개발 서버에서는 안 돼요 (EXE에서만)")
    if name == "backup_list":
        return [], False
    if name in ("backup_create", "backup_restore", "quit_app"):
        raise RuntimeError("개발 서버에서는 안 돼요 (EXE에서만)")
    raise RuntimeError(f"모르는 명령: {name}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path.startswith("/__invoke/"):
            name = self.path[len("/__invoke/"):]
            try:
                binary_in = "octet-stream" in (self.headers.get("content-type") or "")
                args = {} if binary_in or not raw else json.loads(raw)
                val, binary = cmd(name, args, raw if binary_in else None, {k.lower(): v for k, v in self.headers.items()})
                if binary:
                    self.send(200, val, "application/octet-stream")
                else:
                    self.send(200, b"" if val is None else json.dumps(val).encode(), "application/json")
            except Exception as e:  # noqa: BLE001
                self.send(500, str(e).encode(), "text/plain; charset=utf-8")
            return
        if self.path.startswith("/__proxy"):
            return self.proxy(raw)
        self.send(404, b"", "text/plain")

    def do_GET(self):
        if self.path.startswith("/__proxy"):
            return self.proxy(None)
        return super().do_GET()

    def proxy(self, body):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = q.get("url", [""])[0]
        host = urllib.parse.urlparse(url).hostname
        if host not in ALLOWED_HOSTS:
            return self.send(403, f"허용되지 않은 주소: {host}".encode(), "text/plain; charset=utf-8")
        headers = json.loads(self.headers.get("x-proxy-headers") or "{}")
        if body is not None and "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body if body else None, headers=headers, method="POST" if body else "GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self.send(r.status, r.read(), r.headers.get("Content-Type") or "application/octet-stream")
        except urllib.error.HTTPError as e:
            self.send(e.code, e.read(), e.headers.get("Content-Type") or "text/plain")
        except Exception as e:  # noqa: BLE001
            self.send(502, str(e).encode(), "text/plain; charset=utf-8")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5280
    print(f"http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
