//! 🆕 새 버전 받기 (0.15.0, 원조 POWER CHART AND BACKTEST 1.4.0과 같은 방식): GitHub Releases에 더 새 EXE가 있으면 받아서 바꿔 넣고 다시 켠다.
//! - 묻는 곳은 이 앱 저장소 하나뿐 (REPO 고정). 화면(JS)은 주소를 넘길 수 없고 버전 글자만 넘긴다.
//! - 받은 EXE는 GitHub가 알려 준 SHA-256(digest)·크기와 같아야만 쓴다. 확인값이 없거나 다르면 버린다.
//! - 켜져 있는 EXE는 지울 수 없어서 "<이름>.old.exe"로 비켜 두고 그 자리에 새 것을 넣는다 → 다음에 켤 때 remove_old_exe가 지운다.
//! - 다시 켜기: 이 앱이 완전히 꺼진 뒤 새 EXE를 켜는 PowerShell을 숨겨서 띄운다
//!   (바로 켜면 "한 번만 켜기" 플러그인이 아직 켜져 있는 옛 앱을 보고 새 앱을 그냥 꺼 버린다).
//! - User-Agent는 이 앱 이름 그대로 (GitHub API가 User-Agent 없는 요청을 거절한다).

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_http::reqwest;

const REPO: &str = "rlagustn92/fake-trading-power-chart";
const ASSET: &str = "FAKE-TRADING-POWER-CHART.exe";
/// 받는 동안 거치는 주소 (github.com → 파일 저장소로 넘겨준다)
const ALLOWED_HOSTS: &[&str] = &["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

/// 새 EXE를 넣은 자리 (다시 켤 때 이것을 켠다. 켜져 있는 EXE 이름을 바꾼 뒤라 current_exe를 다시 묻지 않는다)
static INSTALLED: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug)]
pub struct Latest {
    /// "0.15.1" (앞의 v 뺌)
    version: String,
    /// 바뀐 것 (Releases 본문 = CHANGELOG의 그 버전 부분)
    notes: String,
    size: u64,
    /// "sha256:…" (GitHub가 올린 파일마다 계산해 둔 값)
    digest: Option<String>,
    /// 지금 켜진 앱 버전
    current: String,
    /// 지금보다 새것인가
    newer: bool,
}

fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .user_agent(concat!("fake-trading-power-chart/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client")
    })
}

/// "0.15.0" → (0, 15, 0). 숫자 세 개가 아니면 None
fn parse(v: &str) -> Option<(u32, u32, u32)> {
    let p: Vec<u32> = v.split('.').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    match p[..] {
        [a, b, c] => Some((a, b, c)),
        _ => None,
    }
}

/// a가 b보다 새 버전인가
fn is_newer(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Some(x), Some(y)) if x > y)
}

fn host_ok(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str().map(|h| ALLOWED_HOSTS.contains(&h)).unwrap_or(false)
}

/// Releases의 최신 버전 (EXE가 붙어 있는 것만). 아직 없으면 None
async fn latest() -> Result<Option<Latest>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let res = client()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub에 연결하지 못했어요 ({e})"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("GitHub 응답 {}", res.status()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?; // tauri의 reqwest는 json 기능이 꺼져 있다
    let j: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let tag = j["tag_name"].as_str().unwrap_or_default();
    let version = tag.strip_prefix('v').unwrap_or(tag).to_string();
    if parse(&version).is_none() {
        return Ok(None);
    }
    let Some(asset) = j["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == ASSET)) else {
        return Ok(None);
    };
    let current = env!("CARGO_PKG_VERSION").to_string();
    Ok(Some(Latest {
        newer: is_newer(&version, &current),
        version,
        notes: j["body"].as_str().unwrap_or_default().chars().take(4000).collect(),
        size: asset["size"].as_u64().unwrap_or(0),
        digest: asset["digest"].as_str().map(str::to_string),
        current,
    }))
}

/// 새 버전이 있나 (화면이 켤 때·12시간마다·⚙ 설정의 "새 버전 확인"에서 부른다)
#[tauri::command]
pub async fn update_check() -> Result<Option<Latest>, String> {
    latest().await
}

