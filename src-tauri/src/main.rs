// 릴리스 빌드에서는 콘솔 창을 띄우지 않는다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alpaca;
mod alpaca_stream;
mod db;
mod toss;
mod update;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

// 원본(power-chart-and-backtest)과 데이터 폴더를 나눈다 (복제할 때 바꿈, 2026-10-30)
const APP_DIR: &str = "fake-trading-power-chart";
/// 문서·사진 아래 폴더 이름 (캡처·CSV·백업)
const USER_DIR: &str = "FAKE TRADING POWER CHART";
/// 백업 폴더 이름 앞부분 (원본은 POWER-CHART-)
const BACKUP_PREFIX: &str = "FAKE-TRADING-";

/// 창 상태 기억 (%APPDATA%\fake-trading-power-chart\window.json)
/// 마지막에 전체화면이었으면 다음에도 그 모니터에 전체화면으로 켠다 (SPEC §0.2)
#[derive(Serialize, Deserialize, Default)]
struct WindowState {
    fullscreen: bool,
    monitor: Option<MonitorPin>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MonitorPin {
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

const WINDOW_FILE: &str = "window.json";

/// %APPDATA%\fake-trading-power-chart
fn data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_DIR)
}

/// 파일 이름은 영문·숫자·`_-.`만 허용 (폴더 밖으로 나가지 못하게)
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn safe_path(name: &str) -> Result<PathBuf, String> {
    if safe_name(name) {
        Ok(data_dir().join(name))
    } else {
        Err(format!("잘못된 파일 이름: {name}"))
    }
}

fn read_file(name: &str) -> Option<String> {
    fs::read_to_string(safe_path(name).ok()?).ok()
}

