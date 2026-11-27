//! DZF 提醒 · 桌面壳
//! 负责：系统托盘、关闭到托盘、置顶提醒小窗、开机自启、单实例、自动更新、把导出的文件存进「下载」文件夹。
//! 所有业务逻辑（数据、调度、通知内容）都在前端，这里只提供窗口和系统能力。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use tauri::{
    ipc::{InvokeBody, Request},
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AlertPayload {
    pub key: String,
    pub reminder_id: String,
    pub occurrence_at: String,
    pub title: String,
    pub body: String,
    pub priority: String,
    pub team_name: String,
    pub team_color: String,
    pub time_label: String,
}

const ALERT_W: f64 = 440.0;
const ALERT_H: f64 = 280.0;

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 弹出（或复用）置顶小窗，并把提醒内容发给它
#[tauri::command]
fn show_alert(app: AppHandle, payload: AlertPayload) -> Result<(), String> {
    let window = match app.get_webview_window("alert") {
        Some(w) => w,
        None => {
            let mut builder = WebviewWindowBuilder::new(&app, "alert", WebviewUrl::App("index.html#/alert".into()))
                .title("DZF 提醒")
                .inner_size(ALERT_W, ALERT_H)
                .resizable(false)
                .always_on_top(true)
                .decorations(false)
                .visible(false);
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.skip_taskbar(true);
            }
            // 右下角
            if let Ok(Some(monitor)) = app.primary_monitor() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let x = size.width as f64 / scale - ALERT_W - 24.0;
                let y = size.height as f64 / scale - ALERT_H - 80.0;
                builder = builder.position(x.max(0.0), y.max(0.0));
            }
            builder.build().map_err(|e| e.to_string())?
        }
    };
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    // 新建的窗口前端可能还没挂上监听，多发几次（重复接收无害）
    let handle = app.clone();
    std::thread::spawn(move || {
        for delay in [50u64, 500, 1500, 3000] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let _ = handle.emit_to("alert", "alert-payload", payload.clone());
        }
    });
    Ok(())
}

#[tauri::command]
fn close_alert(app: AppHandle) {
    if let Some(w) = app.get_webview_window("alert") {
        let _ = w.hide();
    }
}

/// 托盘提示文字里显示逾期数量（macOS 同时显示在菜单栏标题）
#[tauri::command]
fn set_tray_badge(app: AppHandle, overdue: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if overdue > 0 {
            format!("DZF 提醒 · {} 条逾期", overdue)
        } else {
            "DZF 提醒".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
        #[cfg(target_os = "macos")]
        {
            let _ = tray.set_title(if overdue > 0 { Some(overdue.to_string()) } else { None::<String> });
        }
    }
}

/// 文件名里不能有的字符换成 _；首尾的空格和点去掉
fn clean_file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim().trim_matches('.').trim();
    if s.is_empty() {
        "download".to_string()
    } else {
        s.to_string()
    }
}