/// 받아서 확인하고 바꿔 넣기. version = 화면이 보여 준 버전 (그사이 더 새것이 나왔으면 다시 확인하게 한다).
/// 성공하면 다음에 update_restart로 다시 켠다
#[tauri::command]
pub async fn update_install(version: String) -> Result<(), String> {
    let l = latest().await?.ok_or("새 버전을 찾지 못했어요")?;
    if l.version != version {
        return Err(format!("그사이 {} 버전이 나왔어요 · 새 버전 확인을 다시 눌러 주세요", l.version));
    }
    if !l.newer {
        return Err("이미 최신 버전이에요".into());
    }
    let want = l
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or("GitHub가 파일 확인값(SHA-256)을 주지 않아서 받지 않았어요")?;

    let url = format!("https://github.com/{REPO}/releases/download/v{}/{ASSET}", l.version);
    let res = client().get(&url).send().await.map_err(|e| format!("받지 못했어요 ({e})"))?;
    if !host_ok(res.url()) {
        return Err(format!("엉뚱한 곳으로 연결돼서 멈췄어요 ({})", res.url().host_str().unwrap_or("?")));
    }
    if !res.status().is_success() {
        return Err(format!("받지 못했어요 (응답 {})", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("받다가 끊겼어요 ({e})"))?;
    if bytes.len() as u64 != l.size || !bytes.starts_with(b"MZ") {
        return Err("받은 파일 크기가 맞지 않아요 · 다시 해 주세요".into());
    }
    let got = hex::encode(Sha256::digest(&bytes));
    if got != want {
        return Err("받은 파일의 확인값(SHA-256)이 GitHub와 달라서 쓰지 않았어요".into());
    }

    // 바꿔 넣기: 새 것을 옆에 다 쓴 뒤 → 켜져 있는 것을 .old.exe로 비키고 → 새 것을 그 자리로
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let stem = exe.file_stem().and_then(|s| s.to_str()).ok_or("EXE 이름을 읽지 못했어요")?.to_string();
    let fresh = exe.with_file_name(format!("{stem}.new.exe"));
    let old = exe.with_file_name(format!("{stem}.old.exe"));
    std::fs::write(&fresh, &bytes).map_err(|e| format!("새 EXE를 쓰지 못했어요 · 이 폴더에 쓸 수 있는지 봐 주세요 ({e})"))?;
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(&exe, &old) {
        let _ = std::fs::remove_file(&fresh);
        return Err(format!("지금 EXE를 비키지 못했어요 ({e})"));
    }
    if let Err(e) = std::fs::rename(&fresh, &exe) {
        let _ = std::fs::rename(&old, &exe); // 되돌리기
        return Err(format!("새 EXE를 넣지 못했어요 ({e})"));
    }
    *INSTALLED.lock().unwrap() = Some(exe.clone());
    crate::append_log(format!("INFO update installed {} → {} ({} bytes, sha256 {})", l.current, l.version, bytes.len(), &got[..12]));
    Ok(())
}

/// 바꿔 넣은 새 EXE로 다시 켜기: 이 앱이 꺼지길 기다렸다가 켜는 PowerShell을 숨겨서 띄우고 앱을 끈다
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<(), String> {
    let exe = INSTALLED.lock().unwrap().clone().ok_or("새 EXE를 아직 넣지 않았어요")?;
    let path = exe.to_string_lossy().replace('\'', "''");
    let script = format!("Wait-Process -Id {} -ErrorAction SilentlyContinue; Start-Process -FilePath '{path}'", std::process::id());
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 검은 창이 번쩍이지 않게
    }
    cmd.spawn().map_err(|e| format!("다시 켜지 못했어요 · 바로가기로 켜 주세요 ({e})"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.15.0", "0.14.1"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.15.0", "0.15.0"));
        assert!(!is_newer("0.14.9", "0.15.0"));
        assert!(!is_newer("0.16", "0.15.0"));
        assert!(!is_newer("0.16.0-beta", "0.15.0"));
    }

    #[test]
    fn only_github_hosts() {
        let ok = |u: &str| host_ok(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://github.com/x"));
        assert!(ok("https://release-assets.githubusercontent.com/x"));
        assert!(!ok("http://github.com/x"));
        assert!(!ok("https://example.com/x"));
        assert!(!ok("https://github.com.evil.example/x"));
    }
}
