//! DZF 提醒 · 桌面壳
//! 负责：系统托盘、关闭到托盘、置顶提醒小窗、开机自启、单实例、自动更新。
//! 所有业务逻辑（数据、调度、通知内容）都在前端，这里只提供窗口和系统能力。

use serde::{Deserialize, Serialize};
use tauri::{
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![show_alert, close_alert, set_tray_badge])
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
