// Sketch mode: the camera button of the prompt freezes the 3D view and shows a drawing toolbox over it; the prompt box stays
// usable on top. Capture returns the frozen frame + the drawing flattened into one image, with every mark described for the
// agent (numbered, anchored to the parts / 3D points under it).
//
// The drawing is an SVG layer (marks are elements: select, drag, reshape by handles, recolour, delete, undo).
// Marks, in frame pixels (= device pixels of the WebGL canvas):
//   point {a, b}  pointer: tip a on the thing; b = numbered bubble (b == a: a pin)
//   move  {a, b}  movement arrow: what is at a should go to b
//   box   {a, b}  region      pen {pts}  freehand      text {a, text}
// Every mark but text has a number n (stable: never reused in a sketch, so prompt chips keep pointing at the right mark).
// Anchors come from pickAt(clientX, clientY, through?) -> {hit, sel?: {ref, label}, point: [x,y,z]}, taken while the camera
// is frozen, so the screen <-> 3D mapping is the one in the image.

export const COLORS = [['red', '#e0242b'], ['blue', '#1f6feb'], ['green', '#13a03c'], ['black', '#1a1d22']];
export const MARK_WORDS = { point: 'pointer', move: 'move', box: 'box', pen: 'stroke', text: 'text' };
const TOOLS = [
  ['select', 'cursor', 'Select', 'V', 'Click a mark to select it; drag it or its handles. Delete removes it, a colour recolours it, double-click edits a text.'],
  ['point', 'geo-alt-fill', 'Point at', 'N', 'Click: a numbered pin on what is under it. Drag: from the thing to a numbered label.'],
  ['move', 'arrow-right', 'Move arrow', 'M', 'Drag from what should move to where it should go.'],
  ['box', 'square', 'Box', 'B', 'Drag a frame around parts or a region.'],
  ['pen', 'pencil', 'Freehand', 'P', 'Draw a shape, a path, a missing part.'],
  ['text', 'fonts', 'Text', 'T', 'Click, type, Enter.'],
];
const KEYS = Object.fromEntries(TOOLS.map(([t, , , k]) => [k.toLowerCase(), t]));
const SVGNS = 'http://www.w3.org/2000/svg';
const f1 = (v) => +(+v).toFixed(1);
const vec = (v) => '[' + v.map(f1).join(', ') + ']';
const hex = (n) => (COLORS.find(([k]) => k === n) || COLORS[0])[1];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** onRef(mark): the number badge of a mark was clicked (insert a chip for it); onChange(): marks were added / removed */
export function createSketch({ host, pickAt, onRef, onChange }) {
  const el = document.createElement('div'); el.id = 'sk'; el.hidden = true;
  el.innerHTML = `
    <canvas class="frame"></canvas>
    <svg class="ink" xmlns="${SVGNS}" preserveAspectRatio="none"><g class="marks"></g><g class="ui"></g></svg>
    <div class="top">
      <div class="bar">
        ${TOOLS.map(([t, ic, name, k]) => `<button type="button" data-tool="${t}" title="${name} (${k})"><sl-icon name="${ic}"></sl-icon></button>`).join('')}
        <span class="sep"></span>
        ${COLORS.map(([n, c]) => `<button type="button" class="col" data-col="${n}" title="${n}" style="--c:${c}"></button>`).join('')}
        <span class="sep"></span>
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)"><sl-icon name="arrow-counterclockwise"></sl-icon></button>
        <button type="button" data-act="clear" title="Erase all"><sl-icon name="trash"></sl-icon></button>
        <span class="sep"></span>
        <button type="button" data-act="cancel" class="txt" title="Back to the 3D view, nothing captured (Esc)"><sl-icon name="x-lg"></sl-icon>Cancel</button>
        <button type="button" data-act="capture" class="txt go" title="Add this image to the prompt (Enter)"><sl-icon name="camera"></sl-icon>Capture</button>
      </div>
      <div class="hint"></div>
    </div>
    <div class="mini" hidden><button type="button" data-mini="ref" title="Insert a reference to this mark in the prompt">→ prompt</button><button type="button" data-mini="del" title="Delete (Del)"><sl-icon name="trash"></sl-icon></button></div>
    <input class="tx" type="text" hidden placeholder="text, Enter">`;
  host.appendChild(el);
  const frameC = el.querySelector('.frame'), svg = el.querySelector('svg'), gMarks = svg.querySelector('.marks'), gUi = svg.querySelector('.ui');
  const input = el.querySelector('.tx'), mini = el.querySelector('.mini'), hint = el.querySelector('.hint');
  let tool = 'point', color = 'red', marks = [], sel = null, drag = null, done = null, s = 1, W = 1, H = 1, nextN = 1, nextId = 1, key = null, undo = [];

  const byId = (id) => marks.find((m) => m.id === +id);
  function setTool(t) {
    tool = t; el.dataset.tool = t;
    el.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    const [, , name, k, help] = TOOLS.find((x) => x[0] === t); hint.innerHTML = `<b>${name}</b> (${k}) — ${help}`;
  }
  function setColor(c) {
    color = c; el.querySelectorAll('[data-col]').forEach((b) => b.classList.toggle('on', b.dataset.col === c));
    if (sel && sel.color !== c) { snapshot(); sel.color = c; render(); onChange?.(); }
  }
  const snapshot = () => { undo.push(JSON.stringify(marks)); if (undo.length > 100) undo.shift(); };
  function doUndo() { if (!undo.length) return; marks = JSON.parse(undo.pop()); sel = null; render(); onChange?.(); }

  // ---- coordinates: client <-> frame pixels ----
  const toFrame = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  const toClient = ([x, y]) => { const r = svg.getBoundingClientRect(); return [r.left + x * r.width / W, r.top + y * r.height / H]; };
  const pick = (p, through) => pickAt(...toClient(p), through);

  // ---- rendering (SVG markup; .hit = wide invisible strokes to grab thin lines, .badge = numbered disc) ----
  function badge(m, x, y, r = 9) {
    return `<g class="badge" data-id="${m.id}"><circle cx="${x}" cy="${y}" r="${r * s}" fill="${hex(m.color)}" stroke="#fff" stroke-width="${2 * s}"/>` +
      `<text x="${x}" y="${y}" fill="#fff" font-family="system-ui, sans-serif" font-weight="700" font-size="${(r + 2) * s}" text-anchor="middle" dominant-baseline="central">${m.n}</text></g>`;
  }
  const line = (a, b, w, c, extra = '') => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"${extra}/>`;
  const hitLine = (a, b) => `<line class="hit" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="transparent" stroke-width="${16 * s}"/>`;
  function markSvg(m) {
    const c = hex(m.color);
    let body = '';
    if (m.kind === 'move') {
      const [ax, ay] = m.a, [bx, by] = m.b, ang = Math.atan2(by - ay, bx - ax), h = 18 * s, w = 5 * s;
      const back = [bx - Math.cos(ang) * h * 0.7, by - Math.sin(ang) * h * 0.7];
      const head = [[bx, by], [bx - h * Math.cos(ang - 0.42), by - h * Math.sin(ang - 0.42)], [bx - h * Math.cos(ang + 0.42), by - h * Math.sin(ang + 0.42)]];
      body = hitLine(m.a, m.b) + `<circle cx="${ax}" cy="${ay}" r="${4 * s}" fill="none" stroke="${c}" stroke-width="${2.5 * s}"/>` + line(m.a, back, w, c) +
        `<polygon points="${head.map((p) => p.join(',')).join(' ')}" fill="${c}"/>` + badge(m, (ax + bx) / 2 - Math.sin(ang) * 14 * s, (ay + by) / 2 + Math.cos(ang) * 14 * s);
    } else if (m.kind === 'point') {
      const [x, y] = m.a;
      if (dist(m.a, m.b) < 2) { // pin: tip on the point, number above
        const r = 11 * s;
        body = `<polygon points="${x},${y} ${x - r * 0.6},${y - r * 1.4} ${x + r * 0.6},${y - r * 1.4}" fill="${c}"/>` + badge(m, x, y - r * 1.9, 11);
      } else body = hitLine(m.a, m.b) + line(m.a, m.b, 2 * s, c) + `<circle cx="${x}" cy="${y}" r="${4 * s}" fill="${c}" stroke="#fff" stroke-width="${1.5 * s}"/>` + badge(m, m.b[0], m.b[1], 11);
    } else if (m.kind === 'box') {
      const x = Math.min(m.a[0], m.b[0]), y = Math.min(m.a[1], m.b[1]), w = Math.abs(m.b[0] - m.a[0]), h = Math.abs(m.b[1] - m.a[1]);
      const r = `x="${x}" y="${y}" width="${w}" height="${h}" fill="none"`;
      body = `<rect class="hit" ${r} stroke="transparent" stroke-width="${14 * s}"/><rect ${r} stroke="${c}" stroke-width="${3 * s}" stroke-dasharray="${10 * s} ${5 * s}"/>` + badge(m, x, y);
    } else if (m.kind === 'pen') {
      const d = 'M' + m.pts.map((p) => p.map(f1).join(' ')).join(' L');
      body = `<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="${16 * s}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${d}" fill="none" stroke="${c}" stroke-width="${3 * s}" stroke-linecap="round" stroke-linejoin="round"/>` + badge(m, m.pts[0][0] - 12 * s, m.pts[0][1] - 12 * s);
    } else if (m.kind === 'text') {
      body = `<text x="${m.a[0]}" y="${m.a[1]}" fill="${c}" stroke="#fff" stroke-width="${4 * s}" paint-order="stroke" font-family="system-ui, sans-serif" font-weight="700" font-size="${16 * s}" dominant-baseline="central">${esc(m.text)}</text>`;
    }
    return `<g class="mark${sel === m ? ' sel' : ''}" data-id="${m.id}">${body}</g>`;
  }
  // a pointer's label is dragged by its badge (a handle there would hide the number); a pin moves as a whole
  const handlesOf = (m) => (m.kind === 'move' ? [['a', m.a], ['b', m.b]] : m.kind === 'point' ? (dist(m.a, m.b) < 2 ? [] : [['a', m.a]])
    : m.kind === 'box' ? [['a', m.a], ['b', m.b], ['ab', [m.a[0], m.b[1]]], ['ba', [m.b[0], m.a[1]]]] : []);
  function bbox(m) {
    const ps = m.pts || (m.kind === 'text' ? [m.a, [m.a[0] + m.text.length * 9 * s, m.a[1]]] : [m.a, m.b]);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function render(live) {
    gMarks.innerHTML = [...marks, ...(live ? [live] : [])].map(markSvg).join('');
    gUi.innerHTML = sel ? handlesOf(sel).map(([h, [x, y]]) => `<circle class="handle" data-h="${h}" cx="${x}" cy="${y}" r="${6 * s}" fill="#fff" stroke="${hex(sel.color)}" stroke-width="${2 * s}"/>`).join('') : '';
    mini.hidden = !sel || !!drag;
    if (!mini.hidden) {
      const b = bbox(sel), [cx, cy] = toClient([b[2], b[1]]), r = el.getBoundingClientRect();
      mini.style.left = Math.min(r.width - 130, cx - r.left + 10) + 'px'; mini.style.top = Math.max(60, cy - r.top - 34) + 'px';
      mini.querySelector('[data-mini="ref"]').hidden = !sel.n;
    }
  }

  // ---- 3D anchors (refreshed whenever a mark is drawn, moved or reshaped) ----
  /** the whole parts (not their ports / edges) among hits: "actuator/rail.top" -> "actuator/rail" ("lib:x.port" -> "lib:x") */
  const distinct = (hits) => {
    const seen = new Map();
    for (const h of hits) {
      if (!h?.hit || !h.sel) continue;
      const ref = h.sel.ref?.replace(/^((?:lib:)?[^.]*)\..*$/, '$1'), label = h.sel.label.split(' › ')[0], k = ref || label;
      if (!seen.has(k)) seen.set(k, { ref, label });
    }
    return [...seen.values()];
  };
  function anchor(m) {
    for (const k of ['from', 'to', 'at', 'covers', 'touches', 'centre']) delete m[k];
    if (m.kind === 'move') {
      const a = pick(m.a), b = pick(m.b);
      m.from = a.hit ? a : pick(m.a, b.hit ? b.point : null); m.to = b.hit ? b : pick(m.b, m.from.point); // a miss lies in the view plane of the other end
    } else if (m.kind === 'box') {
      const [x0, x1] = [m.a[0], m.b[0]].sort((p, q) => p - q), [y0, y1] = [m.a[1], m.b[1]].sort((p, q) => p - q), N = 8, hits = [];
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) hits.push(pick([x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N]));
      m.covers = distinct(hits); m.centre = pick([(x0 + x1) / 2, (y0 + y1) / 2]);
    } else if (m.kind === 'pen') {
      const step = Math.max(1, Math.floor(m.pts.length / 24));
      m.touches = distinct(m.pts.filter((_, i) => i % step === 0).map((p) => pick(p)));
      m.from = pick(m.pts[0]); m.to = pick(m.pts[m.pts.length - 1]);
    } else m.at = pick(m.a);
  }
  const add = (m) => { snapshot(); m.id = nextId++; if (m.kind !== 'text') m.n = nextN++; anchor(m); marks.push(m); sel = m; render(); onChange?.(); };
  function remove(m) { snapshot(); marks = marks.filter((x) => x !== m); if (sel === m) sel = null; render(); onChange?.(); }

  // ---- pointer ----
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); commitText();
    if (document.activeElement?.closest?.('#pr-dock')) document.activeElement.blur(); // so V / N / M / B / P / T / Del reach the sketch (the prompt stays armed)
    const p = toFrame(e), t = e.target, hd = t.closest('.handle'), bd = t.closest('.badge'), mk = t.closest('.mark');
    svg.setPointerCapture(e.pointerId);
    if (hd && sel) { drag = { type: 'handle', m: sel, h: hd.dataset.h, p0: p, moved: false }; return; }
    if (bd || (mk && tool === 'select')) { // badge: click = chip in the prompt, drag = move; body (select tool): select + move
      const m = byId((bd || mk).dataset.id); sel = m; setColor(m.color); render();
      drag = { type: 'move', m, p0: p, orig: JSON.parse(JSON.stringify(m)), moved: false, chip: !!bd }; return;
    }
    if (tool === 'select') { sel = null; render(); return; }
    if (tool === 'text') return askText(p, e);
    drag = { type: 'new', m: tool === 'pen' ? { kind: 'pen', color, pts: [p] } : { kind: tool, color, a: p, b: p } };
    sel = null; render(drag.m);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return; const p = toFrame(e);
    if (drag.type === 'new') { if (drag.m.pts) drag.m.pts.push(p); else drag.m.b = p; render(drag.m); return; }
    if (!drag.moved && dist(p, drag.p0) < 3 * s) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    const m = drag.m;
    if (drag.type === 'handle') {
      if (drag.h === 'a' || drag.h === 'b') m[drag.h] = p;
      else { const [h1, h2] = drag.h; m[h1] = [p[0], m[h1][1]]; m[h2] = [m[h2][0], p[1]]; } // 'ab': x of a, y of b
    } else {
      const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1], mv = (q) => [q[0] + dx, q[1] + dy], o = drag.orig;
      if (m.pts) m.pts = o.pts.map(mv);
      else if (m.kind === 'point' && drag.chip && dist(o.a, o.b) >= 2) m.b = mv(o.b); // dragging a pointer's label keeps its tip
      else { m.a = mv(o.a); if (o.b) m.b = mv(o.b); }
    }
    render();
  });
  svg.addEventListener('pointerup', () => {
    const d = drag; drag = null; if (!d) return;
    if (d.type === 'new') {
      const m = d.m, big = m.pts ? m.pts.length > 2 : dist(m.a, m.b) >= 6 * s;
      if (big || m.kind === 'point') { if (!big) m.b = m.a; add(m); } else render();
      return;
    }
    if (d.moved) { anchor(d.m); onChange?.(); }
    else if (d.chip && d.m.n) onRef?.(d.m);
    render();
  });
  svg.addEventListener('dblclick', (e) => {
    const mk = e.target.closest('.mark'), m = mk && byId(mk.dataset.id);
    if (m?.kind === 'text') askText(m.a, e, m);
  });

  // ---- text ----
  let editing = null; // text mark being edited (null: a new one)
  function askText(p, e, m = null) {
    const r = el.getBoundingClientRect(), [cx, cy] = m ? toClient(m.a) : [e.clientX, e.clientY];
    editing = m; input.hidden = false; input.value = m ? m.text : ''; input.style.color = hex(m ? m.color : color);
    input.style.left = cx - r.left + 'px'; input.style.top = cy - r.top - 14 + 'px';
    input.dataset.at = JSON.stringify(p); setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  function commitText() {
    if (input.hidden) return;
    const t = input.value.trim(), m = editing; input.hidden = true; editing = null;
    if (m) { if (!t) remove(m); else if (t !== m.text) { snapshot(); m.text = t; render(); onChange?.(); } }
    else if (t) add({ kind: 'text', color, a: JSON.parse(input.dataset.at), text: t });
  }
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commitText(); else if (e.key === 'Escape') { editing = null; input.hidden = true; } });
  input.addEventListener('blur', commitText);

  // ---- toolbar, mini bar, keys ----
  el.querySelector('.bar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (b.dataset.col) setColor(b.dataset.col);
    else if (b.dataset.act === 'undo') doUndo();
    else if (b.dataset.act === 'clear') { if (marks.length) { snapshot(); marks = []; sel = null; render(); onChange?.(); } }
    else if (b.dataset.act === 'cancel') finish(false);
    else if (b.dataset.act === 'capture') finish(true);
  });
  mini.addEventListener('mousedown', (e) => e.preventDefault()); // keep the prompt caret
  mini.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !sel) return;
    if (b.dataset.mini === 'ref') onRef?.(sel); else if (b.dataset.mini === 'del') remove(sel);
  });
  const onKey = (e) => {
    if (el.hidden || e.target === input || e.target.isContentEditable || e.target.closest?.('#pr-dock, input, textarea, sl-input')) return; // typing in the prompt
    if (e.key === 'Escape') { if (sel) { sel = null; render(); } else finish(false); }
    else if (e.key === 'Enter') finish(true);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') doUndo();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) remove(sel);
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && KEYS[e.key.toLowerCase()]) setTool(KEYS[e.key.toLowerCase()]);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  addEventListener('keydown', onKey, true);
  new ResizeObserver(() => { if (!el.hidden) render(); }).observe(el);

  // ---- open / capture ----
  async function flatten() {
    const clone = svg.cloneNode(true); clone.querySelector('.ui').remove();
    clone.querySelectorAll('.hit').forEach((n) => n.remove());
    clone.setAttribute('width', W); clone.setAttribute('height', H);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    try {
      const img = new Image(); await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('drawing could not be rendered')); img.src = url; });
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const o = out.getContext('2d'); o.drawImage(frameC, 0, 0); o.drawImage(img, 0, 0, W, H);
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  async function finish(ok) {
    commitText();
    const d = done; done = null; sel = null; render();
    let out = null;
    if (ok && d) out = { canvas: await flatten(), marks: JSON.parse(JSON.stringify(marks)), key };
    el.hidden = true; host.classList.remove('sketching'); key = null; onChange?.();
    d?.(out);
  }
  /** frame: a canvas holding the frozen view (device pixels). Resolves {canvas, marks, key} on Capture, null on Cancel. */
  function open(frame) {
    if (done) finish(false);
    W = frame.width; H = frame.height;
    frameC.width = W; frameC.height = H; frameC.getContext('2d').drawImage(frame, 0, 0);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    marks = []; undo = []; sel = null; drag = null; nextN = 1; nextId = 1; input.hidden = true;
    key = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    el.hidden = false; host.classList.add('sketching');
    s = W / el.getBoundingClientRect().width || 1;
    setTool(tool); setColor(color); render(); onChange?.();
    return new Promise((ok) => { done = ok; });
  }
  /** the drawing in progress: {key, marks} (for prompt chips that point at a mark not captured yet), or null */
  const pending = () => (el.hidden ? null : { key, marks });
  return { open, pending, get active() { return !el.hidden; } };
}

