//! 토스증권 Open API 관문 (조회 전용) — 국내 주식 실시간 현재가·1분봉.
//!
//! Market Board(같은 PC)와 키·토큰을 같이 쓴다:
//! - 키: Windows 자격 증명 관리자 `market-board` / `toss` (Market Board가 저장한 것, 여기서 넣어도 같은 곳)
//! - 토큰: `market-board` / `toss-token` = {token, exp(유닉스 초)}. 키 하나에 토큰은 1개만 살아 있어서
//!   새로 받으면 이전 것은 바로 `token-revoked`가 된다. 그래서 두 앱 모두
//!   ① 함께 쓰는 토큰이 살아 있으면 그것을 쓰고 ② 없거나 만료됐을 때만 새로 받아 거기에 넣는다.
//!   ③ `token-revoked`를 받으면 함께 쓰는 토큰을 다시 읽어서, 다른 앱이 새로 받아 둔 것이면 그걸로 바꿔 쓴다.
//!   ④ 그것도 같은(죽은) 토큰이면 다른 PC가 가져간 것 → '대기'(Yahoo로 대신)하고, 이 앱은 스스로 다시 뺏지 않는다.
//! - 화면(JS)에는 키·토큰을 절대 넘기지 않는다. 경로는 시세 3개만, GET만. 계좌·주문 경로는 목록에 없다.
//! - FAKE TRADING(이 복제본)도 일부러 같은 `market-board` 이름을 쓴다: 이름을 바꾸면 이 앱이 토큰을 따로 받아
//!   Market Board·원본 앱의 토큰이 `token-revoked`가 된다. (알파카 키 이름만 원본과 다르게 바꿨다)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::Mutex;
use tauri::State;
use tauri_plugin_http::reqwest;

const BASE: &str = "https://openapi.tossinvest.com";
const KEYRING_SERVICE: &str = "market-board";
const KEYRING_USER: &str = "toss";
const TOKEN_USER: &str = "toss-token";

/// 통과시키는 GET 경로 (정확히 일치) → 호출 한도 그룹
const ALLOWED_PATHS: &[(&str, &str)] = &[
    ("/api/v1/prices", "MARKET_DATA"),                        // 현재가
    ("/api/v1/candles", "MARKET_DATA_CHART"),                 // 캔들 (1m·1d)
    ("/api/v1/market-indicators/prices", "MARKET_INDICATOR"), // 코스피·코스닥 현재가
];

// adjusted: 캔들을 실제 거래가로 받기 (FAKE TRADING 토스 1분봉 받아 쌓기, 조회용 값)
const ALLOWED_KEYS: &[&str] = &["symbols", "symbol", "interval", "count", "before", "adjusted"];

/// 공식 한도의 약 70% (Market Board와 같은 값)
fn min_interval(group: &str) -> Duration {
    Duration::from_millis(match group {
        "MARKET_DATA" => 100,
        "MARKET_DATA_CHART" => 72,
        _ => 143,
    })
}

fn allowed_path(path: &str) -> Option<&'static str> {
    ALLOWED_PATHS.iter().find(|(p, _)| *p == path).map(|(_, g)| *g)
}

fn allowed_value(v: &str) -> bool {
    v.len() <= 2400 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ',' | '.' | '-' | '_' | ':' | '+'))
}

#[derive(Serialize, Deserialize)]
struct Creds {
    id: String,
    secret: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Shared {
    token: String,
    exp: u64,
}

#[derive(Default)]
pub struct Toss {
    token: Mutex<Option<(String, Instant)>>,
    /// 다른 PC가 가져가서 물러난 상태 (그때 죽은 토큰을 기억: 함께 쓰는 토큰이 바뀌면 다시 쓴다)
    standby: AtomicBool,
    dead: Mutex<Option<String>>,
    next_call: Mutex<HashMap<&'static str, Instant>>,
}

#[derive(Serialize)]
pub struct KeyStatus {
    saved: bool,
    hint: Option<String>,
    standby: bool,
}

fn entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| e.to_string())
}

