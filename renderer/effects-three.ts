import {AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, LineBasicMaterial,
  LineSegments, OrthographicCamera, Points, Scene, ShaderMaterial, WebGLRenderer} from 'three';
import type {EffectBackend, EffectPose, EffectRequest} from './effects';

// Fixed budgets: 128 particles, 32 short traces, two draw calls, no textures,
// shadows, render targets, full-screen postprocessing or perpetual render loop.
const PARTICLES = 128, TRACES = 32;
export function createThreeEffects(host: HTMLElement, onSlow: () => void): EffectBackend {
  const renderer = new WebGLRenderer({alpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power', failIfMajorPerformanceCaveat: true});
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'pupa-effects-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 1, 0, 1, -100, 100);
  const positions = new Float32Array(PARTICLES * 3), alphas = new Float32Array(PARTICLES), sizes = new Float32Array(PARTICLES);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('alpha', new BufferAttribute(alphas, 1).setUsage(DynamicDrawUsage));
  geometry.setAttribute('size', new BufferAttribute(sizes, 1).setUsage(DynamicDrawUsage));
  const material = new ShaderMaterial({transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending,
    uniforms: {pixelRatio: {value: 1}},
    vertexShader: `attribute float alpha; attribute float size; uniform float pixelRatio; varying float vAlpha; varying float vTint;
      void main(){vAlpha=alpha;vTint=step(7.0,size);gl_PointSize=size*pixelRatio;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying float vAlpha; varying float vTint;
      void main(){float d=length(gl_PointCoord-0.5)*2.0;
      float halo=exp(-d*d*5.0)*0.22;float core=1.0-smoothstep(0.06,0.3,d);
      vec3 color=mix(vec3(0.24,0.91,1.0),vec3(0.8,1.0,0.37),vTint);
      float a=(halo+core*0.78)*vAlpha;if(a<0.004)discard;gl_FragColor=vec4(color,a);}`});
  const points = new Points(geometry, material); points.frustumCulled = false; scene.add(points);
  const tracePositions = new Float32Array(TRACES * 6);
  const traceGeometry = new BufferGeometry();
  traceGeometry.setAttribute('position', new BufferAttribute(tracePositions, 3).setUsage(DynamicDrawUsage));
  const traceMaterial = new LineBasicMaterial({color: 0x84f7ff, transparent: true, opacity: .5, depthTest: false, blending: AdditiveBlending});
  const traces = new LineSegments(traceGeometry, traceMaterial); traces.frustumCulled = false; scene.add(traces);
  let request: EffectRequest | null = null, frame = 0, lastDraw = 0, width = 0, height = 0;
  let draws = 0, slowFrames = 0, disposed = false, renderCost = 0;
  host.dataset.effectsFrames = '0'; host.dataset.effectsActive = 'false';
  const resize = () => {
    const w = Math.round(host.clientWidth), h = Math.round(host.clientHeight);
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25, Math.sqrt(720000 / Math.max(1, w * h))));
    material.uniforms.pixelRatio.value = renderer.getPixelRatio();
    renderer.setSize(w, h, false);
    host.dataset.effectsPixels = String(renderer.domElement.width * renderer.domElement.height);
    camera.right = w; camera.bottom = h; camera.updateProjectionMatrix();
  };
  const perimeter = (pose: EffectPose, phase: number) => {
    const p = ((phase % 1) + 1) % 1 * 4;
    let x: number, y: number;
    if (p < 1) { x = (p - .5) * pose.width; y = -pose.height / 2; }
    else if (p < 2) { x = pose.width / 2; y = (p - 1.5) * pose.height; }
    else if (p < 3) { x = (2.5 - p) * pose.width; y = pose.height / 2; }
    else { x = -pose.width / 2; y = (3.5 - p) * pose.height; }
    const a = pose.angle * Math.PI / 180;
    return {x: pose.x + x * Math.cos(a) - y * Math.sin(a), y: pose.y + x * Math.sin(a) + y * Math.cos(a)};
  };
  const stop = () => {
    cancelAnimationFrame(frame); frame = 0; request = null;
    if (!disposed) renderer.clear();
    host.dataset.effectsActive = 'false';
  };
  const draw = (now: number) => {
    frame = 0;
    if (!request || disposed || document.hidden) { stop(); return; }
    const duration = request.kind === 'reveal' ? 620 : request.kind === 'copy' ? 420 : 300;
    const t = Math.min(1, (now - request.started) / duration);
    if (t >= 1) { stop(); return; }
    if (now - lastDraw < 32) { frame = requestAnimationFrame(draw); return; }
    const interval = lastDraw ? now - lastDraw : 0;
    lastDraw = now;
    resize();
    const start = performance.now();
    const fade = Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t * .4);
    for (let i = 0; i < PARTICLES; i++) {
      const pose = request.poses[i % request.poses.length];
      const seed = (i * .61803398875) % 1;
      const edge = perimeter(pose, seed + t * (request.kind === 'copy' ? 1.2 : .16));
      let x = edge.x, y = edge.y;
      if (request.kind === 'copy') {
        const power = Math.max(0, t - .25);
        x += power * power * (160 + seed * 280);
        y += Math.sin(i * 7.3) * power * (35 + seed * 70);
      } else if (request.kind === 'reveal') {
        const enter = (1 - t) ** 3;
        x += (width - edge.x + 25) * enter;
        y += (height / 2 - edge.y) * enter;
      } else if (request.kind === 'page') {
        y += (request.direction || 1) * (1 - t) * 28;
      }
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = seed * 8;
      alphas[i] = fade * (request.kind === 'copy' ? .85 : .35) * (.3 + seed * .7);
      sizes[i] = 3 + seed * (request.kind === 'copy' ? 12 : 7);
      if (i < TRACES) {
        const at = i * 6;
        tracePositions[at] = x; tracePositions[at + 1] = y;
        tracePositions[at + 3] = x - (request.kind === 'copy' ? 8 + t * 24 : 3);
        tracePositions[at + 4] = y + Math.sin(i * 7.3) * (request.kind === 'copy' ? 6 : 2);
      }
    }
    for (const attribute of Object.values(geometry.attributes)) attribute.needsUpdate = true;
    traceGeometry.attributes.position.needsUpdate = true;
    traceMaterial.opacity = fade * (request.kind === 'copy' ? .65 : .15);
    renderer.render(scene, camera);
    const cost = performance.now() - start;
    if (draws >= 2) renderCost += cost;
    host.dataset.effectsFrames = String(++draws);
    host.dataset.effectsDrawCalls = String(renderer.info.render.calls);
    host.dataset.effectsTextures = String(renderer.info.memory.textures);
    host.dataset.effectsGeometries = String(renderer.info.memory.geometries);
    if (draws > 3 && (renderCost / (draws - 2) > 12 || interval > 90)) slowFrames++; else slowFrames = 0;
    if (slowFrames >= 4) { stop(); onSlow(); return; }
    frame = requestAnimationFrame(draw);
  };
  const lost = (event: Event) => { event.preventDefault(); stop(); onSlow(); };
  renderer.domElement.addEventListener('webglcontextlost', lost);
  return {
    emit(value) {
      if (disposed) return;
      // Shader compilation must never delay the first clipboard confirmation.
      // Until another interaction has warmed the GPU, keep its SVG feedback.
      if (value.kind === 'copy' && draws === 0) { stop(); return; }
      if (!frame) lastDraw = 0;
      request = value; host.dataset.effectsActive = 'true';
      if (!frame) frame = requestAnimationFrame(draw);
    },
    stop,
    dispose() {
      if (disposed) return;
      stop(); disposed = true;
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      geometry.dispose(); material.dispose(); traceGeometry.dispose(); traceMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