/** Text lines for the prompt, one per mark. k = output image px / frame px (the capture is downscaled). */
export function describeMarks(marks, k = 1) {
  const px = (p) => `(${Math.round(p[0] * k)}, ${Math.round(p[1] * k)})`;
  const where = (h) => {
    if (!h) return '?';
    if (h.hit && h.sel) return `«${h.sel.label}»${h.sel.ref && h.sel.ref !== h.sel.label ? ` (${h.sel.ref})` : ''} at ${vec(h.point)}`;
    if (h.hit) return `a surface at ${vec(h.point)}`;
    return `empty space ≈ ${vec(h.point)} (no part there; depth guessed)`;
  };
  const list = (sels) => sels.map((s) => `«${s.label}»${s.ref && s.ref !== s.label ? ` (${s.ref})` : ''}`).join(', ') || 'no part';
  return marks.map((m) => {
    const head = m.n ? `${m.n}. ${m.color} ${MARK_WORDS[m.kind]}` : `${m.color} text "${m.text}"`;
    if (m.kind === 'move') {
      const d = m.to.point.map((v, i) => v - m.from.point[i]);
      return `${head}: move ${where(m.from)} to ${where(m.to)}; displacement ≈ ${vec(d)} mm${m.to.hit && m.from.hit ? '' : ' (in the view plane)'}; image px ${px(m.a)} → ${px(m.b)}`;
    }
    if (m.kind === 'point') return `${head} at ${where(m.at)}; image px ${px(m.a)}${dist(m.a, m.b) >= 2 ? `, label at ${px(m.b)}` : ''}`;
    if (m.kind === 'box') return `${head} around ${list(m.covers)}; centre on ${where(m.centre)}; image px ${px(m.a)}–${px(m.b)}`;
    if (m.kind === 'pen') return `${head} (freehand) over ${list(m.touches)}, from ${where(m.from)} to ${where(m.to)}; starts at image px ${px(m.pts[0])}`;
    return `${head} placed on ${where(m.at)}; image px ${px(m.a)}`;
  });
}
