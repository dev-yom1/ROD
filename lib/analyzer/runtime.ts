type Version = readonly [major: number, minor: number, patch: number];
type Bound = { version: Version; inclusive: boolean };
type Interval = { min?: Bound; max?: Bound };
type RuntimeKind = "node" | "python";

const NODE_SANDBOX_MAJORS = [22, 24, 26] as const;
export type NodeSandboxRuntime = `node${(typeof NODE_SANDBOX_MAJORS)[number]}`;

function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function maxLower(a: Bound | undefined, b: Bound | undefined): Bound | undefined {
  if (!a) return b;
  if (!b) return a;
  const cmp = compareVersion(a.version, b.version);
  if (cmp > 0) return a;
  if (cmp < 0) return b;
  return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

function minUpper(a: Bound | undefined, b: Bound | undefined): Bound | undefined {
  if (!a) return b;
  if (!b) return a;
  const cmp = compareVersion(a.version, b.version);
  if (cmp < 0) return a;
  if (cmp > 0) return b;
  return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

function intersect(a: Interval, b: Interval): Interval | null {
  const result: Interval = { min: maxLower(a.min, b.min), max: minUpper(a.max, b.max) };
  if (!result.min || !result.max) return result;
  const cmp = compareVersion(result.min.version, result.max.version);
  if (cmp < 0) return result;
  if (cmp > 0) return null;
  return result.min.inclusive && result.max.inclusive ? result : null;
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  return intersect(a, b) !== null;
}

function parseVersion(raw: string): { version: Version; parts: number; wildcardIndex: number | null } | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const pieces = cleaned.split(".");
  if (!pieces.length || pieces.length > 3) return null;

  const nums: number[] = [];
  let wildcardIndex: number | null = null;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (/^(?:x|\*)$/i.test(piece)) {
      wildcardIndex = i;
      break;
    }
    if (!/^\d+$/.test(piece)) return null;
    nums.push(Number(piece));
  }
  if (nums.length === 0) return null;
  while (nums.length < 3) nums.push(0);
  return { version: nums as unknown as Version, parts: pieces.length, wildcardIndex };
}

function incrementPrefix(version: Version, index: 0 | 1 | 2): Version {
  const next: [number, number, number] = [...version];
  next[index] += 1;
  for (let i = index + 1; i < 3; i += 1) next[i] = 0;
  return next;
}

function partialInterval(parsed: NonNullable<ReturnType<typeof parseVersion>>): Interval {
  const { version, parts, wildcardIndex } = parsed;
  const effectiveParts = wildcardIndex ?? parts;
  if (effectiveParts >= 3 && wildcardIndex === null) {
    return { min: { version, inclusive: true }, max: { version, inclusive: true } };
  }
  const bumpIndex = Math.max(0, effectiveParts - 1) as 0 | 1 | 2;
  return {
    min: { version, inclusive: true },
    max: { version: incrementPrefix(version, bumpIndex), inclusive: false },
  };
}

function comparatorInterval(token: string, kind: RuntimeKind): Interval | null {
  const match = token.trim().match(/^(>=|<=|>|<|\^|~|~=|==|=)?\s*(v?\d+(?:\.(?:\d+|x|\*)){0,2})$/i);
  if (!match) return null;
  const operator = match[1] ?? "";
  const parsed = parseVersion(match[2]);
  if (!parsed) return null;
  const { version, parts } = parsed;

  if (!operator || operator === "=" || operator === "==") return partialInterval(parsed);
  if (operator === ">=") return { min: { version, inclusive: true } };
  if (operator === ">") return { min: { version, inclusive: false } };
  if (operator === "<=") return { max: { version, inclusive: true } };
  if (operator === "<") return { max: { version, inclusive: false } };

  if (operator === "^") {
    let bump: 0 | 1 | 2 = 0;
    if (version[0] === 0) bump = version[1] === 0 ? 2 : 1;
    return {
      min: { version, inclusive: true },
      max: { version: incrementPrefix(version, bump), inclusive: false },
    };
  }

  if (operator === "~" || operator === "~=") {
    const bump: 0 | 1 = kind === "python" && operator === "~=" && parts <= 2 ? 0 : (parts <= 1 ? 0 : 1);
    return {
      min: { version, inclusive: true },
      max: { version: incrementPrefix(version, bump), inclusive: false },
    };
  }

  return null;
}

function normalizeRequirement(requirement: string): string {
  return requirement.trim().replace(/\b(?:and)\b/gi, " ").replace(/,/g, " ").replace(/\s+/g, " ");
}

