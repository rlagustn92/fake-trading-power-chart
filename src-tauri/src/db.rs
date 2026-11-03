//! 차트 데이터 저장소 (SPEC §2.4). `%APPDATA%\fake-trading-power-chart\market.db` 파일 하나.
//!
//! - 가격은 **실제 가격(분할 반영 전)** 으로 저장하고, 분할·배당은 `events`에 따로 둔다.
//!   새 분할이 생겨도 저장된 봉을 다시 받을 필요가 없다. 반영은 화면(JS)이 읽을 때 한다.
//! - 이 모듈은 "넣고 꺼내기"만 한다. 계산(분할 반영, 봉 묶기)은 JS 한곳에서 한다(브라우저 개발 서버와 같은 코드).
//! - 모든 작업은 화면 스레드가 아닌 곳에서(`spawn_blocking`) 돌려서 화면이 멈추지 않는다.
//! - 봉 읽기는 숫자 배열(f64 리틀 엔디언 `[t,o,h,l,c,v] × n`)을 그대로 돌려준다 → JSON보다 훨씬 빠르다.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::State;

pub struct Db {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -32000;
CREATE TABLE IF NOT EXISTS bars (
  sym TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (sym, tf, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  sym TEXT NOT NULL, kind TEXT NOT NULL, t INTEGER NOT NULL, a REAL NOT NULL, b REAL NOT NULL,
  PRIMARY KEY (sym, kind, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
";

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path: path.to_path_buf() })
    }

    /// 화면 스레드 밖에서 DB 작업 하나 돌리기
    async fn run<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let c = self.conn.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut conn = c.lock().map_err(|_| "DB 잠금 실패".to_string())?;
            f(&mut conn).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

fn check_key(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 96 {
        return Err(format!("잘못된 이름: {s}"));
    }
    Ok(())
}

/// 봉 넣기 (같은 시각이면 바꿔 쓴다). rows = [[t,o,h,l,c,v], ...]
#[tauri::command]
pub async fn db_put(db: State<'_, Db>, sym: String, tf: String, rows: Vec<[f64; 6]>) -> Result<usize, String> {
    check_key(&sym)?;
    check_key(&tf)?;
    db.run(move |c| {
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare_cached(
                "INSERT OR REPLACE INTO bars (sym, tf, t, o, h, l, c, v) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for r in &rows {
                if r.iter().any(|x| !x.is_finite()) {
                    continue;
                }
                st.execute(params![sym, tf, r[0] as i64, r[1], r[2], r[3], r[4], r[5]])?;
            }
        }
        tx.commit()?;
        Ok(rows.len())
    })
    .await
}

/// 봉 읽기 → f64 배열 [t,o,h,l,c,v]×n (시간 오름차순).
/// - `after`가 있으면: after 이상(그리고 before 미만)을 앞에서부터 limit개
/// - 없으면: before 미만에서 **가장 최근** limit개
#[tauri::command]
pub async fn db_get(
    db: State<'_, Db>,
    sym: String,
    tf: String,
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u32>,
) -> Result<Response, String> {
    check_key(&sym)?;
    check_key(&tf)?;
    let before = before.unwrap_or(i64::MAX);
    let limit = limit.unwrap_or(5000).min(2_000_000) as i64;
    let bytes = db
        .run(move |c| {
            let mut out: Vec<[f64; 6]> = Vec::new();
            let row = |r: &rusqlite::Row| -> rusqlite::Result<[f64; 6]> {
                Ok([r.get::<_, i64>(0)? as f64, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?])
            };
            if let Some(after) = after {
                let mut st = c.prepare_cached(
                    "SELECT t, o, h, l, c, v FROM bars WHERE sym = ?1 AND tf = ?2 AND t >= ?3 AND t < ?4 ORDER BY t ASC LIMIT ?5",
                )?;
                for r in st.query_map(params![sym, tf, after, before, limit], row)? {
                    out.push(r?);
                }
            } else {
                let mut st = c.prepare_cached(
                    "SELECT t, o, h, l, c, v FROM bars WHERE sym = ?1 AND tf = ?2 AND t < ?3 ORDER BY t DESC LIMIT ?4",
                )?;
                for r in st.query_map(params![sym, tf, before, limit], row)? {
                    out.push(r?);
                }
                out.reverse();
            }
            let mut bytes = Vec::with_capacity(out.len() * 48);
            for r in &out {
                for x in r {
                    bytes.extend_from_slice(&x.to_le_bytes());
                }
            }
            Ok(bytes)
        })
        .await?;
    Ok(Response::new(bytes))
}

#[derive(Serialize)]
pub struct Range {
    first: i64,
    last: i64,
    count: i64,
}

/// 저장된 범위 (없으면 null)
#[tauri::command]
pub async fn db_range(db: State<'_, Db>, sym: String, tf: String) -> Result<Option<Range>, String> {
    db.run(move |c| {
        c.query_row(
            "SELECT MIN(t), MAX(t), COUNT(*) FROM bars WHERE sym = ?1 AND tf = ?2",
            params![sym, tf],
            |r| {
                let n: i64 = r.get(2)?;
                Ok(if n == 0 { None } else { Some(Range { first: r.get(0)?, last: r.get(1)?, count: n }) })
            },
        )
    })
    .await
}

#[derive(Serialize)]
pub struct Coverage {
    sym: String,
    tf: String,
    first: i64,
    last: i64,
    count: i64,
}

