// Prompt box, global to every view (part, assembly, STEP model): free text + clickable chips that carry exact references into the assembly JSON.
// The viewer never edits geometry: this box only composes a request that is copied to the clipboard and pasted into Claude Code.
//
// Chip = <span class="chip" contenteditable="false" data-ref="actuator/plate.edge_+y" data-label="plate › edge +y">.
// A "selection" is {ref, label}. ref = "<instance>" or "<instance>.<port>" (exactly what goes into the JSON),
// or "lib:<slug>" / "lib:<slug>.<port>" for a library part (a piece to choose, not an instance yet).
import * as m4 from '../lib/mat.js';
import { findPort, edgePorts } from '../lib/assembly.js';

const KEY = 'ob_prompt_draft_v1', POS_KEY = 'ob_prompt_pos_v1', RECENT_N = 5;
const f1 = (v) => +(+v).toFixed(1);
const vec = (v) => '[' + v.map(f1).join(', ') + ']';
const WORDS = [[[1, 0, 0], 'right'], [[-1, 0, 0], 'left'], [[0, 1, 0], 'back'], [[0, -1, 0], 'front'], [[0, 0, 1], 'up'], [[0, 0, -1], 'down']];
const dirWord = (v) => { const w = WORDS.find(([d]) => d.every((c, k) => Math.abs(c - v[k]) < 0.01)); return w ? ` (${w[1]})` : ''; };

const ICONS = { lib: '\u29C9', libport: '\u2295', part: '\u25FC', face: '\u25B1', edge: '\u2571', hole: '\u25CB', port: '\u2295' };
/** kind of a ref from its text alone (the hole / face distinction is by naming convention, see findPort). */
export function kindOf(ref) {
  if (ref.startsWith('lib:')) return ref.includes('.', 4) ? 'libport' : 'lib';
  const dot = ref.indexOf('.');
  if (dot < 0) return 'part';
  const p = ref.slice(dot + 1);
  if (/^edge_/.test(p)) return 'edge';
  if (/^(front|back)$/.test(p)) return 'face';
  if (/^(front|back)(:|@-?[\d.]+\s*,)/.test(p)) return 'hole';
  return 'port';
}