function parseRange(requirement: string | null, kind: RuntimeKind): Interval[] | null {
  if (!requirement?.trim()) return [{}];
  const normalized = normalizeRequirement(requirement);
  if (/!=|===|;/.test(normalized)) return null;
  const alternatives = normalized.split(/\s*\|\|\s*/).filter(Boolean);
  const parsedAlternatives: Interval[] = [];

  for (const alternative of alternatives) {
    const hyphen = alternative.match(/^\s*(v?\d+(?:\.\d+){0,2})\s+-\s+(v?\d+(?:\.\d+){0,2})\s*$/i);
    if (hyphen) {
      const low = parseVersion(hyphen[1]);
      const high = parseVersion(hyphen[2]);
      if (!low || !high) return null;
      const interval = {
        min: { version: low.version, inclusive: true },
        max: { version: high.version, inclusive: true },
      };
      if (intersect(interval, interval)) parsedAlternatives.push(interval);
      continue;
    }

    const tokens = alternative.match(/(?:>=|<=|>|<|\^|~=|~|==|=)?\s*v?\d+(?:\.(?:\d+|x|\*)){0,2}/gi);
    if (!tokens?.length) return null;
    let current: Interval | null = {};
    for (const token of tokens) {
      const next = comparatorInterval(token.replace(/\s+/g, ""), kind);
      if (!next) return null;
      current = current ? intersect(current, next) : null;
      if (!current) break;
    }
    if (current) parsedAlternatives.push(current);
  }

  return parsedAlternatives;
}

function rangesOverlap(a: string | null, b: string | null, kind: RuntimeKind): boolean | null {
  const left = parseRange(a, kind);
  const right = parseRange(b, kind);
  if (!left || !right) return null;
  return left.some((x) => right.some((y) => intervalsOverlap(x, y)));
}

function compareIntervalStart(a: Interval, b: Interval): number {
  if (!a.min && !b.min) return 0;
  if (!a.min) return -1;
  if (!b.min) return 1;
  const cmp = compareVersion(a.min.version, b.min.version);
  if (cmp !== 0) return cmp;
  if (a.min.inclusive === b.min.inclusive) return 0;
  return a.min.inclusive ? -1 : 1;
}

function canMerge(a: Interval, b: Interval): boolean {
  if (!a.max || !b.min) return true;
  const cmp = compareVersion(a.max.version, b.min.version);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  return a.max.inclusive || b.min.inclusive;
}

function laterUpper(a: Bound | undefined, b: Bound | undefined): Bound | undefined {
  if (!a || !b) return undefined;
  const cmp = compareVersion(a.version, b.version);
  if (cmp > 0) return a;
  if (cmp < 0) return b;
  return { version: a.version, inclusive: a.inclusive || b.inclusive };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort(compareIntervalStart);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || !canMerge(previous, interval)) {
      merged.push({ min: interval.min, max: interval.max });
      continue;
    }
    previous.max = laterUpper(previous.max, interval.max);
  }
  return merged;
}

function intervalContains(container: Interval, target: Interval): boolean {
  const lowerCovered = !container.min
    || Boolean(target.min && (
      compareVersion(container.min.version, target.min.version) < 0
      || (compareVersion(container.min.version, target.min.version) === 0
        && (container.min.inclusive || !target.min.inclusive))
    ));
  if (!lowerCovered) return false;

  const upperCovered = !container.max
    || Boolean(target.max && (
      compareVersion(container.max.version, target.max.version) > 0
      || (compareVersion(container.max.version, target.max.version) === 0
        && (container.max.inclusive || !target.max.inclusive))
    ));
  return upperCovered;
}

function rangeSubsetOf(subset: string | null, superset: string | null, kind: RuntimeKind): boolean | null {
  const child = parseRange(subset, kind);
  const parent = parseRange(superset, kind);
  if (!child || !parent) return null;
  const mergedParent = mergeIntervals(parent);
  return child.every((interval) => mergedParent.some((container) => intervalContains(container, interval)));
}

export function nodeRequirementsOverlap(a: string | null, b: string | null): boolean | null {
  return rangesOverlap(a, b, "node");
}

export function pythonRequirementsOverlap(a: string | null, b: string | null): boolean | null {
  return rangesOverlap(a, b, "python");
}

export function nodeReadmeRequirementFitsRepo(
  repoRequirement: string | null,
  readmeRequirement: string | null,
): boolean | null {
  return rangeSubsetOf(readmeRequirement, repoRequirement, "node");
}

export function pythonReadmeRequirementFitsRepo(
  repoRequirement: string | null,
  readmeRequirement: string | null,
): boolean | null {
  return rangeSubsetOf(readmeRequirement, repoRequirement, "python");
}

export function selectNodeSandboxRuntime(requirement: string | null): NodeSandboxRuntime | null {
  if (!requirement) return "node24";
  for (const major of NODE_SANDBOX_MAJORS) {
    if (nodeRequirementsOverlap(requirement, `>=${major} <${major + 1}`)) return `node${major}`;
  }
  return null;
}

export function supportsPython313(requirement: string | null): boolean {
  if (!requirement) return true;
  return pythonRequirementsOverlap(requirement, ">=3.13 <3.14") === true;
}