/// 임시 파일에 쓴 뒤 이름을 바꿔서, 쓰다가 꺼져도 파일이 깨지지 않게 한다
fn write_file(name: &str, data: &str) -> Result<(), String> {
    let path = safe_path(name)?;
    fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

const LOG_MAX: u64 = 1024 * 1024;

/// 로그 한 줄 추가. 파일당 최대 1MB, 최근 3개만 유지 (app.log, app.1.log, app.2.log)
#[tauri::command]
fn append_log(line: String) {
    use std::io::Write;
    let dir = data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let cur = dir.join("app.log");
    if fs::metadata(&cur).map(|m| m.len() > LOG_MAX).unwrap_or(false) {
        let _ = fs::rename(dir.join("app.1.log"), dir.join("app.2.log"));
        let _ = fs::rename(&cur, dir.join("app.1.log"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&cur) {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
fn load_json(name: String) -> Option<String> {
    read_file(&name)
}

#[tauri::command]
fn save_json(name: String, data: String) -> Result<(), String> {
    write_file(&name, &data)
}

/// Market Board의 종목 이름 목록(국내·미국 한글 이름)이 있으면 읽기만 한다 (SPEC §2.10)
#[tauri::command]
fn load_market_board_stocklist() -> Option<String> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    fs::read_to_string(base.join("market-board").join("stocks_all.json")).ok()
}

fn load_window_state() -> WindowState {
    read_file(WINDOW_FILE).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// 전체화면 켜기/끄기. 켜면 그 모니터를 기억해서 다음 실행 때 그 모니터에 전체화면으로 띄운다.
#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    let mut st = load_window_state();
    if on {
        if let Ok(Some(m)) = window.current_monitor() {
            st.monitor = Some(MonitorPin {
                name: m.name().cloned().unwrap_or_default(),
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
            });
        }
    }
    st.fullscreen = on;
    let _ = write_file(WINDOW_FILE, &serde_json::to_string(&st).unwrap());
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// 글씨 배율 (Ctrl ±): 브라우저 확대처럼 화면 전체를 키운다 → 차트 글씨도 선명하게 커진다
#[tauri::command]
fn set_zoom(window: WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.5, 2.0)).map_err(|e| e.to_string())
}

/// 차트 캡처 PNG 저장 → 사진\FAKE TRADING POWER CHART 폴더. 몸통은 PNG 바이트, 파일 이름은 헤더 `name`
#[tauri::command]
fn save_capture(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request
        .headers()
        .get("name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("chart.png")
        .to_string();
    if !safe_name(&name) || !name.ends_with(".png") {
        return Err(format!("잘못된 파일 이름: {name}"));
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("그림 데이터가 없습니다".into());
    };
    let dir = captures_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 백테스트 CSV 저장: 문서\FAKE TRADING POWER CHART\이름.csv (엑셀에서 바로 열리게 UTF-8 BOM)
#[tauri::command]
fn save_export(name: String, text: String) -> Result<String, String> {
    if !safe_name(&name) || !name.ends_with(".csv") {
        return Err(format!("잘못된 파일 이름: {name}"));
    }
    let dir = exports_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(text.as_bytes());
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn exports_dir() -> PathBuf {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(data_dir);
    base.join("Documents").join(USER_DIR)
}

/// 데이터 옮기기 (다른 PC로): 문서\FAKE TRADING POWER CHART\백업\<이름>\ 에 market.db·config.json·drawings.json·trades.json
fn backups_dir() -> PathBuf {
    exports_dir().join("백업")
}

/// 옮길 때 같이 가는 파일 (창 위치·키는 PC마다 다르니 빼고)
/// trades.json = 💰 모의매매 계좌·거래 기록 (FAKE TRADING에서 더함)
const BACKUP_FILES: &[&str] = &["config.json", "drawings.json", "trades.json"];

#[tauri::command]
async fn backup_create(db: tauri::State<'_, db::Db>, name: String) -> Result<String, String> {
    if !safe_name(&name) {
        return Err(format!("잘못된 이름: {name}"));
    }
    let dir = backups_dir().join(&name);
    if dir.exists() {
        return Err("같은 이름의 백업이 이미 있어요".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Err(e) = db.backup_to(dir.join("market.db")).await {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    for f in BACKUP_FILES {
        let src = data_dir().join(f);
        if src.exists() {
            fs::copy(&src, dir.join(f)).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::process::Command::new("explorer").arg(backups_dir()).spawn();
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct BackupInfo {
    name: String,
    size: u64,
    modified: u64,
}

/// 백업 폴더 목록 (새것부터)
#[tauri::command]
fn backup_list() -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = fs::read_dir(backups_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let m = fs::metadata(e.path().join("market.db")).ok()?;
            let modified = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            safe_name(&name).then_some(BackupInfo { name, size: m.len(), modified })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// 백업 가져오기: 파일을 *.import로 옆에 두고, 다음에 켤 때(저장소를 열기 전에) 바꿔 끼운다
#[tauri::command]
async fn backup_restore(name: String) -> Result<(), String> {
    if !safe_name(&name) {
        return Err(format!("잘못된 이름: {name}"));
    }
    let dir = backups_dir().join(&name);
    if !dir.join("market.db").exists() {
        return Err("그 백업에 market.db가 없어요".into());
    }
    let db = dir.join("market.db");
    tauri::async_runtime::spawn_blocking(move || stage_import(&db)).await.map_err(|e| e.to_string())?
}

/// 진짜 POWER CHART 저장소인지 (bars 표가 있는 SQLite 파일)
fn looks_like_store(db: &std::path::Path) -> bool {
    rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'bars'", [], |r| r.get::<_, i64>(0)))
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// 가져오기 준비: market.db(+ 같은 폴더의 config.json·drawings.json)를 *.import로 옆에 둔다 → 다음에 켤 때 바꿔 끼운다
fn stage_import(db: &std::path::Path) -> Result<(), String> {
    if !looks_like_store(db) {
        return Err("POWER CHART 데이터 파일(market.db)이 아니에요".into());
    }
    let data = data_dir();
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    fs::copy(db, data.join("market.db.import")).map_err(|e| e.to_string())?;
    if let Some(dir) = db.parent() {
        for f in BACKUP_FILES {
            if dir.join(f).is_file() {
                let _ = fs::copy(dir.join(f), data.join(format!("{f}.import")));
            }
        }
    }
    Ok(())
}

/// 어디에 있든 가져오기: 파일 고르기 창에서 market.db를 고른다 (USB·바탕화면 등). 취소하면 None
#[tauri::command]
async fn backup_import_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("가져올 백업의 market.db를 고르세요")
        .add_filter("POWER CHART 데이터 (market.db)", &["db"])
        .blocking_pick_file();
    let Some(p) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let shown = p.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || stage_import(&p)).await.map_err(|e| e.to_string())??;
    Ok(Some(shown))
}

/// 새 PC에서 처음 켤 때: 저장소가 아직 없고 EXE 옆에 백업이 있으면(market.db 또는 FAKE-TRADING-… 폴더) 알아서 가져온다.
/// 이미 데이터가 있으면 절대 덮어쓰지 않는다 (그때는 설정 → 데이터 → 파일에서 가져오기).
fn auto_import_beside_exe() {
    let data = data_dir();
    if data.join("market.db").exists() || data.join("market.db.import").exists() {
        return;
    }
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) else {
        return;
    };
    let mut cands: Vec<PathBuf> = Vec::new();
    if dir.join("market.db").is_file() {
        cands.push(dir.join("market.db"));
    }
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = e.path().join("market.db");
        if e.file_name().to_string_lossy().starts_with(BACKUP_PREFIX) && p.is_file() {
            cands.push(p);
        }
    }
    let newest = cands.into_iter().max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
    if let Some(db) = newest {
        match stage_import(&db) {
            Ok(()) => append_log(format!("INFO auto import beside exe: {}", db.display())),
            Err(e) => append_log(format!("ERROR auto import: {e}")),
        }
    }
}

/// 켤 때: 가져온 백업이 있으면 바꿔 끼우기 (옛 저장소는 market.db.old로 하나 남긴다)
fn apply_pending_import() {
    let data = data_dir();
    let import = data.join("market.db.import");
    if !import.exists() {
        return;
    }
    let db = data.join("market.db");
    let _ = fs::remove_file(data.join("market.db.old"));
    if db.exists() {
        if let Err(e) = fs::rename(&db, data.join("market.db.old")) {
            append_log(format!("ERROR backup import: {e}"));
            return;
        }
    }
    let _ = fs::remove_file(data.join("market.db-wal"));
    let _ = fs::remove_file(data.join("market.db-shm"));
    let _ = fs::rename(&import, &db);
    for f in BACKUP_FILES {
        let imp = data.join(format!("{f}.import"));
        if imp.exists() {
            let _ = fs::rename(&imp, data.join(f));
        }
    }
    append_log("INFO backup imported".into());
}

/// 앱 끄기 (백업을 가져온 뒤 "지금 끄기")
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn captures_dir() -> PathBuf {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(data_dir);
    base.join("Pictures").join(USER_DIR)
}

/// 탐색기로 폴더 열기 (캡처 폴더 / 데이터 폴더만)
#[tauri::command]
fn open_folder(which: String) -> Result<(), String> {
    let dir = match which.as_str() {
        "captures" => captures_dir(),
        "exports" => exports_dir(),
        "data" => data_dir(),
        "backups" => backups_dir(),
        _ => return Err("알 수 없는 폴더".into()),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 시작할 때: 기억해 둔 모니터가 연결돼 있으면 그리로 옮기고, 전체화면이었으면 전체화면으로.
/// 이름이 같은 모니터를 먼저 찾고, 없으면 위치·크기가 같은 모니터를 찾는다.
fn restore_window(window: &WebviewWindow) {
    let st = load_window_state();
    if let (Some(pin), Ok(monitors)) = (st.monitor.as_ref(), window.available_monitors()) {
        let same_rect = |m: &tauri::Monitor| {
            m.position().x == pin.x && m.position().y == pin.y && m.size().width == pin.width && m.size().height == pin.height
        };
        let found = monitors
            .iter()
            .find(|m| m.name().map(|n| n == &pin.name).unwrap_or(false) && same_rect(m))
            .or_else(|| monitors.iter().find(|m| same_rect(m)))
            .or_else(|| monitors.iter().find(|m| m.name().map(|n| n == &pin.name).unwrap_or(false)));
        if let Some(m) = found {
            let p = m.position();
            let _ = window.set_position(PhysicalPosition::new(p.x + 10, p.y + 10));
        }
    }
    if st.fullscreen {
        let _ = window.set_fullscreen(true);
    } else {
        let _ = window.maximize();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 새 버전으로 바꿀 때 켜져 있던 EXE를 "<이름>.old.exe"로 비켜 두고 새 것을 넣는다 → 다음에 켤 때 지운다
/// (그 옛 EXE가 아직 켜져 있으면 못 지우고 다음 번에 다시 해 본다). 🆕 새 버전 받기가 중간에 멈춰 남은 .new.exe도 (update.rs)
fn remove_old_exe() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem().and_then(|s| s.to_str()) {
            let _ = fs::remove_file(exe.with_file_name(format!("{stem}.old.exe")));
            let _ = fs::remove_file(exe.with_file_name(format!("{stem}.new.exe")));
        }
    }
}

fn main() {
    remove_old_exe();
    auto_import_beside_exe();
    apply_pending_import();
    let db = match db::Db::open(&data_dir().join("market.db")) {
        Ok(db) => db,
        Err(e) => {
            append_log(format!("ERROR db open: {e}"));
            panic!("market.db 열기 실패: {e}");
        }
    };
    tauri::Builder::default()
        // 두 번 실행하면 새로 띄우지 않고 기존 창을 앞으로
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db)
        .manage(alpaca::Alpaca::default())
        .manage(alpaca_stream::Stream::default())
        .manage(toss::Toss::default())
        .invoke_handler(tauri::generate_handler![
            append_log,
            load_json,
            save_json,
            load_market_board_stocklist,
            set_fullscreen,
            set_zoom,
            save_capture,
            save_export,
            open_folder,
            backup_create,
            backup_list,
            backup_restore,
            backup_import_file,
            quit_app,
            db::db_put,
            db::db_get,
            db::db_range,
            db::db_coverage,
            db::db_put_events,
            db::db_get_events,
            db::db_delete,
            db::db_meta_get,
            db::db_meta_set,
            db::db_size,
            db::db_vacuum,
            db::db_gaps,
            alpaca::alpaca_key_status,
            alpaca::alpaca_save_key,
            alpaca::alpaca_delete_key,
            alpaca::alpaca_get,
            alpaca_stream::alpaca_stream_set,
            toss::toss_key_status,
            toss::toss_save_key,
            toss::toss_get,
            update::update_check,
            update::update_install,
            update::update_restart
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window(&window);
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("FAKE TRADING POWER CHART 실행 실패");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 새 PC 흉내: 저장소가 없고 EXE 옆에 백업 폴더가 있으면 켤 때 가져온다. 이미 있으면 덮어쓰지 않는다.
    #[test]
    fn imports_backup_beside_exe_only_on_a_fresh_pc() {
        let tmp = std::env::temp_dir().join(format!("pcb-import-{}", std::process::id()));
        let appdata = tmp.join("appdata");
        fs::create_dir_all(&appdata).unwrap();
        std::env::set_var("APPDATA", &appdata);
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let backup = exe_dir.join(format!("{BACKUP_PREFIX}TEST-{}", std::process::id()));
        fs::create_dir_all(&backup).unwrap();
        {
            let c = rusqlite::Connection::open(backup.join("market.db")).unwrap();
            c.execute_batch("CREATE TABLE bars (sym TEXT, tf TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL); INSERT INTO bars VALUES ('QQQ','1D',1,1,1,1,1,1);").unwrap();
        }
        fs::write(backup.join("config.json"), "{\"watchlist\":[\"QQQ\"]}").unwrap();

        auto_import_beside_exe();
        apply_pending_import();
        let db = data_dir().join("market.db");
        assert!(db.is_file(), "가져오지 않음");
        assert_eq!(fs::read_to_string(data_dir().join("config.json")).unwrap(), "{\"watchlist\":[\"QQQ\"]}");

        // 이미 데이터가 있으면 그대로 (다시 켜도 덮어쓰지 않음)
        fs::write(data_dir().join("config.json"), "mine").unwrap();
        auto_import_beside_exe();
        apply_pending_import();
        assert_eq!(fs::read_to_string(data_dir().join("config.json")).unwrap(), "mine");

        // 저장소가 아닌 파일은 거절
        fs::write(tmp.join("junk.db"), "not sqlite").unwrap();
        assert!(stage_import(&tmp.join("junk.db")).is_err());

        let _ = fs::remove_dir_all(&backup);
        let _ = fs::remove_dir_all(&tmp);
    }
}
