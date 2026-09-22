// ============================================================
// Tauri 2 后端命令层
// 桌面（Windows/macOS/Linux）：std::fs 直接写入用户选择的文件夹
// Android：MediaStore Downloads（默认）或 SAF 用户目录（platform_android.rs）
// 所有文件写入都必须经过这里，保证"统一保存目录、不随机落盘"
// ============================================================
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
#[cfg(not(target_os = "android"))]
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "android")]
mod platform_android;

/// 前端约定的 Android 默认目录标记（等价于公共 Download 集合）
const ANDROID_DOWNLOADS_URI: &str = "content://media/external/downloads";

#[derive(Serialize)]
struct EnvInfo {
    os: &'static str,
    default_dir: String,
    default_display: String,
}

#[derive(Serialize)]
struct PickedDir {
    uri: String,
    display: String,
}

#[derive(Serialize)]
pub struct SavedFile {
    pub uri: String,
    pub display: String,
}

struct WriteSession {
    dir: String,
    name: String,
    mime: String,
    tmp: PathBuf,
}

struct AppState {
    sessions: Mutex<HashMap<u64, WriteSession>>,
    next_id: Mutex<u64>,
}

// ---------------- 环境与目录选择 ----------------

#[tauri::command]
fn env_info(_app: AppHandle) -> EnvInfo {
    #[cfg(target_os = "android")]
    {
        EnvInfo {
            os: "android",
            default_dir: ANDROID_DOWNLOADS_URI.to_string(),
            default_display: "公共下载目录（Download）".to_string(),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let os = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        let dl = dirs::download_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"));
        EnvInfo {
            os,
            default_dir: dl.to_string_lossy().to_string(),
            default_display: format!("系统下载文件夹：{}", dl.display()),
        }
    }
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<PickedDir>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().blocking_pick_folder();
        match picked {
            Some(folder) => {
                let uri = folder.to_string();
                let display = friendly_dir_display(&uri);
                Ok(Some(PickedDir { uri, display }))
            }
            None => Ok(None),
        }
    }
    #[cfg(target_os = "android")]
    {
        // Android 上 tauri-plugin-dialog 不支持 pick_folder，
        // 直接返回默认下载目录（MediaStore.Downloads）
        let uri = "content://media/external/downloads".to_string();
        let display = "公共下载目录".to_string();
        Ok(Some(PickedDir { uri, display }))
    }
}

fn friendly_dir_display(uri: &str) -> String {
    if uri.starts_with("content://") {
        // SAF tree uri 末段通常是 primary%3Axxx，解出目录名
        let decoded = uri.replace("%2F", "/").replace("%3A", ":");
        let tail = decoded.rsplit('/').next().unwrap_or(uri);
        format!("手机存储 · {}", tail)
    } else {
        format!("本地文件夹：{}", uri)
    }
}

// ---------------- 小文件一次性保存（OCR 导出） ----------------

#[tauri::command]
async fn save_small_file(
    dir: String,
    name: String,
    mime: String,
    b64: String,
) -> Result<SavedFile, String> {
    let bytes = STANDARD.decode(b64).map_err(|e| format!("base64 解码失败：{e}"))?;
    platform_save(&dir, &name, &mime, &bytes)
}

// ---------------- 大文件流式接收会话（互传） ----------------

#[tauri::command]
async fn create_write_session(
    app: AppHandle,
    state: State<'_, AppState>,
    dir: String,
    name: String,
    mime: String,
) -> Result<u64, String> {
    let id = {
        let mut g = state.next_id.lock().map_err(poison)?;
        let v = *g;
        *g += 1;
        v
    };
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败：{e}"))?;
    let tmp = cache.join(format!(".pts_recv_{id}.part"));
    File::create(&tmp).map_err(|e| format!("创建临时文件失败：{e}"))?;
    state
        .sessions
        .lock()
        .map_err(poison)?
        .insert(id, WriteSession { dir, name, mime, tmp });
    Ok(id)
}

#[tauri::command]
async fn append_write_session(
    state: State<'_, AppState>,
    id: u64,
    b64: String,
) -> Result<(), String> {
    let tmp = {
        let sessions = state.sessions.lock().map_err(poison)?;
        let s = sessions
            .get(&id)
            .ok_or_else(|| format!("写入会话 {id} 不存在"))?;
        s.tmp.clone()
    };
    let bytes = STANDARD.decode(b64).map_err(|e| format!("base64 解码失败：{e}"))?;
    let mut f = OpenOptions::new()
        .append(true)
        .open(&tmp)
        .map_err(|e| format!("写入临时文件失败：{e}"))?;
    f.write_all(&bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(())
}

#[tauri::command]
async fn finish_write_session(
    state: State<'_, AppState>,
    id: u64,
) -> Result<SavedFile, String> {
    let session = state
        .sessions
        .lock()
        .map_err(poison)?
        .remove(&id)
        .ok_or_else(|| format!("写入会话 {id} 不存在"))?;
    let bytes = fs::read(&session.tmp).map_err(|e| format!("读取临时文件失败：{e}"))?;
    let _ = fs::remove_file(&session.tmp);
    platform_save(&session.dir, &session.name, &session.mime, &bytes)
}

#[tauri::command]
async fn cancel_write_session(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().map_err(poison)?.remove(&id) {
        let _ = fs::remove_file(s.tmp);
    }
    Ok(())
}

fn poison<T>(_: T) -> String {
    "内部状态锁异常".to_string()
}

// ---------------- 平台分发 ----------------

#[cfg(not(target_os = "android"))]
fn platform_save(dir: &str, name: &str, _mime: &str, bytes: &[u8]) -> Result<SavedFile, String> {
    let dir = Path::new(dir);
    fs::create_dir_all(dir).map_err(|e| format!("创建保存目录失败：{e}"))?;
    let target = unique_path(dir, name);
    fs::write(&target, bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(SavedFile {
        uri: target.to_string_lossy().to_string(),
        display: target.display().to_string(),
    })
}

#[cfg(target_os = "android")]
fn platform_save(dir: &str, name: &str, mime: &str, bytes: &[u8]) -> Result<SavedFile, String> {
    platform_android::save(dir, name, &effective_mime(mime), bytes)
}

#[cfg(target_os = "android")]
fn effective_mime(mime: &str) -> String {
    if mime.trim().is_empty() {
        "application/octet-stream".to_string()
    } else {
        mime.to_string()
    }
}

/// 同名文件自动追加 (1)(2)，绝不覆盖
#[cfg(not(target_os = "android"))]
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i..])),
        _ => (name, None),
    };
    for n in 1..10_000 {
        let fname = match ext {
            Some(e) => format!("{stem} ({n}){e}"),
            None => format!("{stem} ({n})"),
        };
        let p = dir.join(fname);
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} (dup)"))
}

// ---------------- 启动 ----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            env_info,
            pick_directory,
            save_small_file,
            create_write_session,
            append_write_session,
            finish_write_session,
            cancel_write_session
        ])
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
