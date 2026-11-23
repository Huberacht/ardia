import { readdirSync, readFileSync } from "node:fs";

const engine = new URL("../../../engine/", import.meta.url);
const nativeHost = readFileSync(new URL("ardiacore-linux/src/ardia/linux/ac_linux_host.cc", engine), "utf8");
const bootstrap = nativeHost.slice(nativeHost.indexOf("base::DictValue ShellHostView::Bootstrap() const {"), nativeHost.indexOf("void ShellHostView::LayoutOverlay()"));
const engineDirs = ["ardiacore-linux/src/ardia/linux/", "ardiacore-desktop/src/ardia/desktop/"].map((dir) => new URL(dir, engine));
const engineSources = engineDirs.flatMap((dir) => readdirSync(dir).filter((file) => /\.(cc|h)$/.test(file)).map((file) => readFileSync(new URL(file, dir), "utf8")));
const capabilityArrays = new Map(engineSources.flatMap((source) => [...source.matchAll(/const char\* (k[A-Za-z]+)\[\] = \{([^}]*)\}/g)].map(([, name, body]) => [name, [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])])));
const advertisedLoops = [...bootstrap.matchAll(/for \(const char\* \w+ : (?:\w+::)*(k[A-Za-z]+)\)/g)].map((match) => match[1]);

export { advertisedLoops, bootstrap, capabilityArrays, nativeHost };

export const linuxAdvertised = [
  ...[...bootstrap.matchAll(/\.Append\("([A-Za-z]+\.[A-Za-z]+)"\)/g)].map((match) => match[1]),
  ...advertisedLoops.flatMap((name) => capabilityArrays.get(name) ?? []),
];

export const linuxRoutedNatively = new Set(engineSources.flatMap((source) => [...source.matchAll(/"(Ardia[A-Za-z]+\.[A-Za-z]+)"/g)].map((match) => match[1])));
