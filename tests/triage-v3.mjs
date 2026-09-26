#!/usr/bin/env node
/* eslint-disable no-console, no-param-reassign, no-control-regex */
/**
 * Playwright nightly-run triage (v3).
 *
 * Merges the two earlier prototypes:
 *   - from triage.mjs: normalized SHA-256 fingerprinting, a persisted history
 *     store with flake rates and fix-attempt outcomes, and a decision gate
 *     (broad-failure / sensitive-path / escalate-after-N-failed-fixes).
 *   - from triage-playwright-results-2.mjs: actually opening and updating one
 *     GitHub issue per fingerprint, deduped, with the guardrail text embedded
 *     in the issue body, plus a job summary.
 *
 * History is a small rolling-window blob restored/saved by actions/cache, so
 * this needs no push access and no orphan branch. A cold cache is not fatal:
 * flakeRate/priorFixAttempts simply start empty and rebuild over a few nights.
 *
 * Usage:
 *   node triage-v3.mjs --report ./report.json \
 *     --history ./.test-health/history.json \
 *     --out ./.test-health/decisions.json [--dry-run]
 *
 * Env: GITHUB_TOKEN (issues: write), GITHUB_REPOSITORY, GITHUB_RUN_ID,
 *      GITHUB_SERVER_URL, GITHUB_SHA, GITHUB_REF_NAME, GITHUB_STEP_SUMMARY.
 * Without GITHUB_TOKEN the script runs in dry-run mode and only writes files.
 *
 * Schema note: reads Playwright's JSON reporter shape (suites -> specs ->
 * tests -> results, with a resolved `status` of 'expected' | 'unexpected' |
 * 'flaky' | 'skipped'). Generate one real report from your repo and diff it
 * against walk() before trusting this in CI -- the JSON reporter is not a
 * strictly versioned public API.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---------- config ----------

const HISTORY_WINDOW = Number(process.env.HISTORY_WINDOW ?? 20);
const ESCALATE_AFTER_ATTEMPTS = Number(
  process.env.ESCALATE_AFTER_ATTEMPTS ?? 2
);
const BROAD_FAILURE_RATIO = Number(process.env.BROAD_FAILURE_RATIO ?? 0.3);
const CHRONIC_FLAKE_RATE = Number(process.env.CHRONIC_FLAKE_RATE ?? 0.3);
const PERSISTENT_FAILURE_RATE = Number(
  process.env.PERSISTENT_FAILURE_RATE ?? 0.9
);
const MIN_RUNS_FOR_TREND = Number(process.env.MIN_RUNS_FOR_TREND ?? 5);
const HOLD_CONFIRM_RUNS = Number(process.env.HOLD_CONFIRM_RUNS ?? 5);
const PRUNE_AFTER_DAYS = Number(process.env.PRUNE_AFTER_DAYS ?? 60);
const MAX_ISSUE_STATE_REFRESHES = 50; // bound the API calls spent re-checking tracked issues

// Failures under these paths always go to a human, never to an agent.
const SENSITIVE_PATH_PATTERNS = (process.env.SENSITIVE_PATH_PATTERNS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => new RegExp(s, 'i'));

const BASE_LABEL = 'e2e-failure';
const AGENT_LABEL = 'auto-investigate';
const HUMAN_LABEL = 'needs-human';
const CLASSIFICATION_LABELS = {
  chronic_flake: 'chronic-flake',
  new_flake: 'new-flake',
  persistent_failure: 'persistent-failure',
  new_hard_failure: 'new-hard-failure',
};

const MARKER = fp => `<!-- test-health-fingerprint: ${fp} -->`;

// ---------- fingerprinting ----------

// Matches any CSI escape sequence (colors, cursor movement, etc.), not just `m` (SGR/color).
// Playwright's expect() output is colorized with these; left in place they get embedded raw
// in the issue body and render as mangled glyphs (e.g. `<0x1b>[31m` -> `<20>[31m`) once GitHub
// re-encodes the markdown, so this must be stripped from anything we actually display, not
// just from the copy we hash for fingerprinting.
const ANSI_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text = '') {
  return text.replace(ANSI_PATTERN, '');
}

// Strip anything that varies run-to-run (ids, line numbers, timestamps) so
// the same underlying bug hashes to the same fingerprint every time.
function normalizeError(message = '', stackTop = '') {
  return stripAnsi(`${message}\n${stackTop}`)
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>'
    )
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/\b\d{10,13}\b/g, '<timestamp>')
    .replace(/\b\d+(\.\d+)?m?s\b/g, '<duration>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstAppFrame(stack = '') {
  const line = stack
    .split('\n')
    .find(l => l.includes('/tests/') || l.includes('/src/'));
  return line ? line.trim() : '';
}

function fingerprint(error) {
  const signature = normalizeError(error?.message, firstAppFrame(error?.stack));
  return createHash('sha256').update(signature).digest('hex').slice(0, 12);
}

// Playwright exposes the page's accessibility snapshot at failure time either on the
// error itself (1.60+ errorContext) or as an attached markdown file. Try both.
function readAttachmentContext(a) {
  if (!/error.?context/i.test(a.name ?? '')) return undefined;
  if (typeof a.body === 'string') {
    try {
      return Buffer.from(a.body, 'base64').toString('utf8');
    } catch {
      /* not base64-encoded */
    }
  }
  if (a.path && existsSync(a.path)) {
    try {
      return readFileSync(a.path, 'utf8');
    } catch {
      /* unreadable from this runner */
    }
  }
  return undefined;
}

