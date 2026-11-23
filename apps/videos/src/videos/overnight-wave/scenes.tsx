import type { ReactNode } from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { BarRow, Chip, Legend, LEFT, Scene, Tag, clamp, color, font, label, mono, poster, serif, useGrow, useRise } from "./kit";

export interface Shown {
  index: number;
  total: number;
  length: number;
}

export function Intro({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const rise = useRise();
  const out = interpolate(frame, [length - 10, length], [1, 0], clamp);
  const stats: [string, string][] = [
    ["70", "PRs merged overnight"],
    ["47", "in ardia"],
    ["23", "in plugins"],
    ["6", "chapters"],
  ];
  return (
    <AbsoluteFill style={{ background: color.paper, opacity: out }}>
      <div style={{ position: "absolute", left: LEFT, top: 180 }}>
        <div style={{ ...label, fontSize: 24, color: color.blue, ...rise(2) }}>The night of 22 November · before and after</div>
        <div style={{ ...poster, marginTop: 18, fontSize: 176, lineHeight: 0.88, ...rise(6, 26) }}>
          The overnight
          <br />
          wave
        </div>
        <div style={{ ...serif, marginTop: 30, width: 1080, fontSize: 34, lineHeight: 1.3, color: color.ink2, ...rise(14) }}>
          Speed, tabs, security, the ardia command, CI and a deep code cleanup, merged on main while you slept.
        </div>
      </div>
      <div style={{ position: "absolute", left: LEFT, top: 800, display: "flex", gap: 70 }}>
        {stats.map(([n, t], i) => (
          <div key={t} style={rise(24 + i * 5)}>
            <div style={{ ...poster, fontSize: 96, lineHeight: 0.9, color: i === 0 ? color.blue : color.ink }}>{n}</div>
            <div style={{ ...label, fontSize: 18, marginTop: 8 }}>{t}</div>
          </div>
        ))}
      </div>
      <Img src={staticFile("brand/app-icon.png")} style={{ position: "absolute", right: 130, top: 470, width: 340, height: 340, ...rise(10) }} />
      <div style={{ ...label, position: "absolute", left: LEFT, bottom: 40, fontSize: 16, opacity: interpolate(frame, [40, 52], [0, 0.85], clamp) }}>
        Merged 06:00–13:50 UTC, 23 Nov · every number is from the merged PR or its orchestrator's measured report
      </div>
    </AbsoluteFill>
  );
}

export function Chapter({ number, title, line, length }: { number: number; title: string; line: string; length: number }) {
  const frame = useCurrentFrame();
  const rise = useRise();
  const fade = interpolate(frame, [0, 6, length - 6, length], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: color.night, opacity: fade, justifyContent: "center", paddingLeft: LEFT }}>
      <div style={{ ...label, fontSize: 24, color: color.nightInk2, ...rise(0) }}>Chapter {String(number).padStart(2, "0")} / 06</div>
      <div style={{ ...poster, marginTop: 14, fontSize: 170, lineHeight: 0.9, color: color.nightInk, ...rise(3, 24) }}>{title}</div>
      <div style={{ ...serif, marginTop: 24, fontSize: 36, color: color.nightInk2, ...rise(8) }}>{line}</div>
    </AbsoluteFill>
  );
}

export function Folders(p: Shown) {
  const frame = useCurrentFrame();
  const rise = useRise();
  const imgTop = 300;
  const imgH = 680;
  const k = imgH / 1110;
  const ring = { top: imgTop + (779 - 4) * k, h: 78 * k, left: LEFT + 12 * k, w: 352 * k };
  const pulse = interpolate(frame % 50, [0, 25, 50], [0.55, 1, 0.55]);
  const x = 470;
  return (
    <Scene
      chapter="Speed"
      {...p}
      title="Big folders open without the freeze"
      lede="Folders and tab groups open and close on Core Animation, and an open builds only the rows the window can show."
      source="#3748, closes #3660 · nested 500-tab group, compared with main · longest main-thread stall, ranges over interleaved rounds"
    >
      <div style={{ position: "absolute", left: LEFT, top: imgTop, ...rise(6) }}>
        <Img
          src={staticFile("footage/overnight-wave/sidebar.png")}
          style={{ width: 380 * k, height: imgH, borderRadius: 14, boxShadow: "0 24px 60px rgba(22,19,15,0.18), 0 0 0 1px rgba(22,19,15,0.12)" }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: ring.left - 4,
          top: ring.top - 4,
          width: ring.w + 8,
          height: ring.h + 8,
          borderRadius: 12,
          boxShadow: `0 0 0 3px ${color.blue}`,
          opacity: interpolate(frame, [26, 34], [0, 1], clamp) * pulse,
        }}
      />
      <div style={{ ...label, position: "absolute", left: LEFT + 380 * k + 18, top: ring.top + 2, width: 150, fontSize: 15, color: color.blue, ...rise(30) }}>
        200 tabs inside
      </div>
      <div style={{ ...label, position: "absolute", left: LEFT, top: imgTop + imgH + 12, fontSize: 14, ...rise(10) }}>Release build · 520 tabs</div>
      <Legend left={x} top={318} before="main" after="#3748" />
      <BarRow left={x} top={372} name="First open" note="never-opened group" before={{ lo: 488, hi: 516, text: "488–516 ms" }} after={{ lo: 63, hi: 78, text: "63–78 ms" }} max={532} delay={10} ratio="7×" ratioNote="shorter stall" nameWidth={300} barWidth={560} textWidth={190} ratioWidth={150} />
      <BarRow left={x} top={522} name="Reopen" before={{ lo: 470, hi: 532, text: "470–532 ms" }} after={{ lo: 10, hi: 21, text: "10–21 ms" }} max={532} delay={22} ratio="~30×" ratioNote="shorter stall" nameWidth={300} barWidth={560} textWidth={190} ratioWidth={150} />
      <BarRow left={x} top={672} name="Close" before={{ lo: 186, hi: 247, text: "186–247 ms" }} after={{ lo: 9, hi: 14, text: "9–14 ms" }} max={532} delay={34} ratio="~19×" ratioNote="shorter stall" nameWidth={300} barWidth={560} textWidth={190} ratioWidth={150} />
      <div style={{ position: "absolute", left: x, top: 840, width: 1240, display: "flex", gap: 22, alignItems: "baseline", ...rise(52) }}>
        <Tag after>Also</Tag>
        <div style={{ ...serif, fontSize: 27, lineHeight: 1.3 }}>
          Picking a tab while a group opens lands on the right row. Main landed about 1,900 px short. A two-tab drag started mid-fill keeps both tabs.
        </div>
      </div>
    </Scene>
  );
}

