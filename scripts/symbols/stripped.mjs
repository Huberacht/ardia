import { createHash } from "node:crypto";
import { functionStarts, imageFor } from "./macho.mjs";
import { buildMap, lookup } from "./symbol-map.mjs";

export function maskedWords(words) {
  const out = new Uint32Array(words.length);
  const pageRegisters = new Set();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w & 0x7c000000) >>> 0 === 0x14000000) out[i] = (w & 0xfc000000) >>> 0;
    else if ((w & 0x1f000000) >>> 0 === 0x10000000) {
      out[i] = (w & 0x9f00001f) >>> 0;
      pageRegisters.add(w & 0x1f);
    } else if ((w & 0x3b000000) >>> 0 === 0x18000000) out[i] = (w & 0xff00001f) >>> 0;
    else if (pageRegisters.has((w >>> 5) & 0x1f) && ((w & 0x7f800000) >>> 0 === 0x11000000 || (w & 0x3b000000) >>> 0 === 0x39000000)) out[i] = (w & ~(0xfff << 10)) >>> 0;
    else out[i] = w;
  }
  return out;
}

export function functionsOf(buffer) {
  const found = imageFor(buffer);
  if (!found) throw new Error("not a Mach-O binary");
  const { slice, image } = found;
  if (!image.text || image.base == null) throw new Error("the binary has no __TEXT,__text section");
  const textEnd = image.text.addr + image.text.size;
  const starts = functionStarts(slice, image).filter((a) => a >= image.text.addr && a < textEnd);
  starts.push(textEnd);
  const funcs = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const at = image.text.fileOffset + (starts[i] - image.text.addr);
    const count = (starts[i + 1] - starts[i]) >> 2;
    const words = new Uint32Array(count);
    for (let k = 0; k < count; k++) words[k] = slice.readUInt32LE(at + k * 4);
    const hash = createHash("sha1").update(Buffer.from(maskedWords(words).buffer)).digest("hex");
    funcs.push({ start: starts[i] - image.base, end: starts[i + 1] - image.base, hash });
  }
  return { image, funcs };
}

export function nameStripped({ targetBuffer, siblingBuffer, dsymBuffer, objc = new Map(), demanglers }) {
  const target = functionsOf(targetBuffer);
  const sibling = functionsOf(siblingBuffer);
  const siblingMap = buildMap(dsymBuffer, sibling.image.uuid, { demanglers });
  const siblingName = (start) => {
    const hit = lookup(siblingMap, start);
    return hit && hit.delta === 0 ? hit.name : null;
  };
  const siblingByHash = new Map();
  sibling.funcs.forEach((f, j) => siblingByHash.set(f.hash, siblingByHash.has(f.hash) ? -1 : j));
  const targetHashCount = new Map();
  for (const f of target.funcs) targetHashCount.set(f.hash, (targetHashCount.get(f.hash) ?? 0) + 1);
  const pair = target.funcs.map((f) => (targetHashCount.get(f.hash) === 1 && (siblingByHash.get(f.hash) ?? -1) >= 0 ? siblingByHash.get(f.hash) : -1));

  const entries = [];
  const counts = { objc: 0, code: 0, position: 0, none: 0 };
  let previous = -1;
  for (let i = 0; i < target.funcs.length; i++) {
    if (pair[i] >= 0) previous = i;
    const f = target.funcs[i];
    let name = objc.get(f.start) ?? null;
    if (name) counts.objc++;
    else if (pair[i] >= 0 && (name = siblingName(sibling.funcs[pair[i]].start))) counts.code++;
    else {
      let next = i + 1;
      while (next < target.funcs.length && pair[next] < 0) next++;
      if (previous >= 0 && previous < i && next < target.funcs.length && pair[next] - pair[previous] === next - previous) {
        const guess = siblingName(sibling.funcs[pair[previous] + (i - previous)].start);
        if (guess) {
          name = `${guess} (by position)`;
          counts.position++;
        }
      }
    }
    if (name) entries.push({ start: f.start, end: f.end, name });
    else counts.none++;
  }

  const map = {
    uuid: target.image.uuid,
    arch: target.image.arch,
    source: "match",
    textStart: target.image.text.addr - target.image.base,
    textEnd: target.image.text.addr + target.image.text.size - target.image.base,
    entries,
  };
  return { map, counts, functions: target.funcs.length };
}
