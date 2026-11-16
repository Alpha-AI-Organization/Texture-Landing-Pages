/* Nightfall FM player: one HTMLAudioElement streaming the licensed songs listed in tracks.js,
   plus the library (channel playlist, liked songs, your playlists, recently played, search, queue).
   Everything the visitor saves stays in localStorage on this device. Text from outside is always set with textContent. */
(function () {
  'use strict';
  var doc = document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var D = window.NF_TRACKS || [[], [], [], [], []];
  var NAMES = ['Last Tram Home', 'Kitchen Light', 'The Long Quiet', 'Request Hour', 'First Bus'];
  var KEY = 'nf.player.v1';

  /* ---------- saved state ---------- */
  var S = { vol: 0.6, shuffle: false, repeat: 'off', likes: [], lists: [], recent: [], pos: {}, last: -1 };
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && typeof raw === 'object') for (var k in S) if (raw[k] !== undefined && typeof raw[k] === typeof S[k]) S[k] = raw[k]; } catch (e) { /* storage may be off */ }
  if (!Array.isArray(S.likes) || !Array.isArray(S.lists) || !Array.isArray(S.recent)) { S.likes = []; S.lists = []; S.recent = []; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  /* ---------- registry ---------- */
  var REG = {};
  D.forEach(function (arr, st) { arr.forEach(function (t) { REG[t.src] = { t: t, st: st }; }); });
  var trackOf = function (src) { return REG[src] ? REG[src].t : null; };

  /* ---------- state ---------- */
  var au = new Audio(); au.preload = 'none';
  var on = false, tuned = -2, fallback = false, stall = 0, fadeT = 0, fade = 1, seeking = false;
  var playing = null, base = { list: [], order: [], pos: 0, ctx: { type: 'channel', st: 3 } }, queue = [], failed = {};
  var lastRecent = '';

  /* ---------- tiny dom helpers ---------- */
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  var ICO = {
    prev: ['M6 5v14M20 5v14L9 12z', 1], next: ['M18 5v14M4 5v14l11-7z', 1], play: ['M7 4l13 8-13 8z', 1], pause: ['M7 4v16M17 4v16', 2],
    shuffle: ['M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3', 0], repeat: ['M4 11V9a3 3 0 013-3h11M15 3l3 3-3 3M20 13v2a3 3 0 01-3 3H6M9 21l-3-3 3-3', 0],
    heart: ['M12 20s-7-4.6-7-10a4 4 0 017-2.4A4 4 0 0119 10c0 5.4-7 10-7 10z', 0], queue: ['M4 6h14M4 11h14M4 16h6M15 14l6 3-6 3z', 0],
    volume: ['M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6', 0], close: ['M6 6l12 12M18 6L6 18', 0], up: ['M6 15l6-6 6 6', 0], down: ['M6 9l6 6 6-6', 0]
  };
  function ico(name) {
    var NS = 'http://www.w3.org/2000/svg', s = doc.createElementNS(NS, 'svg'), p = doc.createElementNS(NS, 'path'), d = ICO[name];
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico ico--' + name + (d[1] === 1 ? ' ico--fill' : '')); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    p.setAttribute('d', d[0]); s.appendChild(p); return s;
  }
  function fmt(s) { if (!isFinite(s) || s < 0) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  var statusEl = $('[data-lib-status]');
  function say(t) { if (statusEl) { statusEl.textContent = ''; setTimeout(function () { statusEl.textContent = t; }, 30); } }

  /* ---------- volume ---------- */
  function applyGain() { au.volume = clamp(Math.pow(S.vol, 1.6) * fade, 0, 1); }
  function setVolume(v, quiet) {
    S.vol = clamp(v, 0, 1); applyGain(); $$('[data-vol]').forEach(function (i) { i.value = Math.round(S.vol * 100); });
    if (window.NFAudio) window.NFAudio.setVol(S.vol);
    if (!quiet) save();
  }
  function fadeTo(target, ms, done) {
    clearInterval(fadeT);
    var from = fade, t0 = performance.now();
    fadeT = setInterval(function () {
      var k = clamp((performance.now() - t0) / ms, 0, 1); fade = from + (target - from) * k; applyGain();
      if (k >= 1) { clearInterval(fadeT); fadeT = 0; if (done) done(); }
    }, 40);
  }

  /* ---------- lists and order ---------- */
  function listFor(ctx) {
    if (ctx.type === 'channel') return D[ctx.st] || [];
    if (ctx.type === 'liked') return S.likes.map(trackOf).filter(Boolean);
    if (ctx.type === 'playlist') { var p = findList(ctx.id); return p ? p.ids.map(trackOf).filter(Boolean) : []; }
    if (ctx.type === 'recent') return S.recent.map(trackOf).filter(Boolean);
    return ctx.items || [];
  }
  function findList(id) { for (var i = 0; i < S.lists.length; i++) if (S.lists[i].id === id) return S.lists[i]; return null; }
  function makeOrder(n, first) {
    var o = [], i; for (i = 0; i < n; i++) o.push(i);
    if (S.shuffle) {
      for (i = n - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = o[i]; o[i] = o[j]; o[j] = x; }
      if (first >= 0) { var at = o.indexOf(first); o[at] = o[0]; o[0] = first; }
    }
    return o;
  }
  function fromLabel(ctx) {
    if (ctx.type === 'channel') return 'From ' + NAMES[ctx.st];
    if (ctx.type === 'liked') return 'From your liked songs';
    if (ctx.type === 'playlist') { var p = findList(ctx.id); return 'From your playlist ' + (p ? p.name : ''); }
    if (ctx.type === 'recent') return 'From recently played';
    return 'From search results';
  }
  function startList(ctx, index, resumeAt) {
    var list = listFor(ctx);
    if (!list.length) return;
    base = { ctx: ctx, list: list, order: makeOrder(list.length, S.shuffle ? index : -1), pos: 0 };
    base.pos = S.shuffle ? 0 : index;
    playTrack(list[S.shuffle ? base.order[0] : index], resumeAt);
  }
  var hold = false;
  function playFrom(ctx, tracks, i) {
    if (!on) { hold = true; $('[data-sound]').click(); hold = false; if (!on) return; }
    if (tracks) ctx.items = tracks; startList(ctx, i, 0); fadeTo(1, 150);
  }

  /* ---------- playback ---------- */
  function playTrack(t, resumeAt, fromQueue) {
    clearTimeout(stall); busy = false; playing = t; playing.fromQueue = !!fromQueue;
    au.src = t.src; seekAfter = resumeAt || 0;
    var pr = au.play(); if (pr && pr.catch) pr.catch(function () { /* the error event handles real failures */ });
    stall = setTimeout(function () { failTrack(t); }, 8000);
    ui();
  }
  var seekAfter = 0;
  function failTrack(t) {
    clearTimeout(stall); failed[t.src] = 1; markFailed(t.src);
    var ctx = base.ctx;
    if (ctx.type === 'channel' && D[ctx.st].every(function (x) { return failed[x.src]; })) { goFallback(ctx.st); return; }
    /* be polite to the source: one failure waits 2 s, three in a row stop and ask the visitor */
    fails++;
    if (fails >= 3) { busy = true; playing = null; au.pause(); au.removeAttribute('src'); ui(); say('The music source is busy. Try again in a minute.'); return; }
    var at = base.pos; clearTimeout(skipT);
    skipT = setTimeout(function () { if (!on || busy || base.pos !== at) return; if (!advance(1, true)) { playing = null; au.removeAttribute('src'); ui(); } }, 2000);
  }
  var fails = 0, busy = false, skipT = 0;
  var busyBox = $('[data-busy]');
  function clearBusy() { busy = false; fails = 0; clearTimeout(skipT); }
  if (busyBox) {
    $('[data-busy-retry]', busyBox).addEventListener('click', function () {
      clearBusy(); failed = {}; $$('.song.is-failed').forEach(function (li) { li.classList.remove('is-failed'); });
      if (!on) return; if (tuned >= 0) startChannel(tuned); ui();
    });
    $('[data-busy-gen]', busyBox).addEventListener('click', function () { clearBusy(); if (on) goFallback(tuned); });
  }
  function goFallback(st) { fallback = true; playing = null; au.pause(); au.removeAttribute('src'); if (window.NFAudio) window.NFAudio.gen(true); ui(); }
  function leaveFallback() { if (fallback) { fallback = false; if (window.NFAudio) window.NFAudio.gen(false); } }
  function advance(d, skipFailed) {
    var n = base.order.length; if (!n) return false;
    for (var tries = 0; tries < n; tries++) {
      var p = base.pos + d;
      if (p >= n) { if (S.repeat === 'off' && base.ctx.type !== 'channel') { return false; } base.order = makeOrder(n, -1); p = 0; }
      if (p < 0) p = n - 1;
      base.pos = p;
      var t = base.list[base.order[p]];
      if (!failed[t.src] || !skipFailed) { playTrack(t); return true; }
    }
    return false;
  }
  function next() {
    if (!on) return;
    if (queue.length) { var q = queue.shift(); playTrack(q, 0, true); renderQueue(); return; }
    advance(1, true);
  }
  function prev() { if (!on) return; if (au.currentTime > 3) { au.currentTime = 0; return; } advance(-1, true); }
  function toggle() { if (!on) return; if (!playing && !fallback) return; if (au.paused) { fadeTo(1, 150); au.play().catch(function () {}); } else au.pause(); ui(); }
  au.addEventListener('playing', function () {
    clearTimeout(stall); fails = 0;
    if (seekAfter > 1 && isFinite(au.duration)) { au.currentTime = Math.min(seekAfter, au.duration - 2); seekAfter = 0; }
    if (playing && lastRecent !== playing.src) { lastRecent = playing.src; S.recent = [playing.src].concat(S.recent.filter(function (s) { return s !== playing.src; })).slice(0, 20); save(); if (built.recent && activeTab === 'recent') renderRecent(); }
    ui();
  });
  au.addEventListener('pause', ui);
  au.addEventListener('waiting', function () { if (playing) { clearTimeout(stall); var t = playing; stall = setTimeout(function () { if (playing === t && (au.readyState < 3)) failTrack(t); }, 8000); } });
  au.addEventListener('error', function () { if (playing && au.src) failTrack(playing); });
  au.addEventListener('ended', function () {
    if (S.repeat === 'one' && playing) { au.currentTime = 0; au.play().catch(function () {}); return; }
    next();
  });
  au.addEventListener('loadedmetadata', function () { timeUI(); });
  au.addEventListener('timeupdate', function () { if (on && !doc.hidden) timeUI(); });

  /* ---------- the bar ---------- */
  var bar = $('[data-bar]'), b = {};
  function q(n) { return $('[data-b="' + n + '"]', bar); }
  ['title', 'artist', 'from', 'prev', 'play', 'next', 'shuffle', 'repeat', 'seek', 'cur', 'dur', 'like', 'queue', 'mute', 'close', 'expand'].forEach(function (n) { b[n] = q(n); });
  [['prev', 'prev'], ['play', 'play'], ['next', 'next'], ['shuffle', 'shuffle'], ['repeat', 'repeat'], ['like', 'heart'], ['queue', 'queue'], ['mute', 'volume'], ['close', 'close']].forEach(function (p) { b[p[0]].appendChild(ico(p[1])); });
  var playIco = b.play.firstChild, lastSave = 0;
  function timeUI() {
    if (seeking) return;
    var dur = isFinite(au.duration) && au.duration > 0 ? au.duration : (playing && playing.seconds) || 0;
    b.seek.max = Math.max(1, Math.floor(dur)); b.seek.value = Math.floor(au.currentTime || 0);
    b.cur.textContent = fmt(au.currentTime); b.dur.textContent = fmt(dur);
    b.seek.setAttribute('aria-valuetext', fmt(au.currentTime) + ' of ' + fmt(dur));
    if (playing && S.pos) { var st = base.ctx.type === 'channel' ? base.ctx.st : -1; if (st >= 0 && !playing.fromQueue) S.pos[st] = { src: playing.src, t: Math.floor(au.currentTime || 0) }; if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); } }
  }
  function nowText() {
    if (!on) return 'Sound is off. Press the button to hear the station.';
    if (fallback) return 'Offline: playing the generated set.';
    if (busy) return 'The music source is busy. Try again in a minute.';
    if (tuned < 0) return 'Between stations. Only static.';
    if (!playing) return 'Loading the playlist for ' + NAMES[tuned] + '.';
    var t = playing;
    return (base.ctx.type === 'channel' && !t.fromQueue ? 'Now playing on ' + NAMES[base.ctx.st] + ': ' : 'Now playing: ') + t.title + ' by ' + t.artist + '.' + (base.ctx.type === 'channel' && !t.fromQueue ? '' : ' ' + (t.fromQueue ? 'From your queue.' : fromLabel(base.ctx) + '.'));
  }
  function ui() {
    var t = playing, paused = au.paused;
    bar.hidden = !on; doc.documentElement.classList.toggle('has-bar', on);
    if (busyBox) busyBox.hidden = !(on && busy);
    b.title.textContent = t ? t.title : (fallback ? 'Generated set' : (tuned < 0 ? 'Between stations' : 'Loading'));
    b.artist.textContent = t ? t.artist : (fallback ? 'Made in your browser' : '');
    b.from.textContent = t ? (t.fromQueue ? 'From your queue' : fromLabel(base.ctx)) : '';
    playIco.parentNode.replaceChild(ico(paused || !t ? 'play' : 'pause'), playIco); playIco = b.play.firstChild;
    b.play.setAttribute('aria-label', paused || !t ? 'Play' : 'Pause');
    b.shuffle.setAttribute('aria-pressed', S.shuffle); b.repeat.setAttribute('data-mode', S.repeat);
    b.repeat.setAttribute('aria-label', 'Repeat: ' + S.repeat); b.repeat.setAttribute('aria-pressed', S.repeat !== 'off');
    b.like.setAttribute('aria-pressed', !!(t && S.likes.indexOf(t.src) >= 0)); b.like.disabled = !t; b.queue.setAttribute('data-n', queue.length);
    b.mute.setAttribute('aria-pressed', au.muted);
    $$('[data-shuffle]').forEach(function (x) { x.setAttribute('aria-pressed', S.shuffle); });
    markCurrent(); mediaSession(); timeUI();
    if (window.NFAudio) window.NFAudio.refreshNow();
  }
  b.play.addEventListener('click', toggle);
  b.next.addEventListener('click', next);
  b.prev.addEventListener('click', prev);
  b.shuffle.addEventListener('click', function () { setShuffle(!S.shuffle); });
  b.repeat.addEventListener('click', function () { S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off'; save(); ui(); });
  b.like.addEventListener('click', function () { if (playing) toggleLike(playing.src); });
  b.mute.addEventListener('click', function () { au.muted = !au.muted; ui(); });
  b.queue.addEventListener('click', function () { openTab('queue', true); });
  b.close.addEventListener('click', function () { var sb = $('[data-sound]'); if (sb.getAttribute('aria-pressed') === 'true') sb.click(); });
  b.expand.addEventListener('click', function () { var o = bar.classList.toggle('is-open'); b.expand.setAttribute('aria-expanded', o); });
  b.seek.addEventListener('input', function () { seeking = true; b.cur.textContent = fmt(+b.seek.value); });
  b.seek.addEventListener('change', function () { seeking = false; if (playing) au.currentTime = +b.seek.value; });
  if ('ResizeObserver' in window) new ResizeObserver(function () { doc.documentElement.style.setProperty('--bar-h', bar.hidden ? '0px' : bar.offsetHeight + 'px'); }).observe(bar);
  function setShuffle(v) {
    S.shuffle = !!v; save();
    if (base.list.length) { var cur = playing ? base.list.indexOf(playing) : -1; base.order = makeOrder(base.list.length, cur); base.pos = S.shuffle ? 0 : Math.max(0, cur); }
    ui();
  }

  /* ---------- media session ---------- */
  var msSet = false;
  function mediaSession() {
    if (!('mediaSession' in navigator) || !playing || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: playing.title, artist: playing.artist, album: base.ctx.type === 'channel' ? NAMES[base.ctx.st] : 'Nightfall FM' });
    if (msSet) return; msSet = true;
    var h = function (n, f) { try { navigator.mediaSession.setActionHandler(n, f); } catch (e) { /* unsupported action */ } };
    h('play', function () { if (au.paused) toggle(); }); h('pause', function () { if (!au.paused) toggle(); });
    h('previoustrack', prev); h('nexttrack', next);
    h('seekto', function (d) { if (d && typeof d.seekTime === 'number') au.currentTime = d.seekTime; });
  }

  /* ---------- likes, queue, playlists ---------- */
  function toggleLike(src) {
    var i = S.likes.indexOf(src), t = trackOf(src);
    if (i >= 0) S.likes.splice(i, 1); else S.likes.unshift(src);
    save(); say((i >= 0 ? 'Removed from liked songs: ' : 'Liked: ') + (t ? t.title : ''));
    $$('[data-like]').forEach(function (x) { if (x.getAttribute('data-like') === src) x.setAttribute('aria-pressed', i < 0); });
    updateCounts(); if (built.liked && activeTab === 'liked') renderLiked(); ui();
  }
  function addQueue(t, atFront) { if (atFront) queue.unshift(t); else queue.push(t); say((atFront ? 'Playing next: ' : 'Added to queue: ') + t.title); updateCounts(); renderQueue(); ui(); }
  function pl(name) { var p = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: name, ids: [] }; S.lists.push(p); save(); return p; }

  /* ---------- library ui ---------- */
  var lib = $('[data-lib]'), built = {}, activeTab = 'channel', selList = null, chView = -1;
  var tabs = $$('[role="tab"]', lib || doc), panels = {};
  $$('[data-panel]', lib || doc).forEach(function (p) { panels[p.getAttribute('data-panel')] = p; });

  function songRow(t, o) {
    var li = el('li', 'song'); li.setAttribute('data-src', t.src); if (failed[t.src]) li.classList.add('is-failed');
    var main = el('button', 'song__main'); main.type = 'button';
    main.appendChild(el('span', 'song__title', t.title)); main.appendChild(el('span', 'song__artist', t.artist));
    main.appendChild(el('span', 'song__bad', 'Could not play'));
    main.addEventListener('click', o.play);
    li.appendChild(main);
    var meta = el('span', 'song__meta');
    var a1 = el('a', 'song__link', 'Source'); a1.href = t.page; a1.target = '_blank'; a1.rel = 'noopener'; a1.setAttribute('aria-label', 'Source page for ' + t.title);
    var a2 = el('a', 'song__link', t.licence); a2.href = t.licenceUrl; a2.target = '_blank'; a2.rel = 'noopener'; a2.setAttribute('aria-label', 'Licence for ' + t.title + ': ' + t.licence);
    meta.appendChild(a1); meta.appendChild(a2); li.appendChild(meta);
    var acts = el('span', 'song__acts');
    function btn(label, text, fn, pressed) { var x = el('button', 'sbtn', text); x.type = 'button'; x.setAttribute('aria-label', label + ': ' + t.title); if (pressed !== undefined) x.setAttribute('aria-pressed', pressed); x.addEventListener('click', fn); acts.appendChild(x); return x; }
    var lk = btn('Like', '', function () { toggleLike(t.src); }, S.likes.indexOf(t.src) >= 0); lk.setAttribute('data-like', t.src); lk.appendChild(ico('heart'));
    btn('Play next', 'Next', function () { addQueue(t, true); });
    btn('Add to queue', 'Queue', function () { addQueue(t, false); });
    btn('Add to a playlist', 'Add', function () { openAdd(t); });
    (o.extra || []).forEach(function (e) { btn(e[0], e[1], e[2]); });
    li.appendChild(acts);
    return li;
  }
  function markCurrent() {
    var c = playing ? playing.src : '';
    $$('.song', lib || doc).forEach(function (li) { if (li.getAttribute('data-src') === c) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current'); });
    var cur = lib && $('.song[aria-current="true"]', panels[activeTab] || lib);
    if (cur && cur.offsetParent) { var box = cur.closest('.songs'); if (box) { var top = cur.offsetTop, h = cur.offsetHeight; if (top < box.scrollTop) box.scrollTop = top; else if (top + h > box.scrollTop + box.clientHeight) box.scrollTop = top + h - box.clientHeight; } }
  }
  function markFailed(src) { $$('.song').forEach(function (li) { if (li.getAttribute('data-src') === src) li.classList.add('is-failed'); }); }
  function updateCounts() {
    var l = $('[data-count="liked"]'), qn = $('[data-count="queue"]');
    if (l) l.textContent = S.likes.length ? ' (' + S.likes.length + ')' : ''; if (qn) qn.textContent = queue.length ? ' (' + queue.length + ')' : '';
  }
  function fillList(ul, tracks, ctx, extraFn) {
    ul.textContent = '';
    tracks.forEach(function (t, i) { ul.appendChild(songRow(t, { play: function () { playFrom(ctx, ctx.type === 'channel' ? null : tracks, i); }, extra: extraFn ? extraFn(t, i) : null })); });
    markCurrent();
  }
  function hdr(p, text) { var h = el('p', 'lib__count', text); p.appendChild(h); return h; }
  function shuffleBtn() { var x = el('button', 'btn btn--ghost btn--sm', 'Shuffle'); x.type = 'button'; x.setAttribute('data-shuffle', ''); x.setAttribute('aria-pressed', S.shuffle); x.addEventListener('click', function () { setShuffle(!S.shuffle); }); return x; }

  /* channel playlist */
  var MORE_Q = ['subject:(lofi OR chillhop OR "lo-fi")', 'subject:(jazz)', 'subject:(ambient)', 'subject:(funk OR soul)', 'subject:(acoustic OR happy OR ukulele)'], morePage = {}, moreSeen = {};
  function renderChannel(st) {
    var p = panels.channel; chView = st; p.textContent = '';
    if (st < 0) { p.appendChild(el('p', 'lib__empty', 'Tune the dial to a station to see its playlist.')); return; }
    var tracks = D[st], top = el('div', 'lib__top');
    var h = el('h3', null, NAMES[st]); var cnt = el('p', 'lib__count', tracks.length + ' songs');
    top.appendChild(h); top.appendChild(cnt); top.appendChild(shuffleBtn()); p.appendChild(top);
    var fl = el('label', 'lib__find'); fl.appendChild(el('span', null, 'Find a song or artist'));
    var inp = el('input'); inp.type = 'search'; inp.autocomplete = 'off'; fl.appendChild(inp); p.appendChild(fl);
    var ul = el('ul', 'songs'); ul.tabIndex = -1; ul.setAttribute('aria-label', NAMES[st] + ' playlist'); p.appendChild(ul);
    fillList(ul, tracks, { type: 'channel', st: st });
    inp.addEventListener('input', function () {
      var f = inp.value.trim().toLowerCase(), n = 0;
      $$('.song', ul).forEach(function (li, i) { var t = tracks[i], hit = !f || (t.title + ' ' + t.artist).toLowerCase().indexOf(f) >= 0; li.hidden = !hit; if (hit) n++; });
      cnt.textContent = f ? n + ' of ' + tracks.length + ' songs' : tracks.length + ' songs';
    });
    var more = el('div', 'lib__more'), mb = el('button', 'btn btn--ghost', 'Load more songs'), ms = el('p', 'lib__note', 'Live search of the Internet Archive. Only songs under CC0, public domain, CC BY or CC BY-SA are added. The fit with this channel is not checked.');
    mb.type = 'button'; ms.setAttribute('role', 'status'); more.appendChild(mb); more.appendChild(ms); p.appendChild(more);
    mb.addEventListener('click', function () { loadMore(st, mb, ms, function () { cnt.textContent = D[st].length + ' songs'; fillList(ul, D[st], { type: 'channel', st: st }); }); });
  }
  var LICOK = /^https?:\/\/creativecommons\.org\/(licenses\/by\/|licenses\/by-sa\/|publicdomain\/zero\/|publicdomain\/mark\/)/i;
  function licName(u) {
    var m = u.match(/licenses\/(by-sa|by)\/([\d.]+)/i); if (m) return 'CC ' + m[1].toUpperCase() + ' ' + m[2];
    return /zero/.test(u) ? 'CC0' : 'Public domain';
  }
  function secs(v) { if (v === undefined || v === null || v === '') return 0; if (/:/.test(String(v))) { var p = String(v).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]; } return Math.round(parseFloat(v)) || 0; }
  function loadMore(st, btn, note, done) {
    btn.disabled = true; btn.textContent = 'Loading'; note.textContent = 'Loading songs from the Internet Archive.';
    var page = (morePage[st] || 0) + 1;
    var u = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(MORE_Q[st] + ' AND mediatype:audio AND licenseurl:*') + '&fl[]=identifier&fl[]=licenseurl&fl[]=title&fl[]=creator&rows=8&page=' + page + '&sort[]=downloads+desc&output=json';
    fetch(u).then(function (r) { if (!r.ok) throw new Error('search ' + r.status); return r.json(); }).then(function (j) {
      morePage[st] = page;
      var docs = (j.response && j.response.docs || []).filter(function (d) { var l = [].concat(d.licenseurl || [])[0] || ''; return LICOK.test(l) && !moreSeen[d.identifier]; });
      return Promise.all(docs.map(function (d) {
        moreSeen[d.identifier] = 1;
        return fetch('https://archive.org/metadata/' + encodeURIComponent(d.identifier)).then(function (r) { return r.json(); }).then(function (m) {
          var lic = [].concat((m.metadata && m.metadata.licenseurl) || d.licenseurl || [])[0] || '';
          if (!LICOK.test(lic)) return [];
          var item = [].concat((m.metadata && m.metadata.creator) || d.creator || [])[0] || 'Unknown artist', out = [];
          (m.files || []).forEach(function (f) {
            if (out.length >= 4 || !/mp3/i.test(f.format || '')) return;
            var sec = secs(f.length); if (sec && (sec < 90 || sec > 480)) return;
            var src = 'https://archive.org/download/' + encodeURIComponent(d.identifier) + '/' + String(f.name).split('/').map(encodeURIComponent).join('/');
            if (src.indexOf('https://archive.org/') !== 0 || REG[src]) return;
            out.push({ title: String(f.title || f.name).replace(/\.mp3$/i, '').trim(), artist: String(f.creator || f.artist || item).trim(), licence: licName(lic), licenceUrl: lic.replace(/^http:/, 'https:'), page: 'https://archive.org/details/' + encodeURIComponent(d.identifier), src: src, seconds: sec });
          });
          return out;
        }).catch(function () { return []; });
      }));
    }).then(function (groups) {
      var add = []; groups.forEach(function (g) { add = add.concat(g); });
      add.forEach(function (t) { D[st].push(t); REG[t.src] = { t: t, st: st }; });
      btn.disabled = false; btn.textContent = 'Load more songs';
      note.textContent = add.length ? 'Added ' + add.length + ' songs from the Internet Archive for this visit.' : 'No new songs came back this time. Try again for the next page of results.';
      if (add.length) done();
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Load more songs';
      note.textContent = 'Could not reach the Internet Archive. The songs already in this channel still work.';
    });
  }

  function renderLiked() {
    var p = panels.liked; p.textContent = '';
    var tracks = S.likes.map(trackOf).filter(Boolean), top = el('div', 'lib__top');
    top.appendChild(el('h3', null, 'Liked songs')); top.appendChild(el('p', 'lib__count', tracks.length + (tracks.length === 1 ? ' song' : ' songs')));
    if (tracks.length) { var pb = el('button', 'btn', 'Play liked songs'); pb.type = 'button'; pb.addEventListener('click', function () { playFrom({ type: 'liked' }, null, 0); }); top.appendChild(pb); top.appendChild(shuffleBtn()); }
    p.appendChild(top);
    if (!tracks.length) { p.appendChild(el('p', 'lib__empty', 'Nothing liked yet. Press the heart on any song and it will be kept here, on this device.')); return; }
    var ul = el('ul', 'songs'); p.appendChild(ul); fillList(ul, tracks, { type: 'liked' });
  }
  function renderRecent() {
    var p = panels.recent; p.textContent = '';
    var tracks = S.recent.map(trackOf).filter(Boolean), top = el('div', 'lib__top');
    top.appendChild(el('h3', null, 'Recently played')); top.appendChild(el('p', 'lib__count', tracks.length + (tracks.length === 1 ? ' song' : ' songs'))); p.appendChild(top);
    if (!tracks.length) { p.appendChild(el('p', 'lib__empty', 'Songs you play will show up here, the last 20.')); return; }
    var ul = el('ul', 'songs'); p.appendChild(ul); fillList(ul, tracks, { type: 'recent' });
  }
  var searchIdx = null, searchQ = '';
  function renderSearch() {
    var p = panels.search; p.textContent = '';
    var fl = el('label', 'lib__find'); fl.appendChild(el('span', null, 'Search all channels by title or artist'));
    var inp = el('input'); inp.type = 'search'; inp.autocomplete = 'off'; inp.value = searchQ; fl.appendChild(inp); p.appendChild(fl);
    var cnt = el('p', 'lib__count', ''), ul = el('ul', 'songs'); p.appendChild(cnt); p.appendChild(ul);
    function run() {
      if (!searchIdx) { searchIdx = []; D.forEach(function (arr) { arr.forEach(function (t) { searchIdx.push([(t.title + ' ' + t.artist).toLowerCase(), t]); }); }); }
      searchQ = inp.value; var f = searchQ.trim().toLowerCase(), res = [];
      if (f) for (var i = 0; i < searchIdx.length && res.length < 60; i++) if (searchIdx[i][0].indexOf(f) >= 0) res.push(searchIdx[i][1]);
      cnt.textContent = f ? res.length + (res.length === 1 ? ' result' : ' results') : 'Type a title or an artist.';
      fillList(ul, res, { type: 'search' });
    }
    inp.addEventListener('input', run); run();
  }
  function renderQueue() {
    var p = panels.queue; if (!built.queue) return; p.textContent = '';
    var top = el('div', 'lib__top'); top.appendChild(el('h3', null, 'Queue')); top.appendChild(el('p', 'lib__count', queue.length + (queue.length === 1 ? ' song' : ' songs') + ' coming up'));
    if (queue.length) { var cb = el('button', 'btn btn--ghost btn--sm', 'Clear queue'); cb.type = 'button'; cb.addEventListener('click', function () { queue = []; updateCounts(); renderQueue(); ui(); say('Queue cleared'); }); top.appendChild(cb); }
    p.appendChild(top);
    if (!queue.length) { p.appendChild(el('p', 'lib__empty', 'The queue is empty. Use Next or Queue on any song. Queued songs play before the playlist carries on.')); return; }
    var ul = el('ul', 'songs'); p.appendChild(ul);
    queue.forEach(function (t, i) {
      ul.appendChild(songRow(t, { play: function () { queue.splice(i, 1); playTrack(t, 0, true); renderQueue(); }, extra: [
        ['Move up', 'Up', function () { if (i > 0) { queue.splice(i - 1, 0, queue.splice(i, 1)[0]); renderQueue(); say('Moved up'); } }],
        ['Move down', 'Down', function () { if (i < queue.length - 1) { queue.splice(i + 1, 0, queue.splice(i, 1)[0]); renderQueue(); say('Moved down'); } }],
        ['Remove from queue', 'Remove', function () { queue.splice(i, 1); updateCounts(); renderQueue(); ui(); }]] }));
    });
  }
  function renderLists() {
    var p = panels.playlists; p.textContent = '';
    var f = el('form', 'lib__new'); f.setAttribute('novalidate', '');
    var lb = el('label'); lb.appendChild(el('span', null, 'New playlist name')); var inp = el('input'); inp.type = 'text'; inp.maxLength = 40; lb.appendChild(inp);
    var sb = el('button', 'btn', 'Create playlist'); sb.type = 'submit'; f.appendChild(lb); f.appendChild(sb); p.appendChild(f);
    var err = el('p', 'fld__err', 'Give the playlist a name.'); err.hidden = true; err.setAttribute('role', 'alert'); p.appendChild(err);
    f.addEventListener('submit', function (e) { e.preventDefault(); var n = inp.value.trim(); if (!n) { err.hidden = false; inp.focus(); return; } var x = pl(n); selList = x.id; renderLists(); say('Created playlist ' + n); });
    if (!S.lists.length) { p.appendChild(el('p', 'lib__empty', 'No playlists yet. Create one, then use Add on any song.')); return; }
    var nav = el('ul', 'lib__lists');
    S.lists.forEach(function (x) { var li = el('li'), bt = el('button', 'btn btn--ghost btn--sm', x.name + ' (' + x.ids.length + ')'); bt.type = 'button'; bt.setAttribute('aria-pressed', x.id === selList); bt.addEventListener('click', function () { selList = x.id; renderLists(); }); li.appendChild(bt); nav.appendChild(li); });
    p.appendChild(nav);
    var cur = findList(selList) || (selList = S.lists[0].id, S.lists[0]);
    var box = el('div', 'lib__detail'), top = el('div', 'lib__top');
    top.appendChild(el('h3', null, cur.name));
    var tracks = cur.ids.map(trackOf).filter(Boolean);
    top.appendChild(el('p', 'lib__count', tracks.length + (tracks.length === 1 ? ' song' : ' songs')));
    if (tracks.length) { var pb = el('button', 'btn', 'Play playlist'); pb.type = 'button'; pb.addEventListener('click', function () { playFrom({ type: 'playlist', id: cur.id }, null, 0); }); top.appendChild(pb); }
    box.appendChild(top);
    var rn = el('form', 'lib__new'), rl = el('label'); rl.appendChild(el('span', null, 'Rename playlist')); var ri = el('input'); ri.type = 'text'; ri.maxLength = 40; ri.value = cur.name; rl.appendChild(ri);
    var rb = el('button', 'btn btn--ghost', 'Rename'); rb.type = 'submit'; var db = el('button', 'btn btn--ghost', 'Delete playlist'); db.type = 'button';
    rn.appendChild(rl); rn.appendChild(rb); rn.appendChild(db); box.appendChild(rn);
    rn.addEventListener('submit', function (e) { e.preventDefault(); var n = ri.value.trim(); if (!n) return; cur.name = n; save(); renderLists(); say('Renamed to ' + n); });
    db.addEventListener('click', function () { S.lists = S.lists.filter(function (x) { return x.id !== cur.id; }); selList = null; save(); renderLists(); say('Deleted playlist ' + cur.name); });
    if (!tracks.length) box.appendChild(el('p', 'lib__empty', 'This playlist is empty. Use Add on any song.'));
    else { var ul = el('ul', 'songs'); box.appendChild(ul); fillList(ul, tracks, { type: 'playlist', id: cur.id }, function (t) { return [['Remove from playlist', 'Remove', function () { cur.ids = cur.ids.filter(function (s) { return s !== t.src; }); save(); renderLists(); }]]; }); }
    p.appendChild(box);
  }
  var RENDER = { channel: function () { renderChannel(tuned >= 0 ? tuned : (S.last >= 0 ? S.last : -1)); }, liked: renderLiked, playlists: renderLists, recent: renderRecent, search: renderSearch, queue: renderQueue };
  function openTab(name, focus) {
    activeTab = name;
    tabs.forEach(function (t) { var on_ = t.getAttribute('data-tab') === name; t.setAttribute('aria-selected', on_); t.tabIndex = on_ ? 0 : -1; });
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
    if (!built[name]) { built[name] = true; RENDER[name](); } else if (name === 'channel' && tuned >= 0 && chView !== tuned) RENDER.channel(); else if (name === 'liked') renderLiked(); else if (name === 'recent') renderRecent(); else if (name === 'queue') renderQueue();
    markCurrent();
    if (focus) { var t = $('[data-tab="' + name + '"]'); lib.scrollIntoView({ block: 'start' }); t.focus(); }
  }
  if (lib) {
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { openTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function (e) {
        var n = i; if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i + tabs.length - 1) % tabs.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1; else return;
        e.preventDefault(); openTab(tabs[n].getAttribute('data-tab')); tabs[n].focus();
      });
    });
    openTab('channel'); updateCounts();
  }

  /* add to playlist dialog */
  var dlg = $('[data-add-dialog]');
  function openAdd(t) {
    if (!dlg || !dlg.showModal) return;
    var body = $('[data-add-body]', dlg); body.textContent = '';
    $('[data-add-title]', dlg).textContent = 'Add "' + t.title + '" to a playlist';
    S.lists.forEach(function (x) {
      var bt = el('button', 'btn btn--ghost', x.name + (x.ids.indexOf(t.src) >= 0 ? ' (already in it)' : '')); bt.type = 'button';
      bt.addEventListener('click', function () { if (x.ids.indexOf(t.src) < 0) { x.ids.push(t.src); save(); if (built.playlists) renderLists(); say('Added to ' + x.name); } dlg.close(); });
      body.appendChild(bt);
    });
    var f = el('form', 'lib__new'), lb = el('label'); lb.appendChild(el('span', null, 'Or a new playlist')); var inp = el('input'); inp.type = 'text'; inp.maxLength = 40; lb.appendChild(inp);
    var sb = el('button', 'btn', 'Create and add'); sb.type = 'submit'; f.appendChild(lb); f.appendChild(sb); body.appendChild(f);
    f.addEventListener('submit', function (e) { e.preventDefault(); var n = inp.value.trim(); if (!n) { inp.focus(); return; } var x = pl(n); x.ids.push(t.src); save(); if (built.playlists) renderLists(); say('Created ' + n + ' and added the song'); dlg.close(); });
    dlg.showModal();
  }
  if (dlg) $('[data-add-close]', dlg).addEventListener('click', function () { dlg.close(); });

  /* credits: every track, built the first time the list is opened */
  var cred = $('[data-credits]');
  if (cred) cred.addEventListener('toggle', function () {
    if (!cred.open || cred.getAttribute('data-built')) return; cred.setAttribute('data-built', '1');
    var host = $('[data-credits-list]', cred); host.textContent = '';
    D.forEach(function (arr, st) {
      host.appendChild(el('h3', null, NAMES[st] + ' (' + arr.length + ')'));
      var ul = el('ul', 'credits__list');
      arr.forEach(function (t) {
        var li = el('li'); li.appendChild(el('span', 'credits__t', t.title + ' by ' + t.artist + '. '));
        var a = el('a', null, 'Source'); a.href = t.page; a.rel = 'noopener'; li.appendChild(a); li.appendChild(doc.createTextNode(' '));
        var l = el('a', null, t.licence); l.href = t.licenceUrl; l.rel = 'noopener'; li.appendChild(l); ul.appendChild(li);
      });
      host.appendChild(ul);
    });
  });

  /* ---------- keyboard ---------- */
  doc.addEventListener('keydown', function (e) {
    if (!on || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || (t && t.closest && (t.closest('[data-dial]') || t.closest('dialog')))) return;
    var k = e.key;
    if (k === ' ') { if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return; e.preventDefault(); toggle(); }
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      if (t && t.getAttribute && (t.getAttribute('role') === 'tab' || t.getAttribute('role') === 'slider')) return;
      e.preventDefault();
      if (e.shiftKey) { if (k === 'ArrowRight') next(); else prev(); }
      else if (playing) au.currentTime = clamp(au.currentTime + (k === 'ArrowRight' ? 5 : -5), 0, isFinite(au.duration) ? au.duration : 1e9);
    }
    else if (k === 'm' || k === 'M') { au.muted = !au.muted; ui(); }
    else if (k === 'l' || k === 'L') { if (playing) toggleLike(playing.src); }
  });

  window.addEventListener('online', function () { failed = {}; $$('.song.is-failed').forEach(function (li) { li.classList.remove('is-failed'); }); });

  /* ---------- the public side, called from main.js ---------- */
  function startChannel(st) {
    if (hold) return;
    fails = 0; busy = false; clearTimeout(skipT);
    var tracks = D[st] || [];
    if (!tracks.length || tracks.every(function (x) { return failed[x.src]; })) { goFallback(st); return; }
    var rem = S.pos[st], i = 0, at = 0;
    if (rem && REG[rem.src]) { i = tracks.indexOf(REG[rem.src].t); if (i < 0) i = 0; else at = rem.t; }
    startList({ type: 'channel', st: st }, i, at); fadeTo(1, 600);
  }
  window.NFPlayer = {
    sound: function (v) {
      on = !!v; tuned = -2;
      if (!on) { clearTimeout(stall); au.pause(); leaveFallback(); fade = 1; applyGain(); }
      ui();
    },
    tune: function (cur) {
      if (!on || cur === tuned) return;
      var was = tuned; tuned = cur; leaveFallback();
      if (cur >= 0) { S.last = cur; save(); if (built.channel && activeTab === 'channel') renderChannel(cur); else if (built.channel) chView = -2; }
      if (cur < 0) { fadeTo(0, 500, function () { au.pause(); ui(); }); ui(); return; }
      if (was >= 0 && playing && !au.paused) fadeTo(0, 300, function () { au.pause(); startChannel(cur); }); else startChannel(cur);
      ui();
    },
    station: function (st) {
      if (st < 0) return;
      if (st !== S.last) { S.last = st; save(); }
      if (!on && built.channel) { if (activeTab === 'channel') renderChannel(st); else chView = -2; }
    },
    lastStation: function () { return S.last; },
    nowText: nowText,
    volume: function () { return S.vol; },
    setVolume: setVolume
  };
  $$('[data-station-count]').forEach(function (n) { var st = +n.getAttribute('data-station-count'); n.textContent = (D[st] || []).length + ' songs'; n.parentNode.hidden = false; });
  setVolume(S.vol, true);
  b.shuffle.setAttribute('aria-pressed', S.shuffle);
  ui();
})();
