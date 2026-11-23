import type { ReactNode } from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { color, FPS } from "./kit";
import {
  BusyAndClose,
  Chapter,
  CiTimes,
  Cleanup,
  CleanupProof,
  CliActions,
  Closing,
  Folders,
  Hygiene,
  Intro,
  Launch,
  MenusAndroid,
  Security,
  Sleep,
  StopButton,
  WebVoyager,
  type SceneBody,
} from "./scenes";
import { loadFonts } from "../../lib/ac-launch/theme";

loadFonts();

type Part =
  | { kind: "intro"; seconds: number }
  | { kind: "chapter"; seconds: number; number: number; title: string; line: string }
  | { kind: "scene"; seconds: number; body: SceneBody }
  | { kind: "closing"; seconds: number };

const PARTS: Part[] = [
  { kind: "intro", seconds: 7 },
  { kind: "chapter", seconds: 2, number: 1, title: "Speed", line: "Big folders, loading tabs, launch and New Tab." },
  { kind: "scene", seconds: 14, body: Folders },
  { kind: "scene", seconds: 9.5, body: StopButton },
  { kind: "scene", seconds: 12, body: Launch },
  { kind: "chapter", seconds: 2, number: 2, title: "Tabs", line: "Sleep, warnings, closing, menus and glass." },
  { kind: "scene", seconds: 12, body: Sleep },
  { kind: "scene", seconds: 12.5, body: BusyAndClose },
  { kind: "scene", seconds: 10, body: MenusAndroid },
  { kind: "chapter", seconds: 2, number: 3, title: "Security", line: "The socket, plugins, links, secrets and sessions." },
  { kind: "scene", seconds: 16, body: Security },
  { kind: "chapter", seconds: 2, number: 4, title: "The ardia command", line: "Fewer calls per action, and a four-way benchmark." },
  { kind: "scene", seconds: 11, body: CliActions },
  { kind: "scene", seconds: 15, body: WebVoyager },
  { kind: "chapter", seconds: 2, number: 5, title: "CI and tooling", line: "Shorter waits and checks that fail early." },
  { kind: "scene", seconds: 11, body: CiTimes },
  { kind: "scene", seconds: 11, body: Hygiene },
  { kind: "chapter", seconds: 2, number: 6, title: "Deep cleanup", line: "Three PRs, 915 files, same behaviour." },
  { kind: "scene", seconds: 11, body: Cleanup },
  { kind: "scene", seconds: 10, body: CleanupProof },
  { kind: "closing", seconds: 9 },
];

const lengths = PARTS.map((p) => Math.round(p.seconds * FPS));
const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
const total = lengths.reduce((a, b) => a + b, 0);
const sceneCount = PARTS.filter((p) => p.kind === "scene").length;

export const meta = { width: 1920, height: 1080, fps: FPS, durationInFrames: total };

export default function OvernightWave(): ReactNode {
  let sceneIndex = 0;
  return (
    <AbsoluteFill style={{ background: color.paper }}>
      {PARTS.map((part, i) => {
        const length = lengths[i]!;
        let body: ReactNode;
        if (part.kind === "intro") body = <Intro length={length} />;
        else if (part.kind === "closing") body = <Closing length={length} />;
        else if (part.kind === "chapter") body = <Chapter number={part.number} title={part.title} line={part.line} length={length} />;
        else {
          sceneIndex += 1;
          const Body = part.body;
          body = <Body index={sceneIndex} total={sceneCount} length={length} />;
        }
        return (
          <Sequence key={i} from={starts[i]} durationInFrames={length}>
            {body}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
