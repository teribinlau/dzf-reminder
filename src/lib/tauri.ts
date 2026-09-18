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

export async function checkForUpdate(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      await update.downloadAndInstall();
      return update.version;
    }
  } catch {
    /* 没配置更新源或离线 */
  }
  return null;
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
