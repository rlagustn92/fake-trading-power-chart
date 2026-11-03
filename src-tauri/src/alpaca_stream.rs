//! 알파카 실시간 체결 (무료 플랜 IEX): 웹소켓 하나로 보이는 미국 종목의 체결을 받아 화면에 보낸다.
//!
//! 지키는 것 (alpaca.rs와 같은 원칙):
//! - 주소는 시세 전용 스트림 `wss://stream.data.alpaca.markets/v2/iex` 하나뿐. 주문·계좌 주소는 이 코드에 없다.
//! - 키는 Rust 안에서 인증 메시지에만 쓴다. 화면은 "볼 종목 목록"만 넘길 수 있다 (영문 대문자·숫자·점, 최대 30개).
//! - 무료 플랜은 연결 1개·종목 30개까지. 체결은 0.25초마다 종목별로 묶어서(마지막 값·고가·저가·거래량) 보낸다.
//! - REST 한도(분당 200번)와는 따로 센다 → 1초 현재가 조회를 줄일 수 있다.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

const URL: &str = "wss://stream.data.alpaca.markets/v2/iex";
const MAX_SYMBOLS: usize = 30;

#[derive(Default)]
pub struct Stream {
    tx: Mutex<Option<watch::Sender<BTreeSet<String>>>>,
}

/// 0.25초 동안의 체결 묶음 (종목 하나)
#[derive(Serialize, Clone)]
struct Tick {
    s: String,
    p: f64,
    hi: f64,
    lo: f64,
    v: f64,
    t: String,
}

#[derive(Serialize, Clone)]
struct Status {
    ok: bool,
    msg: String,
}

fn valid_symbol(s: &str) -> bool {
    !s.is_empty() && s.len() <= 10 && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.')
}

fn status(app: &AppHandle, ok: bool, msg: &str) {
    let _ = app.emit("alpaca-stream", Status { ok, msg: msg.chars().take(120).collect() });
}

/// 볼 종목 목록 바꾸기 (빈 목록이면 연결을 닫는다). 처음 부르면 연결을 시작한다.
#[tauri::command]
pub fn alpaca_stream_set(app: AppHandle, state: State<'_, Stream>, symbols: Vec<String>) -> Result<(), String> {
    let set: BTreeSet<String> = symbols.into_iter().filter(|s| valid_symbol(s)).take(MAX_SYMBOLS).collect();
    let mut g = state.tx.lock().map_err(|_| "잠금 실패".to_string())?;
    if let Some(tx) = g.as_ref() {
        if !tx.is_closed() {
            let _ = tx.send(set);
            return Ok(());
        }
    }
    if set.is_empty() {
        return Ok(());
    }
    let (tx, rx) = watch::channel(set);
    *g = Some(tx);
    tauri::async_runtime::spawn(run(app, rx));
    Ok(())
}

async fn run(app: AppHandle, mut rx: watch::Receiver<BTreeSet<String>>) {
    let mut backoff = 2u64;
    loop {
        if rx.borrow().is_empty() {
            // 볼 종목이 없으면 연결 없이 기다린다
            if rx.changed().await.is_err() {
                return;
            }
            continue;
        }
        let Some(creds) = crate::alpaca::load_creds() else {
            status(&app, false, "no_key");
            return; // 키를 넣으면 화면이 다시 부른다
        };
        match session(&app, &mut rx, &creds.id, &creds.secret).await {
            Ok(()) => backoff = 2,
            Err(e) => {
                status(&app, false, &e);
                // 406 = 연결 1개 한도 (다른 프로그램이 같은 키로 스트림을 쓰는 중) → 오래 기다린다
                let wait = if e.contains("406") || e.contains("401") || e.contains("402") { 120 } else { backoff };
                tokio::time::sleep(Duration::from_secs(wait)).await;
                backoff = (backoff * 2).min(60);
            }
        }
        if rx.has_changed().is_err() {
            return;
        }
    }
}

