//! 알파카 시세 관문 (조회 전용, 무료 Basic 플랜).
//!
//! - 키(Key ID/Secret)는 Windows 자격 증명 관리자에만 저장하고, 화면(JS)으로는 절대 넘기지 않는다.
//! - 화면은 `alpaca_get(path, query)`로만 알파카에 접근할 수 있다. GET + 시세 경로 3개만 통과시킨다.
//! - 주소는 `data.alpaca.markets`(시세 전용 서버)만 쓴다. 주문·계좌 서버 주소는 이 코드에 아예 없다.
//!   (실시간 체결은 alpaca_stream.rs가 시세 전용 스트림 `stream.data.alpaca.markets` 하나만 쓴다)
//! - 화면의 HTTP 허용 목록(capabilities)에도 알파카 주소가 없어서 JS가 직접 호출할 수도 없다.
//! - 무료 플랜 한도는 분당 200번 → 여기서 분당 150번(0.4초 간격)으로 낮춰서 부른다.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::async_runtime::Mutex;
use tauri::State;
use tauri_plugin_http::reqwest;

const BASE: &str = "https://data.alpaca.markets";
// 원본(POWER CHART AND BACKTEST)과 키를 섞지 않는다 → 이 앱에서 따로 넣는다 (복제할 때 바꿈, 2026-10-30)
const KEYRING_SERVICE: &str = "fake-trading-power-chart";
const KEYRING_USER: &str = "alpaca";
const MIN_INTERVAL: Duration = Duration::from_millis(400);

/// 통과시키는 GET 경로 (정확히 일치)
const ALLOWED_PATHS: &[&str] = &[
    "/v2/stocks/bars",      // 과거 봉 (여러 종목 한 번에)
    "/v2/stocks/snapshots", // 현재가 (여러 종목 한 번에)
    "/v1/corporate-actions", // 분할·배당
];

/// 쿼리 파라미터 이름 허용 목록
const ALLOWED_KEYS: &[&str] = &[
    "symbols", "timeframe", "start", "end", "limit", "adjustment", "feed", "page_token", "sort", "asof",
    "currency", "types",
];

fn allowed_path(path: &str) -> bool {
    ALLOWED_PATHS.contains(&path)
}

fn allowed_value(v: &str) -> bool {
    v.len() <= 4000
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ',' | '.' | '-' | '_' | ':' | '+' | '=' | '/'))
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Creds {
    pub(crate) id: String,
    pub(crate) secret: String,
}

#[derive(Default)]
pub struct Alpaca {
    next_call: Mutex<Option<Instant>>,
}

#[derive(Serialize)]
pub struct KeyStatus {
    saved: bool,
    hint: Option<String>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

pub(crate) fn load_creds() -> Option<Creds> {
    let s = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&s).ok()
}

/// Key ID 앞 4글자 + 끝 4글자만 보여준다 (secret은 어떤 형태로도 돌려주지 않음)
fn mask(id: &str) -> String {
    let n = id.chars().count();
    if n <= 10 {
        return "••••".into();
    }
    let head: String = id.chars().take(4).collect();
    let tail: String = id.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

/// 연결 하나를 계속 쓴다 (요청마다 새로 연결하면 TLS 악수에 시간이 걸린다). gzip으로 받아 크기가 1/5쯤
fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .gzip(true)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("http client")
    })
}

/// 에러 응답에서 message만 꺼낸다 (본문 전체를 화면·로그에 넘기지 않음)
fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let msg: String = v["message"].as_str().unwrap_or("").chars().take(120).collect();
    format!("HTTP {} {}", status.as_u16(), msg).trim().to_string()
}

async fn call(c: &Creds, path: &str, query: &[(String, String)]) -> Result<(reqwest::StatusCode, Option<u64>, String), String> {
    let res = client()
        .get(format!("{BASE}{path}"))
        .query(query)
        .header("APCA-API-KEY-ID", &c.id)
        .header("APCA-API-SECRET-KEY", &c.secret)
        .send()
        .await
        .map_err(|e| format!("요청 실패: {}", e.without_url()))?;
    let status = res.status();
    // 429일 때 다시 해도 되는 시각(유닉스 초)
    let reset = res
        .headers()
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body = res.text().await.unwrap_or_default();
    Ok((status, reset, body))
}

