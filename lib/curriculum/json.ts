export interface JsonIssue {
  path: string;
  code: string;
}

export function fieldPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

export function orderIssues(issues: JsonIssue[]): JsonIssue[] {
  const unique = new Map(
    issues.map((issue) => [JSON.stringify([issue.path, issue.code]), issue]),
  );
  return [...unique.values()].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/** Copy inspected data so later validation/encoding never reads caller properties. */
export function inspectJson(input: unknown): {
  value: unknown;
  errors: JsonIssue[];
} {
  const issues: JsonIssue[] = [];
  const ancestors = new Map<object, string>();
  let visited = 0;
  const add = (path: string, code: string) =>
    issues.push({ path: path || '$', code });
  function visit(value: unknown, path: string, depth: number): unknown {
    visited += 1;
    if (depth > 128 || visited > 1_000_000) {
      add(path, 'UNSAFE_JSON_VALUE');
      return;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (!value.isWellFormed()) add(path, 'UNSAFE_JSON_VALUE');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) add(path, 'NONFINITE_NUMBER');
      return value;
    }
    if (typeof value !== 'object') {
      add(path, 'UNSAFE_JSON_VALUE');
      return;
    }
    if (ancestors.has(value)) {
      add(ancestors.get(value) || '$', 'CYCLIC_VALUE');
      return;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      add(path, 'UNSAFE_JSON_VALUE');
      return;
    }
    const keys = Reflect.ownKeys(value);
    const length = array
      ? Object.getOwnPropertyDescriptor(value, 'length')?.value
      : 0;
    if (
      array &&
      (!Number.isSafeInteger(length) ||
        length < 0 ||
        keys.length !== length + 1)
    ) {
      add(path, 'UNSAFE_JSON_VALUE');
      return;
    }
    const copy: Record<string, unknown> = array
      ? ([] as unknown as Record<string, unknown>)
      : Object.create(null);
    ancestors.set(value, path);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') {
        add(path, 'UNSAFE_JSON_VALUE');
        continue;
      }
      if (!key.isWellFormed()) {
        add(path, 'UNSAFE_JSON_VALUE');
        continue;
      }
      const childPath = array ? `${path}[${key}]` : fieldPath(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
      ) {
        add(childPath, 'UNSAFE_JSON_VALUE');
        continue;
      }
      if (
        key === 'hanzi' &&
        typeof descriptor.value === 'string' &&
        descriptor.value !== descriptor.value.normalize('NFC')
      )
        add(childPath, 'HANZI_NOT_NFC');
      copy[key] = visit(descriptor.value, childPath, depth + 1);
      if (visited > 1_000_000) break;
    }
    ancestors.delete(value);
    return copy;
  }
  let value: unknown;
  try {
    value = visit(input, '', 0);
  } catch {
    add('', 'UNSAFE_JSON_VALUE');
  }
  return { value, errors: orderIssues(issues) };
}
