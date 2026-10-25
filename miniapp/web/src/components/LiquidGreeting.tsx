import { useEffect, useRef, useState } from 'react';
import './LiquidGreeting.css';
import { LIQUID_VERTEX, LIQUID_FRAGMENT, LIQUID_RESPONSE, LIQUID_CLICK_SEED, LIQUID_PALETTE_STATES } from './liquidField';

/** Reference-matched flow, with local lifecycle and readable text fallbacks. */
export function LiquidGreeting({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [generation, setGeneration] = useState(0);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = canvas.parentElement!;
    delete wrap.dataset.ready;
    let gl: WebGLRenderingContext | null = null;
    try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); }
    catch { return; }
    if (!gl || typeof gl.createShader !== 'function' || !gl.getParameter(gl.VERSION)) return;
    const gpu = gl;
    let disposed = false, lost = false, raf = 0, last = 0, visible = true, frames = 0;
    let clock = performance.now(), paletteIndex = 0;
    const current = { mouse: [.5, .5], seed: 0, colors: [] as number[][] };
    const target = { mouse: [.5, .5], seed: 0, colors: [] as number[][] };
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
    const remove: Array<() => void> = [];
    const fallback = () => { delete wrap.dataset.ready; cancelAnimationFrame(raf); if (!disposed) setAvailable(false); };
    const cleanup = () => {
      disposed = true;
      fallback();
      remove.forEach(fn => fn());
      if (texture) gpu.deleteTexture(texture);
      if (buffer) gpu.deleteBuffer(buffer);
      if (program) gpu.deleteProgram(program);
      shaders.forEach(shader => gpu.deleteShader(shader));
    };
    const onLost = (event: Event) => { event.preventDefault(); lost = true; fallback(); };
    const onRestored = () => { if (!disposed) setGeneration(value => value + 1); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    remove.push(() => { canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored); });
    try {
      const compile = (type: number, source: string) => {
        const shader = gpu.createShader(type);
        if (!shader) throw new Error('Shader unavailable');
        shaders.push(shader); gpu.shaderSource(shader, source); gpu.compileShader(shader);
        if (!gpu.getShaderParameter(shader, gpu.COMPILE_STATUS)) throw new Error('Shader unavailable');
        return shader;
      };
      const vertex = compile(gpu.VERTEX_SHADER, LIQUID_VERTEX);
      const fragment = compile(gpu.FRAGMENT_SHADER, LIQUID_FRAGMENT);
      program = gpu.createProgram();
      if (!program) throw new Error('Program unavailable');
      gpu.attachShader(program, vertex); gpu.attachShader(program, fragment); gpu.linkProgram(program);
      if (!gpu.getProgramParameter(program, gpu.LINK_STATUS)) throw new Error('Program unavailable');
      gpu.useProgram(program);
      buffer = gpu.createBuffer(); gpu.bindBuffer(gpu.ARRAY_BUFFER, buffer);
      gpu.bufferData(gpu.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gpu.STATIC_DRAW);
      const at = gpu.getAttribLocation(program, 'p'); gpu.enableVertexAttribArray(at); gpu.vertexAttribPointer(at, 2, gpu.FLOAT, false, 0, 0);
      texture = gpu.createTexture(); gpu.bindTexture(gpu.TEXTURE_2D, texture);
      gpu.texParameteri(gpu.TEXTURE_2D, gpu.TEXTURE_WRAP_S, gpu.CLAMP_TO_EDGE); gpu.texParameteri(gpu.TEXTURE_2D, gpu.TEXTURE_WRAP_T, gpu.CLAMP_TO_EDGE);
      gpu.texParameteri(gpu.TEXTURE_2D, gpu.TEXTURE_MIN_FILTER, gpu.LINEAR); gpu.texParameteri(gpu.TEXTURE_2D, gpu.TEXTURE_MAG_FILTER, gpu.LINEAR);
      const loc = (name: string) => gpu.getUniformLocation(program!, name);
      const uniforms = { time: loc('u_time'), resolution: loc('u_res'), mouse: loc('u_mouse'), seed: loc('u_seed'), crease: loc('u_crease'), zoom: loc('u_zoom'), speed: loc('u_speed'), mask: loc('u_mask'), useMask: loc('u_useMask'), colors: [loc('u_c0'),loc('u_c1'),loc('u_c2')] };
      const reduced=matchMedia('(prefers-reduced-motion: reduce)'), still=new URLSearchParams(location.search).has('still');
      const render = () => {
        gpu.uniform1f(uniforms.time, still ? 2.4 : clock / 1000);
        gpu.uniform1f(uniforms.seed,current.seed);
        gpu.uniform2f(uniforms.mouse,current.mouse[0],current.mouse[1]);
        gpu.uniform1f(uniforms.speed,reduced.matches ? 0 : 1);
        current.colors.forEach((color,index)=>gpu.uniform3fv(uniforms.colors[index],color));
        gpu.drawArrays(gpu.TRIANGLES,0,3);
      };
      const hex = (value: string) => { const s = value.trim().replace('#', ''); return [0,2,4].map(i => parseInt(s.slice(i,i+2),16)/255); };
      const mask = document.createElement('canvas');
      const paint = () => {
        if (disposed || lost) return;
        const style = getComputedStyle(wrap), dpr = Math.min(devicePixelRatio, 2), r = wrap.getBoundingClientRect();
        if (!r.width || !r.height) return;
        canvas.width = Math.round(r.width*dpr); canvas.height = Math.round(r.height*dpr); gpu.viewport(0,0,canvas.width,canvas.height);
        mask.width = canvas.width; mask.height = canvas.height;
        const ctx = mask.getContext('2d'); if (!ctx) throw new Error('Text raster unavailable');
        ctx.scale(dpr,dpr); ctx.textAlign='center'; ctx.textBaseline='alphabetic'; ctx.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily; ctx.letterSpacing=style.letterSpacing;
        const fontSize=parseFloat(style.fontSize), lineHeight=parseFloat(style.lineHeight), lines: string[]=[];
        for (const paragraph of text.split('\n')) {
          let line='';
          for (const word of paragraph.split(' ')) {
            if (line && ctx.measureText(line+' '+word).width > r.width+.5) { lines.push(line); line=''; }
            for (const char of (line ? ' ' : '')+word) {
              if (line && ctx.measureText(line+char).width > r.width+.5) { lines.push(line); line=''; }
              line+=char;
            }
          }
          lines.push(line);
        }
        const metrics=ctx.measureText('Hg');
        const ascent=metrics.fontBoundingBoxAscent ?? fontSize*.8;
        const descent=metrics.fontBoundingBoxDescent ?? fontSize*.2;
        const baseline=(lineHeight-ascent-descent)/2+ascent;
        ctx.fillStyle='#000';
        lines.forEach((line,i)=>ctx.fillText(line,r.width/2,i*lineHeight+baseline));
        gpu.texImage2D(gpu.TEXTURE_2D,0,gpu.RGBA,gpu.RGBA,gpu.UNSIGNED_BYTE,mask);
        target.colors=(['lo','mid','hi'] as const).map(name=>hex(style.getPropertyValue('--liquid-'+name)));
        if(!current.colors.length) current.colors=target.colors.map(color=>[...color]);
        gpu.uniform2f(uniforms.resolution,canvas.width,canvas.height);
        gpu.uniform2f(uniforms.zoom,1,1);
        gpu.uniform1f(uniforms.crease,1);
        gpu.uniform1i(uniforms.mask,0); gpu.uniform1f(uniforms.useMask,1);
        render(); wrap.dataset.ready='true'; setAvailable(true);
      };
      const tick=(now:number) => {
        if(disposed||lost) return;
        if(!visible||document.hidden){last=0;return;}
        const delta=last?Math.min(now-last,250):0;last=now;
        const calm=reduced.matches||still;
        if(!calm)clock+=delta;
        const response=calm?1:LIQUID_RESPONSE;
        current.seed+=(target.seed-current.seed)*response;
        for(let axis=0;axis<2;axis++)current.mouse[axis]+=(target.mouse[axis]-current.mouse[axis])*response;
        current.colors.forEach((color,i)=>color.forEach((value,channel)=>{color[channel]=value+(target.colors[i][channel]-value)*response;}));
        render();wrap.dataset.frames=String(++frames);
        if(!calm)raf=requestAnimationFrame(tick);
      };
      const restart=() => { cancelAnimationFrame(raf); last=0; tick(performance.now()); };
      const repaint=() => { try { paint(); restart(); } catch { lost=true; fallback(); } };
      const ro=new ResizeObserver(repaint); ro.observe(wrap); remove.push(() => ro.disconnect());
      const io=new IntersectionObserver(entries => { visible=entries[0].isIntersecting; restart(); }); io.observe(wrap); remove.push(() => io.disconnect());
      const mo=new MutationObserver(repaint); mo.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-fit']}); remove.push(() => mo.disconnect());
      document.addEventListener('visibilitychange',restart); reduced.addEventListener('change',restart);
      remove.push(() => { document.removeEventListener('visibilitychange',restart); reduced.removeEventListener('change',restart); });
      const move=(event:PointerEvent)=>{if(lost)return;const r=wrap.getBoundingClientRect();target.mouse=[(event.clientX-r.left)/r.width,1-(event.clientY-r.top)/r.height];if(reduced.matches||still)restart();};
      const leave=()=>{target.mouse=[.5,.5];if(reduced.matches||still)restart();};
      const reshape=()=>{if(lost)return;paletteIndex=(paletteIndex+1)%LIQUID_PALETTE_STATES;target.seed=paletteIndex*LIQUID_CLICK_SEED;if(reduced.matches||still)restart();};
      const key=(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();reshape();}};
      wrap.addEventListener('pointermove',move);wrap.addEventListener('pointerleave',leave);wrap.addEventListener('click',reshape);wrap.addEventListener('keydown',key);
      remove.push(()=>{wrap.removeEventListener('pointermove',move);wrap.removeEventListener('pointerleave',leave);wrap.removeEventListener('click',reshape);wrap.removeEventListener('keydown',key);});
      paint(); restart();
      void document.fonts?.ready.then(() => { if (!disposed) repaint(); });
      return cleanup;
    } catch { fallback(); cleanup(); }
  }, [text, generation]);
  return <span className="liquid-greeting" role={available ? 'button' : undefined} tabIndex={available ? 0 : undefined} aria-description={available ? 'Activate to reshape the liquid greeting.' : undefined}><span className="liquid-greeting-a11y">{text.replaceAll('\n',' ')}</span><span className="liquid-greeting-label" aria-hidden="true">{text.split('\n').map((line,i)=><span key={i}>{line}</span>)}</span><canvas ref={canvasRef} aria-hidden="true" /></span>;
}
