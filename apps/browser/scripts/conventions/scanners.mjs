const SHELL_WORD_BREAK = /[\s;&|()<>`]/;
const POWERSHELL_WORD_BREAK = /[\s;|({}]/;

const lineEndAt = (src, at) => {
  const end = src.indexOf("\n", at);
  return end < 0 ? src.length : end;
};

function skipShebang(src) {
  return src.startsWith("#!") ? lineEndAt(src, 0) : 0;
}

export function scanShell(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const heredocs = [];
  let i = skipShebang(src);

  const heredocBodies = () => {
    let at = i + 1;
    let resume = i;
    for (const { word, tabs } of heredocs.splice(0)) {
      const bodyStart = at;
      let terminator = -1;
      while (at < n) {
        const end = lineEndAt(src, at);
        const line = src.slice(at, end).replace(/\r$/, "");
        if ((tabs ? line.replace(/^\t+/, "") : line) === word) {
          terminator = end;
          break;
        }
        at = end + 1;
      }
      if (terminator < 0) break;
      strings.push({ start: bodyStart, end: at, kind: "heredoc" });
      resume = terminator;
      at = terminator + 1;
    }
    i = resume;
  };
  const single = () => {
    const start = ++i;
    while (i < n && src[i] !== "'") i++;
    strings.push({ start, end: Math.min(i, n), kind: "single" });
    i++;
  };
  const ansi = () => {
    i += 2;
    const start = i;
    while (i < n && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
    strings.push({ start, end: Math.min(i, n), kind: "single" });
    i++;
  };
  const backtick = () => {
    const start = ++i;
    while (i < n && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
    strings.push({ start, end: Math.min(i, n), kind: "backtick" });
    i++;
  };
  const arithmetic = () => {
    let depth = 0;
    while (i < n) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
  };
  const double = () => {
    let start = ++i;
    while (i < n && src[i] !== '"') {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "(") {
        strings.push({ start, end: i, kind: "double" });
        if (src[i + 2] === "(") {
          i++;
          arithmetic();
        } else {
          i += 2;
          code(")");
          i++;
        }
        start = i;
      } else if (src[i] === "`") {
        i++;
        while (i < n && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
        i++;
      } else i++;
    }
    strings.push({ start, end: Math.min(i, n), kind: "double" });
    i++;
  };
  const parameter = () => {
    i += 2;
    let depth = 1;
    while (i < n && depth) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
  };
  const heredoc = () => {
    const match = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w][\w.-]*))/.exec(src.slice(i, i + 120));
    if (!match) return false;
    heredocs.push({ word: match[2] ?? match[3] ?? match[4], tabs: match[1] === "-" });
    i += match[0].length;
    return true;
  };
  const code = (closer) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\n") {
        if (heredocs.length) heredocBodies();
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "#" && (i === 0 || SHELL_WORD_BREAK.test(src[i - 1]))) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
      if (c === "'") {
        single();
        continue;
      }
      if (c === '"') {
        double();
        continue;
      }
      if (c === "`") {
        backtick();
        continue;
      }
      if (c === "$") {
        const next = src[i + 1];
        if (next === "'") ansi();
        else if (next === "(" && src[i + 2] === "(") {
          i++;
          arithmetic();
        } else if (next === "(") {
          i += 2;
          code(")");
          i++;
        } else if (next === "{") parameter();
        else i += 2;
        continue;
      }
      if (c === "(" && src[i + 1] === "(" && (i === 0 || SHELL_WORD_BREAK.test(src[i - 1]))) {
        arithmetic();
        continue;
      }
      if (src.startsWith("<<<", i)) {
        i += 3;
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && heredoc()) continue;
      if (closer && depth === 0 && c === closer) return;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  };
  code(null);
  return { comments, strings };
}

export function scanPowerShell(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const help = [];
  let i = skipShebang(src);

  const hereString = (quote) => {
    const close = `\n${quote}@`;
    const start = i + 2;
    const end = src.indexOf(close, start);
    const stop = end < 0 ? n : end + 1;
    strings.push({ start, end: stop });
    i = stop + 2;
  };
  const single = () => {
    const start = ++i;
    while (i < n) {
      if (src[i] === "'" && src[i + 1] === "'") i += 2;
      else if (src[i] === "'") break;
      else i++;
    }
    strings.push({ start, end: Math.min(i, n) });
    i++;
  };
  const double = () => {
    const start = ++i;
    while (i < n) {
      if (src[i] === "`") i += 2;
      else if (src[i] === '"' && src[i + 1] === '"') i += 2;
      else if (src[i] === '"') break;
      else if (src[i] === "$" && src[i + 1] === "(") {
        i += 2;
        code(")");
        i++;
      } else i++;
    }
    strings.push({ start, end: Math.min(i, n) });
    i++;
  };
  const code = (closer) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "<" && src[i + 1] === "#") {
        const start = i;
        const end = src.indexOf("#>", i + 2);
        i = end < 0 ? n : end + 2;
        comments.push([start, i]);
        if (/^\s*\.(?:SYNOPSIS|DESCRIPTION)\b/im.test(src.slice(start, i))) help.push([start, i]);
        continue;
      }
      if (c === "#" && (i === 0 || POWERSHELL_WORD_BREAK.test(src[i - 1]))) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
      if (c === "@" && (src[i + 1] === '"' || src[i + 1] === "'") && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 8))) {
        hereString(src[i + 1]);
        continue;
      }
      if (c === "`") {
        i += 2;
        continue;
      }
      if (c === "'") {
        single();
        continue;
      }
      if (c === '"') {
        double();
        continue;
      }
      if (closer && depth === 0 && c === closer) return;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  };
  code(null);
  return { comments, strings, help };
}

