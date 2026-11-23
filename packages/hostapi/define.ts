export type Binding = "service" | "custom" | "absent";

export type DesktopBinding = "route" | "custom" | "absent";

export type Call = {
  args: string;
  result: string;
  service: string;
  desktop: DesktopBinding;
  mac?: Binding;
  windows?: Binding;
};

export type Domain = {
  imports: Record<string, readonly string[]>;
  calls: Record<string, Call>;
  events: Record<string, string>;
};

export function defineDomain<const D extends Domain>(domain: D): D {
  return domain;
}
