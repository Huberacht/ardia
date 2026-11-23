import { fileURLToPath } from "node:url";

export const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

export const posixFilePath = (url: URL | string, windows?: boolean): string => toPosixPath(fileURLToPath(url, { windows }));