async fn session(app: &AppHandle, rx: &mut watch::Receiver<BTreeSet<String>>, key: &str, secret: &str) -> Result<(), String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(URL))
        .await
        .map_err(|_| "연결 시간 초과".to_string())?
        .map_err(|e| format!("연결 실패: {e}"))?;
    let (mut w, mut r) = ws.split();
    let auth = serde_json::json!({ "action": "auth", "key": key, "secret": secret }).to_string();
    w.send(Message::Text(auth.into())).await.map_err(|e| e.to_string())?;

    // 인증 결과 기다리기 (처음 오는 "connected"는 넘긴다)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let m = tokio::time::timeout_at(deadline, r.next()).await.map_err(|_| "인증 시간 초과".to_string())?;
        let Some(Ok(Message::Text(t))) = m else {
            return Err("인증 중 연결이 끊김".into());
        };
        let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
        let list = v.as_array().cloned().unwrap_or_default();
        if let Some(err) = list.iter().find(|x| x["T"] == "error") {
            return Err(format!("{} {}", err["code"], err["msg"].as_str().unwrap_or("")));
        }
        if list.iter().any(|x| x["T"] == "success" && x["msg"] == "authenticated") {
            break;
        }
    }

    let mut subscribed: BTreeSet<String> = BTreeSet::new();
    let want = rx.borrow().clone();
    sync(&mut w, &mut subscribed, &want).await?;
    status(app, true, "connected");

    let mut pending: HashMap<String, Tick> = HashMap::new();
    let mut flush = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            m = r.next() => match m {
                Some(Ok(Message::Text(t))) => read_trades(&t, &mut pending)?,
                Some(Ok(Message::Ping(p))) => { let _ = w.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None => return Err("연결이 끊김".into()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            },
            ch = rx.changed() => {
                let want = if ch.is_err() { BTreeSet::new() } else { rx.borrow().clone() };
                if want.is_empty() {
                    let _ = w.close().await;
                    status(app, false, "idle");
                    return Ok(());
                }
                sync(&mut w, &mut subscribed, &want).await?;
            }
            _ = flush.tick() => {
                if !pending.is_empty() {
                    let ticks: Vec<Tick> = pending.drain().map(|(_, t)| t).collect();
                    let _ = app.emit("alpaca-trades", ticks);
                }
            }
        }
    }
}

/// 구독 목록 맞추기: 새로 보는 종목은 구독, 안 보는 종목은 해지
async fn sync<S>(w: &mut S, subscribed: &mut BTreeSet<String>, want: &BTreeSet<String>) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let add: Vec<&String> = want.difference(subscribed).collect();
    let del: Vec<&String> = subscribed.difference(want).collect();
    if !add.is_empty() {
        let m = serde_json::json!({ "action": "subscribe", "trades": add }).to_string();
        w.send(Message::Text(m.into())).await.map_err(|e| e.to_string())?;
    }
    if !del.is_empty() {
        let m = serde_json::json!({ "action": "unsubscribe", "trades": del }).to_string();
        w.send(Message::Text(m.into())).await.map_err(|e| e.to_string())?;
    }
    *subscribed = want.clone();
    Ok(())
}

/// [{"T":"t","S":"SOXL","p":40.1,"s":100,"t":"2026-10-26T13:30:00.123456789Z"}, ...] → 종목별로 묶기
fn read_trades(text: &str, pending: &mut HashMap<String, Tick>) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    for x in v.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        match x["T"].as_str() {
            Some("t") => {
                let (Some(s), Some(p)) = (x["S"].as_str(), x["p"].as_f64()) else { continue };
                if !(p > 0.0) {
                    continue;
                }
                let size = x["s"].as_f64().unwrap_or(0.0);
                let t = x["t"].as_str().unwrap_or("").to_string();
                pending
                    .entry(s.to_string())
                    .and_modify(|k| {
                        k.p = p;
                        k.hi = k.hi.max(p);
                        k.lo = k.lo.min(p);
                        k.v += size;
                        k.t = t.clone();
                    })
                    .or_insert(Tick { s: s.to_string(), p, hi: p, lo: p, v: size, t });
            }
            Some("error") => return Err(format!("{} {}", x["code"], x["msg"].as_str().unwrap_or(""))),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_stream_host() {
        assert_eq!(URL, "wss://stream.data.alpaca.markets/v2/iex");
    }

    #[test]
    fn symbols_are_checked() {
        assert!(valid_symbol("SOXL"));
        assert!(valid_symbol("BRK.B"));
        assert!(!valid_symbol("soxl"));
        assert!(!valid_symbol("A\"B"));
        assert!(!valid_symbol(""));
    }

    #[test]
    fn trades_are_grouped() {
        let mut m = HashMap::new();
        read_trades(r#"[{"T":"t","S":"SOXL","p":40,"s":10,"t":"a"},{"T":"t","S":"SOXL","p":41,"s":5,"t":"b"},{"T":"t","S":"SOXL","p":39.5,"s":1,"t":"c"}]"#, &mut m).unwrap();
        let k = &m["SOXL"];
        assert_eq!((k.p, k.hi, k.lo, k.v, k.t.as_str()), (39.5, 41.0, 39.5, 16.0, "c"));
        assert!(read_trades(r#"[{"T":"error","code":406,"msg":"connection limit exceeded"}]"#, &mut m).is_err());
    }
}