impl Alpaca {
    /// 호출 간격 지키기 (분당 150번)
    async fn pace(&self) {
        let wait = {
            let mut next = self.next_call.lock().await;
            let now = Instant::now();
            let at = next.unwrap_or(now).max(now);
            *next = Some(at + MIN_INTERVAL);
            at - now
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn hold(&self, secs: u64) {
        *self.next_call.lock().await = Some(Instant::now() + Duration::from_secs(secs));
    }
}

#[tauri::command]
pub fn alpaca_key_status() -> KeyStatus {
    match load_creds() {
        Some(c) => KeyStatus { saved: true, hint: Some(mask(&c.id)) },
        None => KeyStatus { saved: false, hint: None },
    }
}

/// 키 저장: 먼저 현재가를 실제로 한 번 받아 보고, 성공할 때만 자격 증명 관리자에 저장한다
#[tauri::command]
pub async fn alpaca_save_key(state: State<'_, Alpaca>, key_id: String, secret: String) -> Result<KeyStatus, String> {
    let id = key_id.trim().to_string();
    let secret = secret.trim().to_string();
    let ok = |s: &str| !s.is_empty() && s.len() <= 256 && s.chars().all(|c| c.is_ascii_graphic());
    if !ok(&id) || !ok(&secret) {
        return Err("키 형식이 올바르지 않습니다 (공백·한글 없이 복사해서 붙여넣기)".into());
    }
    let creds = Creds { id, secret };
    state.pace().await;
    let q = vec![("symbols".to_string(), "SPY".to_string()), ("feed".to_string(), "iex".to_string())];
    let (status, _, body) = call(&creds, "/v2/stocks/snapshots", &q).await?;
    if !status.is_success() {
        return Err(format!("키 확인 실패: {}", error_text(status, &body)));
    }
    entry()?
        .set_password(&serde_json::to_string(&creds).unwrap())
        .map_err(|e| format!("키 저장 실패: {e}"))?;
    Ok(alpaca_key_status())
}

#[tauri::command]
pub fn alpaca_delete_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 조회 전용 관문. 허용 목록에 없는 경로·파라미터는 거절한다.
#[tauri::command]
pub async fn alpaca_get(state: State<'_, Alpaca>, path: String, query: Vec<(String, String)>) -> Result<String, String> {
    if !allowed_path(&path) {
        return Err(format!("허용되지 않은 경로: {path}"));
    }
    for (k, v) in &query {
        if !ALLOWED_KEYS.contains(&k.as_str()) || !allowed_value(v) {
            return Err(format!("허용되지 않은 파라미터: {k}"));
        }
    }
    let creds = load_creds().ok_or("no_key: 알파카 키가 없습니다")?;
    let mut retried = false;
    loop {
        state.pace().await;
        let (status, reset, body) = call(&creds, &path, &query).await?;
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let secs = reset.map(|r| r.saturating_sub(now)).unwrap_or(10).clamp(1, 60);
            state.hold(secs).await;
            if !retried {
                retried = true;
                continue; // pace()가 기다린 뒤 한 번 더
            }
        }
        if !status.is_success() {
            return Err(error_text(status, &body));
        }
        return Ok(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_allows_only_market_data_paths() {
        assert!(allowed_path("/v2/stocks/bars"));
        assert!(allowed_path("/v2/stocks/snapshots"));
        assert!(allowed_path("/v1/corporate-actions"));
        for p in [
            "/v2/orders",
            "/v2/account",
            "/v2/positions",
            "/v2/stocks/bars/../../orders",
            "/v2/stocks/AAPL/trades",
            "/v1beta1/news",
            "https://evil.example/v2/stocks/bars",
            "//evil.example/v2/stocks/bars",
            "",
        ] {
            assert!(!allowed_path(p), "{p}");
        }
    }

    #[test]
    fn gate_rejects_odd_values() {
        assert!(allowed_value("SOXL,AMD"));
        assert!(allowed_value("2026-10-23T13:30:00Z"));
        assert!(allowed_value("QUFQTHxNfDIwMjYtMTAtMjM="));
        assert!(!allowed_value("a&b=c"));
        assert!(!allowed_value("삼성"));
        assert!(!allowed_value("x y"));
    }

    #[test]
    fn mask_hides_secret_shape() {
        assert_eq!(mask("PKABCDEFGHIJ12345678"), "PKAB…5678");
        assert_eq!(mask("short"), "••••");
    }

    #[test]
    fn base_is_data_host_only() {
        assert_eq!(BASE, "https://data.alpaca.markets");
    }
}
