import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconX } from '../Icons';

// 手机摄像头扫码：安卓 Chrome 有原生 BarcodeDetector 就用它；iPhone / 其他浏览器用 zxing-wasm 做的同名接口
// （wasm 文件跟着应用一起部署，不走外部 CDN）。只在用到时才加载。
type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
const FORMATS = ['code_128', 'code_39', 'code_93', 'qr_code', 'data_matrix', 'ean_13', 'ean_8', 'itf', 'upc_a'];

let detectorPromise: Promise<Detector> | null = null;

async function makeDetector(): Promise<Detector> {
  type NativeCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
  const Native = (globalThis as { BarcodeDetector?: NativeCtor }).BarcodeDetector;
  if (Native) {
    try {
      const sup = await Native.getSupportedFormats();
      if (sup.includes('code_128')) return new Native({ formats: FORMATS.filter((f) => sup.includes(f)) });
    } catch {
      /* 原生的不好用就换 wasm 的 */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
  });
  return new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
}

/** 能不能用摄像头扫（要 https 和 getUserMedia；桌面版不给这个入口） */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && window.isSecureContext;
}

/**
 * 全屏的扫码框：对准库位条码，认出来就震一下、关掉、把码交出去。
 * 暗的通道里可以开手电（安卓 Chrome 支持 torch 的才显示按钮）。
 */
export function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(true);
  const [torch, setTorch] = useState<{ on: boolean; track: MediaStreamTrack } | null>(null);
  const done = useRef(false);
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let timer = 0;
    (async () => {
      try {
        detectorPromise ??= makeDetector();
        const [detector, s] = await Promise.all([
          detectorPromise,
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          }),
        ]);
        stream = s;
        if (stop) return;
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setStarting(false);
        const track = s.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        if (track && caps.torch) setTorch({ on: false, track });
        const tick = async () => {
          if (stop || done.current) return;
          try {
            if (v.readyState >= 2 && v.videoWidth) {
              const found = await detector.detect(v);
              const code = found.find((b) => b.rawValue?.trim())?.rawValue.trim();
              if (code && !done.current) {
                done.current = true;
                navigator.vibrate?.(60);
                cb.current(code);
                return;
              }
            }
          } catch {
            /* 这一帧没认出来 */
          }
          timer = window.setTimeout(() => void tick(), 120);
        };
        void tick();
      } catch (e) {
        detectorPromise = null;
        const name = (e as { name?: string })?.name ?? '';
        setErr(name === 'NotAllowedError' || name === 'SecurityError' ? t('stock.cam.denied') : name === 'NotFoundError' ? t('stock.cam.none') : t('stock.cam.failed'));
        setStarting(false);
      }
    })();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleTorch = async () => {
    if (!torch) return;
    try {
      await torch.track.applyConstraints({ advanced: [{ torch: !torch.on } as MediaTrackConstraintSet] });
      setTorch({ ...torch, on: !torch.on });
    } catch {
      setTorch(null);
    }
  };

  return (
    <div className="st-cam" role="dialog" aria-modal="true" aria-label={t('stock.cam.title')}>
      <video ref={video} playsInline muted autoPlay />
      <div className="st-cam-frame" aria-hidden="true" />
      <div className="st-cam-top">
        <button className="close-round" aria-label={t('actions.close')} onClick={onClose}>
          <IconX size={18} />
        </button>
        <div className="grow" />
        {torch && (
          <button className={`chip ${torch.on ? 'active' : ''}`} onClick={() => void toggleTorch()}>
            {t('stock.cam.torch')}
          </button>
        )}
      </div>
      <div className="st-cam-hint">{err || (starting ? t('stock.cam.starting') : t('stock.cam.hint'))}</div>
    </div>
  );
}