function StopGlyph() {
  const frame = useCurrentFrame();
  const breathe = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos((frame / 45) * Math.PI * 2));
  return (
    <svg width="150" height="150" viewBox="0 0 150 150">
      <circle cx="75" cy="75" r="62" fill="none" stroke={color.blue} strokeWidth="6" opacity={breathe} />
      <rect x="54" y="54" width="42" height="42" rx="6" fill={color.ink} />
    </svg>
  );
}

export function StopButton(p: Shown) {
  const rise = useRise();
  const x = 470;
  return (
    <Scene
      chapter="Speed"
      {...p}
      title="A loading tab stops waking the app"
      lede="The stop button's breathing runs on Core Animation now, so a loading tab costs what a loaded one does."
      source="#3755, closes #2523 · active tab loading, browser process, medians with ranges"
    >
      <div style={{ position: "absolute", left: LEFT + 40, top: 430, ...rise(6) }}>
        <StopGlyph />
        <div style={{ ...label, fontSize: 15, marginTop: 14, width: 200 }}>The stop button, breathing</div>
      </div>
      <Legend left={x} top={380} />
      <BarRow left={x} top={440} name="Wakeups" note="per second" before={{ lo: 132.1, hi: 141.4, text: "138.1 /s" }} after={{ lo: 1.6, text: "1.6 /s" }} max={141.4} delay={10} ratio="−99%" nameWidth={300} barWidth={600} textWidth={170} ratioWidth={170} />
      <BarRow left={x} top={620} name="CPU" note="browser process" before={{ lo: 7.8, hi: 9.16, text: "8.36 %" }} after={{ lo: 0.48, text: "0.48 %" }} max={9.16} delay={24} ratio="−94%" nameWidth={300} barWidth={600} textWidth={170} ratioWidth={170} />
      <div style={{ ...serif, position: "absolute", left: x, top: 820, width: 1240, fontSize: 29, lineHeight: 1.3, ...rise(44) }}>
        A tab that's still loading now wakes the browser 1.6 times a second, the same as a tab that has finished.
      </div>
    </Scene>
  );
}