function extractErrorContext(error, attachments) {
  const direct = error?.errorContext;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (direct && typeof direct === 'object') {
    const value = direct.value ?? direct.text ?? direct.body;
    if (typeof value === 'string' && value.trim()) return value;
  }
  const fromAttachment = (attachments ?? [])
    .map(readAttachmentContext)
    .find(Boolean);
  return fromAttachment ?? '';
}

// ---------- history store ----------

const HISTORY_VERSION = 3;

function emptyHistory() {
  return { version: HISTORY_VERSION, tests: {}, fingerprints: {} };
}

function loadHistory(historyPath) {
  if (!existsSync(historyPath)) {
    console.log(
      `No history at ${historyPath} (cold cache) - starting a new store.`
    );
    return emptyHistory();
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch (err) {
    console.warn(
      `History at ${historyPath} is unreadable (${err.message}) - starting fresh.`
    );
    return emptyHistory();
  }
  if (raw?.version === HISTORY_VERSION) {
    return {
      version: HISTORY_VERSION,
      tests: raw.tests ?? {},
      fingerprints: raw.fingerprints ?? {},
    };
  }
  // v1 shape was a bare map of testKey -> { runs, fixAttempts }.
  const migrated = emptyHistory();
  Object.entries(raw ?? {}).forEach(([key, value]) => {
    if (Array.isArray(value?.runs)) {
      migrated.tests[key] = { runs: value.runs.slice(-HISTORY_WINDOW) };
    }
  });
  console.log(
    `Migrated ${
      Object.keys(migrated.tests).length
    } legacy history entries to v${HISTORY_VERSION}.`
  );
  return migrated;
}

function saveHistory(historyPath, history) {
  mkdirSync(path.dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function recordRun(history, testKey, record) {
  const entry = history.tests[testKey] ?? { runs: [] };
  entry.runs.push(record);
  entry.runs = entry.runs.slice(-HISTORY_WINDOW);
  history.tests[testKey] = entry;
  return entry;
}

function fingerprintState(history, fp) {
  history.fingerprints[fp] ??= { fixAttempts: [], cleanRunsSinceClose: 0 };
  return history.fingerprints[fp];
}

function recurredAttempts(state) {
  return (state?.fixAttempts ?? []).filter(a => a.outcome === 'recurred');
}

// Aggregate across every test sharing a fingerprint -- one root cause can span
// several specs and several browser projects.
function groupStats(history, testKeys) {
  let runs = 0;
  let bad = 0;
  let window = 0;
  testKeys
    .map(key => history.tests[key])
    .filter(Boolean)
    .forEach(entry => {
      runs += entry.runs.length;
      bad += entry.runs.filter(r => r.status !== 'expected').length;
      window = Math.max(window, entry.runs.length);
    });
  return { flakeRate: runs ? bad / runs : 0, historyWindow: window };
}

// ---------- classification + decision gate ----------

function classify(status, flakeRate, historyWindow) {
  const settled = historyWindow >= MIN_RUNS_FOR_TREND;
  if (status === 'unexpected') {
    return settled && flakeRate >= PERSISTENT_FAILURE_RATE
      ? 'persistent_failure'
      : 'new_hard_failure';
  }
  return settled && flakeRate >= CHRONIC_FLAKE_RATE
    ? 'chronic_flake'
    : 'new_flake';
}

function isSensitivePath(testFiles) {
  return testFiles.some(f => SENSITIVE_PATH_PATTERNS.some(re => re.test(f)));
}

function decide({ testFiles, classification, state, broadFailureRatio }) {
  if (broadFailureRatio > BROAD_FAILURE_RATIO) {
    return { route: 'no_action', reason: 'broad_failure_likely_infra' };
  }
  if (isSensitivePath(testFiles)) {
    return { route: 'escalate', reason: 'sensitive_path' };
  }
  if (recurredAttempts(state).length >= ESCALATE_AFTER_ATTEMPTS) {
    return { route: 'escalate', reason: 'repeat_fix_attempts_failed' };
  }
  return { route: 'auto_fix_candidate', reason: classification };
}

// ---------- issue body ----------

const GUARDANCE = {
  chronic_flake:
    'This fingerprint has been failing intermittently for a while, so treat it as a genuine flake: ' +
    'find the race, the brittle selector, or the shared-state collision. Do not paper over it with waits or retries.',
  new_flake:
    'This fingerprint has not been seen much in recent history. It may be a brand-new flake or the first sign of a ' +
    'regression - check what changed recently before assuming the test is at fault.',
  persistent_failure:
    'This has failed on effectively every attempt across the recorded history window, which is a regression signature, ' +
    'not flakiness. Diagnose why it now fails every time instead of adding resilience around it.',
  new_hard_failure:
    'This failed every retry tonight. Treat it as a likely regression from a recent change and look at the application ' +
    'code first, not just the test.',
};

const GUARDRAIL = [
  '**Guardrail.** Do not resolve this by adding `waitForTimeout`/sleeps, raising `retries` or `timeout`,',
  'loosening an assertion, or wrapping the failure in `try`/`catch`. Prefer Playwright web-first,',
  'auto-retrying assertions (`await expect(locator).toBeVisible()`). If you cannot establish a root cause,',
  'quarantine the test with `test.skip` plus a comment linking back to this issue rather than guessing.',
  'Re-run the affected spec(s) at least 10 times before and after (`--repeat-each=10`) and report the',
  'counts honestly in the PR. See `AGENTS.md` for the full policy and required PR description format.',
].join(' ');

function truncate(text, max = 4000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n... (truncated)` : s;
}

// Pick a fence longer than any backtick run in the payload so error text cannot break out.
function fenced(text) {
  const body = truncate(text) || '(none captured)';
  const longest = (body.match(/`+/g) ?? []).reduce(
    (m, s) => Math.max(m, s.length),
    0
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

function reproCommand(bundle) {
  const files = [...new Set(bundle.tests.map(t => t.file))];
  const projects = [
    ...new Set(bundle.tests.map(t => t.project).filter(Boolean)),
  ];
  const flags = projects.map(p => `--project=${p}`).join(' ');
  return `npx playwright test ${files.join(' ')}${
    flags ? ` ${flags}` : ''
  } --repeat-each=10`;
}

function buildIssueBody(decision, ctx) {
  const b = decision.bundle;
  const lines = [
    MARKER(b.fingerprint),
    `**Fingerprint:** \`${b.fingerprint}\` · **Classification:** \`${b.classification}\` · **Route:** \`${decision.route}\` (${decision.reason})`,
    `**Flake rate:** ${b.flakeRate} over the last ${b.historyWindow} recorded nightly run(s)`,
    `**Prior automated fix attempts that recurred:** ${b.priorFixAttempts}`,
    '',
    `**Tests sharing this fingerprint (${b.tests.length}):**`,
    ...b.tests.map(
      t => `- \`${t.file}\` — ${t.title} _(${t.project || 'default'})_`
    ),
  ];

  if (b.tests.length > 1) {
    lines.push(
      '',
      '> More than one test shares this fingerprint. Fix the shared root cause once (page object, fixture, or helper) rather than patching each spec.'
    );
  }

  lines.push(
    '',
    `> ${GUARDANCE[b.classification]}`,
    '',
    '**Error**',
    fenced(b.error.message),
    '',
    '<details><summary>Stack</summary>',
    '',
    fenced(b.error.stack),
    '',
    '</details>',
    ''
  );

  if (b.pageSnapshot) {
    lines.push(
      '<details><summary>Page accessibility snapshot at the moment of failure</summary>',
      '',
      fenced(b.pageSnapshot),
      '',
      '</details>',
      ''
    );
  }

  lines.push('**Reproduce**', fenced(reproCommand(b)), '');

  if (b.traceAttachments.length > 0) {
    const artifact = ctx.reportUrl
      ? `[\`playwright-report\`](${ctx.reportUrl})`
      : '`playwright-report` (from the run below)';
    lines.push(
      `**Artifacts** — ${artifact} contains ${b.traceAttachments
        .map(a => `\`${a}\``)
        .join(', ')} for the failing attempt.`,
      'Inspect a trace without the GUI:',
      fenced(
        [
          'npx playwright trace open path/to/trace.zip',
          'npx playwright trace actions --grep="expect"',
          'npx playwright trace snapshot <n> --name after',
        ].join('\n')
      ),
      ''
    );
  }

  lines.push(
    `**Run:** ${ctx.runUrl}`,
    `**Commit:** \`${ctx.commit}\` on \`${ctx.branch}\``,
    '',
    decision.route === 'escalate'
      ? `> **Escalated to a human** (${decision.reason}) — this is intentionally not assigned to an agent.\n`
      : null,
    GUARDRAIL
  );

  // null marks an omitted line; '' is a deliberate blank line markdown needs.
  return lines.filter(l => l !== null).join('\n');
}

function buildTitle(bundle) {
  const titles = [...new Set(bundle.tests.map(t => t.title))];
  const shown = titles.slice(0, 2).join(', ');
  const extra = titles.length > 2 ? ` +${titles.length - 2} more` : '';
  return `[e2e] ${shown}${extra}`.slice(0, 240);
}

function labelsFor(decision) {
  return [
    BASE_LABEL,
    CLASSIFICATION_LABELS[decision.bundle.classification],
    decision.route === 'escalate' ? HUMAN_LABEL : AGENT_LABEL,
  ];
}

// ---------- GitHub API ----------

function makeClient(token, repository) {
  const [owner, repo] = (repository ?? '').split('/');
  const api = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function request(pathname, opts = {}) {
    const res = await fetch(`${api}${pathname}`, { headers, ...opts });
    if (!res.ok) {
      throw new Error(
        `${opts.method ?? 'GET'} ${pathname} -> ${res.status}: ${(
          await res.text()
        ).slice(0, 500)}`
      );
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    owner,
    repo,
    getIssue: number => request(`/repos/${owner}/${repo}/issues/${number}`),
    updateIssue: (number, patch) =>
      request(`/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    comment: (number, body) =>
      request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    createIssue: payload =>
      request(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    async openIssuesWithLabel(label) {
      const all = [];
      let page = 1;
      let keepGoing = true;
      while (keepGoing && page <= 5) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await request(
          `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(
            label
          )}&per_page=100&page=${page}`
        );
        all.push(...(batch ?? []));
        keepGoing = Boolean(batch && batch.length >= 100);
        page += 1;
      }
      return all;
    },
  };
}

// ---------- main ----------

function parseArgs() {
  const args = { dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag.startsWith('--')) {
      i += 1;
      args[flag.slice(2)] = argv[i];
    }
  }
  return args;
}

function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  } else {
    console.log(markdown);
  }
}

async function main() {
  const args = parseArgs();
  if (!args.report) {
    console.error(
      'Usage: node triage-v3.mjs --report <path> [--history <path>] [--out <path>] [--dry-run]'
    );
    process.exit(1);
  }

  const historyPath = args.history ?? '.test-health/history.json';
  const outPath = args.out ?? '.test-health/decisions.json';
  const report = JSON.parse(readFileSync(args.report, 'utf8'));
  const history = loadHistory(historyPath);

  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
  const ctx = {
    runId,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    reportUrl: process.env.REPORT_ARTIFACT_URL ?? '',
    commit: process.env.GITHUB_SHA ?? 'unknown',
    branch: process.env.GITHUB_REF_NAME ?? 'unknown',
    timestamp: new Date().toISOString(),
  };

  const dryRun = args.dryRun || !process.env.GITHUB_TOKEN || !repository;
  if (dryRun) console.log('Dry run: no issues will be created or updated.');
  const gh = dryRun ? null : makeClient(process.env.GITHUB_TOKEN, repository);

  // ---- 1. walk the merged report ----

  const failing = [];
  const counts = { total: 0, expected: 0, flaky: 0, unexpected: 0, skipped: 0 };

  function walk(suite) {
    (suite.specs ?? []).forEach(spec => {
      // One entry per browser project, not just the first.
      (spec.tests ?? []).forEach(test => {
        const { status } = test; // 'expected' | 'unexpected' | 'flaky' | 'skipped'
        if (status === 'skipped') {
          counts.skipped += 1;
          return;
        }
        counts.total += 1;
        counts[status] = (counts[status] ?? 0) + 1;

        const project = test.projectName ?? '';
        const testKey = `${spec.file}:${spec.line}::${spec.title}::${project}`;
        const lastResult = test.results?.at(-1);
        // For a 'flaky' test the LAST result is the retry that finally passed and
        // carries no error -- walk backwards for the attempt that actually failed.
        const failingResult =
          test.results
            ?.slice()
            .reverse()
            .find(r => r.error) ?? lastResult;

        recordRun(history, testKey, {
          ...ctx,
          status,
          durationMs: lastResult?.duration ?? 0,
        });

        if (status === 'flaky' || status === 'unexpected') {
          const error = failingResult?.error ?? {};
          const attachments = failingResult?.attachments ?? [];
          failing.push({
            testKey,
            file: spec.file,
            title: spec.title,
            project,
            status,
            fp: fingerprint(error),
            error: {
              message: stripAnsi(error.message ?? ''),
              stack: stripAnsi(error.stack ?? ''),
            },
            pageSnapshot: stripAnsi(extractErrorContext(error, attachments)),
            attachments: attachments.map(a => a.name ?? a.path).filter(Boolean),
          });
        }
      });
    });
    (suite.suites ?? []).forEach(child => walk(child));
  }
  walk(report);

  const broadFailureRatio =
    counts.total > 0 ? failing.length / counts.total : 0;
  console.log(
    `${counts.total} test(s) ran: ${counts.expected ?? 0} passed, ${
      counts.flaky ?? 0
    } flaky, ${counts.unexpected ?? 0} failed.`
  );

  // ---- 2. group by fingerprint and decide ----

  const groups = new Map();
  failing.forEach(f => {
    if (!groups.has(f.fp)) groups.set(f.fp, []);
    groups.get(f.fp).push(f);
  });

  const decisions = [...groups.entries()].map(([fp, group]) => {
    const testKeys = group.map(g => g.testKey);
    const { flakeRate, historyWindow } = groupStats(history, testKeys);
    // 'unexpected' dominates: if any project failed outright, treat the group as a hard failure.
    const status = group.some(g => g.status === 'unexpected')
      ? 'unexpected'
      : 'flaky';
    const classification = classify(status, flakeRate, historyWindow);
    const state = fingerprintState(history, fp);
    const decision = decide({
      testFiles: [...new Set(group.map(g => g.file))],
      classification,
      state,
      broadFailureRatio,
    });

    return {
      ...decision,
      bundle: {
        fingerprint: fp,
        status,
        classification,
        tests: group.map(g => ({
          file: g.file,
          title: g.title,
          project: g.project,
          status: g.status,
        })),
        error: group[0].error,
        pageSnapshot: group.find(g => g.pageSnapshot)?.pageSnapshot ?? '',
        flakeRate: Number(flakeRate.toFixed(2)),
        historyWindow,
        priorFixAttempts: recurredAttempts(state).length,
        traceAttachments: [...new Set(group.flatMap(g => g.attachments))],
      },
    };
  });

  // ---- 3. refresh tracked issue state, record held/recurred outcomes ----

  const seenThisRun = new Set(groups.keys());
  if (gh) {
    const tracked = Object.entries(history.fingerprints)
      .filter(([, s]) => s.issueNumber)
      .sort(([fpA, a], [fpB, b]) => {
        // Prioritize fingerprints failing this run (their issueState decides reopening below),
        // then the rest by recency, so a long tail of old tracked issues can't crowd out the
        // refreshes that actually matter once the list exceeds MAX_ISSUE_STATE_REFRESHES.
        const seenA = seenThisRun.has(fpA);
        const seenB = seenThisRun.has(fpB);
        if (seenA !== seenB) return seenA ? -1 : 1;
        return (
          (Date.parse(b.lastSeenAt ?? '') || 0) -
          (Date.parse(a.lastSeenAt ?? '') || 0)
        );
      })
      .slice(0, MAX_ISSUE_STATE_REFRESHES);
    await Promise.all(
      tracked.map(async ([fp, state]) => {
        try {
          const issue = await gh.getIssue(state.issueNumber);
          state.issueState = issue.state;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `Could not refresh issue #${state.issueNumber} for ${fp}: ${err.message}`
          );
        }
      })
    );
  }

  Object.entries(history.fingerprints)
    .filter(([, state]) => state.issueNumber && state.issueState === 'closed')
    .forEach(([fp, state]) => {
      if (seenThisRun.has(fp)) {
        // The issue was closed as fixed and the same fingerprint came back: the fix did not hold.
        state.fixAttempts.push({
          outcome: 'recurred',
          issueNumber: state.issueNumber,
          runId: ctx.runId,
          at: ctx.timestamp,
        });
        state.cleanRunsSinceClose = 0;
      } else {
        state.cleanRunsSinceClose = (state.cleanRunsSinceClose ?? 0) + 1;
        const alreadyHeld = state.fixAttempts.at(-1)?.outcome === 'held';
        if (state.cleanRunsSinceClose >= HOLD_CONFIRM_RUNS && !alreadyHeld) {
          state.fixAttempts.push({
            outcome: 'held',
            issueNumber: state.issueNumber,
            runId: ctx.runId,
            at: ctx.timestamp,
          });
        }
      }
    });

  // Recount after recording recurrences so escalation takes effect on this run.
  decisions.forEach(decision => {
    const state = history.fingerprints[decision.bundle.fingerprint];
    decision.bundle.priorFixAttempts = recurredAttempts(state).length;
    if (
      decision.route === 'auto_fix_candidate' &&
      decision.bundle.priorFixAttempts >= ESCALATE_AFTER_ATTEMPTS
    ) {
      decision.route = 'escalate';
      decision.reason = 'repeat_fix_attempts_failed';
    }
  });

  // ---- 4. open or update one issue per fingerprint ----

  const existingByFingerprint = new Map();
  if (gh) {
    try {
      const open = await gh.openIssuesWithLabel(BASE_LABEL);
      open.forEach(issue => {
        const match = issue.body?.match(
          /<!-- test-health-fingerprint: ([0-9a-f]+) -->/
        );
        if (match) existingByFingerprint.set(match[1], issue.number);
      });
    } catch (err) {
      console.warn(
        `Could not list existing issues, relying on cached history only: ${err.message}`
      );
    }
  }

  await decisions.reduce(async (prevPromise, decision) => {
    await prevPromise;

    const fp = decision.bundle.fingerprint;
    const state = fingerprintState(history, fp);
    state.lastSeenAt = ctx.timestamp;
    state.lastSeenRunId = ctx.runId;

    if (decision.route === 'no_action') {
      // eslint-disable-next-line no-console
      console.log(`  [no_action] ${fp} (${decision.reason})`);
      return;
    }

    const body = buildIssueBody(decision, ctx);
    const labels = labelsFor(decision);
    const issueNumber = state.issueNumber ?? existingByFingerprint.get(fp);
    // Keep the rendered issue on the decision so a dry run is reviewable.
    decision.rendered = { title: buildTitle(decision.bundle), labels, body };

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        `  [${decision.route}] ${fp} (${decision.reason}) - would ${
          issueNumber ? `update #${issueNumber}` : 'open an issue'
        }`
      );
      decision.issue = issueNumber ?? null;
      return;
    }

    try {
      if (issueNumber) {
        const reopening = state.issueState === 'closed';
        await gh.updateIssue(issueNumber, {
          body,
          labels,
          ...(reopening ? { state: 'open' } : {}),
        });
        await gh.comment(
          issueNumber,
          reopening
            ? `Recurred after this issue was closed — run ${ctx.runUrl}. Reopening; the previous fix did not hold.`
            : `Still failing — run ${ctx.runUrl}.`
        );
        state.issueState = 'open';
        state.issueNumber = issueNumber;
        decision.issue = issueNumber;
        // eslint-disable-next-line no-console
        console.log(
          `  [${decision.route}] ${fp} -> ${
            reopening ? 'reopened' : 'updated'
          } #${issueNumber}`
        );
      } else {
        const created = await gh.createIssue({
          title: buildTitle(decision.bundle),
          body,
          labels,
        });
        state.issueNumber = created.number;
        state.issueState = 'open';
        state.openedAt = ctx.timestamp;
        decision.issue = created.number;
        // eslint-disable-next-line no-console
        console.log(`  [${decision.route}] ${fp} -> opened #${created.number}`);
      }
    } catch (err) {
      console.error(`Failed to sync issue for ${fp}: ${err.message}`);
      decision.issueError = err.message;
    }
  }, Promise.resolve());

  // ---- 5. prune, persist, summarize ----

  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400_000;
  Object.entries(history.fingerprints).forEach(([fp, state]) => {
    const lastSeen = Date.parse(state.lastSeenAt ?? '') || 0;
    if (lastSeen < cutoff && state.issueState !== 'open') {
      delete history.fingerprints[fp];
    }
  });

  saveHistory(historyPath, history);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ ...ctx, counts, broadFailureRatio, decisions }, null, 2)
  );

  const byRoute = route => decisions.filter(d => d.route === route);
  writeSummary(
    `${[
      '### Nightly E2E triage',
      '',
      `- Ran ${counts.total} test(s): ${counts.expected ?? 0} passed, ${
        counts.flaky ?? 0
      } flaky, ${counts.unexpected ?? 0} failed`,
      `- ${failing.length} failing test(s) grouped into ${decisions.length} fingerprint(s)`,
      `- Routed: ${byRoute('auto_fix_candidate').length} to an agent, ${
        byRoute('escalate').length
      } escalated, ${byRoute('no_action').length} suppressed`,
      dryRun ? '- _Dry run — no issues were created or updated._' : null,
      broadFailureRatio > BROAD_FAILURE_RATIO
        ? `- ⚠️ ${(broadFailureRatio * 100).toFixed(
            0
          )}% of the suite failed at once; treated as infrastructure, no issues opened.`
        : null,
      '',
      ...(decisions.length
        ? [
            '| Route | Fingerprint | Classification | Flake rate | Tests | Issue |',
            '| --- | --- | --- | --- | --- | --- |',
            ...decisions.map(
              d =>
                `| ${d.route} | \`${d.bundle.fingerprint}\` | ${
                  d.bundle.classification
                } | ${d.bundle.flakeRate} (${d.bundle.historyWindow} runs) | ${
                  d.bundle.tests.length
                } | ${d.issue ? `#${d.issue}` : '—'} |`
            ),
          ]
        : []),
      '',
    ]
      .filter(l => l !== null)
      .join('\n')}\n`
  );
}

await main();
