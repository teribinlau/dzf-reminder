import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconCamera, IconX } from '../Icons';

// 手机摄像头扫码：安卓 Chrome 有原生 BarcodeDetector 就用它；iPhone / 其他浏览器用 zxing-wasm 做的同名接口
// （wasm 文件跟着应用一起部署，不走外部 CDN）。只在用到时才加载。
// 认出来的码不在这次盘点里：直接在相机画面上显示读到的原文，接着扫
// （v0.8.0 是弹在相机下面的提示，被相机盖住看不见，相机也停了 —— 现场看起来就是「扫不出来」）。
// 实时扫不出来（对不上焦、标签远、内嵌浏览器不给相机）：「拍照识别」用系统相机拍一张清楚的再认。
type Found = { rawValue: string };
type Detector = { detect(src: ImageBitmapSource): Promise<Found[]> };
type Engine = 'native' | 'zxing';
const FORMATS = [
  'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e',
  'qr_code', 'data_matrix', 'aztec', 'pdf417',
];
const LENS_KEY = 'dzf-st-lens-v1';
const MISS_MS = 6000;

let detectorPromise: Promise<{ detector: Detector; engine: Engine }> | null = null;

async function makeDetector(): Promise<{ detector: Detector; engine: Engine }> {
  type NativeCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
  const Native = (globalThis as { BarcodeDetector?: NativeCtor }).BarcodeDetector;
  if (Native) {
    try {
      const sup = await Native.getSupportedFormats();
      if (sup.includes('code_128') && sup.includes('qr_code')) {
        return { detector: new Native({ formats: FORMATS.filter((f) => sup.includes(f)) }), engine: 'native' };
      }
    } catch {
      /* 原生的不好用就换 wasm 的 */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  // 马上加载 wasm：加载不了在这里就报出来，而不是每一帧悄悄失败
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
    fireImmediately: true,
  });
  return { detector: new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector, engine: 'zxing' };
}

function getDetector() {
  detectorPromise ??= makeDetector().catch((e: unknown) => {
    detectorPromise = null;
    throw e;
  });
  return detectorPromise;
}

const codesOf = (found: Found[]) => [...new Set(found.map((b) => b.rawValue?.trim()).filter((c): c is string => !!c))];
const errText = (e: unknown) => String((e as { message?: string })?.message || (e as { name?: string })?.name || e).slice(0, 80);

/** 一张照片里找条码：先缩到 1600 再原图再 1000（手机照片大、条码小，换个尺寸常常就认出来了） */
async function decodePhoto(detector: Detector, file: Blob): Promise<string[]> {
  const bmp = await createImageBitmap(file);
  try {
    const big = Math.max(bmp.width, bmp.height);
    for (const side of [1600, 0, 1000]) {
      if (side && big <= side * 1.2) continue;
      let src: ImageBitmapSource = bmp;
      if (side) {
        const k = side / big;
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k);
        c.height = Math.round(bmp.height * k);
        c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
        src = c;
      }
      try {
        const codes = codesOf(await detector.detect(src));
        if (codes.length) return codes;
      } catch {
        /* 换个尺寸再试 */
      }
    }
    return [];
  } finally {
    bmp.close();
  }
}

// ---- 镜头：多摄像头的手机可以换；安卓优先主摄（Chrome 默认的后置有时是超广角，近处对不上焦） ----
const isFront = (l: string) => /front|user|前置|vorder/i.test(l);
const isBack = (l: string) => /back|rear|environment|后置|背面|rück/i.test(l);

async function backLenses(): Promise<MediaDeviceInfo[]> {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  const backs = cams.filter((d) => isBack(d.label));
  return backs.length ? backs : cams.filter((d) => !isFront(d.label));
}

const mainLens = (lenses: MediaDeviceInfo[]) => lenses.find((d) => /\b0, facing back/i.test(d.label));

function readLens(): string {
  try {
    return localStorage.getItem(LENS_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveLens(id: string) {
  try {
    if (id) localStorage.setItem(LENS_KEY, id);
    else localStorage.removeItem(LENS_KEY);
  } catch {
    /* 存不了就算了 */
  }
}

async function openStream(deviceId: string): Promise<MediaStream> {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: { exact: deviceId } }, audio: false });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw e;
      saveLens(''); // 记住的镜头不在了：用默认的后置
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: { ideal: 'environment' } }, audio: false });
}

type TrackCaps = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[]; zoom?: { min: number; max: number } };

/** 能不能用摄像头扫（要 https 和 getUserMedia；桌面版不给这个入口） */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && window.isSecureContext;
}

type Phase = 'starting' | 'live' | 'error' | 'paused' | 'photo';

/**
 * 全屏的扫码框：对准库位条码，认出来就震一下、关掉、把码交出去。
 * onCode 返回 true = 这次盘点里有这个库位（关相机跳过去）；false = 没有，画面上显示读到的码，接着扫。
 */
