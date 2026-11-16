(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var smooth = function (a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  var NP = window.NFPlayer || { sound: function () {}, tune: function () {}, nowText: function () { return ''; }, setVolume: function () {}, station: function () {}, lastStation: function () { return -1; }, volume: function () { return 0.6; } };
  var FMIN = 88, FMAX = 108, TH = 135;
  var S = [
    { f: 89.3, name: 'Last Tram Home', warp: 0.9, shift: 0.0, scale: 1.5 },
    { f: 93.1, name: 'Kitchen Light', warp: 0.7, shift: 3.7, scale: 1.9 },
    { f: 97.5, name: 'The Long Quiet', warp: 0.5, shift: 7.1, scale: 1.2 },
    { f: 101.2, name: 'Request Hour', warp: 1.1, shift: 11.3, scale: 1.7 },
    { f: 105.8, name: 'First Bus', warp: 0.8, shift: 15.9, scale: 1.4 }
  ];

  /* ---------- colours from the CSS tokens ---------- */
  var cx = doc.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function rgb(css) {
    cx.canvas.width = cx.canvas.height = 1;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
  var cs = getComputedStyle(root);
  S.forEach(function (st, i) {
    st.pal = [0, 1, 2, 3].map(function (k) { return rgb(cs.getPropertyValue('--st' + (i + 1) + '-' + k).trim()); });
  });
  var TINT = rgb(cs.getPropertyValue('--color-static').trim());
  var to255 = function (c) { return c.map(function (v) { return Math.round(clamp(v, 0, 1) * 255); }); };
  var css = function (c, a) { var q = to255(c); return a === undefined ? 'rgb(' + q.join(',') + ')' : 'rgba(' + q.join(',') + ',' + a + ')'; };
  var hex = function (c) { return '#' + to255(c).map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''); };
  var unhex = function (h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); };

  /* ---------- baked grain tile and swatches (made once) ---------- */
  function bakeGrain(w, h) {
    var c = doc.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), im = x.createImageData(w, h), d = im.data;
    for (var i = 0; i < w * h; i++) {
      var v = Math.random(), j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = v > 0.5 ? 255 : 0;
      d[j + 3] = Math.round(Math.abs(v - 0.5) * 2 * 200);
    }
    x.putImageData(im, 0, 0);
    return c;
  }
  function blob(x, cxp, cyp, rx, ry, c) {
    x.save(); x.translate(cxp, cyp); x.scale(rx, ry);
    var g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, css(c, 1)); g.addColorStop(1, css(c, 0));
    x.fillStyle = g; x.fillRect(-1, -1, 2, 2); x.restore();
  }
  function paint(x, w, h, pal) {
    x.fillStyle = css(pal[0]); x.fillRect(0, 0, w, h);
    blob(x, 0, h, 0.56 * w * 1.2, 0.56 * h * 1.2, pal[1]);
    blob(x, w, h, 0.58 * w * 1.2, 0.64 * h * 1.2, pal[2]);
    blob(x, 0.15 * w, 0, 0.74 * w * 1.2, 0.56 * h * 1.2, pal[3]);
  }
  var tile = bakeGrain(160, 160);
  try {
    root.style.setProperty('--grain-img', 'url(' + tile.toDataURL('image/png') + ')');
    S.forEach(function (s, i) {
      var c = doc.createElement('canvas'); c.width = c.height = 240;
      var x = c.getContext('2d'); paint(x, 240, 240, s.pal);
      x.globalAlpha = 0.9; x.fillStyle = x.createPattern(tile, 'repeat'); x.fillRect(0, 0, 240, 240);
      root.style.setProperty('--sw' + (i + 1), 'url(' + c.toDataURL('image/jpeg', 0.82) + ')');
    });
    root.classList.add('baked');
  } catch (e) { /* the CSS gradients stay as they are */ }

  /* ---------- state ---------- */
  var st = {
    f: NP.lastStation() >= 0 ? S[NP.lastStation()].f : 101.2, tween: null, dragging: false, vel: 0, lastT: 0,
    grain: 0.6, warp: 0.5, frozen: false, time: 0, dirty: true, idx: 3, lock: 1, custom: null, dim: 1, pend: false, calm: null
  };
  var el = {
    field: $('[data-field]'), gl: $('[data-gl]'), grain: $('[data-grain]'), dial: $('[data-dial]'), knob: $('[data-knob]'),
    needleSvg: $('[data-needle-svg]'), read: $('[data-read]'), chip: $('[data-chip]'), live: $('[data-live]'),
    needle: $('[data-needle]'), tuner: $('[data-tuner]')
  };
  var stns = $$('.stn'), marks = $$('.tuner__mark');
  var mirrors = $$('[data-mirror]').map(function (c) { c.width = 192; c.height = 144; return { c: c, x: c.getContext('2d'), wrap: c.parentNode, vis: false }; });
  var stopIn = $$('[data-stop]');

  function f2t(f) { return (f - FMIN) / (FMAX - FMIN) * (2 * TH) - TH; }
  function t2f(t) { return FMIN + (t + TH) / (2 * TH) * (FMAX - FMIN); }

  /* look for a given frequency: palette, shader params and static amount */
  function look(f) {
    var i = 0;
    while (i < S.length - 1 && f >= S[i + 1].f) i++;
    var j = Math.min(i + 1, S.length - 1);
    var k = f < S[0].f || j === i ? 0 : (f - S[i].f) / (S[j].f - S[i].f);
    var m = smooth(0.3, 0.7, k);
    var c = st.custom || [0, 1, 2, 3].map(function (n) {
      return [0, 1, 2].map(function (q) { return lerp(S[i].pal[n][q], S[j].pal[n][q], m); });
    });
    var d = 99, near = 0;
    S.forEach(function (s, n) { var dd = Math.abs(f - s.f); if (dd < d) { d = dd; near = n; } });
    var lock = 1 - smooth(0.15, 1.0, d);
    return {
      c: c, warp: lerp(S[i].warp, S[j].warp, m), shift: lerp(S[i].shift, S[j].shift, k),
      scale: lerp(S[i].scale, S[j].scale, m), lock: lock, stat: (1 - lock) * 0.92, near: near
    };
  }

  /* ---------- dial UI ---------- */
  var ticks = $('[data-ticks]');
  if (ticks) {
    var out = '';
    for (var m = 88; m <= 108; m++) {
      var a = f2t(m) * Math.PI / 180, major = m % 4 === 0;
      var r1 = major ? 168 : 176, r2 = 188;
      out += '<line class="' + (major ? 'maj' : '') + '" x1="' + (200 + r1 * Math.sin(a)).toFixed(1) + '" y1="' + (200 - r1 * Math.cos(a)).toFixed(1) + '" x2="' + (200 + r2 * Math.sin(a)).toFixed(1) + '" y2="' + (200 - r2 * Math.cos(a)).toFixed(1) + '"/>';
      if (major) out += '<text text-anchor="middle" dominant-baseline="middle" x="' + (200 + 148 * Math.sin(a)).toFixed(1) + '" y="' + (200 - 148 * Math.cos(a)).toFixed(1) + '">' + m + '</text>';
    }
    S.forEach(function (s) {
      var a2 = f2t(s.f) * Math.PI / 180;
      out += '<circle class="st" r="4.5" cx="' + (200 + 196 * Math.sin(a2)).toFixed(1) + '" cy="' + (200 - 196 * Math.cos(a2)).toFixed(1) + '"/>';
    });
    ticks.innerHTML = out;
  }

  var liveTimer = 0, slowTimer = 0, lastKey = -2, tw = 0;
  function setGrainO() {
    var s = clamp(0.1 + st.grain * 0.75, 0, 1).toFixed(3);
    el.field.style.setProperty('--grain-o', s);
    mirrors.forEach(function (mm) { mm.wrap.style.setProperty('--grain-o', s); });
  }
  /* cheap part, runs at most about 30 times a second while turning: knob, needle, readout */
  function updateFast() {
    var f = st.f, t = f2t(f).toFixed(2);
    el.knob.setAttribute('transform', 'rotate(' + t + ' 200 200)');
    el.needleSvg.setAttribute('transform', 'rotate(' + t + ' 200 200)');
    el.read.textContent = f.toFixed(1);
    el.needle.style.setProperty('--nx', ((f - FMIN) / (FMAX - FMIN) * tw).toFixed(1) + 'px');
    st.dirty = true; kick();
  }
  /* the rest, only when something changed, and no more than about 8 times a second */
  function updateSlow() {
    slowTimer = 0;
    var f = st.f, L = look(f);
    st.lock = L.lock; st.idx = L.near;
    var locked = L.lock > 0.6, key = locked ? L.near : -1;
    el.dial.setAttribute('aria-valuenow', f.toFixed(1));
    if (key !== lastKey) {
      lastKey = key; NP.station(key);
      el.dial.setAttribute('aria-valuetext', f.toFixed(1) + ' megahertz, ' + (locked ? S[L.near].name : 'static'));
      el.chip.textContent = locked ? S[L.near].name : 'Between stations'; el.chip.classList.toggle('is-static', !locked);
      stns.forEach(function (r, i) { if (i === key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
      marks.forEach(function (r, i) { if (i === key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
      clearTimeout(liveTimer);
      liveTimer = setTimeout(function () { el.live.textContent = locked ? 'Tuned to ' + S[L.near].name + ', ' + S[L.near].f.toFixed(1) : 'Between stations, static'; }, 600);
    }
    if (!gl) [0, 1, 2, 3].forEach(function (n) { el.field.style.setProperty('--f' + n, css(L.c[n])); });
    if (!st.custom && !st.tween && !st.dragging) stopIn.forEach(function (inp, n) { inp.value = hex(L.c[n]); });
    audioLevels(L);
  }
  function updateUI() { updateFast(); if (!slowTimer) slowTimer = setTimeout(updateSlow, 120); }
  function updateNow() { clearTimeout(slowTimer); updateFast(); updateSlow(); }

  /* instant = apply everything now (keys, jumps); otherwise the loop applies it at most about 30 times a second */
  function setFreq(f, instant) {
    var n = clamp(f, FMIN, FMAX), now = performance.now();
    if (st.lastT) st.vel = lerp(st.vel, Math.abs(n - st.f) / Math.max(16, now - st.lastT) * 16, 0.4);
    st.lastT = now; st.f = n;
    if (instant || doc.hidden || !watched()) updateNow(); else { st.pend = true; kick(); }
  }
  var userAt = 0;
  function user() { userAt = performance.now(); }
  function tuneTo(f, instant) {
    if (instant || reduced || doc.hidden || !watched()) { st.tween = null; setFreq(f, true); return; }
    var from = st.f, d = Math.abs(f - from);
    if (d < 0.02) return;
    st.tween = { from: from, to: f, t0: performance.now(), dur: clamp(450 + d * 55, 500, 1400) };
    kick();
  }
  /* scroll-triggered retune: a short dip through dark, no tear, no static */
  function calmTo(f) {
    if (reduced || doc.hidden || !watched()) { tuneTo(f, true); return; }
    if (Math.abs(f - st.f) < 0.02) return;
    st.tween = null; st.calm = { t0: performance.now(), f: f, sw: false }; kick();
  }
  function step(dir) {
    var n = -1, i;
    if (dir > 0) { for (i = 0; i < S.length; i++) if (S[i].f > st.f + 0.05) { n = i; break; } if (n < 0) n = 0; }
    else { for (i = S.length - 1; i >= 0; i--) if (S[i].f < st.f - 0.05) { n = i; break; } if (n < 0) n = S.length - 1; }
    tuneTo(S[n].f);
  }

  /* drag */
  function angleOf(e) {
    var r = el.dial.getBoundingClientRect();
    return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
  }
  var lastA = 0;
  el.dial.addEventListener('pointerdown', function (e) {
    user();
    el.dial.setPointerCapture(e.pointerId); st.dragging = true; st.tween = null; lastA = angleOf(e);
    el.dial.focus({ preventScroll: true });
  });
  el.dial.addEventListener('pointermove', function (e) {
    if (!st.dragging) return;
    var a = angleOf(e), d = a - lastA; lastA = a;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    setFreq(t2f(clamp(f2t(st.f) + d, -TH, TH)));
  });
  function release() {
    if (!st.dragging) return; st.dragging = false;
    var L = look(st.f), s = S[L.near];
    if (Math.abs(st.f - s.f) < 0.35) tuneTo(s.f);
  }
  el.dial.addEventListener('pointerup', release);
  el.dial.addEventListener('pointercancel', release);
  el.dial.addEventListener('keydown', function (e) {
    var d = 0, k = e.key, big = e.shiftKey ? 1 : 0.1;
    if (k === 'ArrowRight' || k === 'ArrowUp') d = big;
    else if (k === 'ArrowLeft' || k === 'ArrowDown') d = -big;
    else if (k === 'PageUp') d = 1; else if (k === 'PageDown') d = -1;
    else if (k === 'Home') { e.preventDefault(); st.tween = null; setFreq(FMIN, true); return; }
    else if (k === 'End') { e.preventDefault(); st.tween = null; setFreq(FMAX, true); return; }
    else return;
    e.preventDefault(); user(); st.tween = null; setFreq(Math.round((st.f + d) * 10) / 10, true);
  });

  $$('[data-step]').forEach(function (b) { b.addEventListener('click', function () { user(); step(+b.getAttribute('data-step')); }); });
  $$('[data-tune]').forEach(function (b) { b.addEventListener('click', function () { user(); tuneTo(S[+b.getAttribute('data-tune')].f); }); });

  /* scroll retunes: a station crossing the middle of the screen tunes the dial */
  if ('IntersectionObserver' in window) {
    var cand = -1, candT = 0;
    var fireCand = function () { candT = 0; if (cand >= 0 && !st.dragging && performance.now() - userAt > 1500) calmTo(S[cand].f); };
    var arm = function () { clearTimeout(candT); candT = setTimeout(fireCand, 150); };
    var rowIO = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        var i = +en.target.getAttribute('data-station');
        if (en.isIntersecting) { cand = i; arm(); } else if (cand === i) cand = -1;
      });
    }, { rootMargin: '-46% 0px -46% 0px' });
    stns.forEach(function (r) { rowIO.observe(r); });
    addEventListener('scroll', function () { if (cand >= 0) arm(); }, { passive: true });
  }

  /* ---------- mood picker ---------- */
  function onAirIndex() {
    var off = (nowMins() - 1320 + 1440) % 1440;
    return off < 480 ? Math.min(4, off < 120 ? 0 : Math.floor((off - 120) / 90) + 1) : 0;
  }
  var whys = $$('.mood__why');
  $$('[data-mood] input').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var v = inp.value, idx = v === 'clock' ? onAirIndex() : +v;
      whys.forEach(function (w) { w.classList.toggle('is-on', w.getAttribute('data-for') === v); });
      user(); tuneTo(S[idx].f);
    });
  });

  /* ---------- grain lab ---------- */
  var DEF = { grain: 60, warp: 50 };
  $$('[data-ctl]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var k = inp.getAttribute('data-ctl'); st[k] = inp.value / 100;
      $('[data-out="' + k + '"]').textContent = inp.value; if (k === 'grain') setGrainO(); st.dirty = true; kick();
    });
  });
  stopIn.forEach(function (inp, n) {
    inp.addEventListener('input', function () {
      if (!st.custom) st.custom = look(st.f).c.map(function (c) { return c.slice(); });
      st.custom[n] = unhex(inp.value); updateUI();
    });
  });
  var freezeBtn = $('[data-freeze]');
  freezeBtn.addEventListener('click', function () {
    st.frozen = !st.frozen; freezeBtn.setAttribute('aria-pressed', st.frozen); freezeBtn.textContent = st.frozen ? 'Unfreeze the field' : 'Freeze the field'; kick();
  });
  $('[data-reset]').addEventListener('click', function () {
    st.custom = null;
    $$('[data-ctl]').forEach(function (inp) { var k = inp.getAttribute('data-ctl'); inp.value = DEF[k]; st[k] = DEF[k] / 100; $('[data-out="' + k + '"]').textContent = DEF[k]; });
    setGrainO(); updateNow();
  });
  $('[data-poster]').addEventListener('click', function () {
    var W = 1600, H = 2000, L = look(st.f), c = doc.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    if (gl) {
      el.gl.width = W; el.gl.height = H; gl.viewport(0, 0, W, H);
      paintGL(W, H, L, 0, 0, 1);
      x.drawImage(el.gl, 0, 0);
      resize();
    } else paint(x, W, H, L.c);
    x.save(); x.scale(1.5, 1.5); x.globalAlpha = clamp(0.25 + st.grain * 0.75, 0, 1);
    x.fillStyle = x.createPattern(tile, 'repeat'); x.fillRect(0, 0, W / 1.5, H / 1.5); x.restore();
    x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 16; x.fillStyle = css(rgb(cs.getPropertyValue('--color-cream').trim()));
    x.font = '600 84px "Clash Display", "Arial Narrow", sans-serif'; x.fillText('Nightfall FM ' + st.f.toFixed(1), 96, H - 150);
    x.font = '500 40px Satoshi, sans-serif'; x.fillText(L.lock > 0.6 ? S[L.near].name : 'Between stations', 96, H - 92);
    c.toBlob(function (b) {
      if (!b) return;
      var u = URL.createObjectURL(b), a = doc.createElement('a');
      a.href = u; a.download = 'nightfall-fm-poster.png'; doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 3000);
      $('[data-poster-note]').textContent = 'Saved nightfall-fm-poster.png to your downloads.';
    }, 'image/png');
  });

  /* ---------- WebGL: a quarter-size field, scaled up by CSS ---------- */
  var gl = null, prog, U = {}, vis = { field: true };
  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'uniform vec2 u_res;uniform float u_time,u_warp,u_shift,u_scale,u_static,u_jolt,u_gt,u_dim;',
    'uniform vec3 u_c0,u_c1,u_c2,u_c3,u_tint;',
    'float h(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}',
    'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}',
    'float fb2(vec2 p){return .5*vn(p)+.25*vn(p*2.03+vec2(17.,9.));}',
    'float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<3;i++){s+=a*vn(p);p=p*2.03+vec2(17.,9.);a*=.5;}return s;}',
    'vec3 ramp(float x){x=clamp(x,0.,1.)*3.;vec3 c=mix(u_c0,u_c1,smoothstep(0.,1.,x));c=mix(c,u_c2,smoothstep(1.,2.,x));return mix(c,u_c3,smoothstep(2.,3.,x));}',
    'void main(){',
    ' vec2 fc=gl_FragCoord.xy;vec2 uv=fc/u_res;float asp=u_res.x/u_res.y;',
    ' float tear=(h(vec2(floor(fc.y*.5),floor(u_gt*12.)))-.5)*u_jolt;',
    ' vec2 p=(uv-.5)*vec2(asp,1.)*u_scale*1.8;p.x+=tear*.35;',
    ' float t=u_time*.045;',
    ' vec2 q=vec2(fb2(p+u_shift+vec2(0.,t)),fb2(p+u_shift+vec2(5.2,1.3)-t));',
    ' float f=fbm(p+u_warp*3.4*q+vec2(1.7,9.2)+t);',
    ' float v=clamp((f-.28)*2.3+(uv.y-.5)*.35+(q.x-.5)*.4,0.,1.);',
    ' vec3 col=ramp(v);',
    ' col*=mix(1.,smoothstep(1.25,.25,length(uv-.5)),.35)*u_dim;',
    ' float s=h(fc+floor(u_gt*12.)*7.13);s*=.82+.18*sin(fc.y*1.6);',
    ' col=mix(col,u_tint*s*.9,u_static*(.45+.55*s));',
    ' gl_FragColor=vec4(col,1.);}'
  ].join('\n');

  function initGL() {
    try { gl = el.gl.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }); } catch (e) { gl = null; }
    if (!gl) return false;
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
    var v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) { gl = null; return false; }
    prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; return false; }
    gl.useProgram(prog);
    var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['u_res', 'u_time', 'u_warp', 'u_shift', 'u_scale', 'u_static', 'u_jolt', 'u_gt', 'u_dim', 'u_c0', 'u_c1', 'u_c2', 'u_c3', 'u_tint'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    el.gl.addEventListener('webglcontextlost', function (e) { e.preventDefault(); gl = null; el.field.classList.remove('has-gl'); });
    el.field.classList.add('has-gl');
    return true;
  }

  function resize() {
    tw = el.tuner.clientWidth;
    if (!gl) return;
    var r = el.field.getBoundingClientRect(), k = 1 / 6;
    if (r.width * r.height * k * k > 60000) k = Math.sqrt(60000 / (r.width * r.height));
    el.gl.width = Math.max(2, Math.round(r.width * k)); el.gl.height = Math.max(2, Math.round(r.height * k));
    gl.viewport(0, 0, el.gl.width, el.gl.height);
    st.dirty = true; kick();
  }

  function paintGL(w, h, L, jolt, stat, dim) {
    gl.uniform2f(U.u_res, w, h);
    gl.uniform1f(U.u_time, st.time % 1000); gl.uniform1f(U.u_gt, st.time % 1000);
    gl.uniform1f(U.u_warp, L.warp * (0.25 + st.warp * 1.5));
    gl.uniform1f(U.u_shift, L.shift); gl.uniform1f(U.u_scale, L.scale);
    gl.uniform1f(U.u_static, stat); gl.uniform1f(U.u_jolt, jolt); gl.uniform1f(U.u_dim, dim);
    gl.uniform3fv(U.u_c0, L.c[0]); gl.uniform3fv(U.u_c1, L.c[1]); gl.uniform3fv(U.u_c2, L.c[2]); gl.uniform3fv(U.u_c3, L.c[3]);
    gl.uniform3fv(U.u_tint, TINT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function draw() {
    if (!gl) return;
    var L = look(st.f);
    paintGL(el.gl.width, el.gl.height, L, clamp(st.vel * 1.6, 0, 1) * 0.6 + L.stat * 0.35, L.stat, st.dim);
    mirrors.forEach(function (mm) {
      if (!mm.vis) return;
      var gw = el.gl.width, gh = el.gl.height, ar = mm.c.width / mm.c.height, sw = gw, sh = gw / ar;
      if (sh > gh) { sh = gh; sw = gh * ar; }
      mm.x.drawImage(el.gl, (gw - sw) / 2, (gh - sh) / 2, sw, sh, 0, 0, mm.c.width, mm.c.height);
    });
  }

  /* ---------- loop: ambient at about 24 fps, UI and picture updates at most about 30 a second, grain tile at about 12 fps; stops when nobody sees it ---------- */
  var raf = 0, tm = 0, last = 0, lastDraw = 0, lastGrain = 0, lastTw = 0, lastUI = 0;
  function watched() { return vis.field || mirrors.some(function (mm) { return mm.vis; }); }
  function kick() {
    if (raf || doc.hidden || !watched()) return;
    clearTimeout(tm); tm = 0; raf = requestAnimationFrame(loop);
  }
  function loop(ts) {
    raf = 0;
    if (doc.hidden || !watched()) { last = 0; return; }
    var dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    if (st.tween && ts - lastTw >= 33) {
      lastTw = ts;
      var k = (performance.now() - st.tween.t0) / st.tween.dur, e = k < 1 ? (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2) : 1;
      setFreq(lerp(st.tween.from, st.tween.to, e));
      if (k >= 1) { st.tween = null; updateNow(); }
    }
    if (st.calm) {
      var c = st.calm, kk = (performance.now() - c.t0) / 420;
      if (kk >= 0.38 && !c.sw) { c.sw = true; setFreq(c.f, true); st.vel = 0; }
      st.dim = kk < 0.38 ? 1 - 0.8 * (kk / 0.38) : 0.2 + 0.8 * Math.min(1, (kk - 0.38) / 0.62);
      if (kk >= 1) { st.calm = null; st.dim = 1; }
      st.dirty = true;
    }
    if (st.pend && ts - lastUI >= 33) { st.pend = false; lastUI = ts; updateUI(); }
    st.vel *= 0.93;
    var animated = !st.frozen && !reduced;
    if (animated) st.time += dt;
    if ((st.dirty || animated) && ts - lastDraw >= (st.dirty ? 33 : 41)) { draw(); lastDraw = ts; st.dirty = false; }
    if (animated && ts - lastGrain >= 83) {
      lastGrain = ts;
      el.grain.style.transform = 'translate3d(' + (-Math.floor(Math.random() * 160)) + 'px,' + (-Math.floor(Math.random() * 160)) + 'px,0)';
    }
    if (st.tween || st.dirty || st.calm || st.pend) raf = requestAnimationFrame(loop);
    else if (animated) tm = setTimeout(function () { tm = 0; kick(); }, 30);
    else last = 0;
  }
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) { stopTimer(); if (au.ctx) au.ctx.suspend().catch(function () {}); }
    else { if (au.ctx && au.want) { au.ctx.resume().catch(function () {}); startTimer(); } kick(); }
  });

  /* ---------- sound: static between stations is made here with WebAudio. The songs are streamed by player.js.
     The generated music below plays only as the offline fallback (au.gen). Off until the button is pressed. ---------- */
  var au = { ctx: null, want: false, gen: false, master: null, comp: null, bus: null, stat: null, sg: [], nbuf: null, timer: 0, sus: 0, cur: -2, m: null, vol: NP.volume() };
  var mf = function (n) { return 440 * Math.pow(2, (n - 69) / 12); };
  var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
  var rnd = Math.random;
  var QUAL = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], dom7: [0, 4, 7, 10], sus2: [0, 2, 7, 12], open5: [0, 7, 12, 14] };
  var MAJP = [0, 2, 4, 7, 9], MINP = [0, 3, 5, 7, 10];
  /* one style per station: tempo, swing of off-beat eighths (sw8) and odd sixteenths (sw16), bars per piece, reverb send, and several pieces */
  var STY = [
    { tempo: 70, sw8: 0, sw16: 0.22, bars: 12, rev: 0.3, pieces: [
      { t: 'Platform Seven', key: 57, sc: MINP, prog: [[0, 'm9'], [8, 'maj7'], [5, 'm9'], [7, 'dom7']] },
      { t: 'Window Seat', key: 50, sc: MINP, prog: [[0, 'm9'], [10, 'maj7'], [3, 'maj7'], [7, 'm7']] },
      { t: 'Last Carriage', key: 52, sc: MINP, prog: [[0, 'm7'], [5, 'maj7'], [3, 'maj7'], [10, 'dom7']] },
      { t: 'Rain on the Glass', key: 55, sc: MAJP, prog: [[0, 'maj9'], [9, 'm7'], [2, 'm7'], [7, 'dom7']] }] },
    { tempo: 96, sw8: 0.55, sw16: 0, bars: 12, rev: 0.2, pieces: [
      { t: 'Pan on Low', key: 60, sc: MAJP, prog: [[2, 'm7'], [7, 'dom7'], [0, 'maj7'], [9, 'dom7']] },
      { t: 'Steam on the Window', key: 53, sc: MAJP, prog: [[0, 'maj7'], [9, 'm7'], [2, 'm7'], [7, 'dom7']] },
      { t: 'Second Helping', key: 55, sc: MAJP, prog: [[4, 'm7'], [9, 'm7'], [2, 'm7'], [7, 'dom7']] },
      { t: 'The Last Dish', key: 58, sc: MAJP, prog: [[0, 'maj7'], [7, 'm7'], [3, 'maj7'], [10, 'dom7']] }] },
    { tempo: 52, sw8: 0, sw16: 0, bars: 8, rev: 0.75, pieces: [
      { t: 'Empty Room', key: 50, sc: MAJP, prog: [[0, 'sus2'], [7, 'open5'], [5, 'maj9'], [0, 'sus2']] },
      { t: 'Door Closed', key: 53, sc: MAJP, prog: [[0, 'maj9'], [9, 'm7'], [5, 'sus2'], [7, 'open5']] },
      { t: 'Slow Light', key: 57, sc: MINP, prog: [[0, 'sus2'], [3, 'maj9'], [10, 'open5'], [7, 'm7']] }] },
    { tempo: 100, sw8: 0, sw16: 0.1, bars: 16, rev: 0.2, pieces: [
      { t: 'Card One', key: 57, sc: MINP, prog: [[0, 'm7'], [5, 'm7'], [8, 'maj7'], [7, 'dom7']] },
      { t: 'Cross It Out', key: 60, sc: MAJP, prog: [[0, 'maj7'], [9, 'm7'], [5, 'maj7'], [7, 'dom7']] },
      { t: 'The Song You Need', key: 52, sc: MINP, prog: [[0, 'm7'], [3, 'maj7'], [10, 'dom7'], [8, 'maj7']] },
      { t: 'Read It Twice', key: 55, sc: MINP, prog: [[0, 'm7'], [8, 'maj7'], [3, 'maj7'], [10, 'dom7']] }] },
    { tempo: 118, sw8: 0, sw16: 0, bars: 16, rev: 0.3, pieces: [
      { t: 'Weather from the Window', key: 60, sc: MAJP, prog: [[0, 'maj9'], [7, 'dom7'], [9, 'm7'], [5, 'maj7']] },
      { t: 'First Light', key: 62, sc: MAJP, prog: [[0, 'maj7'], [7, 'dom7'], [9, 'm7'], [5, 'maj7']] },
      { t: 'Empty Street', key: 55, sc: MAJP, prog: [[0, 'maj7'], [4, 'm7'], [5, 'maj7'], [7, 'dom7']] },
      { t: 'Doors Open', key: 53, sc: MAJP, prog: [[0, 'maj7'], [5, 'maj7'], [2, 'm7'], [7, 'dom7']] }] }
  ];

  /* instruments: small synth voices built from oscillators and noise */
  function osc(type, f, t, dur) { var o = au.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(t + dur); return o; }
  function gn(v) { var g = au.ctx.createGain(); g.gain.value = v; return g; }
  function flt(type, f, q) { var b = au.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }
  function adsr(g, t, a, peak, dur, rel) { var p = g.gain, h = Math.max(a, dur); p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(peak, t + a); p.setValueAtTime(peak, t + h); p.exponentialRampToValueAtTime(0.0001, t + h + rel); }
  function decay(g, t, peak, dec) { g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dec); }
  function noise(t, dur) { var s = au.ctx.createBufferSource(); s.buffer = au.nbuf; s.start(t, rnd() * 0.7, dur); return s; }
  function ep(D, t, n, v, dur) {
    var f = mf(n), car = osc('sine', f, t, dur + 0.4), mod = osc('sine', f, t, dur + 0.4), tine = osc('sine', f * 14, t, 0.12), mg = gn(0), tg = gn(0), g = gn(0);
    mg.gain.setValueAtTime(f * 1.3, t); mg.gain.exponentialRampToValueAtTime(f * 0.1, t + 0.5);
    mod.connect(mg); mg.connect(car.frequency); car.connect(g);
    decay(tg, t, v * 0.08, 0.1); tine.connect(tg); tg.connect(g);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
    g.connect(D);
  }
  function bass(D, t, n, v, dur, type) { var o = osc(type || 'triangle', mf(n), t, dur + 0.15), l = flt('lowpass', 420), g = gn(0); adsr(g, t, 0.012, v, dur * 0.6, dur * 0.4 + 0.05); o.connect(l); l.connect(g); g.connect(D); }
  function kickDrum(D, t, v) { var o = osc('sine', 140, t, 0.34), g = gn(0); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.1); decay(g, t, v, 0.3); o.connect(g); g.connect(D); }
  function snare(D, t, v) {
    var n = noise(t, 0.2), b = flt('bandpass', 1900, 0.7), g = gn(0), o = osc('sine', 190, t, 0.1), og = gn(0);
    decay(g, t, v * 0.7, 0.17); n.connect(b); b.connect(g); g.connect(D); decay(og, t, v * 0.5, 0.08); o.connect(og); og.connect(D);
  }
  function rim(D, t, v) { var n = noise(t, 0.05), h = flt('highpass', 2200), g = gn(0), o = osc('sine', 820, t, 0.04), og = gn(0); decay(g, t, v * 0.8, 0.035); n.connect(h); h.connect(g); g.connect(D); decay(og, t, v * 0.4, 0.03); o.connect(og); og.connect(D); }
  function hat(D, t, v, open, bright) { var n = noise(t, open ? 0.25 : 0.08), h = flt('highpass', bright ? 6000 : 7500), g = gn(0); decay(g, t, v, open ? 0.16 : 0.045); n.connect(h); h.connect(g); g.connect(D); }
  function brush(D, t, v) { var n = noise(t, 0.25), b = flt('bandpass', 5200, 0.5), g = gn(0); adsr(g, t, 0.02, v, 0.02, 0.12); n.connect(b); b.connect(g); g.connect(D); }
  function crackle(D, t, v) { var n = noise(t, 0.006), h = flt('highpass', 2500), g = gn(0); decay(g, t, v, 0.005); n.connect(h); h.connect(g); g.connect(D); }
  function swell(D, t, dur, v) { dur = Math.min(dur, 3); var n = noise(t, dur * 1.6), b = flt('bandpass', 450, 0.8), g = gn(0); adsr(g, t, dur * 0.8, v, 0.1, dur * 0.8); n.connect(b); b.connect(g); g.connect(D); }
  function pad(D, t, notes, dur, v, mode) {
    var att = mode === 'bright' ? 0.4 : mode === 'dark' ? 2.2 : 1.1, rel = mode === 'dark' ? 2.5 : 1, lp = mode === 'bright' ? 2200 : mode === 'dark' ? 500 : 800;
    notes.forEach(function (n) {
      var f = mf(n), l = flt('lowpass', lp), g = gn(0);
      adsr(g, t, att, v / Math.sqrt(notes.length), dur, rel);
      [-6, 6].forEach(function (dt) { var o = osc(mode === 'bright' ? 'sawtooth' : 'triangle', f, t, dur + rel + 0.2); o.detune.value = dt; o.connect(l); });
      l.connect(g); g.connect(D);
    });
  }
  function pluck(D, t, n, v, dur, bright) {
    var f = mf(n), a = osc('triangle', f, t, dur + 0.2), b = osc('sine', f * 2, t, dur + 0.2), bg = gn(0.4), l = flt('lowpass', bright ? 3800 : 1800), g = gn(0);
    a.connect(l); b.connect(bg); bg.connect(l); l.connect(g); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15); g.connect(D);
  }
  function lead(D, t, n, v, dur) {
    var f = mf(n), a = osc('square', f, t, dur + 0.2), b = osc('triangle', f * 1.004, t, dur + 0.2), l = flt('lowpass', 1700), g = gn(0);
    a.connect(l); b.connect(l); l.connect(g); adsr(g, t, 0.01, v * 0.5, dur * 0.5, dur * 0.5 + 0.1); g.connect(D);
  }
  function bell(D, t, n, v) {
    var f = mf(n), a = osc('sine', f, t, 3), b = osc('sine', f * 2.76, t, 1.2), bg = gn(0.25), g = gn(0), g2 = gn(0);
    a.connect(g); decay(g, t, v, 2.6); b.connect(bg); bg.connect(g2); decay(g2, t, v * 0.25, 0.9); g.connect(D); g2.connect(D);
  }

  /* harmony and melody rules */
  var fit = function (n) { while (n > 52) n -= 12; while (n < 36) n += 12; return n; };
  var low = function (n) { n -= 12; while (n < 34) n += 12; return n; };
  function progAt(m, bar) { var o = [[0, 1, 2, 3], [2, 3, 0, 1], [0, 3, 2, 1], [0, 1, 0, 3]][Math.floor(bar / 4) % 4]; return m.piece.prog[o[bar % 4]]; }
  function setChord(m) { var pr = progAt(m, m.bar); m.root = m.piece.key + pr[0]; m.notes = QUAL[pr[1]].map(function (i) { return m.root + i; }); }
  function scn(m, i) { var sc = m.piece.sc, n = sc.length; return m.piece.key + 12 + sc[((i % n) + n) % n] + 12 * Math.floor(i / n); }
  function melNote(m, strong) {
    if (strong && rnd() < 0.6) { var n = pick(m.notes); while (n < m.piece.key + 12) n += 12; while (n > m.piece.key + 30) n -= 12; return n; }
    m.mi = clamp(m.mi + pick([-2, -1, -1, 1, 1, 2]), 0, 9); return scn(m, m.mi);
  }
  function comp(D, t, m, v) { m.notes.slice(1, 5).forEach(function (n, i) { ep(D, t + i * 0.012, n, v, 0.5); }); }
  function motif(m) {
    var steps = [0, 2, 3, 6, 8, 10, 12, 14].sort(function () { return rnd() - 0.5; }).slice(0, 5).sort(function (a, b) { return a - b; }), i = 3;
    m.motif = steps.map(function (s) { i = clamp(i + pick([-2, -1, 1, 2]), 0, 9); return [s, i]; });
  }

  /* the five pieces of music, one step (a sixteenth note) at a time */
  var P0 = [[0, 6, 10], [0, 10], [0, 3, 10, 14], [0, 7]], P1 = [[3, 10], [0, 7, 14], [6, 11], [2, 8, 13]];
  var KP = [[0, 7, 10], [0, 3, 7, 10], [0, 6, 10, 14], [0, 7, 10, 15]], SP = [[2, 6, 11], [3, 10], [6, 9, 14], [0, 7, 12]];
  var BP = [[[0, 0], [3, 0], [6, 12], [10, 7], [12, 0]], [[0, 0], [2, 0], [7, 7], [10, 5], [14, 7]], [[0, 0], [4, 0], [6, 3], [10, 7], [11, 5]]];
  var STEP = [
    /* Last Tram Home: slow mellow keys, soft beat, vinyl crackle */
    function (m, s, t, sd, D) {
      if (s === 0) { m.pat = pick(P0); pad(D, t, m.notes.slice(0, 4), sd * 16, 0.07, 'soft'); }
      if (m.pat.indexOf(s) >= 0) comp(D, t, m, 0.2);
      if (s === 0 || s === 10 || (s === 7 && rnd() < 0.3)) { bass(D, t, low(m.root), 0.45, sd * 5, 'sine'); kickDrum(D, t, 0.6); }
      if (s === 4 || s === 12) rim(D, t, 0.3);
      if (s % 2 === 0) hat(D, t, s % 4 === 0 ? 0.1 : 0.06, false);
      if (rnd() < 0.25) crackle(D, t + rnd() * sd, 0.04 + rnd() * 0.06);
      if ([2, 5, 8, 11, 13].indexOf(s) >= 0 && rnd() < 0.22) ep(D, t, melNote(m, s === 8), 0.26, sd * 3);
    },
    /* Kitchen Light: light jazz, walking bass, brushes, piano comping */
    function (m, s, t, sd, D) {
      if (s === 0) m.pat = pick(P1);
      if (s % 4 === 0) {
        var b = s / 4, nx = m.piece.key + progAt(m, m.bar + 1)[0];
        bass(D, t, fit(b === 0 ? m.root : b === 1 ? m.notes[1] : b === 2 ? m.notes[2] : nx + (rnd() < 0.5 ? 1 : -1)), 0.5, sd * 3.6, 'triangle');
      }
      if ([0, 4, 6, 8, 12, 14].indexOf(s) >= 0) brush(D, t, s % 4 === 2 ? 0.05 : 0.07);
      if (s === 4 || s === 12) hat(D, t, 0.07, false);
      if ((s === 0 || s === 8) && rnd() < 0.5) kickDrum(D, t, 0.2);
      if (m.pat.indexOf(s) >= 0) comp(D, t, m, 0.17);
      if (s % 2 === 0 && rnd() < 0.28) ep(D, t, melNote(m, s % 4 === 0), 0.26, sd * 3);
    },
    /* The Long Quiet: ambient, slow pads, sparse bells, no drums */
    function (m, s, t, sd, D) {
      if (s === 0) {
        pad(D, t, m.notes, sd * 16, 0.09, 'dark');
        if (m.bar % 2 === 0) bass(D, t, low(m.root), 0.3, sd * 30, 'sine');
        if (rnd() < 0.35) swell(D, t, sd * 14, 0.05);
      }
      if (s % 4 === 0 && rnd() < (s === 0 ? 0.35 : 0.18)) bell(D, t + rnd() * sd * 2, melNote(m, s === 0) + (rnd() < 0.4 ? 12 : 0), 0.2);
    },
    /* Request Hour: the fullest groove, kick and snare, bass line, stabs and a simple melody */
    function (m, s, t, sd, D) {
      if (s === 0) { m.kp = pick(KP); m.bp = pick(BP); m.sp = pick(SP); m.fill = m.bar % 4 === 3; if (m.bar % 4 === 0 || !m.motif.length) motif(m); else if (rnd() < 0.5) { var p = pick(m.motif); p[1] = clamp(p[1] + pick([-1, 1]), 0, 9); } }
      if (m.kp.indexOf(s) >= 0) kickDrum(D, t, 0.8);
      if (s === 4 || s === 12 || (m.fill && s === 14)) snare(D, t, 0.5); else if (s === 15 && rnd() < 0.3) snare(D, t, 0.15);
      if (s % 2 === 0) hat(D, t, s % 4 === 0 ? 0.1 : 0.07, false);
      if (s === 14 && m.bar % 2) hat(D, t, 0.12, true);
      m.bp.forEach(function (p) { if (p[0] === s) bass(D, t, low(m.root) + p[1], 0.5, sd * 1.8, 'sawtooth'); });
      if (m.sp.indexOf(s) >= 0) m.notes.slice(1, 4).forEach(function (n) { pluck(D, t, n, 0.1, sd * 1.2, false); });
      m.motif.forEach(function (p) { if (p[0] === s) lead(D, t, scn(m, p[1]), 0.2, sd * 1.8); });
    },
    /* First Bus: bright morning arpeggios, light drums */
    function (m, s, t, sd, D) {
      if (s === 0) { pad(D, t, m.notes, sd * 16, 0.06, 'bright'); m.seq = m.notes.concat(m.notes.map(function (n) { return n + 12; })); }
      var L = m.seq.length, p = m.ai++ % (2 * L - 2); p = p < L ? p : 2 * L - 2 - p;
      pluck(D, t, m.seq[p], s % 4 === 0 ? 0.2 : 0.12, sd * 1.6, true);
      if (s % 4 === 0) bass(D, t, s % 8 === 0 ? low(m.root) : low(m.root) + 7, 0.4, sd * 3, 'triangle');
      if (s === 0 || s === 8) kickDrum(D, t, 0.5);
      if (s === 4 || s === 12) rim(D, t, 0.2);
      if (s % 4 === 2) hat(D, t, 0.09, false, true);
      if (s === 0 && rnd() < 0.4) bell(D, t, melNote(m, true) + 12, 0.18);
    }
  ];

  /* lookahead scheduler: a timer places notes about 120 ms ahead on the audio clock */
  var npEl = $('[data-now-playing]');
  function setNow() {
    var t = NP.nowText();
    if (npEl.textContent !== t) npEl.textContent = t;
  }
  window.NFAudio = {
    refreshNow: function () { setNow(); },
    setVol: function (v) { au.vol = v; if (au.ctx) volApply(); },
    gen: function (on) { au.gen = !!on; genApply(); }
  };
  function choosePiece(m) {
    var ps = STY[m.st].pieces, k;
    do { k = Math.floor(rnd() * ps.length); } while (ps.length > 1 && k === m.pi);
    m.pi = k; m.piece = ps[k]; m.mi = 3; m.motif = []; if (m === au.m) setNow();
  }
  function newStation() {
    if (au.cur < 0) { au.m = null; setNow(); return; }
    var m = { st: au.cur, s: 0, bar: 0, next: au.ctx.currentTime + 0.12, mi: 3, pat: [0], motif: [], pi: -1, ai: 0, seq: [] };
    choosePiece(m); setChord(m); au.m = m; setNow();
  }
  function schedule() {
    var m = au.m;
    if (!m || !au.want || !au.ctx || au.ctx.state !== 'running') return;
    var Y = STY[m.st], now = au.ctx.currentTime, sd = 60 / Y.tempo / 4, D = au.sg[m.st];
    if (m.next < now) m.next = now + 0.05;
    while (m.next < now + 0.12) {
      var s = m.s, t = m.next + (s % 4 === 2 ? Y.sw8 * sd : 0) + (s % 2 ? Y.sw16 * sd : 0);
      if (s === 0) setChord(m);
      STEP[m.st](m, s, t, sd, D);
      m.next += sd; m.s++;
      if (m.s === 16) { m.s = 0; m.bar++; if (m.bar % Y.bars === 0) choosePiece(m); }
    }
  }
  function startTimer() { if (!au.timer) au.timer = setInterval(schedule, 25); }
  function stopTimer() { clearInterval(au.timer); au.timer = 0; }

  function audioInit() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    var c = new AC(); au.ctx = c;
    au.master = gn(0); au.master.connect(c.destination);
    au.comp = c.createDynamicsCompressor(); au.comp.threshold.value = -16; au.comp.knee.value = 12; au.comp.ratio.value = 5; au.comp.attack.value = 0.005; au.comp.release.value = 0.2;
    au.comp.connect(au.master);
    au.bus = gn(1); au.bus.connect(au.comp);
    var len = c.sampleRate * 4; au.nbuf = c.createBuffer(1, len, c.sampleRate);
    var d = au.nbuf.getChannelData(0); for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = c.createBufferSource(); src.buffer = au.nbuf; src.loop = true;
    var hp = flt('highpass', 900), lp = flt('lowpass', 7000);
    au.stat = gn(0); src.connect(hp); hp.connect(lp); lp.connect(au.stat); au.stat.connect(au.master); src.start();
    var ir = c.createBuffer(2, Math.floor(c.sampleRate * 2.4), c.sampleRate);
    for (var ch = 0; ch < 2; ch++) { var id = ir.getChannelData(ch); for (var j = 0; j < id.length; j++) id[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / id.length, 2.6); }
    var conv = c.createConvolver(); conv.buffer = ir; var wet = gn(0.6); conv.connect(wet); wet.connect(au.bus);
    au.sg = STY.map(function (Y) { var g = gn(0), sn = gn(Y.rev); g.connect(au.bus); g.connect(sn); sn.connect(conv); return g; });
    return true;
  }
  function volApply() { if (au.master) au.master.gain.setTargetAtTime(au.want ? 0.9 * au.vol * au.vol : 0, au.ctx.currentTime, 0.08); }
  /* levels are set only when the tuning changes, never from the draw loop */
  function genApply() {
    if (!au.ctx) return;
    var t = au.ctx.currentTime;
    au.sg.forEach(function (g, i) { g.gain.setTargetAtTime(au.gen && i === au.cur ? 1 : 0, t, 0.3); });
    if (au.gen) newStation(); else au.m = null;
  }
  function audioLevels(L) {
    if (!au.ctx || !au.want) return;
    var t = au.ctx.currentTime, cur = L.lock > 0.55 ? L.near : -1;
    au.stat.gain.setTargetAtTime(L.stat * 0.6, t, 0.06);
    if (cur !== au.cur) { au.cur = cur; NP.tune(cur); genApply(); }
  }
  var soundBtn = $('[data-sound]'), soundTxt = $('[data-sound-txt]');
  soundBtn.addEventListener('click', function () {
    var on = soundBtn.getAttribute('aria-pressed') !== 'true';
    if (on && !au.ctx && !audioInit()) { soundTxt.textContent = 'Sound not available'; return; }
    au.want = on; clearTimeout(au.sus);
    soundBtn.setAttribute('aria-pressed', on); soundTxt.textContent = on ? 'Sound on' : 'Sound off';
    NP.sound(on);
    if (on) {
      au.ctx.resume().catch(function () {}); volApply(); au.cur = -2; startTimer(); audioLevels(look(st.f));
    } else if (au.ctx) {
      au.gen = false; genApply(); volApply(); stopTimer();
      au.sus = setTimeout(function () { if (!au.want) au.ctx.suspend().catch(function () {}); }, 400);
    }
    setNow();
  });
  $$('[data-vol]').forEach(function (v) { v.addEventListener('input', function () { NP.setVolume(this.value / 100); }); });

  if (initGL()) {
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(el.field); else window.addEventListener('resize', resize);
    resize();
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (en.target === el.field) vis.field = en.isIntersecting;
          else mirrors.forEach(function (mm) { if (mm.wrap === en.target) mm.vis = en.isIntersecting; });
        });
        st.dirty = true; kick();
      });
      io.observe(el.field); mirrors.forEach(function (mm) { io.observe(mm.wrap); });
    }
  }
  tw = el.tuner.clientWidth; setGrainO(); updateNow();

  /* ---------- tonight: the visitor's own clock ---------- */
  var tryIn = $('[data-try]'), statusEl = $('[data-status]'), nowEl = $('[data-now]'), bar = $('.tl__bar');
  var shows = $$('.show'), segs = $$('.segs li');
  function nowMins() {
    if (tryIn && tryIn.value) { var p = tryIn.value.split(':'); return +p[0] * 60 + +p[1]; }
    var d = new Date(); return d.getHours() * 60 + d.getMinutes();
  }
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  function clockTick() {
    var mins = nowMins(), off = (mins - 1320 + 1440) % 1440, label = (tryIn && tryIn.value ? 'At ' : 'It is ') + two(Math.floor(mins / 60)) + ':' + two(mins % 60) + (tryIn && tryIn.value ? '' : ' by your clock') + '. ';
    var curShow = -1, curSeg = null, msg;
    if (off < 480) {
      segs.forEach(function (li) { if (+li.getAttribute('data-at') <= off) curSeg = li; });
      shows.forEach(function (s, i) { if (curSeg && s.contains(curSeg)) curShow = i; });
      var next = segs[segs.indexOf(curSeg) + 1], who = shows[curShow].querySelector('.show__meta').textContent.split(',')[0];
      msg = label + 'On air now: ' + shows[curShow].querySelector('h3').textContent + ' with ' + who + ', ' + curSeg.querySelector('.seg__n').textContent + '. ' + (next ? 'Next at ' + next.querySelector('.seg__t').textContent + ': ' + next.querySelector('.seg__n').textContent + '.' : 'Nightfall FM signs off at 06:00.');
    } else {
      var until = 1320 - mins, h = Math.floor(until / 60), m = until % 60;
      msg = label + 'Nightfall FM is off air. The next show starts at 22:00, in ' + (h ? plural(h, 'hour') + (m ? ' ' + plural(m, 'minute') : '') : plural(m, 'minute')) + '.';
    }
    statusEl.textContent = msg;
    nowEl.hidden = off >= 480;
    bar.style.setProperty('--now', (off / 480 * 100).toFixed(2) + '%');
    shows.forEach(function (s, i) { if (i === curShow) s.setAttribute('aria-current', 'true'); else s.removeAttribute('aria-current'); });
    segs.forEach(function (li) { if (li === curSeg) li.setAttribute('aria-current', 'time'); else li.removeAttribute('aria-current'); });
  }
  var clockTimer = 0;
  function clockLoop() { clockTick(); clearTimeout(clockTimer); clockTimer = setTimeout(clockLoop, 60000 - (Date.now() % 60000) + 50); }
  tryIn.addEventListener('input', clockTick);
  $('[data-try-reset]').addEventListener('click', function () { tryIn.value = ''; clockTick(); });
  clockLoop();
  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () {
      var f = S[+b.getAttribute('data-goto')].f;
      $('#top').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      user(); setTimeout(function () { tuneTo(f); }, reduced ? 0 : 500);
    });
  });

  /* ---------- request wall: cards live in localStorage on this device ---------- */
  var KEY = 'nightfall-fm-requests', wallEl = $('[data-wall]'), emptyEl = $('[data-wall-empty]');
  var form = $('[data-form]'), song = $('#f-song'), err = $('#f-song-err'), ok = $('[data-ok]');
  function loadCards() { try { var a = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveCards(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* storage may be off */ } }
  function el2(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
  function renderCards() {
    var cards = loadCards();
    wallEl.textContent = '';
    cards.forEach(function (c) {
      var si = clamp(+c.station || 0, 0, 4), li = el2('li', 'rcard grain st' + (si + 1));
      li.appendChild(el2('p', 'rcard__song', c.song));
      li.appendChild(el2('p', 'rcard__meta', S[si].name + ', ' + S[si].f.toFixed(1) + (c.name ? '. For ' + c.name + '.' : '')));
      if (c.note) li.appendChild(el2('p', 'rcard__note', c.note));
      var b = el2('button', 'btn', 'Remove card'); b.type = 'button'; b.setAttribute('aria-label', 'Remove card: ' + c.song);
      b.addEventListener('click', function () {
        saveCards(loadCards().filter(function (x) { return x.id !== c.id; })); renderCards();
        var hd = $('#h-wall'); hd.tabIndex = -1; hd.focus();
      });
      li.appendChild(b); wallEl.appendChild(li);
    });
    emptyEl.hidden = cards.length > 0;
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (song.value.trim().length < 2) {
      err.hidden = false; ok.hidden = true; song.setAttribute('aria-invalid', 'true'); song.focus(); return;
    }
    err.hidden = true; song.removeAttribute('aria-invalid');
    var cards = loadCards();
    cards.push({ id: Date.now() + '-' + Math.floor(Math.random() * 1e6), song: song.value.trim(), name: $('#f-name').value.trim(), station: +$('#f-station').value, note: $('#f-note').value.trim() });
    saveCards(cards.slice(-24)); renderCards();
    form.reset(); ok.hidden = false;
  });
  song.addEventListener('input', function () { if (song.value.trim().length >= 2) { err.hidden = true; song.removeAttribute('aria-invalid'); } });
  renderCards();
})();
