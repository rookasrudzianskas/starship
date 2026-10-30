/** How a frame's title looks. */
const FRAME_TITLE_STYLE: Partial<CSSStyleDeclaration> = {
  fontSize: '9.5px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  color: 'rgba(255,255,255,0.85)',
  textShadow: '0 1px 6px rgba(0,0,0,0.9)',
};

const DIVIDER_STYLE: Partial<CSSStyleDeclaration> = { width: '1px', background: 'rgba(255,255,255,0.35)' };

/** A loose title or line and what was last written to it. */
interface Mark {
  el: HTMLDivElement;
  text: string;
  x: number;
  y: number;
  h: number;
  shown: boolean;
}

/** One label's elements and what was last written to them (DOM writes only on change). */
interface Label {
  el: HTMLDivElement;
  dot: HTMLElement | null;
  title: HTMLElement;
  sub: HTMLElement;
  color: string;
  x: number;
  y: number;
  shown: boolean;
}

/** DOM layer over the canvas for vehicle labels, event-gate labels and the small-frame chrome. */
export class Overlay {
  readonly root: HTMLDivElement;
  private readonly labels = new Map<string, Label>();
  private readonly used = new Set<string>();
  private readonly frames = new Map<string, HTMLDivElement>();
  private readonly usedFrames = new Set<string>();
  /** Loose titles and divider lines (the split view's). */
  private readonly marks = new Map<string, Mark>();
  private readonly usedMarks = new Set<string>();

  constructor() {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '2',
      fontFamily: 'var(--font)',
    } satisfies Partial<CSSStyleDeclaration>);
  }

  /** Put the layer in `parent` (moving it from wherever it was). */
  mount(parent: HTMLElement): void {
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
  }

  /** Hide everything (nothing to label). */
  clear(): void {
    this.begin();
    this.end();
  }

  /** Start a frame: everything not placed again before `end()` is hidden. */
  begin(): void {
    this.used.clear();
    this.usedFrames.clear();
    this.usedMarks.clear();
  }

  /** A vehicle's or an event's label with its top left at (x, y). */
  label(id: string, x: number, y: number, title: string, sub: string, color: string, kind: 'vehicle' | 'gate'): void {
    let l = this.labels.get(id);
    if (!l) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        whiteSpace: 'nowrap',
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        textShadow: '0 1px 6px rgba(0,0,0,0.9)',
        willChange: 'transform',
      } satisfies Partial<CSSStyleDeclaration>);
      el.innerHTML = kind === 'vehicle' ? '<i></i><b></b><span></span>' : '<b></b><span></span>';
      const dot = el.querySelector('i');
      if (dot) Object.assign(dot.style, { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', marginRight: '8px', verticalAlign: '1px' });
      const b = el.querySelector('b') as HTMLElement;
      Object.assign(b.style, { fontWeight: '700', fontSize: kind === 'vehicle' ? '10.5px' : '10px' });
      const span = el.querySelector('span') as HTMLElement;
      Object.assign(span.style, { marginLeft: '8px', fontSize: '9.5px', opacity: '0.75' });
      this.root.appendChild(el);
      l = { el, dot, title: b, sub: span, color: '', x: NaN, y: NaN, shown: false };
      this.labels.set(id, l);
    }
    if (l.color !== color) {
      l.color = color;
      if (l.dot) l.dot.style.background = color;
      l.title.style.color = kind === 'gate' ? color : '#fff';
      l.sub.style.color = kind === 'gate' ? color : '#fff';
    }
    if (l.title.textContent !== title) l.title.textContent = title;
    if (l.sub.textContent !== sub) l.sub.textContent = sub;
    const px = Math.round(x);
    const py = Math.round(y);
    if (px !== l.x || py !== l.y) {
      l.x = px;
      l.y = py;
      l.el.style.transform = `translate(${px}px, ${py}px)`;
    }
    if (!l.shown) {
      l.shown = true;
      l.el.style.display = 'block';
    }
    this.used.add(id);
  }

  /** A bordered frame with a title (the small frame), and a close button if `onClose` is given. */
  frame(id: string, x: number, y: number, w: number, h: number, title: string, onClose?: () => void): void {
    let el = this.frames.get(id);
    if (!el) {
      el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: '3px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      } satisfies Partial<CSSStyleDeclaration>);
      const t = document.createElement('div');
      Object.assign(t.style, { position: 'absolute', left: '9px', top: '7px', ...FRAME_TITLE_STYLE } satisfies Partial<CSSStyleDeclaration>);
      el.appendChild(t);
      if (onClose) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Hide the small frame');
        btn.title = 'Hide the small frame (P)';
        btn.textContent = '✕';
        Object.assign(btn.style, {
          position: 'absolute',
          right: '4px',
          top: '3px',
          width: '22px',
          height: '22px',
          pointerEvents: 'auto',
          color: 'rgba(255,255,255,0.8)',
          fontSize: '12px',
          lineHeight: '22px',
          textAlign: 'center',
          cursor: 'pointer',
        } satisfies Partial<CSSStyleDeclaration>);
        btn.addEventListener('click', onClose);
        el.appendChild(btn);
      }
      this.root.appendChild(el);
      this.frames.set(id, el);
    }
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
    const titleEl = el.firstChild as HTMLDivElement;
    if (titleEl.textContent !== title) titleEl.textContent = title;
    this.usedFrames.add(id);
  }

  /** A title over the view with its top left at (x, y), styled like a frame's. */
  title(id: string, x: number, y: number, text: string): void {
    const m = this.mark(id, FRAME_TITLE_STYLE);
    if (m.text !== text) {
      m.text = text;
      m.el.textContent = text;
    }
    this.place(m, x, y, 0);
  }

  /** A vertical line `h` px long from (x, y), like a frame's edge (between the halves of the split view). */
  divider(id: string, x: number, y: number, h: number): void {
    this.place(this.mark(id, DIVIDER_STYLE), x, y, Math.max(0, h));
  }

  private mark(id: string, style: Partial<CSSStyleDeclaration>): Mark {
    let m = this.marks.get(id);
    if (!m) {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', ...style } satisfies Partial<CSSStyleDeclaration>);
      this.root.appendChild(el);
      m = { el, text: '', x: NaN, y: NaN, h: NaN, shown: false };
      this.marks.set(id, m);
    }
    this.usedMarks.add(id);
    return m;
  }

  private place(m: Mark, x: number, y: number, h: number): void {
    if (m.x !== x || m.y !== y) {
      m.x = x;
      m.y = y;
      m.el.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (h > 0 && m.h !== h) {
      m.h = h;
      m.el.style.height = `${h}px`;
    }
    if (!m.shown) {
      m.shown = true;
      m.el.style.display = 'block';
    }
  }

  end(): void {
    for (const [id, l] of this.labels) {
      if (l.shown && !this.used.has(id)) {
        l.shown = false;
        l.el.style.display = 'none';
      }
    }
    for (const [id, el] of this.frames) if (!this.usedFrames.has(id)) el.style.display = 'none';
    for (const [id, m] of this.marks) {
      if (m.shown && !this.usedMarks.has(id)) {
        m.shown = false;
        m.el.style.display = 'none';
      }
    }
  }

  clearGates(): void {
    for (const [id, l] of this.labels) {
      if (id.startsWith('gate:')) {
        l.el.remove();
        this.labels.delete(id);
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