export function CameraScanner({ onCode, onClose }: { onCode: (code: string) => boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const liveRef = useRef(false);
  const doneRef = useRef(false);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  const lastMiss = useRef({ code: '', at: 0 });
  const missTimer = useRef(0);
  const cb = useRef(onCode);
  cb.current = onCode;

  const [phase, setPhase] = useState<Phase>('starting');
  const [camErr, setCamErr] = useState('');
  const [detErr, setDetErr] = useState('');
  const [engine, setEngine] = useState<Engine | null>(null);
  const [res, setRes] = useState<{ w: number; h: number } | null>(null);
  const [lenses, setLenses] = useState<MediaDeviceInfo[]>([]);
  const [lensId, setLensId] = useState('');
  const [torch, setTorch] = useState<{ on: boolean } | null>(null);
  const [zoom, setZoom] = useState<{ levels: number[]; i: number } | null>(null);
  const [miss, setMiss] = useState('');
  const [photoMsg, setPhotoMsg] = useState<'' | 'none' | 'bad'>('');

  const stopStream = () => {
    liveRef.current = false;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    trackRef.current = null;
    if (video.current) video.current.srcObject = null;
  };

  const showMiss = (code: string) => {
    setMiss(code);
    window.clearTimeout(missTimer.current);
    missTimer.current = window.setTimeout(() => setMiss(''), MISS_MS);
  };

  // 认到的码：有一个在这次盘点里就收下；都没有就在画面上说读到了什么（同一个码 2.5 秒内不重复震）
  const handleRef = useRef((codes: string[]): boolean => {
    for (const c of codes) {
      if (cb.current(c)) {
        doneRef.current = true;
        liveRef.current = false;
        navigator.vibrate?.(60);
        return true;
      }
    }
    const c = codes[0];
    if (!c) return false;
    const now = Date.now();
    const same = c === lastMiss.current.code && now - lastMiss.current.at < 2500;
    lastMiss.current = { code: c, at: now };
    if (!same) {
      navigator.vibrate?.([30, 60, 30]);
      showMiss(c);
    }
    return false;
  });

  const startCam = async (id: string, autoMain = false) => {
    const seq = ++seqRef.current;
    stopStream();
    setPhase('starting');
    setPhotoMsg('');
    try {
      const s = await openStream(id);
      if (!aliveRef.current || seq !== seqRef.current) {
        s.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = s;
      const track = s.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      const v = video.current;
      if (v) {
        v.srcObject = s;
        await v.play().catch(() => undefined);
      }
      const caps = (track?.getCapabilities?.() ?? {}) as TrackCaps;
      if (track && caps.focusMode?.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      setTorch(caps.torch ? { on: false } : null);
      const zmax = caps.zoom?.max ?? 1;
      const levels = [Math.max(1, caps.zoom?.min ?? 1), ...[2, 3].filter((z) => z <= zmax)];
      if (levels.length === 1) levels.push(zmax);
      setZoom(zmax >= 1.5 ? { levels, i: 0 } : null);
      const st = track?.getSettings?.() ?? {};
      setRes({ w: st.width ?? v?.videoWidth ?? 0, h: st.height ?? v?.videoHeight ?? 0 });
      const cur = st.deviceId ?? '';
      setLensId(cur);
      setCamErr('');
      setPhase('live');
      liveRef.current = true;
      const list = await backLenses().catch(() => [] as MediaDeviceInfo[]);
      if (!aliveRef.current || seq !== seqRef.current) return;
      setLenses(list);
      // 第一次用、没选过镜头：安卓有主摄就换到主摄
      const main = mainLens(list);
      if (autoMain && main && cur && main.deviceId !== cur) {
        saveLens(main.deviceId);
        void startCam(main.deviceId);
      }
    } catch (e) {
      if (!aliveRef.current || seq !== seqRef.current) return;
      const name = (e as { name?: string })?.name ?? '';
      setCamErr(
        name === 'NotAllowedError' || name === 'SecurityError' ? t('stock.cam.denied') : name === 'NotFoundError' ? t('stock.cam.none') : t('stock.cam.failed'),
      );
      setPhase('error');
    }
  };

  // 打开相机（上次选过的镜头优先）
  useEffect(() => {
    aliveRef.current = true;
    const saved = readLens();
    void startCam(saved, !saved);
    return () => {
      aliveRef.current = false;
      seqRef.current += 1;
      window.clearTimeout(missTimer.current);
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 一直认：相机在播就每 0.1 秒认一帧
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let errs = 0;
    getDetector().then(
      ({ detector, engine: eng }) => {
        if (!alive) return;
        setEngine(eng);
        const loop = async () => {
          if (!alive || doneRef.current) return;
          const v = video.current;
          if (liveRef.current && v && v.readyState >= 2 && v.videoWidth) {
            try {
              const codes = codesOf(await detector.detect(v));
              if (errs >= 8) setDetErr('');
              errs = 0;
              if (alive && liveRef.current && handleRef.current(codes)) return;
            } catch (e) {
              errs += 1;
              if (errs === 8) setDetErr(errText(e));
            }
          }
          timer = window.setTimeout(() => void loop(), 100);
        };
        void loop();
      },
      (e: unknown) => alive && setDetErr(errText(e)),
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const switchLens = () => {
    if (lenses.length < 2) return;
    const i = lenses.findIndex((d) => d.deviceId === lensId);
    const next = lenses[(i + 1) % lenses.length];
    saveLens(next.deviceId);
    void startCam(next.deviceId);
  };

  const cycleZoom = async () => {
    const track = trackRef.current;
    if (!zoom || !track) return;
    const i = (zoom.i + 1) % zoom.levels.length;
    try {
      await track.applyConstraints({ advanced: [{ zoom: zoom.levels[i] } as MediaTrackConstraintSet] });
      setZoom({ ...zoom, i });
    } catch {
      setZoom(null);
    }
  };

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!torch || !track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch.on } as MediaTrackConstraintSet] });
      setTorch({ on: !torch.on });
    } catch {
      setTorch(null);
    }
  };

  // 拍照识别：先关掉实时画面，系统相机才能用
  const pickPhoto = () => {
    seqRef.current += 1;
    stopStream();
    setPhase('paused');
    setPhotoMsg('');
    const inp = fileRef.current;
    if (!inp) return;
    inp.value = '';
    inp.click();
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhase('photo');
    setPhotoMsg('');
    let accepted = false;
    try {
      const { detector } = await getDetector();
      const codes = await decodePhoto(detector, file);
      if (!aliveRef.current) return;
      if (!codes.length) setPhotoMsg('none');
      else accepted = handleRef.current(codes);
    } catch {
      if (!aliveRef.current) return;
      setPhotoMsg('bad');
    }
    if (!accepted && aliveRef.current) setPhase('paused');
  };

  const hint =
    phase === 'starting'
      ? t('stock.cam.starting')
      : phase === 'error'
        ? `${camErr} · ${t('stock.cam.tryPhoto')}`
        : phase === 'live'
          ? detErr
            ? t('stock.cam.detectErr', { msg: detErr })
            : t('stock.cam.hint')
          : '';
  const status = phase === 'live' && engine && res?.w ? `${engine === 'native' ? t('stock.cam.native') : 'zxing'} · ${res.w}×${res.h}` : '';

  return (
    <div className="st-cam" role="dialog" aria-modal="true" aria-label={t('stock.cam.title')}>
      <video ref={video} playsInline muted autoPlay />
      {phase === 'live' && <div className="st-cam-frame" aria-hidden="true" />}
      <div className="st-cam-top">
        <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
          <IconX size={18} />
        </button>
        <div className="grow" />
        {phase === 'live' && lenses.length > 1 && (
          <button className="st-cam-chip" onClick={switchLens}>
            {t('stock.cam.lens')}
          </button>
        )}
        {phase === 'live' && zoom && (
          <button className="st-cam-chip" onClick={() => void cycleZoom()} aria-label={t('stock.cam.zoom')}>
            {zoom.levels[zoom.i]}×
          </button>
        )}
        {phase === 'live' && torch && (
          <button className={`st-cam-chip ${torch.on ? 'on' : ''}`} onClick={() => void toggleTorch()}>
            {t('stock.cam.torch')}
          </button>
        )}
      </div>
      {(phase === 'paused' || phase === 'photo') && (
        <div className="st-cam-paused">
          {phase === 'photo' ? (
            <div className="st-cam-msg">{t('stock.cam.photoBusy')}</div>
          ) : (
            <>
              {photoMsg && <div className="st-cam-msg">{t(photoMsg === 'none' ? 'stock.cam.photoNone' : 'stock.cam.photoBad')}</div>}
              <button className="st-cam-btn" onClick={pickPhoto}>
                <IconCamera size={18} />
                {t('stock.cam.photoAgain')}
              </button>
              <button className="st-cam-btn ghost" onClick={() => void startCam(lensId || readLens())}>
                {t('stock.cam.resume')}
              </button>
            </>
          )}
        </div>
      )}
      <div className="st-cam-bottom">
        {miss && (
          <div className="st-cam-miss" role="status">
            {t('stock.cam.miss', { code: miss })}
          </div>
        )}
        {hint && <div className="st-cam-hint">{hint}</div>}
        {(phase === 'live' || phase === 'error' || phase === 'starting') && (
          <button className="st-cam-btn" onClick={pickPhoto}>
            <IconCamera size={18} />
            {t('stock.cam.photo')}
          </button>
        )}
        {status && <div className="st-cam-status">{status}</div>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e)} />
    </div>
  );
}