/// 重名就加 (1)、(2)…：盘点结果.xlsx → 盘点结果 (1).xlsx
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    for i in 1..10000 {
        let p = dir.join(format!("{stem} ({i}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

/// 要存的文件：名字 + 内容（`bytes` 里从 `start` 开始才是内容）
struct Download<'a> {
    name: String,
    bytes: Cow<'a, [u8]>,
    start: usize,
}

impl Download<'_> {
    fn data(&self) -> &[u8] {
        &self.bytes[self.start..]
    }
}

/// 打包好的请求体：4 字节文件名长度（小端）+ 文件名（UTF-8）+ 文件内容
fn unpack_download(body: Cow<'_, [u8]>) -> Result<Download<'_>, String> {
    if body.len() < 4 {
        return Err("save_download: empty body".into());
    }
    let n = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if n == 0 || n > 1024 || body.len() < 4 + n {
        return Err("save_download: bad file name".into());
    }
    let name = String::from_utf8_lossy(&body[4..4 + n]).into_owned();
    Ok(Download { name, bytes: body, start: 4 + n })
}

/// 界面发来的存文件请求，三种样子都认。
///
/// Tauri 的 IPC 有两条路：正常走自定义协议（`ipc://localhost`，二进制原样到）；只要 webview 里有一次这样的请求失败
/// （CSP 没放行、电脑睡眠唤醒时请求断了……），它就整个改走 postMessage，直到窗口重开 —— 那条路上一切都是 JSON。
/// v0.8.3–v0.8.10 这里只认二进制，而 CSP 的 connect-src 又没放行 `ipc:`，所以打包好的桌面版一直在走 postMessage，
/// 存文件一直报「expected raw bytes」。
///
/// 1. 二进制（正常）：打包好的请求体，见 [`unpack_download`]
/// 2. JSON 对象 `{ name, data }`，`data` 是 base64：界面先用 `ipc_raw` 问过、知道走的是 postMessage 时发这个
/// 3. JSON 数字数组：1 在 postMessage 那条路上被框架拆成的样子（问完之后、发的那一下才掉到备用通道时会遇到）
fn read_download(body: &InvokeBody) -> Result<Download<'_>, String> {
    match body {
        InvokeBody::Raw(b) => unpack_download(Cow::Borrowed(b.as_slice())),
        InvokeBody::Json(serde_json::Value::Object(o)) => {
            let name = o.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            if name.is_empty() || name.len() > 1024 {
                return Err("save_download: bad file name".into());
            }
            let data = o.get("data").and_then(|v| v.as_str()).ok_or("save_download: no data")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| format!("save_download: bad base64: {e}"))?;
            Ok(Download { name: name.to_string(), bytes: Cow::Owned(bytes), start: 0 })
        }
        InvokeBody::Json(serde_json::Value::Array(a)) => {
            let bytes = a
                .iter()
                .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or("save_download: not bytes")?;
            unpack_download(Cow::Owned(bytes))
        }
        InvokeBody::Json(_) => Err("save_download: unexpected body".into()),
    }
}

/// 界面问一声：这次调用带的二进制是不是原样到的。不是（IPC 走的是 postMessage）的话，界面存文件时改发 base64，
/// 免得大文件被拆成一长串 JSON 数字。
#[tauri::command]
fn ipc_raw(request: Request<'_>) -> bool {
    matches!(request.body(), InvokeBody::Raw(_))
}