export function Launch(p: Shown) {
  const rise = useRise();
  const grow = useGrow();
  return (
    <Scene chapter="Speed" {...p} title="Big sessions and new tabs paint sooner" source="#3783 · native-bench launch, paired medians vs main, Mac mini under load 100–220 · #3751 · J4 native-bench, interleaved bundles">
      <div style={{ position: "absolute", left: LEFT, top: 210, width: 780, ...rise(4) }}>
        <Tag after>#3783</Tag>
        <div style={{ ...poster, fontSize: 40, marginTop: 18, lineHeight: 1 }}>Launch with a big session</div>
        <div style={{ ...serif, fontSize: 25, lineHeight: 1.3, color: color.ink2, marginTop: 14 }}>
          Off-screen sidebar rows wait until the restored page has loaded, 1 s at most, so the page gets the main thread first.
        </div>
      </div>
      <div style={{ position: "absolute", left: LEFT, top: 520, display: "flex", gap: 70 }}>
        {[
          ["−598 ms", "500 tabs", "restored page first paint, 9 of 12 pairs better"],
          ["−152 ms", "200 tabs", "restored page first paint, 8 of 12 pairs better"],
        ].map(([n, t, s], i) => (
          <div key={t} style={{ width: 340, ...rise(14 + i * 8) }}>
            <div style={{ ...poster, fontSize: 92, lineHeight: 0.9, color: color.blue }}>{n}</div>
            <div style={{ ...poster, fontSize: 30, marginTop: 12 }}>{t}</div>
            <div style={{ ...label, fontSize: 15, marginTop: 8, lineHeight: 1.4 }}>{s}</div>
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 980, top: 210, width: 840, ...rise(10) }}>
        <Tag after>#3751</Tag>
        <div style={{ ...poster, fontSize: 40, marginTop: 18, lineHeight: 1 }}>⌘T, type, Enter</div>
        <div style={{ ...serif, fontSize: 25, lineHeight: 1.3, color: color.ink2, marginTop: 14 }}>
          Enter hides the New Tab page at once and removes it after the page loads, instead of tearing it down first.
        </div>
      </div>
      <Legend left={980} top={500} />
      <BarRow left={980} top={550} name="Commit" before={{ lo: 68, text: "68 ms" }} after={{ lo: 57, text: "57 ms" }} max={110} delay={24} nameWidth={190} barWidth={420} textWidth={110} />
      <BarRow left={980} top={690} name="First paint" before={{ lo: 107, text: "107 ms" }} after={{ lo: 87, text: "87 ms" }} max={110} delay={34} nameWidth={190} barWidth={420} textWidth={110} />
      <div style={{ position: "absolute", left: 980, top: 850, width: 820, ...serif, fontSize: 22, color: color.ink2, lineHeight: 1.3, opacity: grow(50) }}>
        Real but small: the PR puts it at a few to about 10 ms, noisy under machine load.
      </div>
    </Scene>
  );
}

export function Sleep(p: Shown) {
  const rise = useRise();
  const chips: [string, string][] = [
    ["Active tab", ""],
    ["Playing or heard recently", ""],
    ["Picture in picture", ""],
    ["Screen or media capture", ""],
    ["Typed input", ""],
    ["DevTools open", ""],
    ["Kept-active sites", ""],
    ["Held by an ardia session", "#3849"],
    ["Page from a form POST", "#3825"],
    ["Leave-page prompt", "#3825"],
    ["Download running", "#3825"],
  ];
  return (
    <Scene
      chapter="Tabs"
      {...p}
      title="Tabs sleep sooner, never the wrong one"
      lede="One pure sleep policy, where every protection is a named veto. The engine's own discard now respects it too."
      source="#3823 sleep policy · #3824 memory pressure · #3825 engine discard veto (macOS) · #3849 ardia session holds"
    >
      <div style={{ ...label, position: "absolute", left: LEFT, top: 300, fontSize: 18, ...rise(6) }}>Never put to sleep automatically</div>
      <div style={{ position: "absolute", left: LEFT, top: 340, width: 860, display: "flex", flexWrap: "wrap", gap: 14 }}>
        {chips.map(([c, pr], i) => (
          <div key={c} style={rise(10 + i * 2)}>
            <Chip tone={pr ? "blue" : "ink"} size={23}>
              {c}
              {pr ? <span style={{ ...label, fontSize: 13, color: color.blue, marginLeft: 10 }}>{pr}</span> : null}
            </Chip>
          </div>
        ))}
      </div>
      <div style={{ ...label, position: "absolute", left: LEFT, top: 640, fontSize: 15, color: color.blue, ...rise(36) }}>
        The policy's vetoes are #3823 · the POST, prompt and download vetoes live in the Mac engine
      </div>
      <div style={{ ...label, position: "absolute", left: 1040, top: 300, fontSize: 18, ...rise(14) }}>Under memory pressure, a hidden tab may sleep after</div>
      <Legend left={1040} top={350} />
      <BarRow left={1040} top={400} name="Warning" before={{ lo: 10, text: "10 min" }} after={{ lo: 5, text: "5 min" }} max={10} delay={20} nameWidth={170} barWidth={400} textWidth={100} />
      <BarRow left={1040} top={540} name="Critical" before={{ lo: 10, text: "10 min" }} after={{ lo: 2, text: "2 min" }} max={10} delay={30} nameWidth={170} barWidth={400} textWidth={100} />
      <div style={{ ...serif, position: "absolute", left: 1040, top: 700, width: 760, fontSize: 25, lineHeight: 1.3, color: color.ink2, ...rise(44) }}>
        A few tabs per tick, under one process-wide rate limit, and warm background pages are capped. Every protection still holds.
      </div>
      <div style={{ ...serif, position: "absolute", left: LEFT, top: 700, width: 860, fontSize: 25, lineHeight: 1.3, color: color.ink2, ...rise(40) }}>
        A tab an <span style={{ ...mono, fontSize: 22 }}>ardia browse</span> session is driving no longer falls asleep mid-task, and neither does its profile.
      </div>
    </Scene>
  );
}

function ClosePicture({ mode, left, top, delay }: { mode: "recent" | "above"; left: number; top: number; delay: number }) {
  const rise = useRise();
  const grow = useGrow();
  const rows = ["Docs", "Mail", "Closed tab", "Calendar", "Music"];
  const target = mode === "recent" ? 4 : 1;
  const rowH = 46;
  const gap = 10;
  const y = (i: number) => i * (rowH + gap) + rowH / 2;
  const g = grow(delay + 16, 20);
  const fromY = y(2);
  const toY = y(target);
  const path = `M 250 ${fromY} C 310 ${fromY}, 310 ${toY}, 250 ${toY}`;
  return (
    <div style={{ position: "absolute", left, top, width: 360, ...rise(delay) }}>
      <svg width="360" height={5 * rowH + 4 * gap} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <path d={path} fill="none" stroke={color.blue} strokeWidth="4" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - g} />
      </svg>
      {rows.map((r, i) => {
        const closed = i === 2;
        const picked = i === target;
        return (
          <div
            key={r}
            style={{
              position: "absolute",
              left: 0,
              top: i * (rowH + gap),
              width: 240,
              height: rowH,
              borderRadius: 10,
              boxSizing: "border-box",
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              fontFamily: font.serif,
              fontSize: 22,
              color: closed ? color.ink2 : picked ? color.paper : color.ink,
              background: closed ? "transparent" : picked ? `rgba(33,80,217,${0.25 + 0.75 * g})` : color.paperDeep,
              border: closed ? `2px dashed ${color.ink2}` : "none",
            }}
          >
            {r}
            {mode === "recent" && i === 4 ? <span style={{ ...label, fontSize: 12, marginLeft: "auto", color: picked && g > 0.5 ? color.paper : color.ink2 }}>used last</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function BusyAndClose(p: Shown) {
  const rise = useRise();
  return (
    <Scene chapter="Tabs" {...p} title="A warning for busy tabs, a choice after closing" source="#3851 busy background-tab warning (macOS) · #3884 + #3909 after closing a tab">
      <div style={{ position: "absolute", left: LEFT, top: 200, width: 800, ...rise(4) }}>
        <Tag after>#3851</Tag>
        <div style={{ ...serif, fontSize: 26, lineHeight: 1.3, color: color.ink2, marginTop: 16 }}>
          When a tab has been out of sight for 2 minutes and averages 0.7 of a core or more, one line offers a way out.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: LEFT,
          top: 420,
          width: 780,
          boxSizing: "border-box",
          padding: "22px 26px",
          borderRadius: 18,
          background: color.night2,
          display: "flex",
          alignItems: "center",
          gap: 16,
          boxShadow: "0 24px 60px rgba(22,19,15,0.22)",
          ...rise(14),
        }}
      >
        <div style={{ fontFamily: font.serif, fontSize: 26, color: color.nightInk, flex: 1 }}>“‹Tab›” is using a lot of power</div>
        <div style={{ fontFamily: font.serif, fontSize: 21, color: color.nightInk, padding: "8px 14px", borderRadius: 10, background: "rgba(239,232,220,0.12)" }}>Keep Running</div>
        <div style={{ fontFamily: font.serif, fontSize: 21, color: color.night, padding: "8px 14px", borderRadius: 10, background: color.nightInk }}>Sleep</div>
      </div>
      <div style={{ ...label, position: "absolute", left: LEFT, top: 520, fontSize: 14, ...rise(18) }}>The toast's approved copy · after Sleep: “‹Tab›” is asleep</div>
      <div style={{ ...serif, position: "absolute", left: LEFT, top: 600, width: 780, fontSize: 25, lineHeight: 1.35, ...rise(24) }}>
        <span style={{ ...mono, fontSize: 19 }}>Settings › Advanced › Performance</span>
        <br />
        “Warn about busy background tabs” is on by default. Off stops the watcher completely: no timer, no CPU reads.
      </div>
      <div style={{ position: "absolute", left: 1000, top: 200, width: 820, ...rise(8) }}>
        <Tag after>#3884 · #3909</Tag>
        <div style={{ ...serif, fontSize: 26, lineHeight: 1.3, color: color.ink2, marginTop: 16 }}>
          Choose which tab comes forward after you close one, as a picture choice in <span style={{ ...mono, fontSize: 20 }}>Settings › Appearance › Switching tabs</span>.
        </div>
      </div>
      <ClosePicture mode="recent" left={1000} top={420} delay={20} />
      <ClosePicture mode="above" left={1420} top={420} delay={30} />
      <div style={{ position: "absolute", left: 1000, top: 720, width: 360, ...rise(26) }}>
        <div style={{ ...poster, fontSize: 28 }}>Previously active</div>
        <div style={{ ...label, fontSize: 14, marginTop: 6 }}>the default, as before</div>
      </div>
      <div style={{ position: "absolute", left: 1420, top: 720, width: 400, ...rise(36) }}>
        <div style={{ ...poster, fontSize: 28 }}>Tab above</div>
        <div style={{ ...label, fontSize: 14, marginTop: 6 }}>“Tab to the left” with tabs on top</div>
      </div>
    </Scene>
  );
}

export function MenusAndroid(p: Shown) {
  const rise = useRise();
  const subs = ["Move to", "Customize", "Shared Folder", "Filters", "Sources", "Arrange", "Open in"];
  return (
    <Scene chapter="Tabs" {...p} title="Shorter menus, real glass on Android" source="#3820 context menus, menu bar and Settings copy (78 files, +1,217 / −756) · #3759 Android Liquid Glass">
      <div style={{ position: "absolute", left: LEFT, top: 260, width: 820, ...rise(4) }}>
        <Tag after size={19}>
          #3820
        </Tag>
        <div style={{ ...poster, fontSize: 48, marginTop: 22, lineHeight: 1 }}>Menus</div>
        <div style={{ ...serif, fontSize: 31, lineHeight: 1.32, marginTop: 16 }}>
          Rows you rarely use leave the context menus and stay reachable in Settings, the command bar or the menu bar. Every menu keeps its SF Symbols.
        </div>
        <div style={{ ...label, fontSize: 17, marginTop: 40 }}>New submenus</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 16 }}>
          {subs.map((s, i) => (
            <div key={s} style={rise(16 + i * 3)}>
              <Chip size={27}>{s}</Chip>
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", left: 1040, top: 260, width: 780, ...rise(10) }}>
        <Tag after size={19}>
          #3759
        </Tag>
        <div style={{ ...poster, fontSize: 48, marginTop: 22, lineHeight: 1 }}>Android glass</div>
        <div style={{ ...serif, fontSize: 31, lineHeight: 1.32, marginTop: 16 }}>
          A Liquid Glass lens and rim light ported from liquid-dom: a squircle bezel that refracts each colour channel, chained after the frost's blur.
        </div>
        <div style={{ display: "flex", gap: 50, marginTop: 40 }}>
          {[
            ["1.5", "index of refraction, ± 0.04 per channel"],
            ["13+", "Android, as a RuntimeShader"],
          ].map(([n, t], i) => (
            <div key={t} style={{ width: 320, ...rise(24 + i * 6) }}>
              <div style={{ ...poster, fontSize: 110, lineHeight: 0.9, color: color.blue }}>{n}</div>
              <div style={{ ...label, fontSize: 16, marginTop: 12, lineHeight: 1.4 }}>{t}</div>
            </div>
          ))}
        </div>
        <div style={{ ...serif, fontSize: 27, color: color.ink2, marginTop: 30, ...rise(36) }}>Native Glass stays the default.</div>
      </div>
    </Scene>
  );
}

interface Guard {
  title: string;
  prs: string;
  before: string;
  now: string;
}

const GUARDS: Guard[] = [
  { title: "Control socket", prs: "#3839 · #3908", before: "Any process running as you got in.", now: "Checks the program's code identity and asks you first." },
  { title: "DevTools token", prs: "#3908 · #3848", before: "The token server answered browser-sent requests and any Host.", now: "Both refused; the socket hands the token only to programs it let in." },
  { title: "Plugin sandbox", prs: "#3838", before: "Seatbelt started from allow default.", now: "Deny by default, with ZIP caps: 1 GB expanded, 100× ratio." },
  { title: "Plugin consent", prs: "#3847 · #3879", before: "Every official pin bump waited for a click.", now: "Full control is disclosed first; updates asking for nothing new just install." },
  { title: "Clean links", prs: "#3807", before: "Copy, share and email could skip tracker stripping.", now: "A raw string at those sinks is a compile error. The address bar copies as shown." },
  { title: "Secrets", prs: "#3833", before: "Passwords, tokens and the recovery phrase were plain strings in JS.", now: "Branded Secret<kind>: telemetry, logs, sync and the socket refuse it." },
  { title: "Sessions", prs: "#3821", before: "A damaged session.json read as empty, then got saved over.", now: "Kept aside first, then restored from immutable daily backups." },
  { title: "Hosts", prs: "#3811", before: "Nothing checked a new hard-coded host.", now: "docs/privacy.md lists every host; a test fails on any other." },
];

export function Security(p: Shown) {
  const rise = useRise();
  const cardW = 405;
  const cardH = 330;
  const gap = 20;
  return (
    <Scene chapter="Security" {...p} title="Locks on every door" lede="Eight guards, each now enforced by code or a test rather than by convention." source="Track S · all merged · each card names its PRs">
      {GUARDS.map((g, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return (
          <div
            key={g.title}
            style={{
              position: "absolute",
              left: LEFT + col * (cardW + gap),
              top: 270 + row * (cardH + gap),
              width: cardW,
              height: cardH,
              boxSizing: "border-box",
              padding: "22px 24px",
              borderRadius: 16,
              background: color.paperDeep,
              boxShadow: "0 0 0 1px rgba(22,19,15,0.08)",
              ...rise(8 + i * 4),
            }}
          >
            <div style={{ ...poster, fontSize: 32 }}>{g.title}</div>
            <div style={{ ...label, fontSize: 14, color: color.blue, marginTop: 6 }}>{g.prs}</div>
            <div style={{ marginTop: 16 }}>
              <Tag size={13}>Before</Tag>
              <div style={{ ...serif, fontSize: 21, lineHeight: 1.28, color: color.ink2, marginTop: 8 }}>{g.before}</div>
            </div>
            <div style={{ marginTop: 16 }}>
              <Tag after size={13}>
                Now
              </Tag>
              <div style={{ ...serif, fontSize: 21, lineHeight: 1.28, marginTop: 8 }}>{g.now}</div>
            </div>
          </div>
        );
      })}
    </Scene>
  );
}

export function CliActions(p: Shown) {
  const x = LEFT;
  const rows: { name: string; note: string; before: number; after: number; bt: string; at: string; ratio: string; unit: string }[] = [
    { name: "Click", note: "CDP calls · plugins#92", before: 31, after: 11, bt: "31 calls", at: "11 calls", ratio: "2.8×", unit: "fewer calls" },
    { name: "Click", note: "total time, p50 · plugins#92", before: 265, after: 112, bt: "265 ms", at: "112 ms", ratio: "2.4×", unit: "faster" },
    { name: "5 fills, batched", note: "CDP calls · plugins#92", before: 164, after: 60.5, bt: "164 calls", at: "60.5 calls", ratio: "2.7×", unit: "fewer calls" },
    { name: "Script, 60 reads", note: "Promise.all · plugins#89", before: 2659, after: 627, bt: "2,659 ms", at: "627 ms", ratio: "4.2×", unit: "faster" },
    { name: "read on HF models", note: "line of the first result · plugins#119", before: 110, after: 21, bt: "line 110", at: "line 21", ratio: "−89", unit: "lines to scroll" },
  ];
  return (
    <Scene
      chapter="The ardia command"
      {...p}
      title="Every browse action does less"
      lede="One page call per pointer action, reads that run side by side, and filter lists folded to one line."
      ledeWidth={1600}
      source="Hidden Ardia 0.2.48, p50 over 10 runs, old and new binaries alternating · CDP counts are exact; ms are noisy under shared load"
    >
      <Legend left={x + 404} top={262} before="Before" after="Now" />
      {rows.map((r, i) => (
        <BarRow
          key={`${r.name}${r.note}`}
          left={x}
          top={300 + i * 132}
          name={r.name}
          note={r.note}
          before={{ lo: r.before, text: r.bt }}
          after={{ lo: r.after, text: r.at }}
          max={r.before}
          delay={8 + i * 8}
          ratio={r.ratio}
          ratioNote={r.unit}
          nameWidth={380}
          barWidth={760}
          textWidth={200}
          ratioWidth={260}
        />
      ))}
    </Scene>
  );
}

export function WebVoyager(p: Shown) {
  const rise = useRise();
  const grow = useGrow();
  const rows: { name: string; runs: string; time: number; tlo?: number; thi?: number; tok: number; tt: string; kt: string; ink: string }[] = [
    { name: "OpenCode Browse 0.1.5", runs: "1 run", time: 308.0, tok: 482.9, tt: "308.0 s", kt: "482.9k tok", ink: color.ink2 },
    { name: "Ardia Python 0.4.0", runs: "1 run", time: 100.3, tok: 137.1, tt: "100.3 s", kt: "137.1k tok", ink: color.ink2 },
    { name: "Ardia Bun 0.6.0", runs: "4 runs · median", time: 92.4, tlo: 80.2, thi: 128.0, tok: 127.1, tt: "92.4 s", kt: "127.1k tok", ink: color.ink },
    { name: "Final TypeScript CLI", runs: "5 runs · median", time: 96.6, tlo: 90.2, thi: 124.1, tok: 137.8, tt: "96.6 s", kt: "137.8k tok", ink: color.blue },
  ];
  const tasks: [string, number, number][] = [
    ["GitHub", 17.7, 15.2],
    ["Allrecipes", 13.7, 11.4],
    ["Coursera", 24.1, 18.0],
    ["ESPN", 15.7, 16.2],
    ["Cambridge", 9.6, 11.6],
    ["Hugging Face", 12.0, 21.7],
  ];
  const barW = 420;
  return (
    <Scene
      chapter="The ardia command"
      {...p}
      title="Six WebVoyager tasks, four CLIs"
      lede="Every run passed 6 of 6. The final CLI is within noise of Bun 0.6.0, at about a third of OpenCode Browse's time and tokens."
      ledeWidth={1600}
      source="Orchestrator #5's interleaved bench · single runs swung up to ~40% · final CLI from plugins main 8a94ee95 on a Release build of ardia main"
    >
      <div style={{ ...label, position: "absolute", left: LEFT + 360, top: 282, fontSize: 15, ...rise(6) }}>wall-clock · range shown pale</div>
      <div style={{ ...label, position: "absolute", left: LEFT + 360 + barW + 150, top: 282, fontSize: 15, ...rise(6) }}>tokens</div>
      {rows.map((r, i) => {
        const g = grow(10 + i * 7);
        const top = 320 + i * 150;
        const scale = barW / 320;
        return (
          <div key={r.name} style={{ position: "absolute", left: LEFT, top, ...rise(8 + i * 7) }}>
            <div style={{ width: 340 }}>
              <div style={{ ...poster, fontSize: 30, lineHeight: 1.02, color: r.ink === color.blue ? color.blue : color.ink }}>{r.name}</div>
              <div style={{ ...label, fontSize: 14, marginTop: 6 }}>{r.runs}</div>
            </div>
            <div style={{ position: "absolute", left: 360, top: 6, width: barW, height: 30 }}>
              {r.thi ? <div style={{ position: "absolute", left: (r.tlo ?? 0) * scale * g, width: ((r.thi - (r.tlo ?? 0)) * scale) * g, height: 30, background: r.ink, opacity: 0.22, borderRadius: 6 }} /> : null}
              <div style={{ position: "absolute", left: 0, width: r.time * scale * g, height: 30, background: r.ink, borderRadius: 6 }} />
            </div>
            <div style={{ ...mono, position: "absolute", left: 360, top: 46, fontSize: 21, fontWeight: 560, color: r.ink, opacity: g, whiteSpace: "nowrap" }}>{r.tt}</div>
            <div style={{ position: "absolute", left: 360 + barW + 150, top: 6, width: 260, height: 30 }}>
              <div style={{ position: "absolute", left: 0, width: (r.tok / 482.9) * 260 * g, height: 30, background: r.ink, opacity: 0.75, borderRadius: 6 }} />
            </div>
            <div style={{ ...mono, position: "absolute", left: 360 + barW + 150, top: 46, fontSize: 21, fontWeight: 560, color: r.ink, opacity: g, whiteSpace: "nowrap" }}>{r.kt}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 1330, top: 282, width: 490, ...rise(30) }}>
        <div style={{ display: "flex", ...label, fontSize: 15 }}>
          <div style={{ width: 210 }}>Task, median</div>
          <div style={{ width: 140, textAlign: "right" }}>Bun 0.6.0</div>
          <div style={{ width: 140, textAlign: "right", color: color.blue }}>Final</div>
        </div>
        {tasks.map(([t, a, b], i) => {
          const faster = b < a;
          return (
            <div key={t} style={{ display: "flex", alignItems: "baseline", borderBottom: `1.5px solid ${color.rule}`, padding: "13px 0", ...rise(34 + i * 3) }}>
              <div style={{ ...serif, width: 210, fontSize: 25 }}>{t}</div>
              <div style={{ ...mono, width: 140, textAlign: "right", fontSize: 21, color: color.ink2 }}>{a.toFixed(1)} s</div>
              <div style={{ ...mono, width: 140, textAlign: "right", fontSize: 21, fontWeight: faster ? 700 : 460, color: faster ? color.blue : color.stamp }}>{b.toFixed(1)} s</div>
            </div>
          );
        })}
        <div style={{ ...serif, fontSize: 21, lineHeight: 1.3, color: color.ink2, marginTop: 18, ...rise(56) }}>
          Hugging Face's gap was its 90-row filter list. plugins#119, merged after this run, moves the first model from line 110 to 21.
        </div>
      </div>
    </Scene>
  );
}

export function CiTimes(p: Shown) {
  const rows: { name: string; note: string; before: [number, number?]; after: [number, number?]; bt: string; at: string; ratio: string }[] = [
    { name: "Perf gate", note: "candidate → publish · #3770", before: [90, 100], after: [45], bt: "~90–100 min", at: "~45 min", ratio: "2×" },
    { name: "Ratchet baseline", note: "#3875", before: [1098.7], after: [295.7], bt: "1,098.7 s", at: "295.7 s", ratio: "3.7×" },
    { name: "Plugins docs-only PR", note: "plugins#98", before: [23], after: [0.55], bt: "~23 min", at: "33 s", ratio: "42×" },
    { name: "Plugins macOS TS job", note: "plugins#98", before: [13.5], after: [2.3], bt: "13.5 min", at: "2.3 min", ratio: "5.9×" },
    { name: "PR bots' API calls", note: "per team PR push, worst case · #3882", before: [100], after: [26], bt: "up to ~100", at: "up to 1 + ~25", ratio: "~4×" },
  ];
  return (
    <Scene
      chapter="CI and tooling"
      {...p}
      title="Same verdicts, less waiting"
      lede="Each pair is drawn against its own before. The gates give the same verdicts; only the wait shrank."
      source="#3770 wall time 0.2.47 vs 0.2.48 · #3875 median of 3, interleaved · plugins#98 last 97 PR runs vs test branches · #3882 GITHUB_TOKEN calls per check"
    >
      <Legend left={LEFT + 404} top={262} before="Before" after="Now" />
      {rows.map((r, i) => {
        const max = r.before[1] ?? r.before[0];
        return (
          <BarRow
            key={r.name}
            left={LEFT}
            top={300 + i * 132}
            name={r.name}
            note={r.note}
            before={{ lo: r.before[0], hi: r.before[1], text: r.bt }}
            after={{ lo: r.after[0], hi: r.after[1], text: r.at }}
            max={max}
            delay={8 + i * 8}
            ratio={r.ratio}
            ratioNote={r.name === "PR bots' API calls" ? "fewer" : "faster"}
            nameWidth={380}
            barWidth={720}
            textWidth={270}
            ratioWidth={200}
          />
        );
      })}
    </Scene>
  );
}

export function Hygiene(p: Shown) {
  const rise = useRise();
  const items: [string, string, string][] = [
    ["#3801", "Every engine patch says why", "why it exists and when it can go, checked by a test"],
    ["#3817", "Checkout-free series check", "every patch applies with zero fuzz to the published base"],
    ["#3800", "Engine-match stamp", "the app records its engine and fails fast on a mismatch"],
    ["#3806", "Sparkle deltas", "an update no longer always downloads the whole ~190 MB zip"],
    ["#3798", "One-second preflight", "stale build, bad notes or a broken feed fail before any runner"],
    ["#3810", "promises.lock", "168 regression tests for 85 closed bugs, locked"],
    ["#3819", "Conventions, repo-wide", "no comments, no bare sleeps, dated skips, across the repo"],
  ];
  return (
    <Scene chapter="CI and tooling" {...p} title="Engine and release safety" lede="Seven checks that fail early, before a build, a runner or a user finds the problem." source="All merged overnight · engine checks run without a Chromium checkout">
      {items.map(([pr, t, s], i) => {
        const col = i < 4 ? 0 : 1;
        const row = i < 4 ? i : i - 4;
        return (
          <div key={pr} style={{ position: "absolute", left: LEFT + col * 880, top: 290 + row * 170, width: 820, display: "flex", gap: 24, ...rise(8 + i * 5) }}>
            <div style={{ ...mono, width: 110, fontSize: 22, fontWeight: 600, color: color.blue, paddingTop: 6 }}>{pr}</div>
            <div style={{ width: 680 }}>
              <div style={{ ...poster, fontSize: 36, lineHeight: 1 }}>{t}</div>
              <div style={{ ...serif, fontSize: 25, lineHeight: 1.3, color: color.ink2, marginTop: 8 }}>{s}</div>
            </div>
          </div>
        );
      })}
    </Scene>
  );
}

export function Cleanup(p: Shown) {
  const rise = useRise();
  const grow = useGrow();
  const stats: [string, string, string][] = [
    ["915", "files touched", "across 3 PRs"],
    ["−827", "net lines", "+2,290 / −3,117"],
    ["~180", "dead symbols removed", "and 5 dead files"],
    ["~1,600", "exports made private", "used only in their own file"],
    ["11", "shared helpers", "replace ~25 copies and 33 inline reads"],
    ["0", "engine keys moved", "behaviour-preserving by design"],
  ];
  const prs: [string, string, number, number][] = [
    ["#3921", "dead TS across UI, state, packages, Linux", 1637, 1954],
    ["#3923", "duplicated helpers, one shared copy each", 308, 310],
    ["#3925", "dead native Mac and script code", 345, 853],
  ];
  const maxDel = 1954 + 1637;
  return (
    <Scene chapter="Deep cleanup" {...p} title="Less code, same behaviour" source="#3921 · #3923 · #3925 · closes #3913, #3914, #3915 · line counts from GitHub, files from git">
      {stats.map(([n, t, s], i) => (
        <div key={t} style={{ position: "absolute", left: LEFT + (i % 3) * 580, top: 220 + Math.floor(i / 3) * 230, width: 540, ...rise(6 + i * 5) }}>
          <div style={{ ...poster, fontSize: 100, lineHeight: 0.88, color: i === 1 || i === 5 ? color.blue : color.ink }}>{n}</div>
          <div style={{ ...poster, fontSize: 30, marginTop: 10 }}>{t}</div>
          <div style={{ ...label, fontSize: 15, marginTop: 6 }}>{s}</div>
        </div>
      ))}
      {prs.map(([pr, t, add, del], i) => {
        const g = grow(40 + i * 6);
        const w = 900;
        return (
          <div key={pr} style={{ position: "absolute", left: LEFT, top: 720 + i * 82, display: "flex", alignItems: "center", gap: 22, ...rise(36 + i * 6) }}>
            <div style={{ ...mono, width: 100, fontSize: 21, fontWeight: 600, color: color.blue }}>{pr}</div>
            <div style={{ ...serif, width: 470, fontSize: 23 }}>{t}</div>
            <div style={{ display: "flex", width: w, height: 26 }}>
              <div style={{ width: (add / maxDel) * w * g, background: color.blue, opacity: 0.85, borderRadius: "6px 0 0 6px" }} />
              <div style={{ width: (del / maxDel) * w * g, background: color.stamp, borderRadius: "0 6px 6px 0" }} />
            </div>
            <div style={{ ...mono, fontSize: 19, color: color.ink2, opacity: g, whiteSpace: "nowrap" }}>
              +{add.toLocaleString("en-US")} −{del.toLocaleString("en-US")}
            </div>
          </div>
        );
      })}
    </Scene>
  );
}

export function CleanupProof(p: Shown) {
  const rise = useRise();
  const checks: [string, string][] = [
    ["12 / 12", "typechecks"],
    ["6,524 / 6,524", "browser tests"],
    ["418 / 418", "script tests"],
    ["6 / 6 · 966", "Linux test:graph · test:host"],
    ["2 / 2", "Mac and Windows Metro bundles"],
    ["Codex", "approved every part"],
  ];
  const code = (text: string, tone: "minus" | "plus") => (
    <div
      style={{
        ...mono,
        fontSize: 21,
        lineHeight: 1.5,
        color: tone === "minus" ? "#F0A08F" : "#9DB6FF",
        background: tone === "minus" ? "rgba(195,55,31,0.16)" : "rgba(33,80,217,0.22)",
        padding: "10px 18px",
        borderRadius: 8,
        whiteSpace: "pre",
      }}
    >
      {text}
    </div>
  );
  return (
    <Scene chapter="Deep cleanup" {...p} title="One helper instead of 33 inline checks" source="#3923 · apps/browser/src/lib/decode.ts ownValue · checks from the PRs' own runs on main">
      <div style={{ position: "absolute", left: LEFT, top: 210, width: 1060, padding: "30px 32px", boxSizing: "border-box", borderRadius: 18, background: color.night, ...rise(4) }}>
        <div style={{ ...label, fontSize: 15, color: color.nightInk2, marginBottom: 16 }}>A real hunk from #3923, bookmark lookup, reflowed</div>
        {code(`- const node = typeof value === "string" &&\n-   Object.hasOwn(s.bookmarks.nodes, value)\n-   ? s.bookmarks.nodes[value] : undefined;`, "minus")}
        <div style={{ height: 14 }} />
        {code(`+ const node = ownValue(s.bookmarks.nodes, value);`, "plus")}
        <div style={{ ...serif, fontSize: 23, lineHeight: 1.35, color: color.nightInk2, marginTop: 22 }}>
          That guard was spelled out inline 33 times. Now one tested helper does it, prototype keys and non-string keys included.
        </div>
      </div>
      <div style={{ position: "absolute", left: 1240, top: 210, width: 580 }}>
        <div style={{ ...label, fontSize: 16, ...rise(10) }}>Verified on main</div>
        {checks.map(([n, t], i) => (
          <div key={t} style={{ display: "flex", alignItems: "baseline", gap: 18, borderBottom: `1.5px solid ${color.rule}`, padding: "16px 0", ...rise(14 + i * 5) }}>
            <div style={{ ...poster, fontSize: 36, color: color.blue, width: 250 }}>{n}</div>
            <div style={{ ...serif, fontSize: 24 }}>{t}</div>
          </div>
        ))}
      </div>
      <div style={{ ...serif, position: "absolute", left: LEFT, top: 760, width: 1060, fontSize: 25, lineHeight: 1.35, color: color.ink2, ...rise(40) }}>
        Also: one PNG codec replaces 7 copied ones, one median replaces 10, and two dead Linux bring-up scripts are gone.
      </div>
    </Scene>
  );
}

export function Closing({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const rise = useRise();
  const out = interpolate(frame, [length - 12, length], [1, 0], clamp);
  const queued: [string, string][] = [
    ["#3754", "Windows: the shared desktop UI on Chromium WebUI, a pilot"],
    ["#3844", "Windows: background tab renderers in efficiency mode"],
    ["#3886", "A private window reads other profiles' favicons read-only"],
    ["#3866", "Linux: site domains reach the engine for the ad blocker"],
  ];
  return (
    <AbsoluteFill style={{ background: color.paper, opacity: out }}>
      <div style={{ position: "absolute", left: LEFT, top: 120 }}>
        <div style={{ ...label, fontSize: 22, color: color.blue, ...rise(0) }}>Good morning</div>
        <div style={{ ...poster, fontSize: 130, lineHeight: 0.9, marginTop: 14, ...rise(4, 24) }}>
          70 merged.
          <br />
          4 waiting on Boat.
        </div>
      </div>
      <div style={{ position: "absolute", left: LEFT, top: 520, width: 1100 }}>
        <div style={{ ...label, fontSize: 16, ...rise(14) }}>Open, queued for Boat's rolling VM window</div>
        {queued.map(([pr, t], i) => (
          <div key={pr} style={{ display: "flex", gap: 24, alignItems: "baseline", borderBottom: `1.5px solid ${color.rule}`, padding: "14px 0", ...rise(18 + i * 4) }}>
            <div style={{ ...mono, width: 100, fontSize: 21, fontWeight: 600, color: color.blue }}>{pr}</div>
            <div style={{ ...serif, fontSize: 26 }}>{t}</div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 18, alignItems: "baseline", marginTop: 30, ...rise(40) }}>
          <Tag>Needs you</Tag>
          <div style={{ ...serif, fontSize: 25 }}>#3929 takes the DevTools token off disk; it waits on a cli-v0.7.0 release.</div>
        </div>
      </div>
      <Img src={staticFile("brand/app-icon.png")} style={{ position: "absolute", right: 170, top: 330, width: 360, height: 360, ...rise(10) }} />
    </AbsoluteFill>
  );
}

export type SceneBody = (p: Shown) => ReactNode;
