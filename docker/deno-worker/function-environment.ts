export interface InvocationEnvironment {
  get(name: string): string | undefined;
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
  toObject(): Record<string, string>;
}

export function createInvocationEnvironment(
  secrets: Record<string, string>,
): InvocationEnvironment {
  const values = new Map(Object.entries(secrets));
  return {
    get: (name) => values.get(name),
    has: (name) => values.has(name),
    set: (name, value) => {
      values.set(name, String(value));
    },
    delete: (name) => {
      values.delete(name);
    },
    toObject: () => Object.fromEntries(values),
  };
}

export function createInvocationDeno<T extends object>(
  runtimeDeno: T,
  secrets: Record<string, string>,
  overrides: Record<PropertyKey, unknown> = {},
): T {
  const environment = createInvocationEnvironment(secrets);
  return new Proxy(runtimeDeno, {
    get(target, property, receiver) {
      if (property === "env") return environment;
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property];
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
