import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const { analyzeTrace, MAX_TRACE_EVENTS } = await import("./devToolsInsights.ts");
const { describeIssues, describeIssue } = await import("./devToolsIssues.ts");
const { parseSourceMap, originalPositionFor, generatedPositionFor, sourceMapRefOf, mapLocation, SourceMapResolver } = await import("./devToolsSourceMaps.ts");
const { chainOf, framesOfStack, resolveChain, CAUSE_CHAIN_FUNCTION } = await import("./devToolsStacks.ts");
const { cascadeFor, declaredProperties, estimateSpecificity, headerOf } = await import("./devToolsCascade.ts");
const { logpointCondition, checkedExpression } = await import("./devToolsLogpoints.ts");
const { InspectionSession, liveInspectionSessions } = await import("./devToolsSession.ts");
const { recordTrace } = await import("./devToolsTrace.ts");
const { fetchFieldData, fieldDataKey } = await import("./devToolsFieldData.ts");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/devtools/${name}`, import.meta.url), "utf8"));

test("a page-load trace gives Core Web Vitals, the LCP phases and each insight's culprits", () => {
  const result = analyzeTrace(fixture("trace-load.json"));
  assert.deepEqual(result.navigation, { url: "https://shop.example/", navigationId: "N1" });
  assert.deepEqual(result.metrics, {
    fcp: { ms: 1000, rating: "good" },
    lcp: { ms: 2600, rating: "needs-improvement" },
    ttfb: { ms: 655, rating: "good" },
    tbt: { ms: 170, rating: "good" },
    inp: { ms: 320, rating: "needs-improvement" },
    cls: { value: 0.13, rating: "needs-improvement" },
  });
  const byId = Object.fromEntries(result.insights.map((i) => [i.id, i]));
  assert.deepEqual(byId["lcp-breakdown"].details.phases, { ttfbMs: 655, loadDelayMs: 545, loadDurationMs: 1200, renderDelayMs: 200 });
  assert.equal(byId["lcp-breakdown"].details.element.url, "https://cdn.shop.example/hero.jpg");
  assert.match(byId["lcp-breakdown"].summary, /loadDuration/);
  assert.deepEqual(byId["cls-culprits"].details.culprits.map((c) => [c.atMs, c.score, c.nodeIds]), [[1320, 0.08, [7, 9]], [1500, 0.05, [11]]], "the shift with recent input and the ad frame's shift don't count");
  assert.equal(byId["cls-culprits"].details.culprits[0].likelyCauses[0].kind, "web-font");
  assert.deepEqual(byId["inp-breakdown"].details.phases, { inputDelayMs: 150, processingMs: 130, presentationMs: 40 });
  assert.deepEqual(byId["long-tasks"].details.tasks.map((t) => [t.durationMs, t.attribution?.activity]), [[180, "EvaluateScript"], [90, "FunctionCall"]], "another process's and a worker thread's tasks don't count");
  assert.equal(byId["long-tasks"].details.tasks[1].attribution.functionName, "onBuyClick");
  assert.deepEqual(byId["render-blocking"].details.requests.map((r) => r.url), ["https://shop.example/site.css"]);
  assert.equal(byId["render-blocking"].savingsMs, 245);
  assert.equal(byId["document-latency"].rating, "good");
  assert.equal(byId["network-bottlenecks"].details.slowest[0].url, "https://cdn.shop.example/hero.jpg");
  assert.deepEqual(result.counts, { events: 43, requests: 5, layoutShifts: 3, interactions: 2, longTasks: 2 });
  assert.equal(result.truncated, false);
});

test("each analysis builds a fresh model, so a second trace never sees the first one's events", () => {
  const trace = fixture("trace-load.json");
  const first = analyzeTrace(trace);
  const empty = analyzeTrace({ traceEvents: [] });
  assert.equal(empty.metrics.lcp, null);
  assert.equal(empty.counts.events, 0);
  assert.deepEqual(empty.insights, []);
  assert.deepEqual(analyzeTrace(trace), first);
});

test("hostile trace input never throws and stays bounded", () => {
  const weird = [null, 1, "x", [], { name: 5 }, { name: "RunTask", ts: "nope" }, { name: "LayoutShift", ts: 1, args: { data: { score: Infinity } } }, { name: "__proto__", ts: 2, args: "x" }, { name: "EventTiming", ph: "b", ts: 3, args: { data: { interactionId: -1, duration: 9e99 } } }];
  for (const input of [undefined, null, 42, "trace", { traceEvents: "x" }, weird, { traceEvents: weird }]) {
    const result = analyzeTrace(input);
    assert.equal(typeof result.metrics.cls.value, "number");
  }
  const long = { traceEvents: { length: MAX_TRACE_EVENTS + 1 } };
  assert.equal(analyzeTrace(long).counts.events, 0);
  assert.equal({}.polluted, undefined);
});

const ISSUES = fixture("audits-issues.json");

test("DevTools Issues are explained with a fix and their affected request, element, source and cookie, never a cookie value", () => {
  const { issues, byKind, dropped } = describeIssues(ISSUES);
  assert.equal(dropped, 0);
  assert.deepEqual(byKind, { cookie: 2, cors: 1, csp: 1, "mixed-content": 1, deprecation: 1, other: 1 });
  const cookie = issues.find((i) => i.reasons.includes("ExcludeSameSiteUnspecifiedTreatedAsLax"));
  assert.equal(cookie.severity, "error");
  assert.match(cookie.explanation, /SameSite=Lax/);
  assert.match(cookie.fix, /SameSite=None; Secure/);
  assert.deepEqual(cookie.affected.cookie, { name: "session", domain: "api.shop.example", path: "/" });
  assert.equal(cookie.affected.request.url, "https://api.shop.example/cart");
  assert.ok(!JSON.stringify(issues).includes("s3cr3t-value"), "the raw cookie line never comes back");
  const cors = issues.find((i) => i.kind === "cors");
  assert.match(cors.explanation, /different origin/);
  assert.match(cors.explanation, /https:\/\/evil\.example/);
  const csp = issues.find((i) => i.kind === "csp");
  assert.deepEqual(csp.affected.source, { url: "https://shop.example/", line: 41, column: 8 });
  assert.equal(csp.affected.nodeId, 88);
  assert.equal(issues.find((i) => i.kind === "mixed-content").severity, "error");
  assert.equal(issues[issues.length - 1].severity, "info");
  assert.equal(describeIssue({ issue: { code: "Bad Code!", details: {} } }), null);
  assert.equal(describeIssue("x"), null);
});

function vlq(value) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += chars[digit];
  } while (v > 0);
  return out;
}

function encode(lines) {
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  return lines
    .map((segments) => {
      let col = 0;
      return segments
        .map(([c, s, l, sc, n]) => {
          let out = vlq(c - col) + vlq(s - src) + vlq(l - srcLine) + vlq(sc - srcCol);
          col = c, src = s, srcLine = l, srcCol = sc;
          if (n !== undefined) out += vlq(n - name), (name = n);
          return out;
        })
        .join(",");
    })
    .join(";");
}

const MINIFIED_MAP = { version: 3, file: "app.min.js", sourceRoot: "", sources: ["webpack:///src/cart.ts", "webpack:///src/util/money.ts"], names: ["addToCart", "formatPrice"], mappings: encode([[[0, 0, 0, 0], [14, 0, 11, 2, 0], [60, 1, 4, 9, 1]], [[0, 1, 20, 0]]]) };

test("a source map maps generated positions back to the original source and original lines forward", () => {
  const map = parseSourceMap(JSON.stringify(MINIFIED_MAP));
  assert.deepEqual(originalPositionFor(map, 0, 20), { source: "webpack:///src/cart.ts", line: 12, column: 3, name: "addToCart" });
  assert.deepEqual(originalPositionFor(map, 0, 75), { source: "webpack:///src/util/money.ts", line: 5, column: 10, name: "formatPrice" });
  assert.equal(originalPositionFor(map, 5, 0), null);
  assert.deepEqual(generatedPositionFor(map, "src/cart.ts", 12, null), { line: 0, column: 14 });
  assert.deepEqual(generatedPositionFor(map, "src/util/money.ts", 21, null), { line: 1, column: 0 });
  assert.equal(generatedPositionFor(map, "src/missing.ts", 1, null), null);
  const index = parseSourceMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: MINIFIED_MAP }, { offset: { line: 10, column: 0 }, map: MINIFIED_MAP }] });
  assert.deepEqual(originalPositionFor(index, 10, 20), { source: "webpack:///src/cart.ts", line: 12, column: 3, name: "addToCart" });
  for (const bad of [null, "{", { version: 2 }, { version: 3, mappings: "!!!" }, { version: 3, mappings: "gggggggggggggggggggggggggggggggggggg" }]) assert.equal(parseSourceMap(bad), null);
});

test("a TypeScript-compiled inline source map resolves a thrown error's stack to the .ts line, with its Error.cause chain", async () => {
  const source = ["type Money = number;", "", "export function charge(amount: Money): Money {", "  const fee: Money = amount * 0.03;", "  if (fee > 10) {", '    throw new Error("fee too high", { cause: new RangeError("amount out of range") });', "  }", "  return amount + fee;", "}"].join("\n");
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, inlineSourceMap: true, inlineSources: true }, fileName: "src/charge.ts" }).outputText;
  const ref = sourceMapRefOf(out);
  assert.match(ref, /^data:application\/json;base64,/);
  const lines = out.split("\n");
  const throwLine = lines.findIndex((l) => l.includes("throw new Error"));
  const throwColumn = lines[throwLine].indexOf("throw") + 1;
  const scriptUrl = "https://shop.example/assets/charge.js";
  const stack = `Error: fee too high\n    at charge (${scriptUrl}:${throwLine + 1}:${throwColumn})\n    at async checkout (${scriptUrl}:40:3)`;
  const chain = chainOf({ error: { name: "Error", message: "fee too high", stack, cause: { name: "RangeError", message: "amount out of range", stack: `RangeError: amount out of range\n    at charge (${scriptUrl}:${throwLine + 1}:${throwColumn + 40})` } } });
  assert.deepEqual(chain.map((l) => [l.name, l.message, l.frames.length]), [["Error", "fee too high", 2], ["RangeError", "amount out of range", 1]]);
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    return { ok: true, headers: new Map(), text: async () => out };
  };
  const resolver = new SourceMapResolver({ allowFetch: true, fetchFn });
  const resolved = await resolveChain(chain, resolver);
  assert.deepEqual(resolved[0].frames[0].original && [resolved[0].frames[0].original.source, resolved[0].frames[0].original.line], ["charge.ts", 6]);
  assert.equal(resolved[0].frames[1].async, "await");
  assert.equal(resolved[1].frames[0].original.line, 6);
  assert.deepEqual(fetched, [scriptUrl], "one fetch per script, then the parsed map is reused");
  assert.equal(resolver.resolvedCount, 1);
});

test("source maps are fetched only from the script's own origin over http(s), without cookies or redirects", async () => {
  assert.equal(mapLocation("https://shop.example/a.js", "https://evil.example/a.js.map"), null);
  assert.equal(mapLocation("https://shop.example/a.js", "file:///etc/passwd"), null);
  assert.equal(mapLocation("https://shop.example/a.js", "javascript:alert(1)"), null);
  assert.equal(mapLocation("chrome://settings/a.js", "a.js.map"), null);
  assert.deepEqual(mapLocation("https://shop.example/js/a.js", "../maps/a.js.map"), { kind: "remote", url: "https://shop.example/maps/a.js.map" });
  assert.equal(mapLocation("https://shop.example/a.js", "data:application/json;base64,!!!"), null);
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push([url, init.credentials, init.redirect]);
    if (url.endsWith(".js")) return { ok: true, headers: new Map(), text: async () => "x()\n//# sourceMappingURL=https://evil.example/x.map" };
    return { ok: true, headers: new Map(), text: async () => "{}" };
  };
  const resolver = new SourceMapResolver({ allowFetch: true, fetchFn });
  assert.equal(await resolver.mapFor("https://shop.example/x.js"), null);
  assert.equal(await resolver.mapFor("file:///Users/me/x.js"), null);
  assert.deepEqual(seen, [["https://shop.example/x.js", "omit", "error"]]);
  assert.deepEqual(resolver.failures.map((f) => f.reason), ["cross-origin", "not-web"]);
  const offline = new SourceMapResolver({ allowFetch: false, fetchFn: async () => assert.fail("no fetch when fetchSourceMaps is false") });
  assert.equal(await offline.mapFor("https://shop.example/x.js"), null);
});

test("CDP exception details keep async parents and the stack text parser ignores junk lines", () => {
  const chain = chainOf({
    exceptionDetails: {
      text: "Uncaught",
      exception: { className: "TypeError", description: "TypeError: x is not a function\n    at a (https://s.example/a.js:1:2)" },
      stackTrace: { callFrames: [{ functionName: "a", url: "https://s.example/a.js", lineNumber: 0, columnNumber: 1, scriptId: "1" }], parent: { description: "setTimeout", callFrames: [{ functionName: "", url: "https://s.example/b.js", lineNumber: 4, columnNumber: 9 }] } },
    },
  });
  assert.deepEqual(chain[0].frames, [
    { functionName: "a", url: "https://s.example/a.js", line: 1, column: 2, async: null },
    { functionName: null, url: "https://s.example/b.js", line: 5, column: 10, async: "setTimeout" },
  ]);
  assert.equal(chain[0].message, "x is not a function");
  assert.deepEqual(framesOfStack("junk\n    at <anonymous>\n    at x (y:0:0)\n    at https://a.example/z.js:3:4"), [{ functionName: null, url: "https://a.example/z.js", line: 3, column: 4, async: null }]);
  const loop = { name: "E", message: "m" };
  loop.cause = loop;
  assert.equal(chainOf({ error: loop }).length, 1, "a cause cycle stops");
  const cause = vm.runInNewContext(`(${CAUSE_CHAIN_FUNCTION}).call(new Error("outer", { cause: new TypeError("inner", { cause: "root" }) }))`);
  assert.deepEqual(JSON.parse(JSON.stringify(cause)).map((l) => [l.name, l.message]), [["Error", "outer"], ["TypeError", "inner"], ["", "root"]]);
});

const MATCHED = fixture("css-matched.json");

test("the cascade names the winning rule for each property with specificity, origin and stylesheet line, and why the rest lost", () => {
  const headers = new Map([headerOf({ header: { styleSheetId: "S1", sourceURL: "https://shop.example/site.css", origin: "regular", startLine: 0, startColumn: 0, isInline: false } }), headerOf({ header: { styleSheetId: "S2", sourceURL: "https://shop.example/", origin: "regular", startLine: 10, startColumn: 4, isInline: true } })]);
  const [color, padding, margin, fontSize, display] = cascadeFor(MATCHED.matched, MATCHED.computed, ["color", "padding", "margin", "font-size", "display"], headers);
  assert.equal(color.computed, "rgb(0, 128, 0)");
  assert.deepEqual([color.winner.value, color.winner.selector, color.winner.specificity, color.winner.important], ["green", ".cta", [0, 1, 0], true]);
  assert.deepEqual(color.winner.source, { styleSheetId: "S2", url: "https://shop.example/", line: 14, column: 5, inline: true });
  assert.deepEqual(color.overridden.map((o) => [o.value, o.reason]), [["purple", "the winner is !important"], ["blue", "the winner is !important"], ["red", "the winner is !important"]]);
  assert.deepEqual([padding.winner.value, padding.winner.source.line], ["4px", 3]);
  assert.deepEqual(padding.overridden.map((o) => [o.value, o.reason]), [["8px", "disabled"]]);
  assert.equal(margin.winner, null);
  assert.deepEqual(margin.overridden.map((o) => o.reason), ["invalid value"]);
  assert.deepEqual([fontSize.winner.value, fontSize.winner.selector, fontSize.winner.inheritedFrom], ["18px", "body", 1]);
  assert.deepEqual([display.winner.value, display.winner.origin], ["block", "user-agent"]);
  assert.deepEqual(declaredProperties(MATCHED.matched), ["color", "padding", "margin"]);
});

test("specificity is estimated when the engine leaves it out", () => {
  assert.deepEqual(estimateSpecificity("#buy.btn"), [1, 1, 0]);
  assert.deepEqual(estimateSpecificity("ul li > a:hover"), [0, 1, 3]);
  assert.deepEqual(estimateSpecificity(":where(#x) .a"), [0, 1, 0]);
  assert.deepEqual(estimateSpecificity("p::first-line"), [0, 0, 2]);
});

function runCondition(code, globals = {}) {
  const logged = [];
  const context = vm.createContext({ console: { log: (...args) => logged.push(args) }, String, ...globals });
  const result = vm.runInContext(`(function () { const cart = { total: 42 }; return ${code}; })()`, context, { timeout: 500 });
  return { result, logged };
}

test("a logpoint's condition logs and always answers false, so it can never pause the page", () => {
  const plain = runCondition(logpointCondition("lp1", "cart.total", null));
  assert.equal(plain.result, false);
  assert.deepEqual(plain.logged, [["[ardia logpoint lp1]", 42]]);
  const gated = runCondition(logpointCondition("lp2", "cart.total * 2", "cart.total > 100"));
  assert.deepEqual([gated.result, gated.logged.length], [false, 0]);
  const escapes = ['0); return true; (0', '"}) || true || (() => {"', "0)}catch(e){}return true;(()=>{", "`${true}`", "debugger", "throw 1", "true true", "\\", "</script>"];
  for (const hostile of escapes) {
    for (const [expression, condition] of [[hostile, null], ["1", hostile], [hostile, hostile]]) {
      const { result } = runCondition(logpointCondition("lp3", expression, condition));
      assert.equal(result, false, `${JSON.stringify(hostile)} never makes the condition truthy`);
    }
  }
  const replacedEval = runCondition(logpointCondition("lp4", "cart.total", null), { eval: () => true });
  assert.equal(replacedEval.result, false, "a page that replaces eval still can't make it pause");
  assert.throws(() => checkedExpression("", "expression"), /empty/);
  assert.throws(() => checkedExpression("a\u0000b", "expression"), /NUL/);
  assert.throws(() => checkedExpression("x".repeat(2001), "expression"), /longer/);
});

function fakeTransport(script = {}) {
  const sent = [];
  let listener = null;
  let closed = false;
  return {
    sent,
    emit: (method, params) => listener?.(method, params),
    get closed() {
      return closed;
    },
    transport: {
      async send(method, params) {
        sent.push([method, params]);
        const reply = script[method];
        return typeof reply === "function" ? reply(params, (m, p) => listener?.(m, p)) : (reply ?? {});
      },
      onEvent(next) {
        listener = next;
        return () => (listener = null);
      },
      async close() {
        closed = true;
      },
    },
  };
}

test("an inspection session never sends an override and undoes only what it turned on when it closes", async () => {
  const fake = fakeTransport({ "Debugger.setBreakpointByUrl": { breakpointId: "bp-1", locations: [] } });
  const before = liveInspectionSessions();
  const session = new InspectionSession("tab-1", fake.transport);
  assert.equal(liveInspectionSessions(), before + 1);
  for (const method of ["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Network.setCacheDisabled", "Network.emulateNetworkConditions", "Network.disable", "Audits.checkContrast", "Runtime.evaluate", "Page.navigate", "Debugger.pause", "Target.closeTarget"]) {
    await assert.rejects(session.send(method), /never sends/, method);
  }
  await session.send("Audits.enable");
  await session.send("Debugger.enable");
  await session.send("Debugger.setBreakpointByUrl", { url: "https://a.example/x.js", lineNumber: 1 });
  await session.send("Tracing.start", {});
  await Promise.all([session.close(), session.close()]);
  assert.deepEqual(fake.sent.map(([m]) => m), ["Audits.enable", "Debugger.enable", "Debugger.setBreakpointByUrl", "Tracing.start", "Tracing.end", "Debugger.removeBreakpoint", "Debugger.disable", "Audits.disable"]);
  assert.ok(fake.sent.every(([m]) => !/^(Emulation|Network)\./.test(m)));
  assert.ok(fake.closed);
  assert.equal(liveInspectionSessions(), before);
  await assert.rejects(session.send("Audits.enable"), /already ended/);
});

test("each trace recording starts from an empty buffer and drops it once handed back", async () => {
  const chunks = (n) => Array.from({ length: n }, (_, i) => ({ name: "RunTask", ph: "X", ts: 1000 + i, dur: 10, pid: 1, tid: 1 }));
  const run = async (n) => {
    const fake = fakeTransport({
      "Tracing.end": (_params, emit) => {
        emit("Tracing.dataCollected", { value: chunks(n) });
        emit("Tracing.dataCollected", { value: "junk" });
        setTimeout(() => emit("Tracing.tracingComplete", { dataLossOccurred: false }), 1);
        return {};
      },
    });
    const session = new InspectionSession("tab-2", fake.transport);
    try {
      return { recording: await recordTrace(session, { durationMs: 1, reload: false }), sent: fake.sent };
    } finally {
      await session.close();
    }
  };
  const first = await run(30);
  const second = await run(5);
  assert.equal(first.recording.events.length, 30);
  assert.equal(second.recording.events.length, 5);
  assert.ok(second.recording.complete);
  assert.deepEqual(first.sent.map(([m]) => m), ["Tracing.start", "Tracing.end"], "a finished trace isn't ended twice");
  assert.deepEqual(first.sent[0][1].traceConfig.excludedCategories, ["*"]);
});

test("field data sends only the origin by default and refuses non-web pages", async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push([url, JSON.parse(init.body), init.credentials]);
    return { ok: true, status: 200, json: async () => ({ record: { metrics: { largest_contentful_paint: { histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }], percentiles: { p75: "2100" } } } } }) };
  };
  const data = await fetchFieldData({ pageUrl: "https://shop.example/cart?id=9#x", scope: "origin", apiKey: "AIzaFixtureKey_123", formFactor: null }, fetchFn);
  assert.deepEqual(sent[0][1].origin, "https://shop.example");
  assert.equal(JSON.stringify(sent[0][1]).includes("cart"), false);
  assert.equal(sent[0][2], "omit");
  assert.deepEqual(data.metrics.largest_contentful_paint, { p75: 2100, good: 0.7, poor: 0.1 });
  await fetchFieldData({ pageUrl: "https://shop.example/cart?id=9", scope: "url", apiKey: "AIzaFixtureKey_123", formFactor: "PHONE" }, fetchFn);
  assert.deepEqual(sent[1][1].url, "https://shop.example/cart");
  for (const pageUrl of ["chrome://settings", "file:///etc/hosts", "javascript:alert(1)", "https://u:p@shop.example/"]) assert.throws(() => fieldDataKey(pageUrl, "origin"));
  await assert.rejects(fetchFieldData({ pageUrl: "https://shop.example/", scope: "origin", apiKey: "bad key&x=1", formFactor: null }, fetchFn), /API key/);
});