fn load_creds() -> Option<Creds> {
    serde_json::from_str(&entry(KEYRING_USER).ok()?.get_password().ok()?).ok()
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 함께 쓰는 토큰 (만료 1분 전까지만 살아 있다고 본다)
fn shared_read() -> Option<Shared> {
    let s: Shared = serde_json::from_str(&entry(TOKEN_USER).ok()?.get_password().ok()?).ok()?;
    (s.exp > now_unix() + 60).then_some(s)
}

fn shared_write(token: &str, secs: u64) {
    let s = Shared { token: token.to_string(), exp: now_unix() + secs };
    if let Ok(e) = entry(TOKEN_USER) {
        let _ = e.set_password(&serde_json::to_string(&s).unwrap_or_default());
    }
}

fn mask(id: &str) -> String {
    let n = id.chars().count();
    if n <= 13 {
        return "••••".into();
    }
    let head: String = id.chars().take(9).collect();
    let tail: String = id.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client"))
}

fn error_code_only(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    v["error"]["code"].as_str().or_else(|| v["error"].as_str()).unwrap_or("").to_string()
}

/// 새 토큰 받기 → 함께 쓰는 곳에 넣는다 (= 다른 곳의 토큰은 무효가 된다)
async fn issue_token(c: &Creds) -> Result<(String, Instant), String> {
    let res = client()
        .post(format!("{BASE}/oauth2/token"))
        .form(&[("grant_type", "client_credentials"), ("client_id", c.id.as_str()), ("client_secret", c.secret.as_str())])
        .send()
        .await
        .map_err(|e| format!("토큰 요청 실패: {}", e.without_url()))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("토큰 발급 실패: HTTP {} {}", status.as_u16(), error_code_only(&body)));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "토큰 응답 형식 오류")?;
    let token = v["access_token"].as_str().ok_or("토큰 없음")?.to_string();
    let secs = v["expires_in"].as_u64().unwrap_or(3600);
    shared_write(&token, secs);
    Ok((token, Instant::now() + Duration::from_secs(secs.saturating_sub(60).max(30))))
}

fn adopt(s: &Shared) -> (String, Instant) {
    (s.token.clone(), Instant::now() + Duration::from_secs(s.exp.saturating_sub(now_unix() + 60)))
}

impl Toss {
    fn status(&self) -> KeyStatus {
        match load_creds() {
            Some(c) => KeyStatus { saved: true, hint: Some(mask(&c.id)), standby: self.standby.load(Ordering::Relaxed) },
            None => KeyStatus { saved: false, hint: None, standby: false },
        }
    }

    /// 지금 쓸 토큰: 내 것 → 함께 쓰는 것 → (둘 다 없으면) 새로 받기
    async fn token(&self) -> Result<String, String> {
        let mut t = self.token.lock().await;
        if let Some((tok, until)) = t.as_ref() {
            if Instant::now() < *until {
                return Ok(tok.clone());
            }
        }
        if let Some(s) = shared_read() {
            let a = adopt(&s);
            *t = Some(a.clone());
            return Ok(a.0);
        }
        let creds = load_creds().ok_or("토스 키가 없습니다")?;
        let a = issue_token(&creds).await?;
        *t = Some(a.clone());
        Ok(a.0)
    }

    /// 대기 중: 함께 쓰는 토큰이 죽은 것과 다르면(Market Board가 다시 가져옴) 대기를 푼다
    async fn check_standby(&self) -> bool {
        if !self.standby.load(Ordering::Relaxed) {
            return false;
        }
        let dead = self.dead.lock().await.clone();
        if let Some(s) = shared_read() {
            if Some(&s.token) != dead.as_ref() {
                *self.token.lock().await = Some(adopt(&s));
                self.standby.store(false, Ordering::Relaxed);
                return false;
            }
        }
        true
    }

