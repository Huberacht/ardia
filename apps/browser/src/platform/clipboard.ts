import type { CleanedUrl, LinkText } from "@ardia/core";
import { nativeModule } from "@ardia/shell";

const Shell = nativeModule("ArdiaShell");

export const copyText = (text: string) => Shell.copyText(text);
export const copyLink = (link: LinkText) => Shell.copyText(link);
export const copyAddress = (url: CleanedUrl, unlessChangedSince: number | null = null) =>
  Shell.copyURL ? Shell.copyURL(url, unlessChangedSince) : Shell.copyText(url);
export const copyUncleanedUrl = (url: string) => Shell.copyText(url);
export const readText = () => Shell.readText();
