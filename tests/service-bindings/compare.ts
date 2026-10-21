// Compares a platform run of the service-binding suite with the workerd reference, case by
// case, and scores the reliability checks against fixed limits.
//   bun tests/service-bindings/compare.ts REFERENCE.json PLATFORM.json [SCORE.json]
// A case passes when what the caller observed is identical on both runtimes. Headers the
// platform adds for its own plumbing (x-sb-*) are left out of the comparison and listed.
import { isObject, isString, parseRun, type JsonValue } from "./run";

const [refPath, platPath, outPath] = process.argv.slice(2);
if (!refPath || !platPath) {
  console.error("usage: bun tests/service-bindings/compare.ts REFERENCE.json PLATFORM.json [SCORE.json]");
  process.exit(2);
}
const ref = parseRun(await Bun.file(refPath).text(), refPath);
const plat = parseRun(await Bun.file(platPath).text(), platPath);

const leaked = new Set<string>();
const isInternalHeader = (entry: JsonValue) =>
  Array.isArray(entry) && isString(entry[0]) && entry[0].startsWith("x-sb-");
// Drops the platform's own x-sb-* headers wherever a [name, value] header list appears.
const strip = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    for (const entry of value)
      if (Array.isArray(entry) && isInternalHeader(entry) && isString(entry[0])) leaked.add(entry[0]);
    return value.filter((entry) => !isInternalHeader(entry)).map(strip);
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]));
  return value;
};
const show = (value: JsonValue | undefined) => (value === undefined ? "(absent)" : JSON.stringify(value).slice(0, 90));
// Every differing leaf path between two JSON values (objects are walked; arrays compare whole).
const diff = (a: JsonValue | undefined, b: JsonValue | undefined, path = ""): string[] => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      diff(a[key], b[key], `${path}.${key}`),
    );
  }
  return [`${path || "."}: workerd ${show(a)} | platform ${show(b)}`];
};

const cases = new Map<string, string[]>();
for (const [name, expected] of ref.cases) {
  const actual = plat.cases.get(name);
  cases.set(
    name,
    actual
      ? diff({ status: expected.status, value: expected.value }, { status: actual.status, value: strip(actual.value) })
      : ["missing on the platform"],
  );
}

// Reliability: what a caller should be able to count on, whatever workerd's exact timings.
const r = plat.reliability;
const reliability = [
  {
    name: "responsiveDuringCall",
    pass: r.responsiveDuringCall.pingStatus === 200 && r.responsiveDuringCall.pingMs < 500,
    observed: r.responsiveDuringCall,
  },
  {
    name: "concurrent8x500ms",
    pass: r.concurrent8x500ms.statuses.every((s) => s === 200) && r.concurrent8x500ms.totalMs < 1500,
    observed: r.concurrent8x500ms,
  },
  {
    name: "selfRecursion",
    pass: r.selfRecursion.status === 200 && r.selfRecursion.text === "bottom 50",
    observed: r.selfRecursion,
  },
  {
    name: "mutualRecursion",
    pass: r.mutualRecursion.status === 200 && r.mutualRecursion.text === "pong",
    observed: r.mutualRecursion,
  },
  {
    // workerd waits as long as the client does; the platform must at least not wedge the caller.
    name: "calleeNeverAnswers",
    pass:
      r.calleeNeverAnswers.ms >= 59_000 || (r.calleeNeverAnswers.status >= 500 && r.calleeNeverAnswers.status < 600),
    observed: r.calleeNeverAnswers,
  },
];

const casePass = [...cases.values()].filter((d) => d.length === 0).length;
const relPass = reliability.filter((c) => c.pass).length;
for (const [name, d] of cases)
  console.log(`${d.length ? "FAIL" : "PASS"} ${name}${d.map((line) => "\n       " + line).join("")}`);
for (const c of reliability)
  console.log(`${c.pass ? "PASS" : "FAIL"} reliability/${c.name}  ${JSON.stringify(c.observed)}`);
const score = { cases: `${casePass}/${cases.size}`, reliability: `${relPass}/${reliability.length}` };
console.log(`\ncases ${score.cases}, reliability ${score.reliability}`);
if (leaked.size) console.log(`internal headers visible to the caller: ${[...leaked].join(", ")}`);
if (outPath) {
  const report = { score, cases: Object.fromEntries(cases), reliability, leakedHeaders: [...leaked] };
  await Bun.write(outPath, JSON.stringify(report, null, 2));
}
