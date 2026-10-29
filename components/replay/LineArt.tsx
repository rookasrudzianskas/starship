import type { Generation } from '@/lib/sim/types';

/** Dimensions (m) used for the outline drawing of each generation. */
const DIMS: Record<Generation, { booster: number; ring: number; ship: number; nose: number; fins: 3 | 4 }> = {
  b1: { booster: 69, ring: 1.8, ship: 50.3, nose: 18, fins: 4 },
  b2: { booster: 69, ring: 1.8, ship: 52.1, nose: 18.5, fins: 4 },
  v3: { booster: 70.2, ring: 2.4, ship: 52.1, nose: 18.5, fins: 3 },
};

const R = 4.5;

interface Props {
  generation: Generation;
  /** Flight 1 flew without a hot-staging ring. */
  hotStageRing?: boolean;
  className?: string;
}

/**
 * Side-view outline of the full stack, drawn from the vehicle dimensions. Used while the 3D scene
 * loads and when the 3D view is off. y grows downward in SVG, so the drawing is flipped.
 */
export function LineArt({ generation, hotStageRing = true, className }: Props) {
  const d = DIMS[generation];
  const ring = hotStageRing ? d.ring : 0;
  const total = d.booster + ring + d.ship;
  const pad = 3;
  const w = 26;
  const Y = (y: number) => total + pad - y; // flip to SVG coordinates

  const shipBase = d.booster + ring;
  const shipBodyTop = shipBase + d.ship - d.nose;
  const noseTip = shipBase + d.ship;

  // Ogive nose: two quadratic curves meeting at the tip.
  const nose = `M ${-R} ${Y(shipBodyTop)} Q ${-R} ${Y(noseTip - 4)} ${-0.6} ${Y(noseTip - 0.4)} Q 0 ${Y(noseTip)} ${0.6} ${Y(noseTip - 0.4)} Q ${R} ${Y(noseTip - 4)} ${R} ${Y(shipBodyTop)}`;

  const seams: number[] = [];
  for (let y = 4; y < d.booster - 2; y += 9) seams.push(y);

  const finY = d.booster - 6.5;
  const finH = generation === 'v3' ? 5.2 : 4.2;
  const finW = generation === 'v3' ? 4.2 : 3.4;

  const vents: number[] = [];
  if (ring > 0) for (let x = -3.6; x <= 3.61; x += 1.2) vents.push(x);

  return (
    <svg
      className={className}
      viewBox={`${-w / 2} 0 ${w} ${total + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Super Heavy and Starship"
    >
      <g fill="#000" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeLinejoin="round">
        {/* Booster engine skirt and bells */}
        <path d={`M ${-R} ${Y(1.5)} L ${-R + 0.6} ${Y(0)} L ${R - 0.6} ${Y(0)} L ${R} ${Y(1.5)}`} vectorEffect="non-scaling-stroke" />
        {[-3.2, -1.6, 0, 1.6, 3.2].map((x) => (
          <path key={x} d={`M ${x - 0.45} ${Y(0)} L ${x - 0.65} ${Y(-1.6)} L ${x + 0.65} ${Y(-1.6)} L ${x + 0.45} ${Y(0)}`} vectorEffect="non-scaling-stroke" />
        ))}
        {/* Booster body */}
        <rect x={-R} y={Y(d.booster)} width={R * 2} height={d.booster - 1.5} vectorEffect="non-scaling-stroke" />
        {seams.map((y) => (
          <line key={y} x1={-R} x2={R} y1={Y(y)} y2={Y(y)} strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />
        ))}
        {/* Chines */}
        <line x1={-R + 0.9} x2={-R + 0.9} y1={Y(3)} y2={Y(d.booster * 0.55)} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />
        <line x1={R - 0.9} x2={R - 0.9} y1={Y(3)} y2={Y(d.booster * 0.55)} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />
        {/* Grid fins */}
        <g>
          <rect x={-R - finW} y={Y(finY + finH)} width={finW} height={finH} vectorEffect="non-scaling-stroke" />
          <rect x={R} y={Y(finY + finH)} width={finW} height={finH} vectorEffect="non-scaling-stroke" />
          <path
            d={`M ${-R - finW} ${Y(finY + finH / 2)} H ${-R} M ${-R - finW / 2} ${Y(finY)} V ${Y(finY + finH)} M ${R} ${Y(finY + finH / 2)} H ${R + finW} M ${R + finW / 2} ${Y(finY)} V ${Y(finY + finH)}`}
            strokeOpacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
          {d.fins === 4 ? (
            <rect x={-finW / 2} y={Y(finY + finH)} width={finW} height={finH} strokeOpacity={0.55} vectorEffect="non-scaling-stroke" />
          ) : null}
        </g>
        {/* Hot-staging ring */}
        {ring > 0 ? (
          <g>
            <rect x={-R} y={Y(d.booster + ring)} width={R * 2} height={ring} vectorEffect="non-scaling-stroke" />
            {vents.map((x) => (
              <line key={x} x1={x} x2={x} y1={Y(d.booster + ring - 0.35)} y2={Y(d.booster + 0.35)} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        ) : null}
        {/* Ship aft flaps */}
        <path d={`M ${-R} ${Y(shipBase + 1)} L ${-R - 2.4} ${Y(shipBase + 1.6)} L ${-R - 2.4} ${Y(shipBase + 9.5)} L ${-R} ${Y(shipBase + 12)}`} vectorEffect="non-scaling-stroke" />
        <path d={`M ${R} ${Y(shipBase + 1)} L ${R + 2.4} ${Y(shipBase + 1.6)} L ${R + 2.4} ${Y(shipBase + 9.5)} L ${R} ${Y(shipBase + 12)}`} vectorEffect="non-scaling-stroke" />
        {/* Ship body */}
        <rect x={-R} y={Y(shipBodyTop)} width={R * 2} height={shipBodyTop - shipBase} vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={0} y1={Y(shipBase + 0.6)} y2={Y(shipBodyTop)} strokeOpacity={0.25} vectorEffect="non-scaling-stroke" />
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={-R}
            x2={R}
            y1={Y(shipBase + (shipBodyTop - shipBase) * f)}
            y2={Y(shipBase + (shipBodyTop - shipBase) * f)}
            strokeOpacity={0.3}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Nose and forward flaps */}
        <path d={nose} vectorEffect="non-scaling-stroke" />
        <path d={`M ${-R + 0.3} ${Y(shipBodyTop + 1)} L ${-R - 1.6} ${Y(shipBodyTop + 2)} L ${-R - 1.3} ${Y(shipBodyTop + 7.5)} L ${-R + 1.5} ${Y(shipBodyTop + 9)}`} vectorEffect="non-scaling-stroke" />
        <path d={`M ${R - 0.3} ${Y(shipBodyTop + 1)} L ${R + 1.6} ${Y(shipBodyTop + 2)} L ${R + 1.3} ${Y(shipBodyTop + 7.5)} L ${R - 1.5} ${Y(shipBodyTop + 9)}`} vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
