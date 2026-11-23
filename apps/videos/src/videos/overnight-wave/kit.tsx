import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { color, font } from "../../lib/ac-launch/theme";
import { clamp, label } from "../../lib/fixes-film/look";

export const FPS = 30;
export const LEFT = 100;
export const RIGHT = 1820;

export const poster: CSSProperties = {
  fontFamily: font.poster,
  fontWeight: 850,
  fontStretch: "75%",
  textTransform: "uppercase",
  letterSpacing: "0.01em",
  color: color.ink,
};

export const serif: CSSProperties = {
  fontFamily: font.serif,
  color: color.ink,
};

export const mono: CSSProperties = {
  fontFamily: font.mono,
  fontStretch: "87.5%",
  color: color.ink,
};

export { color, font, label, clamp };

const ease = Easing.out(Easing.cubic);

export function useRise() {
  const frame = useCurrentFrame();
  return (delay: number, distance = 18): CSSProperties => ({
    opacity: interpolate(frame, [delay, delay + 12], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 16], [distance, 0], { ...clamp, easing: ease })}px)`,
  });
}

export function useGrow() {
  const frame = useCurrentFrame();
  return (delay: number, length = 22) => interpolate(frame, [delay, delay + length], [0, 1], { ...clamp, easing: ease });
}

export function Tag({ after, children, size = 17 }: { after?: boolean; children: ReactNode; size?: number }) {
  return (
    <span
      style={{
        ...label,
        fontSize: size,
        fontWeight: 620,
        color: after ? color.paper : color.ink,
        background: after ? color.blue : "transparent",
        boxShadow: after ? "none" : `inset 0 0 0 2px ${color.ink}`,
        padding: "4px 9px 3px",
        borderRadius: 7,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Chip({ children, tone = "ink", size = 20 }: { children: ReactNode; tone?: "ink" | "blue" | "stamp"; size?: number }) {
  const ink = tone === "blue" ? color.blue : tone === "stamp" ? color.stamp : color.ink;
  return (
    <span
      style={{
        fontFamily: font.serif,
        fontSize: size,
        lineHeight: 1.1,
        color: ink,
        background: color.paperDeep,
        boxShadow: `inset 0 0 0 1.5px ${tone === "ink" ? color.rule : ink}`,
        padding: "8px 14px 9px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        display: "inline-block",
      }}
    >
      {children}
    </span>
  );
}

export function Scene({
  chapter,
  index,
  total,
  title,
  lede,
  source,
  length,
  children,
  ledeWidth = 1000,
}: {
  chapter: string;
  index: number;
  total: number;
  title: string;
  lede?: string;
  source?: string;
  length: number;
  children: ReactNode;
  ledeWidth?: number;
}) {
  const frame = useCurrentFrame();
  const rise = useRise();
  const fade = interpolate(frame, [0, 8, length - 8, length], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: color.paper, opacity: fade }}>
      <div style={{ position: "absolute", left: LEFT, top: 52, right: 1920 - RIGHT, display: "flex", justifyContent: "space-between" }}>
        <div style={{ ...label, color: color.ink }}>Overnight wave · {chapter}</div>
        <div style={{ ...label, color: color.blue }}>
          {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </div>
      </div>
      <div style={{ ...poster, position: "absolute", left: LEFT, top: 96, width: 1720, fontSize: 70, lineHeight: 0.98, ...rise(0, 14) }}>{title}</div>
      {lede ? (
        <div style={{ ...serif, position: "absolute", left: LEFT, top: 178, width: ledeWidth, fontSize: 29, lineHeight: 1.3, color: color.ink2, ...rise(4, 12) }}>{lede}</div>
      ) : null}
      {children}
      {source ? (
        <div style={{ ...label, position: "absolute", left: LEFT, bottom: 40, width: 1720, fontSize: 16, color: color.ink2, opacity: interpolate(frame, [20, 32], [0, 0.85], clamp) }}>
          {source}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

export interface Span {
  lo: number;
  hi?: number;
  text: string;
}

export function BarRow({
  name,
  note,
  before,
  after,
  max,
  delay,
  ratio,
  ratioNote,
  left,
  top,
  nameWidth = 380,
  barWidth = 560,
  textWidth = 230,
  ratioWidth = 200,
}: {
  name: string;
  note?: string;
  before: Span;
  after: Span;
  max: number;
  delay: number;
  ratio?: string;
  ratioNote?: string;
  left: number;
  top: number;
  nameWidth?: number;
  barWidth?: number;
  textWidth?: number;
  ratioWidth?: number;
}) {
  const rise = useRise();
  const grow = useGrow();
  const g1 = grow(delay + 4);
  const g2 = grow(delay + 14);
  const bar = (span: Span, g: number, ink: string) => {
    const lo = (Math.max(span.lo, max * 0.006) / max) * barWidth;
    const hi = ((span.hi ?? span.lo) / max) * barWidth;
    return (
      <div style={{ position: "relative", width: barWidth, height: 30 }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 30, width: barWidth, background: "rgba(22,19,15,0.05)", borderRadius: 6 }} />
        <div style={{ position: "absolute", left: 0, top: 0, height: 30, width: hi * g, background: ink, opacity: 0.32, borderRadius: 6 }} />
        <div style={{ position: "absolute", left: 0, top: 0, height: 30, width: lo * g, background: ink, borderRadius: 6 }} />
      </div>
    );
  };
  const value = (span: Span, ink: string, g: number) => (
    <div style={{ ...mono, width: textWidth, fontSize: 23, fontWeight: 560, color: ink, opacity: g, whiteSpace: "nowrap" }}>{span.text}</div>
  );
  return (
    <div style={{ position: "absolute", left, top, display: "flex", alignItems: "center", gap: 24, ...rise(delay) }}>
      <div style={{ width: nameWidth }}>
        <div style={{ ...poster, fontSize: 31, lineHeight: 1.02 }}>{name}</div>
        {note ? <div style={{ ...label, fontSize: 15, marginTop: 7, lineHeight: 1.35 }}>{note}</div> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bar(before, g1, color.stamp)}
          {value(before, color.ink2, g1)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bar(after, g2, color.blue)}
          {value(after, color.blue, g2)}
        </div>
      </div>
      {ratio ? (
        <div style={{ width: ratioWidth, textAlign: "right", opacity: g2 }}>
          <div style={{ ...poster, fontSize: 56, lineHeight: 0.9, color: color.blue }}>{ratio}</div>
          {ratioNote ? <div style={{ ...label, fontSize: 14, marginTop: 6 }}>{ratioNote}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Legend({ left, top, before = "Before", after = "After" }: { left: number; top: number; before?: string; after?: string }) {
  const rise = useRise();
  const swatch = (ink: string) => <span style={{ display: "inline-block", width: 26, height: 14, borderRadius: 4, background: ink, marginRight: 10, verticalAlign: "middle" }} />;
  return (
    <div style={{ position: "absolute", left, top, display: "flex", gap: 34, ...label, fontSize: 16, ...rise(6) }}>
      <span>
        {swatch(color.stamp)}
        {before}
      </span>
      <span style={{ color: color.blue }}>
        {swatch(color.blue)}
        {after}
      </span>
    </div>
  );
}
