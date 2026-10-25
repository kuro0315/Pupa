/** Short-lived decorative effects. Never passes clipboard content to the GPU. */
export type EffectsMode = 'auto' | 'light' | 'off';
export type EffectKind = 'reveal' | 'hover' | 'page' | 'copy';
export interface EffectPose { x: number; y: number; width: number; height: number; angle: number }
export interface EffectRequest { kind: EffectKind; poses: EffectPose[]; started: number; direction?: number }
export interface EffectBackend {
  emit(request: EffectRequest): void;
  stop(): void;
  dispose(): void;
}

export function createEffects(host: HTMLElement) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let mode: EffectsMode = 'auto';
  let visible = !document.hidden;
  let backend: EffectBackend | null = null;
  let loading: Promise<void> | null = null;
  let pending: EffectRequest | null = null;
  let unavailable = false;
  let disposed = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const eligible = () => !disposed && visible && !document.hidden && mode === 'auto' && !reduced.matches && !unavailable;
  const annotate = () => {
    host.dataset.effectsMode = reduced.matches ? 'off' : unavailable && mode === 'auto' ? 'light' : mode;
    host.dataset.effectsBackend = backend ? 'three' : unavailable ? 'fallback' : 'css';
  };
  const release = () => { backend?.dispose(); backend = null; annotate(); };
  const stop = () => { pending = null; backend?.stop(); };
  const disableGPU = () => { unavailable = true; release(); };
  const load = () => {
    if (loading || !eligible()) return;
    loading = import('./effects-three').then(({createThreeEffects}) => {
      if (!eligible()) return;
      try { backend = createThreeEffects(host, disableGPU); }
      catch { unavailable = true; }
      annotate();
      const request = pending; pending = null;
      if (request && performance.now() - request.started < 300) backend?.emit(request);
    }).catch(() => { unavailable = true; annotate(); }).finally(() => { loading = null; });
  };
  const setVisible = (value: boolean) => {
    visible = value;
    clearTimeout(releaseTimer);
    if (!value) { stop(); releaseTimer = setTimeout(release, 5000); }
  };
  const onVisibility = () => setVisible(!document.hidden);
  const onBlur = () => setVisible(false);
  const onFocus = () => setVisible(!host.classList.contains('is-tucked') && !host.classList.contains('is-copy-dismissed'));
  const onReduced = () => { stop(); if (reduced.matches) release(); annotate(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  reduced.addEventListener('change', onReduced);
  annotate();
  return {
    setMode(value: EffectsMode) {
      if (mode === value) return;
      mode = value; stop();
      if (mode !== 'auto') release();
      annotate();
    },
    setVisible,
    emit(kind: EffectKind, poses: EffectPose[], direction?: number) {
      if (!eligible() || !poses.length) return;
      const request = {kind, poses: poses.slice(0, 10), direction, started: performance.now()};
      if (backend) backend.emit(request);
      else { pending = request; load(); }
    },
    stop,
    dispose() {
      disposed = true; clearTimeout(releaseTimer); stop(); release();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus);
      reduced.removeEventListener('change', onReduced);
    },
  };
}
