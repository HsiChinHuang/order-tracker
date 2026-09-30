// Tests for the three functions that decide every incident outcome, plus the
// write-scope audit's tree walking. Issue #11: the responder had zero automated
// tests, so a regression in any of these would silently turn "escalate" into
// "resolved" (or the reverse) with nothing to catch it until a real alert fired.
//
// Run with:  node --test incident-response/
// No docker, no network, no agent, no .env required. Importing responder.mjs must
// therefore have no side effects - the last test asserts exactly that.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseVerdict,
  isRecovered,
  statusAfterVerify,
  classifyWriteScope,
  diffTrees,
  snapshotTreeForTests,
  WRITE_ALLOW_PREFIX_FOR_TESTS,
  server,
} from "./responder.mjs";

const probe = (statuses) => ({
  verified: true,
  results: statuses.map((s, i) => ({ url: `/api/orders/x-${i}`, status: s })),
  still_failing: statuses.filter((s) => s >= 500).map((s, i) => ({ status: s })),
  unreachable: statuses.filter((s) => s === 0 || s >= 600 || s < 200).map((s) => ({ status: s })),
  indeterminate: false,
});

test("parseVerdict reads the contract line the agent actually produces", () => {
  const text = [
    "I investigated the incident.",
    "",
    "VERDICT: fixed - replace(day=day+2) raises ValueError at month end",
  ].join("\n");
  const v = parseVerdict(text);
  assert.equal(v.kind, "fixed");
  assert.match(v.reason, /month end/);
  // The line is the last non-blank line, so an appended blank line must not break it.
  assert.equal(v.lineFromEnd, 0);
  assert.equal(parseVerdict(text + "\n\n").lineFromEnd, 0);
});

test("parseVerdict finds the last VERDICT line, not the first", () => {
  const text = [
    "VERDICT: needs-human - initial guess",
    "I kept digging and found the real cause.",
    "VERDICT: fixed - the real cause",
  ].join("\n");
  const v = parseVerdict(text);
  assert.equal(v.kind, "fixed");
  assert.equal(v.lineFromEnd, 0);
});

test("parseVerdict accepts all three kinds and normalises case", () => {
  for (const kind of ["fixed", "no-action", "needs-human"]) {
    assert.equal(parseVerdict(`VERDICT: ${kind} - r`).kind, kind);
    assert.equal(parseVerdict(`VERDICT: ${kind.toUpperCase()} - r`).kind, kind);
  }
});

test("parseVerdict returns null when the agent said nothing attributable", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict("I could not find the cause."), null);
  // An unknown kind must not be coerced into a known one.
  assert.equal(parseVerdict("VERDICT: maybe - r"), null);
  // A VERDICT line that is not a line of its own is not a contract fulfilment.
  assert.equal(parseVerdict("the VERDICT: fixed - r was mentioned"), null);
});

test("isRecovered is true only for a check that measured something healthy", () => {
  assert.equal(isRecovered(probe([200, 200, 200])), true);
  assert.equal(isRecovered(probe([200, 304, 200])), true);
});

test("isRecovered is false for 5xx", () => {
  assert.equal(isRecovered(probe([200, 500, 200])), false);
});

test("isRecovered is false when a probe never got an HTTP answer", () => {
  // This is the production bug #5 records: APP_BASE_URL pointed at an
  // unresolvable host, all three probes returned status 0, and the responder
  // certified recovered=true. An unreachable endpoint is UNKNOWN, never healthy.
  const r = probe([0, 0, 0]);
  assert.equal(r.still_failing.length, 0, "fixture really has no 5xx");
  assert.equal(isRecovered(r), false);
});

test("isRecovered is false when the check measured nothing at all", () => {
  // Same bug class, narrower: verified=true with zero results used to read as
  // recovered because "no failures" cannot be told apart from "no measurements".
  assert.equal(
    isRecovered({ verified: true, results: [], still_failing: [], unreachable: [] }),
    false,
  );
});

test("isRecovered is false when the check never ran", () => {
  assert.equal(isRecovered(null), false);
  assert.equal(isRecovered({}), false);
  assert.equal(
    isRecovered({ verified: false, results: [{ status: 200 }], still_failing: [], unreachable: [] }),
    false,
  );
});

test("diffTrees reports changed, added and removed paths", () => {
  const before = new Map([
    ["app/main.py", "10:1"],
    ["README.md", "20:1"],
    ["gone.txt", "5:1"],
  ]);
  const after = new Map([
    ["app/main.py", "11:1"], // changed
    ["README.md", "20:1"], // untouched
    ["new.txt", "3:1"], // added
  ]);
  const d = diffTrees(before, after);
  assert.deepEqual(d.changed, ["app/main.py"]);
  assert.deepEqual(d.added, ["new.txt"]);
  assert.deepEqual(d.removed, ["gone.txt"]);
});

test("classifyWriteScope puts anything outside app/ in outside", () => {
  const scope = classifyWriteScope({
    changed: ["app/main.py"],
    added: ["tests/test_api.py", "NOTES.md"],
    removed: [],
  });
  assert.deepEqual(scope.allowed, ["app/main.py"]);
  assert.deepEqual(scope.outside, ["tests/test_api.py", "NOTES.md"]);
  assert.equal(scope.touched.length, 3);
});

test("classifyWriteScope on a clean run reports nothing outside app/", () => {
  const scope = classifyWriteScope({ changed: ["app/main.py"], added: [], removed: [] });
  assert.deepEqual(scope.outside, []);
  assert.equal(WRITE_ALLOW_PREFIX_FOR_TESTS, "app/");
});

test("snapshotTree prunes .git and other churn, and catches root files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-"));
  try {
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "app", "main.py"), "x = 1\n");
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "//\n");
    await writeFile(join(root, "NOTES.md"), "root file\n");

    const tree = await snapshotTreeForTests(root);
    const paths = [...tree.keys()].sort();
    assert.deepEqual(paths, ["NOTES.md", "app/main.py"]);

    // Edit one file under app/, add one outside: the audit must see both, and the
    // second one must be the thing that forces escalation.
    await writeFile(join(root, "app", "main.py"), "x = 2\n");
    await writeFile(join(root, "compose.yaml"), "surprise\n");
    const scope = classifyWriteScope(diffTrees(tree, await snapshotTreeForTests(root)));
    assert.deepEqual(scope.allowed, ["app/main.py"]);
    assert.deepEqual(scope.outside, ["compose.yaml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("statusAfterVerify is one definition, used live and on rebuild (issue #12)", () => {
  // The bug: only the boot rebuild derived these two statuses, so GET /incidents
  // said agent_completed for an incident that had been verified minutes earlier,
  // and the answer flipped to "recovered" only after a restart.
  assert.equal(statusAfterVerify(true), "recovered");
  assert.equal(statusAfterVerify(false), "verified_unrecovered");
  assert.notEqual(statusAfterVerify(true), "agent_completed");
});

test("importing responder.mjs does not start the HTTP server", () => {
  // Without the main-module guard this import would bind :8001 and collide with
  // the running responder, so a unit test could not run next to the real service.
  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
});