/// 网页那边导出的文件（盘点结果、照片压缩包、移库文件、全部下载）直接写进「下载」文件夹，返回完整路径。
/// 桌面的 webview 不一定处理 <a download>（Mac 的不下载，Windows 的有时没反应），所以走这里。
/// 请求体的几种样子见 [`read_download`]。
#[tauri::command]
async fn save_download(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let file = read_download(request.body())?;
    let name = clean_file_name(&file.name);
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &name);
    std::fs::write(&path, file.data()).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![show_alert, close_alert, set_tray_badge, save_download, ipc_raw])
        .setup(|app| {
            // 托盘菜单
            let open = MenuItem::with_id(app, "open", "打开主窗口 · Öffnen", true, None::<&str>)?;
            let mute = MenuItem::with_id(app, "mute", "静音 1 小时 · 1 Std. stumm", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 · Beenden", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &mute, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("DZF 提醒")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "mute" => {
                        let _ = app.emit("tray-command", "mute-1h");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 开机自启带 --minimized 参数时不显示主窗口
            let minimized = std::env::args().any(|a| a == "--minimized");
            if let Some(main) = app.get_webview_window("main") {
                if minimized {
                    let _ = main.hide();
                } else {
                    let _ = main.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗口 = 最小化到托盘；真正退出走托盘菜单
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DZF reminder");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 界面那边 packDownload() 的同款：4 字节名字长度 + 名字 + 内容
    fn pack(name: &str, data: &[u8]) -> Vec<u8> {
        let mut v = (name.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(name.as_bytes());
        v.extend_from_slice(data);
        v
    }

    fn got(body: InvokeBody) -> Result<(String, Vec<u8>), String> {
        read_download(&body).map(|d| (d.name.clone(), d.data().to_vec()))
    }

    #[test]
    fn raw_bytes() {
        let data: Vec<u8> = (0..=255).collect();
        assert_eq!(got(InvokeBody::Raw(pack("盘点 4厅.xlsx", &data))), Ok(("盘点 4厅.xlsx".to_string(), data)));
        // 空文件也能存
        assert_eq!(got(InvokeBody::Raw(pack("a.txt", b""))), Ok(("a.txt".to_string(), vec![])));
    }

    #[test]
    fn number_array_from_post_message() {
        // Tauri 的 postMessage 那条路发来的整条消息（scripts/process-ipc-message-fn.js 对 Uint8Array 的处理：拆成数字数组）
        let msg: serde_json::Value = serde_json::from_str(
            r#"{"cmd":"save_download","callback":1,"error":2,"options":{"customProtocolIpcBlocked":true},"payload":[5,0,0,0,97,46,116,120,116,104,105,0,255],"__TAURI_INVOKE_KEY__":"k"}"#,
        )
        .unwrap();
        assert_eq!(got(InvokeBody::Json(msg["payload"].clone())), Ok(("a.txt".to_string(), vec![b'h', b'i', 0, 255])));
        let data: Vec<u8> = (0..=255).rev().collect();
        let arr = serde_json::Value::Array(pack("中文名.zip", &data).into_iter().map(|n| json!(n)).collect());
        assert_eq!(got(InvokeBody::Json(arr)), Ok(("中文名.zip".to_string(), data)));
    }

    #[test]
    fn base64_object() {
        let data: Vec<u8> = (0..=255).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        assert_eq!(got(InvokeBody::Json(json!({ "name": "移库 WMS-A.xls", "data": b64 }))), Ok(("移库 WMS-A.xls".to_string(), data)));
        assert_eq!(got(InvokeBody::Json(json!({ "name": "空.txt", "data": "" }))), Ok(("空.txt".to_string(), vec![])));
    }

    #[test]
    fn rejects_bad_requests() {
        // 太短、名字长度对不上
        assert!(got(InvokeBody::Raw(vec![1, 0])).is_err());
        assert!(got(InvokeBody::Raw(vec![0, 0, 0, 0, 1, 2])).is_err());
        assert!(got(InvokeBody::Raw(vec![9, 0, 0, 0, b'a'])).is_err());
        // 数组里有不是字节的东西
        assert!(got(InvokeBody::Json(json!([1, 0, 0, 0, 97, 300]))).is_err());
        assert!(got(InvokeBody::Json(json!([1, 0, 0, 0, 97, -1]))).is_err());
        assert!(got(InvokeBody::Json(json!([1, 0, 0, 0, 97, 1.5]))).is_err());
        assert!(got(InvokeBody::Json(json!([1, 0, 0, 0, 97, "1"]))).is_err());
        // 对象缺东西、base64 不对
        assert!(got(InvokeBody::Json(json!({ "data": "aGk=" }))).is_err());
        assert!(got(InvokeBody::Json(json!({ "name": "", "data": "aGk=" }))).is_err());
        assert!(got(InvokeBody::Json(json!({ "name": "a.txt" }))).is_err());
        assert!(got(InvokeBody::Json(json!({ "name": "a.txt", "data": "***" }))).is_err());
        assert!(got(InvokeBody::Json(json!({ "name": "a.txt", "data": [104, 105] }))).is_err());
        // 别的 JSON
        assert!(got(InvokeBody::Json(json!(null))).is_err());
        assert!(got(InvokeBody::Json(json!("hi"))).is_err());
    }

    #[test]
    fn file_names() {
        assert_eq!(clean_file_name("a/b:c*?.txt"), "a_b_c__.txt");
        assert_eq!(clean_file_name("  ..  "), "download");
    }
}
