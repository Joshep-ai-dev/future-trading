import type { ReactNode } from "react";
import type { DrawingTool, DrawingToolbarProps } from "./drawings";

const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox='0 0 28 28' aria-hidden='true'>
    <g {...s}>{children}</g>
  </svg>
);

const TOOLS: { tool: DrawingTool; label: string; key?: string; icon: ReactNode }[] = [
  {
    tool: "cursor",
    label: "Cross",
    icon: (
      <Icon>
        <path d='M14 5v18M5 14h18' />
      </Icon>
    ),
  },
  {
    tool: "trend",
    label: "Trend line",
    key: "Alt+T",
    icon: (
      <Icon>
        <path d='M7 21 21 7' />
        <circle cx='6.5' cy='21.5' r='1.6' />
        <circle cx='21.5' cy='6.5' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "ray",
    label: "Ray",
    icon: (
      <Icon>
        <path d='M8 20 24 6' />
        <circle cx='7' cy='21' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "hline",
    label: "Horizontal line",
    key: "Alt+H",
    icon: (
      <Icon>
        <path d='M4 14h20' />
        <circle cx='14' cy='14' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "hray",
    label: "Horizontal ray",
    icon: (
      <Icon>
        <path d='M10 14h14' />
        <circle cx='8' cy='14' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "vline",
    label: "Vertical line",
    key: "Alt+V",
    icon: (
      <Icon>
        <path d='M14 4v20' />
        <circle cx='14' cy='14' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "rect",
    label: "Rectangle",
    icon: (
      <Icon>
        <rect x='6' y='8' width='16' height='12' />
        <circle cx='6' cy='8' r='1.6' />
        <circle cx='22' cy='20' r='1.6' />
      </Icon>
    ),
  },
  {
    tool: "fib",
    label: "Fib retracement",
    icon: (
      <Icon>
        <path d='M5 7h18M5 11.5h18M5 16h18M5 21h18' />
        <path d='M6 21 22 7' strokeDasharray='2 2' />
      </Icon>
    ),
  },
  {
    tool: "measure",
    label: "Measure",
    icon: (
      <Icon>
        <path d='m5.5 18.5 13-13 4 4-13 13Z' />
        <path d='m9 15 2 2M12 12l2 2M15 9l2 2' />
      </Icon>
    ),
  },
];

/** Vertical TradingView-style drawing toolbar on the left edge of the chart. */
export default function DrawingToolbar(props: DrawingToolbarProps) {
  const {
    tool,
    setTool,
    magnet,
    setMagnet,
    locked,
    setLocked,
    hidden,
    setHidden,
    count,
    selected,
    removeSelected,
    clear,
  } = props;
  return (
    <div
      className='tv-drawing-toolbar'
      role='toolbar'
      aria-orientation='vertical'
      aria-label='Drawing tools'
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map((item, index) => (
        <span key={item.tool} className='tv-draw-slot'>
          <button
            type='button'
            className='tv-draw-button'
            aria-pressed={tool === item.tool}
            title={`${item.label}${item.key ? ` (${item.key})` : ""}`}
            aria-label={item.label}
            onClick={() => setTool(tool === item.tool && item.tool !== "cursor" ? "cursor" : item.tool)}
          >
            {item.icon}
          </button>
          {index === 0 && <i className='tv-draw-sep' />}
        </span>
      ))}
      <i className='tv-draw-sep' />
      <button
        type='button'
        className='tv-draw-button'
        aria-pressed={magnet}
        title='Magnet mode snaps to OHLC'
        aria-label='Magnet mode'
        onClick={() => setMagnet(!magnet)}
      >
        <Icon>
          <path d='M8 6v8a6 6 0 0 0 12 0V6h-4v8a2 2 0 0 1-4 0V6Z' />
          <path d='M8 9.5h4M16 9.5h4' />
        </Icon>
      </button>
      <button
        type='button'
        className='tv-draw-button'
        aria-pressed={locked}
        title={locked ? "Unlock all drawings" : "Lock all drawings"}
        aria-label='Lock all drawings'
        onClick={() => setLocked(!locked)}
      >
        <Icon>
          <rect x='8' y='13' width='12' height='9' rx='1.5' />
          <path d={locked ? "M10.5 13V10a3.5 3.5 0 0 1 7 0v3" : "M10.5 13V10a3.5 3.5 0 0 1 6.8-1.2"} />
        </Icon>
      </button>
      <button
        type='button'
        className='tv-draw-button'
        aria-pressed={hidden}
        title={hidden ? "Show all drawings" : "Hide all drawings"}
        aria-label='Hide all drawings'
        onClick={() => setHidden(!hidden)}
      >
        <Icon>
          <path d='M4.5 14S8 8.5 14 8.5 23.5 14 23.5 14 20 19.5 14 19.5 4.5 14 4.5 14Z' />
          <circle cx='14' cy='14' r='2.8' />
          {hidden && <path d='M6 22 22 6' />}
        </Icon>
      </button>
      <i className='tv-draw-sep' />
      <button
        type='button'
        className='tv-draw-button'
        title={selected ? "Remove selected drawing (Del)" : "Remove all drawings"}
        aria-label={selected ? "Remove selected drawing" : "Remove all drawings"}
        disabled={!count || locked}
        onClick={() => {
          if (selected) removeSelected();
          else if (window.confirm(`Remove all ${count} drawings?`)) clear();
        }}
      >
        <Icon>
          <path d='M7 9h14M11.5 9V6.5h5V9M9 9l1 13h8l1-13M12.5 12.5v6M15.5 12.5v6' />
        </Icon>
      </button>
    </div>
  );
}
