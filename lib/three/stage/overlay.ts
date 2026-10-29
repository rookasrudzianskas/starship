/** DOM layer over the canvas for vehicle labels, event-gate labels and the small-frame chrome. */
export class Overlay {
  readonly root: HTMLDivElement;
  private readonly labels = new Map<string, HTMLDivElement>();
  private readonly used = new Set<string>();
  private readonly frames = new Map<string, HTMLDivElement>();
  private readonly usedFrames = new Set<string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '2',
      fontFamily: 'var(--font)',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);
  }

  /** Start a frame: everything not placed again before `end()` is hidden. */
  begin(): void {
    this.used.clear();
    this.usedFrames.clear();
  }

  label(id: string, x: number, y: number, title: string, sub: string, color: string, kind: 'vehicle' | 'gate'): void {
    let el = this.labels.get(id);
    if (!el) {
      el = document.createElement('div');
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
      this.labels.set(id, el);
    }
    const dot = el.querySelector('i');
    if (dot) (dot as HTMLElement).style.background = color;
    const b = el.querySelector('b') as HTMLElement;
    if (b.textContent !== title) b.textContent = title;
    b.style.color = kind === 'gate' ? color : '#fff';
    const span = el.querySelector('span') as HTMLElement;
    if (span.textContent !== sub) span.textContent = sub;
    span.style.color = kind === 'gate' ? color : '#fff';
    el.style.transform = `translate(${Math.round(x + (kind === 'vehicle' ? -3 : 10))}px, ${Math.round(y - 7)}px)`;
    el.style.display = 'block';
    this.used.add(id);
  }

  /** A bordered frame with a title (small frame or one half of the split view). */
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
      Object.assign(t.style, {
        position: 'absolute',
        left: '9px',
        top: '7px',
        fontSize: '9.5px',
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.85)',
        textShadow: '0 1px 6px rgba(0,0,0,0.9)',
      } satisfies Partial<CSSStyleDeclaration>);
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

  end(): void {
    for (const [id, el] of this.labels) if (!this.used.has(id)) el.style.display = 'none';
    for (const [id, el] of this.frames) if (!this.usedFrames.has(id)) el.style.display = 'none';
  }

  clearGates(): void {
    for (const [id, el] of this.labels) {
      if (id.startsWith('gate:')) {
        el.remove();
        this.labels.delete(id);
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