const PY_STRING_START = /^([rRbBuUfF]{0,2})('''|"""|'|")/;

export function scanPython(src) {
  const n = src.length;
  const comments = [];
  const strings = [];
  const docstrings = [];
  let i = skipShebang(src);
  let depth = 0;
  let statementStart = true;
  let continued = false;

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      if (depth === 0 && !continued) statementStart = true;
      continued = false;
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      continued = true;
      i++;
      continue;
    }
    if (c === "#") {
      const start = i;
      i = lineEndAt(src, i);
      comments.push([start, i]);
      continue;
    }
    if (/[ \t\r\f]/.test(c)) {
      i++;
      continue;
    }
    const opener = /[\w'"]/.test(c) && !/[\w]/.test(src[i - 1] ?? "") ? PY_STRING_START.exec(src.slice(i, i + 5)) : null;
    if (opener) {
      const quote = opener[2];
      const tokenStart = i;
      i += opener[0].length;
      const start = i;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src.startsWith(quote, i)) break;
        if (quote.length === 1 && src[i] === "\n") break;
        i++;
      }
      const end = Math.min(i, n);
      strings.push({ start, end });
      i += src.startsWith(quote, i) ? quote.length : 0;
      if (statementStart && depth === 0) {
        const rest = src.slice(i, lineEndAt(src, i));
        if (/^\s*(?:#.*)?$/.test(rest)) docstrings.push([tokenStart, i]);
      }
      statementStart = false;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      statementStart = true;
      i++;
      continue;
    }
    statementStart = false;
    i++;
  }
  return { comments, strings, docstrings };
}

const SIMPLE_HASH = {
  toml: { quotes: ['"""', "'''", '"', "'"], escapes: { '"': true, '"""': true } },
  gn: { quotes: ['"'], escapes: { '"': true } },
  ruby: { quotes: ['"', "'"], escapes: { '"': true, "'": true }, rubyBlocks: true, regexes: true },
  docker: { quotes: [], escapes: {}, lineStartOnly: true },
};

export function scanHashSimple(src, lang) {
  const { quotes, escapes, lineStartOnly, rubyBlocks, regexes } = SIMPLE_HASH[lang];
  const n = src.length;
  const comments = [];
  const strings = [];
  let i = skipShebang(src);
  while (i < n) {
    const lineStart = i === 0 || src[i - 1] === "\n";
    if (rubyBlocks && lineStart && src.startsWith("=begin", i)) {
      const start = i;
      const end = src.indexOf("\n=end", i);
      i = end < 0 ? n : lineEndAt(src, end + 1);
      comments.push([start, i]);
      continue;
    }
    const c = src[i];
    if (c === "#") {
      const onlyIndentBefore = /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i));
      if (!lineStartOnly || onlyIndentBefore) {
        const start = i;
        i = lineEndAt(src, i);
        comments.push([start, i]);
        continue;
      }
    }
    if (regexes && c === "/" && /(?:^|[(,=~!|&{[;]|\b(?:when|if|unless|and|or|not|return))\s*$/.test(src.slice(Math.max(0, i - 12), i))) {
      const start = ++i;
      while (i < n && src[i] !== "/" && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      strings.push({ start, end: Math.min(i, n) });
      i++;
      continue;
    }
    const quote = quotes.find((q) => src.startsWith(q, i));
    if (quote) {
      i += quote.length;
      const start = i;
      while (i < n && !src.startsWith(quote, i) && (quote.length === 3 || src[i] !== "\n")) i += escapes[quote] && src[i] === "\\" ? 2 : 1;
      strings.push({ start, end: Math.min(i, n) });
      i += quote.length;
      continue;
    }
    i++;
  }
  return { comments, strings };
}

const YAML_BLOCK = /^(\s*)(-\s+)?(?:([\w.$-]+|"[^"]*"|'[^']*')\s*:\s+)?[|>][-+]?\d?[-+]?\s*(?:#.*)?$/;

const indentOf = (text) => text.match(/^\s*/)[0].length;

function defaultsShells(lines) {
  const found = [];
  lines.forEach((line, k) => {
    if (!/^\s*defaults:\s*$/.test(line.text)) return;
    const base = indentOf(line.text);
    let run = -1;
    for (let j = k + 1; j < lines.length; j++) {
      const text = lines[j].text;
      if (!text.trim()) continue;
      const indent = indentOf(text);
      if (indent <= base) break;
      if (/^\s*run:\s*$/.test(text)) run = indent;
      else if (run >= 0 && indent > run) {
        const shell = /^\s*shell:\s*['"]?(\w+)/.exec(text);
        if (shell) found.push({ at: k, indent: base, shell: shell[1] });
      } else if (indent <= run) run = -1;
    }
  });
  return found;
}

function jobOf(lines, at) {
  for (let k = at; k >= 0; k--) {
    const text = lines[k].text;
    if (text.trim() && indentOf(text) === 2 && /^\s*[\w.-]+:\s*$/.test(text)) return k;
  }
  return -1;
}

function defaultsShell(lines, at) {
  const all = defaultsShells(lines);
  const job = jobOf(lines, at);
  const own = all.find((entry) => entry.indent > 0 && job >= 0 && jobOf(lines, entry.at) === job);
  return own?.shell ?? all.find((entry) => entry.indent === 0)?.shell ?? null;
}

function runnerShell(lines, at) {
  const job = jobOf(lines, at);
  if (job < 0) return null;
  for (let k = job + 1; k < lines.length; k++) {
    const text = lines[k].text;
    if (text.trim() && indentOf(text) <= 2) break;
    if (/^\s{4}runs-on:.*\bwindows\b/i.test(text)) return "pwsh";
    if (/^\s{4}runs-on:\s*$/.test(text)) {
      for (let j = k + 1; j < lines.length && (!lines[j].text.trim() || indentOf(lines[j].text) > 4 || /^\s{4}-\s/.test(lines[j].text)); j++) if (/^\s*-\s*['"]?windows\b/i.test(lines[j].text)) return "pwsh";
    }
  }
  return null;
}

function runShellOf(lines, at, keyIndent) {
  return siblingShell(lines, at, keyIndent) ?? defaultsShell(lines, at) ?? runnerShell(lines, at);
}

function siblingShell(lines, at, keyIndent) {
  for (let k = at; k >= 0; k--) {
    const line = lines[k].text;
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (k < at && indent < keyIndent && !/^\s*-\s/.test(line)) break;
    const shell = /^\s*(?:-\s+)?shell:\s*['"]?(\w+)/.exec(line);
    if (shell && (indent === keyIndent || line.match(/^\s*-\s+/)?.[0].length === keyIndent)) return shell[1];
    if (/^\s*-\s/.test(line) && line.match(/^\s*-\s+/)[0].length === keyIndent) break;
  }
  for (let k = at + 1; k < lines.length; k++) {
    const line = lines[k].text;
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent < keyIndent || (indent === keyIndent && /^\s*-\s/.test(line))) break;
    const shell = /^\s*shell:\s*['"]?(\w+)/.exec(line);
    if (shell && indent === keyIndent) return shell[1];
  }
  return null;
}

const SHELL_LANGS = { pwsh: "powershell", powershell: "powershell", python: "python", bash: "shell", sh: "shell" };

export function scanYaml(src) {
  const comments = [];
  const strings = [];
  const embedded = [];
  const lines = [];
  for (let at = 0; at <= src.length; ) {
    const end = lineEndAt(src, at);
    lines.push({ start: at, text: src.slice(at, end) });
    at = end + 1;
  }
  let quote = null;
  let quoteStart = 0;
  for (let k = 0; k < lines.length; k++) {
    const { start, text } = lines[k];
    if (!quote) {
      const block = YAML_BLOCK.exec(text);
      if (block) {
        const keyIndent = block[1].length + (block[2]?.length ?? 0);
        const key = block[3]?.replace(/^['"]|['"]$/g, "");
        const hash = text.search(/\s#/);
        if (hash >= 0) comments.push([start + hash + 1, start + text.length]);
        let last = k;
        let indent = Infinity;
        for (let j = k + 1; j < lines.length; j++) {
          const body = lines[j].text;
          if (!body.trim()) continue;
          const bodyIndent = body.match(/^\s*/)[0].length;
          if (bodyIndent <= keyIndent - (block[2] && !block[3] ? 2 : 0)) break;
          indent = Math.min(indent, bodyIndent);
          last = j;
        }
        if (last > k) {
          const bodyLines = lines.slice(k + 1, last + 1);
          const lang = key === "run" ? (SHELL_LANGS[runShellOf(lines, k, keyIndent)] ?? "shell") : key === "script" ? "js" : null;
          if (lang) {
            const offsets = bodyLines.map((line) => line.start + Math.min(indent, line.text.length));
            const pieces = bodyLines.map((line) => line.text.slice(indent));
            const folded = /^[^#]*:\s+>|^\s*-\s+>/.test(text.replace(/\s+#.*$/, ""));
            const joins = pieces.map((piece, at) => (at === 0 ? "" : folded && piece && pieces[at - 1] && !/^\s/.test(piece) && !/^\s/.test(pieces[at - 1]) ? " " : "\n"));
            const charMap = [];
            let joined = "";
            pieces.forEach((piece, at) => {
              if (at > 0) {
                charMap.push(offsets[at] - 1);
                joined += joins[at];
              }
              for (let c = 0; c < piece.length; c++) charMap.push(offsets[at] + c);
              joined += piece;
            });
            embedded.push({ lang, text: joined, offsets, charMap });
          }
          strings.push({ start: lines[k + 1].start, end: lines[last].start + lines[last].text.length });
          k = last;
        }
        continue;
      }
    }
    let commentAt = text.length;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      if (quote === "'") {
        if (ch === "'" && text[c + 1] === "'") c++;
        else if (ch === "'") {
          strings.push({ start: quoteStart, end: start + c });
          quote = null;
        }
        continue;
      }
      if (quote === '"') {
        if (ch === "\\") c++;
        else if (ch === '"') {
          strings.push({ start: quoteStart, end: start + c });
          quote = null;
        }
        continue;
      }
      if (ch === "#" && (c === 0 || /\s/.test(text[c - 1]))) {
        comments.push([start + c, start + text.length]);
        commentAt = c;
        break;
      }
      if ((ch === "'" || ch === '"') && /(?:^\s*|[:?-]\s+|[[{,]\s*)$/.test(text.slice(0, c))) {
        quote = ch;
        quoteStart = start + c + 1;
      }
    }
    const inline = /^(\s*)(-\s+)?(run|script):[ \t]+(?=[^\s|>])/.exec(text);
    if (inline && !quote) {
      const keyIndent = inline[1].length + (inline[2]?.length ?? 0);
      let from = inline[0].length;
      let value = text.slice(from, commentAt).replace(/\s+$/, "");
      const quoted = /^(["'])(.*)\1$/.exec(value);
      if (quoted) {
        from++;
        value = quoted[2].replace(quoted[1] === '"' ? /\\(["\\])/g : /''/g, (escaped) => (quoted[1] === '"' ? ` ${escaped[1]}` : " '"));
      }
      const lang = inline[3] === "script" ? "js" : (SHELL_LANGS[runShellOf(lines, k, keyIndent)] ?? "shell");
      if (value) embedded.push({ lang, text: value, offsets: [start + from] });
    }
  }
  return { comments, strings, embedded };
}

export function embeddedToSource({ text, offsets, charMap }, at) {
  if (charMap) return at < charMap.length ? charMap[at] : (charMap.at(-1) ?? offsets[0]) + 1;
  let line = 0;
  let lineStart = 0;
  for (let k = 0; k < at && k < text.length; k++) {
    if (text[k] === "\n") {
      line++;
      lineStart = k + 1;
    }
  }
  return offsets[line] + (at - lineStart);
}

const MARKUP_COMMENT_OR_BLOCK = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const NON_JS_SCRIPT = /\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[\w/+.-]+/i;

export function scanMarkup(src, lang) {
  const comments = [];
  const strings = [];
  const embedded = [];
  let body = src;
  if (lang === "astro") {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
    if (front) {
      embedded.push({ lang: "js", text: front[1], offsets: lineOffsets(src, 4, front[1]) });
      body = " ".repeat(front[0].length) + src.slice(front[0].length);
    }
  }
  if (lang !== "xml") {
    let rest = "";
    let at = 0;
    for (const match of body.matchAll(MARKUP_COMMENT_OR_BLOCK)) {
      if (!match[1]) continue;
      const contentStart = match.index + match[0].indexOf(">") + 1;
      const content = match[3];
      rest += body.slice(at, contentStart) + content.replace(/[^\n]/g, " ");
      at = contentStart + content.length;
      const isStyle = match[1].toLowerCase() === "style";
      if (isStyle || !NON_JS_SCRIPT.test(match[2])) embedded.push({ lang: isStyle ? "css" : "js", text: content, offsets: lineOffsets(src, contentStart, content) });
      strings.push({ start: contentStart, end: contentStart + content.length });
    }
    body = rest + body.slice(at);
    if (lang === "astro") {
      for (const match of body.matchAll(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g)) comments.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of body.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) comments.push([match.index, match.index + match[0].length]);
  return { comments, strings, embedded };
}

function lineOffsets(src, start, text) {
  const offsets = [start];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") offsets.push(start + k + 1);
  return offsets;
}