    async fn pace(&self, group: &'static str) {
        let wait = {
            let mut m = self.next_call.lock().await;
            let now = Instant::now();
            let next = m.get(group).copied().unwrap_or(now).max(now);
            m.insert(group, next + min_interval(group));
            next - now
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn hold(&self, group: &'static str, secs: u64) {
        self.next_call.lock().await.insert(group, Instant::now() + Duration::from_secs(secs));
    }
}

#[tauri::command]
pub fn toss_key_status(state: State<'_, Toss>) -> KeyStatus {
    state.status()
}

/// 키 저장 (Market Board와 같은 곳): 먼저 토큰을 실제로 받아 보고, 성공할 때만 저장한다
#[tauri::command]
pub async fn toss_save_key(state: State<'_, Toss>, client_id: String, client_secret: String) -> Result<KeyStatus, String> {
    let id = client_id.trim().to_string();
    let secret = client_secret.trim().to_string();
    let ok = |s: &str| !s.is_empty() && s.len() <= 256 && s.chars().all(|c| c.is_ascii_graphic());
    if !ok(&id) || !ok(&secret) {
        return Err("키 형식이 올바르지 않습니다 (공백·한글 없이 복사해서 붙여넣기)".into());
    }
    let creds = Creds { id, secret };
    let tok = issue_token(&creds).await?;
    entry(KEYRING_USER)?.set_password(&serde_json::to_string(&creds).unwrap()).map_err(|e| format!("키 저장 실패: {e}"))?;
    *state.token.lock().await = Some(tok);
    state.standby.store(false, Ordering::Relaxed);
    Ok(state.status())
}

/// 조회 전용 관문
#[tauri::command]
pub async fn toss_get(state: State<'_, Toss>, path: String, query: Vec<(String, String)>) -> Result<String, String> {
    let group = allowed_path(&path).ok_or_else(|| format!("허용되지 않은 경로: {path}"))?;
    for (k, v) in &query {
        if !ALLOWED_KEYS.contains(&k.as_str()) || !allowed_value(v) {
            return Err(format!("허용되지 않은 파라미터: {k}"));
        }
    }
    if state.check_standby().await {
        return Err("standby: 다른 PC에서 토스 사용 중".into());
    }
    let mut retried = false;
    let mut retried_429 = false;
    loop {
        state.pace(group).await;
        let token = state.token().await?;
        let res = client()
            .get(format!("{BASE}{path}"))
            .query(&query)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("요청 실패: {}", e.without_url()))?;
        let status = res.status();
        let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
        let body = res.text().await.unwrap_or_default();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            let code = error_code_only(&body);
            *state.token.lock().await = None;
            if !retried {
                retried = true;
                // 같은 PC의 다른 앱(Market Board)이 새로 받아 뒀으면 그걸로 바꿔서 한 번 더
                match shared_read() {
                    Some(s) if s.token != token => {
                        *state.token.lock().await = Some(adopt(&s));
                        continue;
                    }
                    _ if code != "token-revoked" => continue, // 만료 등 → 새로 받아 한 번 더
                    _ => {}
                }
            }
            if code == "token-revoked" {
                // 다른 PC가 가져갔다 → 물러나고 다시 뺏지 않는다
                *state.dead.lock().await = Some(token);
                state.standby.store(true, Ordering::Relaxed);
                return Err("standby: 다른 PC에서 토스 사용 중".into());
            }
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let secs = retry_after.unwrap_or(2).clamp(1, 30);
            state.hold(group, secs).await;
            if !retried_429 && secs <= 5 {
                retried_429 = true;
                continue;
            }
        }
        if !status.is_success() {
            return Err(format!("HTTP {} {}", status.as_u16(), error_code_only(&body)).trim().to_string());
        }
        return Ok(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_allows_only_three_read_paths() {
        assert_eq!(allowed_path("/api/v1/prices"), Some("MARKET_DATA"));
        assert_eq!(allowed_path("/api/v1/candles"), Some("MARKET_DATA_CHART"));
        assert_eq!(allowed_path("/api/v1/market-indicators/prices"), Some("MARKET_INDICATOR"));
        for p in ["/api/v1/orders", "/api/v1/accounts", "/api/v1/holdings", "/oauth2/token", "/api/v1/prices/../orders", "/api/v1/stocks/all", "https://evil.example/api/v1/prices"] {
            assert!(allowed_path(p).is_none(), "{p}");
        }
    }

    #[test]
    fn gate_rejects_odd_values() {
        assert!(allowed_value("005930,000660"));
        assert!(!allowed_value("a&b=c"));
        assert!(!allowed_value("삼성"));
    }
}