// hooks (all optional): resolve(ref) -> {color} | null (null = ref no longer exists), hover(ref|null), focus(ref),
//   describe(ref) -> string | undefined (details for refs the assembly does not know, e.g. lib:), library() -> [{ref, label, show}]
// getContext() -> first line of the copied prompt (what is on screen)
export function createPrompt({ $, getResult, getContext, hooks = {} }) {
  const box = $('pr-box'), recentEl = $('pr-recent'), pop = $('pr-pop'), status = $('pr-status');
  let saved = null;      // last caret range inside the box (the 3D click would otherwise lose it)
  let armed = false;     // the box was the last thing focused: a 3D click inserts a chip
  let recent = [];
  let comp = null;       // @-completion state {items, idx}

  // ---- caret handling ----
  const inBox = (n) => n && box.contains(n);
  // selectionchange is async and coalesced, so also save synchronously on input/key/mouse events
  const save = () => {
    const s = getSelection();
    if (s.rangeCount && inBox(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  };
  document.addEventListener('selectionchange', save);
  for (const ev of ['input', 'keyup', 'mouseup']) box.addEventListener(ev, save);
  box.addEventListener('focus', () => { armed = true; });
  addEventListener('pointerdown', (e) => {
    // clicks on the canvas or on the prompt widgets keep the box armed; anything else in the panel disarms it
    if (e.target === $('canvas').firstChild || e.target.closest?.('#pr-dock') || e.target.closest?.('#canvas')) return;
    if (e.target.closest?.('[data-keep-prompt]')) return; // e.g. the "+" on a library card
    if (e.target.closest?.('.side,[data-side]')) armed = false;
  }, true);
  function restore() {
    save(); // the live caret wins when it is still in the box
    box.focus();
    const s = getSelection();
    s.removeAllRanges();
    if (saved && inBox(saved.startContainer)) s.addRange(saved);
    else { const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); s.addRange(r); }
    return s.getRangeAt(0);
  }

  // ---- chips ----
  function decorate(c, sel) {
    const info = hooks.resolve ? hooks.resolve(sel.ref) : undefined; // undefined = unknown yet (not solved)
    const stale = info === null;
    c.classList.toggle('stale', stale);
    if (info && info.color) c.style.setProperty('--c', info.color); else c.style.removeProperty('--c');
    c.title = stale ? `${sel.ref}\nWARNING: this reference is not in the current assembly (it was edited or renamed)` : sel.ref;
  }
  function makeChip(sel, el, tag) {
    const c = document.createElement(tag || 'span');
    c.className = 'chip'; if (tag) c.classList.add('sug');
    c.dataset.ref = sel.ref; c.dataset.label = sel.label;
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = ICONS[kindOf(sel.ref)];
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = sel.label;
    c.append(ic, tx);
    decorate(c, sel);
    c.addEventListener('mouseenter', () => hooks.hover?.(sel.ref));
    c.addEventListener('mouseleave', () => hooks.hover?.(null));
    return c;
  }
  function chipEl(sel) {
    const c = makeChip(sel);
    c.contentEditable = 'false';
    // a click selects + frames the instance; it never moves the caret or deletes the chip
    c.addEventListener('mousedown', (e) => e.preventDefault());
    c.addEventListener('click', (e) => { e.preventDefault(); hooks.focus?.(sel.ref); });
    return c;
  }
  function insertChip(sel, range) {
    const r = range || restore();
    r.deleteContents();
    const c = chipEl(sel), sp = document.createTextNode(' ');
    r.insertNode(sp); r.insertNode(c);          // order: chip, space
    const nr = document.createRange(); nr.setStart(sp, 1); nr.collapse(true); // inside the text node: at box level Chrome types before the space
    const s = getSelection(); s.removeAllRanges(); s.addRange(nr); saved = nr.cloneRange();
    changed();
  }
  const same = (a, b) => a.ref === b.ref && a.label === b.label;
  function remember(sel) {
    recent = [sel, ...recent.filter((r) => !same(r, sel))].slice(0, RECENT_N);
    renderRecent();
  }
  function renderRecent() {
    recentEl.innerHTML = '';
    if (!recent.length) { recentEl.innerHTML = '<i>recent clicks appear here</i>'; return; }
    for (const sel of recent) {
      const b = makeChip(sel, null, 'button'); b.type = 'button';
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the box
      b.addEventListener('click', () => { hooks.hover?.(null); insertChip(sel); hooks.focus?.(sel.ref); });
      recentEl.appendChild(b);
    }
  }
  /** Called by the 3D view on every click on a part. */
  function pick(sel) {
    if (!sel) return;
    remember(sel);
    if (armed) insertChip(sel);
  }

  // ---- serialisation (draft + prompt text) ----
  function tokens() {
    const out = []; let first = true;
    const text = (t) => { const last = out[out.length - 1]; if (last && last.t === 'text') last.v += t; else out.push({ t: 'text', v: t }); };
    const walk = (n, top) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) text(c.nodeValue.replace(/\u00A0/g, ' ').replace(/\u200B/g, ''));
        else if (c.nodeType === 1) {
          if (c.classList.contains('chip')) out.push({ t: 'chip', ref: c.dataset.ref, label: c.dataset.label });
          else if (c.tagName === 'BR') text('\n');
          else if (c.tagName === 'DIV' || c.tagName === 'P') { if (out.length && !/\n$/.test(out[out.length - 1].v || '')) text('\n'); walk(c); }
          else walk(c);
        }
      }
    };
    walk(box);
    return out;
  }
  function fill(toks) {
    box.textContent = '';
    for (const t of toks) {
      if (t.t === 'chip') box.appendChild(chipEl(t));
      else t.v.split('\n').forEach((line, i) => { if (i) box.appendChild(document.createElement('br')); if (line) box.appendChild(document.createTextNode(line)); });
    }
    anchors();
  }
  /** Re-tint chips and mark stale ones (called after every solve). */
  function refresh() {
    for (const c of document.querySelectorAll('#pr-box .chip, #pr-recent .chip')) decorate(c, c.dataset);
  }
  /** A non-editable chip with no text before it (first in the box, after another chip or a line break) leaves no caret
   *  position in front of it: keep a zero-width space there (dropped by tokens()), and drop the ones no longer needed. */
  const ZW = '\u200B';
  function anchors() {
    const caret = getSelection().rangeCount ? getSelection().anchorNode : null;
    for (const n of [...box.childNodes]) {
      if (n.nodeType === 3 && n.nodeValue === ZW && n !== caret && !n.nextSibling?.classList?.contains('chip')) n.remove();
    }
    for (const c of box.querySelectorAll(':scope > .chip')) {
      const p = c.previousSibling;
      if (!p || p.nodeType !== 3 || p.nodeValue === '') box.insertBefore(document.createTextNode(ZW), c);
    }
  }
  function changed() {
    anchors();
    hooks.hover?.(null); // a hovered chip may just have been deleted: no mouseleave then
    try { localStorage.setItem(KEY, JSON.stringify({ toks: tokens(), recent })); } catch (e) { /* storage may be blocked */ }
  }
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d) { fill(d.toks || []); recent = (d.recent || []).slice(0, RECENT_N); }
  } catch (e) { /* ignore */ }
  renderRecent();

  // ---- reference details for the copied block ----
  function instOf(path) { return getResult()?.instances.find((i) => i.name === path); }
  function describeRef(ref) {
    const ext = hooks.describe?.(ref);
    if (ext !== undefined) return ext;
    const res = getResult();
    if (!res) return '';
    const dot = ref.indexOf('.'), path = dot < 0 ? ref : ref.slice(0, dot), inst = instOf(path);
    if (!inst) return '(not in the current assembly)';
    const d = inst.def;
    if (dot < 0) {
      const { min, max } = d.bbox, c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
      return `${d.slug}${d.length ? `, ${d.length} mm` : ''}  world centre ${vec(m4.point(inst.M, c))}`;
    }
    try {
      const p = findPort(d, ref.slice(dot + 1)), w = m4.point(inst.M, p.origin), n = m4.vec(inst.M, p.z);
      if (/^edge_/.test(p.name)) return `${d.slug}  world midpoint ${vec(w)}, direction ${vec(m4.vec(inst.M, p.x))}, outward normal ${vec(n)}${dirWord(n)}`;
      return `${d.slug}  world point ${vec(w)}, normal ${vec(n)}`;
    } catch (e) { return `${d.slug}  (${e.message.slice(0, 80)})`; }
  }
  function buildText() {
    const toks = tokens();
    const req = toks.map((t) => (t.t === 'chip' ? `«${t.label}»` : t.v)).join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const seen = new Set(), refs = [];
    for (const t of toks) if (t.t === 'chip' && !seen.has(t.label + '|' + t.ref)) { seen.add(t.label + '|' + t.ref); refs.push(`- «${t.label}» = ${t.ref}  ${describeRef(t.ref)}`); }
    return [`[plotter viewer] ${getContext()}`, `Request: ${req}`,
      ...(refs.length ? ['References:', ...refs] : []),
      ...(toks.some((t) => t.t === 'chip' && t.ref.startsWith('lib:')) ? ['(lib:<slug> = a library part, used in the assembly JSON as {"part": "<slug>"}; lib:vslot-<profile> = a parametric V-Slot rail)'] : []),
      'Read docs/VOCABULARY.md, edit the assembly JSON, run `node tools/solve.mjs <file>` to check it.'].join('\n');
  }

  // ---- copy / clear ----
  let tmo = 0;
  const say = (m, bad) => { status.textContent = m; status.style.color = bad ? '#b3261e' : '#1b7f3b'; clearTimeout(tmo); tmo = setTimeout(() => (status.textContent = ''), 2500); };
  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove(); return ok;
  }
  async function copy() {
    const text = buildText();
    window.__viewer.lastPrompt = text;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = fallbackCopy(text); }
    say(ok ? 'copied to clipboard' : 'copy failed, select the text manually', !ok);
    return text;
  }
  $('pr-copy').addEventListener('click', copy);
  $('pr-clear').addEventListener('click', () => { box.textContent = ''; saved = null; changed(); box.focus(); });

  // ---- @ completion ----
  const closePop = () => { comp = null; pop.hidden = true; };
  function libCandidates(q) {
    const f = q.toLowerCase().replace(/^lib:/, '');
    return (hooks.library?.() || []).filter((it) => it.show.toLowerCase().includes(f) || it.label.toLowerCase().includes(f)).slice(0, 12);
  }
  function candidates(q) {
    const res = getResult();
    if (!res || q.startsWith('lib:')) return libCandidates(q);
    const dot = q.indexOf('.');
    if (dot >= 0) { // instance chosen: list its ports
      const inst = instOf(q.slice(0, dot)); if (!inst) return [];
      const f = q.slice(dot + 1).toLowerCase();
      const names = [...inst.def.ports.map((p) => p.name), ...edgePorts(inst.def).map((p) => p.name)];
      return names.filter((n) => n.toLowerCase().includes(f)).slice(0, 12).map((n) => ({ ref: `${inst.name}.${n}`, label: `${short(inst.name)} › ${portWords(n)}`, show: `${inst.name}.${n}` }));
    }
    const f = q.toLowerCase();
    const inst = res.instances.filter((i) => i.name.toLowerCase().includes(f)).slice(0, 12).map((i) => ({ ref: i.name, label: short(i.name), show: i.name, more: true }));
    return [...inst, ...libCandidates(q)].slice(0, 16);
  }
  function atQuery() {
    const s = getSelection(); if (!s.rangeCount || !inBox(s.anchorNode) || s.anchorNode.nodeType !== 3) return null;
    const t = s.anchorNode.nodeValue.slice(0, s.anchorOffset), m = /@([\w\/.:+\-]*)$/.exec(t);
    return m ? { q: m[1], node: s.anchorNode, end: s.anchorOffset, start: s.anchorOffset - m[0].length } : null;
  }
  function renderPop() {
    pop.innerHTML = '';
    comp.items.forEach((it, i) => {
      const d = document.createElement('div'); d.className = 'it' + (i === comp.idx ? ' on' : ''); d.textContent = it.show + (it.more ? '  …' : '');
      d.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
      pop.appendChild(d);
    });
    pop.hidden = !comp.items.length;
  }
  function choose(it) {
    const a = atQuery(); if (!a) return closePop();
    const r = document.createRange(); r.setStart(a.node, a.start); r.setEnd(a.node, a.end); r.deleteContents();
    closePop(); insertChip({ ref: it.ref, label: it.label }, r);
  }
  box.addEventListener('input', () => {
    changed();
    const a = atQuery();
    if (!a) return closePop();
    const items = candidates(a.q);
    comp = { items, idx: 0 }; renderPop();
  });
  box.addEventListener('keydown', (e) => {
    if (!comp || pop.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); comp.idx = (comp.idx + (e.key === 'ArrowDown' ? 1 : -1) + comp.items.length) % comp.items.length; renderPop(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const it = comp.items[comp.idx]; if (it) choose(it); }
    else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
  });
  box.addEventListener('blur', () => setTimeout(closePop, 100));
  // pasting: plain text only
  box.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });

  // ---- drag: the dock moves by its grip (it may hide a menu); position kept in % of the stage, double-click resets ----
  const dock = $('pr-dock'), grip = $('pr-grip'), host = dock.parentElement;
  let pos = null; // {x, y}: fractions of the free space (0 = left / top, 1 = right / bottom)
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* ignore */ }
  function place() {
    if (!pos) { dock.style.left = dock.style.top = ''; dock.classList.remove('moved'); return; }
    const W = host.clientWidth - dock.offsetWidth, H = host.clientHeight - dock.offsetHeight;
    dock.classList.add('moved');
    dock.style.left = Math.max(0, W * pos.x) + 'px'; dock.style.top = Math.max(0, H * pos.y) + 'px';
  }
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const hr = host.getBoundingClientRect(), dr = dock.getBoundingClientRect(), dx = e.clientX - dr.left, dy = e.clientY - dr.top;
    const move = (ev) => {
      const W = Math.max(1, hr.width - dr.width), H = Math.max(1, hr.height - dr.height);
      const x = Math.min(W, Math.max(0, ev.clientX - hr.left - dx)), y = Math.min(H, Math.max(0, ev.clientY - hr.top - dy));
      pos = { x: x / W, y: y / H }; place();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { pos = null; place(); try { localStorage.removeItem(POS_KEY); } catch (e) { /* ignore */ } });
  const ro = new ResizeObserver(place); ro.observe(host); ro.observe(dock);
  place();

  return { pick, refresh, copy, buildText, tokens, insertChip, get armed() { return armed; } };
}

export const short = (name) => name.split('/').pop().replace(/_/g, ' ');
export const portWords = (n) => (/^edge_/.test(n) ? 'edge ' + n.slice(5) : n);
