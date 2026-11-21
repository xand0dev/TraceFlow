// Line-art pictures for each kind of block. 80×56 box, white strokes, red accent details.
import type { Module } from '../types';

type Kind = Module['kind'];
const dots = (y = 6.5) => [8, 15, 22].map((x) => <circle key={x} cx={x} cy={y} r={1.6} className="fc" />);

const ICONS: Record<Kind, () => JSX.Element> = {
  terminal: () => (
    <>
      <rect x={0.5} y={0.5} width={79} height={55} rx={7} />
      <path d="M0 13 H80" />
      {dots()}
      <path d="M12 26 L20 32 L12 38" />
      <rect x={25} y={35} width={11} height={3} className="fr blink" />
      <path d="M12 47 H44" className="faint" />
    </>
  ),
  editor: () => (
    <>
      <rect x={0.5} y={0.5} width={79} height={55} rx={7} />
      <path d="M0 13 H80 M18 13 V56" />
      <path d="M5 22 H13 M5 28 H11 M5 34 H13 M24 22 H44 M24 29 H38 M24 36 H46 M24 43 H34" className="faint" />
      <path d="M60 24 L70 37 L57 45 Z" className="faint" />
      <circle cx={60} cy={24} r={2.6} className="fr" />
      <circle cx={70} cy={37} r={2.6} className="fw" />
      <circle cx={57} cy={45} r={2.6} className="fw" />
    </>
  ),
  plug: () => (
    <>
      <path d="M0 42 C14 42 16 28 28 28" />
      <rect x={28} y={20} width={16} height={16} rx={3} />
      <path d="M44 24 H51 M44 32 H51" />
      <rect x={60} y={17} width={18} height={22} rx={4} />
      <path d="M78 28 C86 28 86 46 80 50" className="faint" />
      <path d="M55 14 L56 9 M55 42 L56 47 M53 28 H57" className="spark" />
    </>
  ),
  core: () => (
    <g transform="translate(12 0)">
      <g className="spin">
        {Array.from({ length: 12 }, (_, i) => (
          <rect key={i} x={25} y={0} width={6} height={8} rx={1.5} transform={`rotate(${i * 30} 28 28)`} className="fc" />
        ))}
      </g>
      <circle cx={28} cy={28} r={21} />
      <circle cx={28} cy={28} r={12} className="faint" />
      <circle cx={28} cy={28} r={5} className="fr glow" />
    </g>
  ),
  parser: () => (
    <>
      <path d="M8 1 H40 L52 13 V55 H8 Z M40 1 V13 H52" />
      <path d="M15 21 H40 M15 28 H34 M15 35 H42 M15 42 H30" className="faint" />
      <rect x={9} y={18} width={42} height={1.4} className="fr scan" />
      <circle cx={54} cy={38} r={12} className="glass" />
      <path d="M63 47 L74 58" />
    </>
  ),
  antenna: () => (
    <>
      <rect x={22} y={32} width={36} height={23} rx={4} />
      <path d="M30 43 H50" className="faint" />
      <path d="M40 32 V16" />
      <circle cx={40} cy={13} r={2.8} className="fr glow" />
      <path d="M31 7 A13 13 0 0 0 31 19 M49 7 A13 13 0 0 1 49 19" className="wave" />
      <path d="M24 2 A21 21 0 0 0 24 24 M56 2 A21 21 0 0 1 56 24" className="wave w2" />
    </>
  ),
  book: () => (
    <>
      <path d="M40 10 C30 4 16 4 6 8 V52 C16 48 30 48 40 54 C50 48 64 48 74 52 V8 C64 4 50 4 40 10 Z" />
      <path d="M40 10 V54" />
      <path d="M13 18 H32 M13 25 H30 M13 32 H33 M48 18 H67 M48 25 H62" className="faint" />
      <path d="M48 32 H58" className="sr" />
    </>
  ),
  database: () => (
    <>
      <ellipse cx={40} cy={9} rx={24} ry={7.5} />
      <path d="M16 9 V47 C16 51 26 55 40 55 C54 55 64 51 64 47 V9" />
      <path d="M16 22 C16 26 26 30 40 30 C54 30 64 26 64 22 M16 35 C16 39 26 43 40 43 C54 43 64 39 64 35" className="faint" />
      <circle cx={56} cy={17} r={2} className="fr blink" />
    </>
  ),
  browser: () => (
    <>
      <rect x={0.5} y={0.5} width={79} height={55} rx={7} />
      <path d="M0 13 H80" />
      {dots()}
      <path d="M18 34 L40 25 L62 40 M40 25 L34 46" className="faint" />
      {[[18, 34], [40, 25], [62, 40], [34, 46]].map(([x, y]) => <circle key={x} cx={x} cy={y} r={3} className="fw" />)}
      <circle r={2} className="fr">
        <animateMotion dur="2.6s" repeatCount="indefinite" path="M18 34 L40 25 L62 40" />
      </circle>
    </>
  ),
  server: () => (
    <>
      {[2, 21, 40].map((y) => (
        <g key={y}>
          <rect x={10} y={y} width={60} height={15} rx={3} />
          <path d={`M18 ${y + 7.5} H40`} className="faint" />
        </g>
      ))}
      <circle cx={61} cy={9.5} r={2} className="fr blink" />
      <circle cx={61} cy={28.5} r={2} className="fw" />
      <circle cx={61} cy={47.5} r={2} className="fw" />
    </>
  ),
  cube: () => (
    <>
      <path d="M40 3 L66 16 V42 L40 55 L14 42 V16 Z" />
      <path d="M14 16 L40 29 L66 16 M40 29 V55" className="faint" />
      <circle cx={40} cy={29} r={2.4} className="fr" />
    </>
  ),
};

export function Icon({ kind }: { kind: Kind }) {
  const Draw = ICONS[kind] ?? ICONS.cube;
  return <Draw />;
}
