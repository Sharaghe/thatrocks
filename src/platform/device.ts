import type { QualityTier } from '../config';

export interface DeviceInfo {
  isIOS: boolean;
  isIPad: boolean;
  isIPhone: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  isTouch: boolean;
  /** Running as an installed home-screen web app. */
  standalone: boolean;
  dpr: number;
  prefersReducedMotion: boolean;
  cores: number;
  memoryGB: number | null;
}

export function detectDevice(): DeviceInfo {
  const ua = navigator.userAgent;
  const touchPoints = navigator.maxTouchPoints ?? 0;
  // iPadOS 13+ reports a desktop Mac user agent; touch support gives it away.
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const isIOS = isIPad || isIPhone;
  const isAndroid = /Android/.test(ua);
  const isTouch = touchPoints > 0 || 'ontouchstart' in window;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    isIOS,
    isIPad,
    isIPhone,
    isAndroid,
    isMobile: isIOS || isAndroid || /Mobi/.test(ua),
    isTouch,
    standalone: Boolean(standalone),
    dpr: window.devicePixelRatio || 1,
    prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    cores: navigator.hardwareConcurrency || 4,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  };
}

/** Initial quality guess; the adaptive controller refines resolution at runtime. */
export function pickQualityTier(info: DeviceInfo, override?: string | null): QualityTier {
  if (override === 'low' || override === 'medium' || override === 'high') return override;
  // iPads (A12+/M-series) handle the full scene comfortably at DPR 2.
  if (info.isIPad) return 'high';
  // iPhones: full scene, but texture/terrain detail one notch lower.
  if (info.isIPhone) return 'medium';
  if (info.isAndroid || info.isMobile) {
    if ((info.memoryGB ?? 4) <= 3 || info.cores <= 4) return 'low';
    return 'medium';
  }
  return 'high';
}