/// 저장된 것 전체 목록 (설정 → 데이터 화면)
#[tauri::command]
pub async fn db_coverage(db: State<'_, Db>) -> Result<Vec<Coverage>, String> {
    db.run(|c| {
        let mut st = c.prepare("SELECT sym, tf, MIN(t), MAX(t), COUNT(*) FROM bars GROUP BY sym, tf ORDER BY sym, tf")?;
        let rows = st
            .query_map([], |r| {
                Ok(Coverage { sym: r.get(0)?, tf: r.get(1)?, first: r.get(2)?, last: r.get(3)?, count: r.get(4)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await
}

/// 분할·배당 넣기. rows = [[kind, t, a, b]] (split: a=새 주식 수, b=옛 주식 수 / div: a=주당 배당(실제 금액))
#[tauri::command]
pub async fn db_put_events(db: State<'_, Db>, sym: String, rows: Vec<(String, i64, f64, f64)>) -> Result<usize, String> {
    check_key(&sym)?;
    db.run(move |c| {
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare_cached("INSERT OR REPLACE INTO events (sym, kind, t, a, b) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for (kind, t, a, b) in &rows {
                st.execute(params![sym, kind, t, a, b])?;
            }
        }
        tx.commit()?;
        Ok(rows.len())
    })
    .await
}

#[tauri::command]
pub async fn db_get_events(db: State<'_, Db>, sym: String) -> Result<Vec<(String, i64, f64, f64)>, String> {
    db.run(move |c| {
        let mut st = c.prepare_cached("SELECT kind, t, a, b FROM events WHERE sym = ?1 ORDER BY t")?;
        let rows = st
            .query_map(params![sym], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await
}

/// 종목 지우기. tf가 없으면 그 종목의 봉·분할·배당·기록 전부
#[tauri::command]
pub async fn db_delete(db: State<'_, Db>, sym: String, tf: Option<String>) -> Result<(), String> {
    db.run(move |c| {
        match tf {
            Some(tf) => {
                c.execute("DELETE FROM bars WHERE sym = ?1 AND tf = ?2", params![sym, tf])?;
            }
            None => {
                c.execute("DELETE FROM bars WHERE sym = ?1", params![sym])?;
                c.execute("DELETE FROM events WHERE sym = ?1", params![sym])?;
                c.execute("DELETE FROM meta WHERE k LIKE ?1", params![format!("{sym}|%")])?;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn db_meta_get(db: State<'_, Db>, k: String) -> Result<Option<String>, String> {
    db.run(move |c| c.query_row("SELECT v FROM meta WHERE k = ?1", params![k], |r| r.get(0)).optional())
        .await
}

#[tauri::command]
pub async fn db_meta_set(db: State<'_, Db>, k: String, v: Option<String>) -> Result<(), String> {
    check_key(&k)?;
    db.run(move |c| {
        match v {
            Some(v) => c.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)", params![k, v])?,
            None => c.execute("DELETE FROM meta WHERE k = ?1", params![k])?,
        };
        Ok(())
    })
    .await
}

/// DB 파일 크기(바이트, WAL 포함)
#[tauri::command]
pub fn db_size(db: State<'_, Db>) -> u64 {
    let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let wal = db.path.with_extension("db-wal");
    size(&db.path) + size(&wal)
}

/// 봉 사이가 min_gap초보다 벌어진 곳 [[앞 봉, 뒤 봉], ...] (받다가 끊겨 생긴 구멍 찾기)
#[tauri::command]
pub async fn db_gaps(db: State<'_, Db>, sym: String, tf: String, min_gap: i64) -> Result<Vec<(i64, i64)>, String> {
    check_key(&sym)?;
    check_key(&tf)?;
    db.run(move |c| {
        let mut st = c.prepare(
            "SELECT t, nt FROM (SELECT t, LEAD(t) OVER (ORDER BY t) AS nt FROM bars WHERE sym = ?1 AND tf = ?2) WHERE nt - t > ?3 LIMIT 500",
        )?;
        let rows = st.query_map(params![sym, tf, min_gap], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await
}

impl Db {
    /// 켜 둔 채로 안전하게 사본 만들기 (VACUUM INTO: 빈 공간 없이 한 파일로)
    pub async fn backup_to(&self, path: PathBuf) -> Result<(), String> {
        self.run(move |c| c.execute("VACUUM INTO ?1", params![path.to_string_lossy().to_string()]).map(|_| ())).await
    }
}

/// 지운 뒤 빈 공간 돌려받기
#[tauri::command]
pub async fn db_vacuum(db: State<'_, Db>) -> Result<(), String> {
    db.run(|c| c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_opens_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("pcb-test-{}", std::process::id()));
        let db = Db::open(&dir.join("t.db")).unwrap();
        let c = db.conn.lock().unwrap();
        c.execute(
            "INSERT OR REPLACE INTO bars VALUES ('QQQ','1D',100,1,2,0.5,1.5,10)",
            [],
        )
        .unwrap();
        c.execute("INSERT OR REPLACE INTO bars VALUES ('QQQ','1D',100,1,2,0.5,1.7,10)", []).unwrap();
        let (n, close): (i64, f64) = c
            .query_row("SELECT COUNT(*), MAX(c) FROM bars WHERE sym='QQQ'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(close, 1.7);
        drop(c);
        let _ = std::fs::remove_dir_all(dir);
    }
}
