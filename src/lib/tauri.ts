// 桌面壳相关的调用都集中在这里，网页版下全部安全降级。
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface AlertPayload {
  key: string;
  reminderId: string;
  occurrenceAt: string;
  title: string;
  body: string;
  priority: 'low' | 'medium' | 'high';
  teamName: string;
  teamColor: string;
  timeLabel: string;
}

export async function showAlertWindow(payload: AlertPayload): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_alert', { payload });
}

/** 把主窗口从托盘里叫出来（置顶小窗点「查看」、或者需要上传文件时用） */
export async function showMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const w = await WebviewWindow.getByLabel('main');
    if (!w) return;
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch {
    /* ignore */
  }
}

/** 在系统浏览器里打开链接（桌面壳用 opener 插件；网页版就是新标签页） */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      /* 插件不可用时退回 window.open */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 当前是不是 macOS 桌面壳（WKWebView 不会自己处理下载，打包下载按钮要藏起来） */
export async function isMacDesktop(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { platform } = await import('@tauri-apps/plugin-os');
    return platform() === 'macos';
  } catch {
    return false;
  }
}

export async function closeAlertWindow(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_alert');
}

export async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (isTauri()) {
    const n = await import('@tauri-apps/plugin-notification');
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === 'granted';
    if (granted) n.sendNotification({ title, body });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png' });
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const a = await import('@tauri-apps/plugin-autostart');
    if (enabled) await a.enable();
    else await a.disable();
  } catch {
    /* 插件不可用时忽略 */
  }
}

// 自动更新分两步：先在后台把新版本下好（不打断正在干活的人），
// 等用户点「重启更新」时才真正安装 —— Windows 上安装会关掉应用。
let pendingUpdate: { version: string; install: () => Promise<void> } | null = null;
let inflight: Promise<string | null> | null = null;

/** 更新进行到哪一步了（关于页按它显示；后台检查也会更新它，但不弹东西） */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; pct: number | null }
  | { phase: 'ready'; version: string }
  | { phase: 'latest'; at: number }
  | { phase: 'error'; message: string; at: number };

/** 查更新最多等多久；下载最多等多久（安装包 3–7 MB，慢网也够） */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** 手动下载安装包的地方（检查更新失败时给用户的退路） */
export const RELEASES_URL = 'https://github.com/teribinlau/dzf-reminder/releases/latest';

/** 超时就报错。updater 自己也带了超时，这里再兜一层：万一卡在别处，界面也不会一直「…」 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label}: timeout ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => { window.clearTimeout(t); resolve(v); },
      (e) => { window.clearTimeout(t); reject(e); },
    );
  });
}

/** Tauri 的错误多半是字符串；统一成一行短文字给人看 */
export function errorText(e: unknown): string {
  const s = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  return (s || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * 查有没有新版本并下载好；返回新版本号，没有新版本 / 出错返回 null。可以反复调用：
 * 已经下好的直接返回；正在查 / 正在下的（比如后台那次还没完、用户又点了「检查更新」）共用同一次，不会并排下两份。
 * 进度和结果通过 report 报出去（关于页显示），出错不再悄悄吞掉。
 */
export function downloadUpdate(report: (s: UpdateState) => void = () => {}): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  if (pendingUpdate) {
    report({ phase: 'ready', version: pendingUpdate.version });
    return Promise.resolve(pendingUpdate.version);
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      report({ phase: 'checking' });
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await withTimeout(check({ timeout: UPDATE_CHECK_TIMEOUT_MS }), UPDATE_CHECK_TIMEOUT_MS + 5000, 'check');
      if (!update) {
        report({ phase: 'latest', at: Date.now() });
        return null;
      }
      report({ phase: 'downloading', version: update.version, pct: null });
      let total = 0;
      let got = 0;
      let lastPct = -1;
      await withTimeout(
        update.download(
          (ev) => {
            if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
            else if (ev.event === 'Progress') {
              got += ev.data.chunkLength;
              const pct = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : null;
              if (pct !== lastPct) {
                lastPct = pct ?? -1;
                report({ phase: 'downloading', version: update.version, pct });
              }
            }
          },
          { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
        ),
        UPDATE_DOWNLOAD_TIMEOUT_MS + 5000,
        'download',
      );
      pendingUpdate = { version: update.version, install: () => update.install() };
      report({ phase: 'ready', version: update.version });
      return update.version;
    } catch (e) {
      // 离线、连不上 GitHub、清单里没有这个平台、签名不对……都写出来，别再只显示「已是最新」
      report({ phase: 'error', message: errorText(e), at: Date.now() });
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 安装已经下好的新版本并重启（Windows 上安装程序会先把应用关掉） */
export async function installUpdate(): Promise<void> {
  if (!pendingUpdate) return;
  await pendingUpdate.install();
  await relaunchApp();
}

export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return;
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** 监听置顶小窗发回的动作（完成 / 稍后 / 打开） */
export async function listenAlertActions(
  cb: (action: { type: 'complete' | 'snooze' | 'open'; key: string; reminderId: string; occurrenceAt: string; minutes?: number }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ type: 'complete' | 'snooze' | 'open'; key: string; reminderId: string; occurrenceAt: string; minutes?: number }>(
    'alert-action',
    (e) => cb(e.payload),
  );
  return un;
}

export async function emitAlertAction(action: {
  type: 'complete' | 'snooze' | 'open';
  key: string;
  reminderId: string;
  occurrenceAt: string;
  minutes?: number;
}): Promise<void> {
  if (!isTauri()) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit('alert-action', action);
}

/** 主窗口里完成 / 稍后了某条提醒：小窗如果正显示这一条就自己关掉 */
export async function dismissAlert(key: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('alert-dismiss', { key });
  } catch {
    /* ignore */
  }
}

export async function listenAlertDismiss(cb: (key: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ key: string }>('alert-dismiss', (e) => cb(e.payload.key));
}

export async function listenAlertPayload(cb: (p: AlertPayload) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<AlertPayload>('alert-payload', (e) => cb(e.payload));
}

export async function listenTrayCommands(cb: (cmd: 'mute-1h' | 'open') => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<'mute-1h' | 'open'>('tray-command', (e) => cb(e.payload));
}

export async function setTrayBadge(overdue: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_badge', { overdue });
  } catch {
    /* ignore */
  }
}

/** 一段短促的提示音（WebAudio，不依赖音频文件） */
export function playChime(loud: boolean): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = loud ? 0.35 : 0.18;
    gain.connect(ctx.destination);
    const notes = loud ? [880, 1174, 880, 1174] : [880, 1174];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(gain);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.16);
    });
    window.setTimeout(() => ctx.close(), 1500);
  } catch {
    /* 无音频设备 */
  }
}
