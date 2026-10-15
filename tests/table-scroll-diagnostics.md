# Mouse-scroll investigation — issue #14

Classification: **unresolved**. This is an evidence-collection change, not a
behavioral fix. Keep [#14](https://github.com/cryolins/web-client-ui/issues/14)
open and keep Chromium quarantined unless deliberately opting in below.

## Root cause

Fingerprint `6cbc263a47fa`: `(x, 27)` was expected to equal `"27"` but returned
`null` for 15 seconds. A missing cell can mean that the row left the viewport;
it does not establish that the underlying value was wrong.

The complete issue context reports a chronic flake, 0.33 across six nightly
runs, one affected test, and zero recurring automated fix attempts. The issue
comment supplies no further evidence.

Historical run
[36930530345](https://github.com/cryolins/web-client-ui/actions/runs/36930530345),
commit `d3ed4aa0ff9c60fa23e41a7bc5c34b3071fbe98c`, Chromium job
`110600667629`, succeeded because the retry passed:

- Initial: 2026-10-01 21:56:13.081 UTC; 18,851 ms; row-27 assertion failed.
- Retry: 2026-10-01 21:56:32.463 UTC; 6,401 ms; passed.

All three available run artifacts were inspected: HTML report `11196059982`,
JSON report `11195874827`, and triage decisions `11197260101`. The HTML report's
embedded step tree establishes that the failed attempt sent **two** wheel
commands: its first predicate still observed row zero; the second predicate
passed. It then captured row 27 and failed the exact-value assertion.

Only the **passing retry** retained a trace and video. Its trace shows one
wheel, rows 0–18 before and 27–45 after, and successful exact checks of rows
27–31. A decoded video frame also shows those later rows. The retry has no
recorded console/page errors or failed network requests: all 48 recorded
requests returned HTTP 200. Software-WebGL warnings are present.

The failed attempt retained only error-context, whose page snapshot omits
canvas cell values. There is **no failed-attempt trace, screenshot, video,
browser-console/network timeline, or core-server log**. The three standalone
PNGs in the report concern a different WebKit selection failure. Server-log
collection was skipped because the historical job succeeded. Proxy errors in
the job log do not coincide with this attempt.

History inspection: `71115181` introduced this test, its replaying `toPass`
block, and the accessibility helpers. Neither test nor helper changed before
the failing commit; `d3ed4aa0` changes only nightly triage. `7d9454e7` later
changed selection/accessibility integration, not wheel handling. `cb72d294`
introduced the wheel handler's conditional state-update/event-prevention
boundary behavior. Older wheel-handler introduction predates the fetched
history. `waitForLoadingDone` observes absence of the loading indicator, not
completion of wheel processing. Snapshot state follows canvas draw listeners;
listener registration immediately supplies existing render state, and resize
can draw synchronously.

**Hypothesis, not a finding:** the replay loop might send another wheel while
the preceding operation is still becoming visible, invalidating captured
rows. Historical evidence cannot show whether that happened. No local run
reproduced the original failure, so neither the loop nor production code was
changed to implement this hypothesis.

## Fix

- Preserve Chromium quarantine by default. Only
  `DH_GRID_SCROLL_DIAGNOSTICS=1` opts this test into unquarantined recording.
- Preserve the replay loop, timeout/retry configuration, positive scrolling
  predicate, and exact `expectCellText(grid, 'x', row, String(row))` checks.
- Add a narrowly scoped fixture, active only for this test with that flag.
  Every attempt, including successful attempts, attaches
  `grid-scroll-diagnostics` JSON.
- Record wheel-command issuance/return, native wheel delivery, captured row
  lists, assertion targets, accessibility snapshot mutations, and actual draw
  notifications. The immediate subscription callback is labeled
  `current-render-state`, **not** `completed-draw`.
- Record console warnings/errors, page errors, failed requests, HTTP errors,
  and WebSocket errors from before navigation through fixture teardown.
  Request headers, bodies, query strings and socket frames are not collected.
- Enable failure screenshots. Existing `trace: 'retain-on-failure'` remains
  unchanged. CI video remains first-retry-only; it does not supply video of
  an initial failure.

The draw observer uses a diagnostic-only React-fiber lookup to subscribe to
the existing Grid listener, avoiding any production changes. If that private
lookup stops working, JSON explicitly reports `draw-probe-unavailable`.
Listeners and observers are removed at teardown. Node and browser event
buffers each cap at 2,000 entries and report dropped-event counts.

Raw draw `metrics.visibleRows` can include rows beyond the clipped snapshot
(e.g. 27–47 versus DOM rows 27–45); these are separate observations, not
interchangeable completion conditions. Browser timestamps use
`performance.timeOrigin + performance.now()`; Node timestamps use `Date.now()`.
These records are never used to synchronize the test.

## Evidence

All actual affected-test repetitions used Playwright **1.56.1**, Chromium
**141.0.7390.37**, Desktop Chrome **1280×720**, and **two workers**.

- **Before, initial ten repeats:** nine initial passes, one initial setup
  failure, and its passing retry; zero skips.
- **Before, confirmatory ten, retries disabled:** 10 passed, zero failed/skipped.
- **After, instrumented ten, retries disabled:** 10 passed, zero failed/skipped.
- **After, final recorder ten, retries disabled:** 10 passed, zero failed/skipped.
- **After, recorder-disabled controls, retries disabled:** two batches of ten;
  20 passed, zero failed/skipped.
- **Quarantine control, diagnostics disabled:** ten skipped; zero executed.
- **Related Chromium content + accessibility suites, retries disabled:** two
  executions, each 18/18 passed; zero failed/skipped.

The additional initial baseline failure was in `openPanel`: the Panels
search input never appeared. It failed **before any wheel/cell assertions**
and is not fingerprint `6cbc263a47fa`. Its trace/context were inspected; no
console/page/network error established a cause. Its passing retry retained
the failed-attempt trace through report merging. One attempted frame view
was blocked by the image viewer's limit; no visual conclusion is drawn.

Before-edit quarantine bypass was process-local: a Node `--import` data-URL
preload intercepted only the linked quarantine reason's `test.skip` call.
The recorder-disabled post-change control similarly intercepted the derived
test returned by `test.extend`. Neither bypass changed repository files,
assertions, wheel delivery, or waiting behavior. The default-quarantine
control's ten skips are **not** counted as successful repetitions.

The first instrumented batch's ten JSON attachments each contain one native
wheel, three actual completed-draw notifications, initial-state notification,
snapshot updates, after-capture rows 27–45, and zero dropped browser events.
No replay was observed in that batch. Instrumentation can perturb timing;
passing controls with it disabled also do **not** establish a root cause.

Validation:

- `npm run test:lint -- --runInBand`: **1,446/1,446 passed**. The repository
  lint runner covers package source, not `tests/`; targeted ESLint on both
  changed test files also passed, with an 8 GiB Node heap.
- `npm run types`: passed.
- Additional in-memory TypeScript program covering the changed config, spec,
  helper and their imports: **zero diagnostics**.
- Prettier check of the changed TypeScript files: passed.
- A separate synthetic browser smoke harness deliberately failed attempt zero
  and passed retry one, using inherited CI retry/trace/screenshot settings.
  Both attempts retained JSON; the initial attempt retained screenshot and
  trace. Console, HTTP-503, request-abort, wheel, snapshot and draw-observer
  records were asserted present. Blob-to-HTML merging retained these
  attachments. Its mocked draw listener validates collection plumbing,
  **not** application rendering or the original race.

The broad `tsconfig.eslint.json` compile was also tried. It includes unit-test
sources and produced many unrelated pre-existing type errors; it is not the
repository's `npm run types` command. Two initial helper listener-type errors
were corrected, then the targeted program passed. Direct ESLint on the root
config cannot use that existing TSConfig because it excludes root configs;
the config was instead covered by the targeted TypeScript/Prettier checks.

### Environment and reproducibility gaps

Historical CI: Ubuntu 22.04 host, Noble Playwright image
`mcr.microsoft.com/playwright:v1.56.1-noble`, digest
`sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a`,
Node 24.14.1 / npm 11.11.0, 150-test Chromium shard with two workers.
Core used mutable `ghcr.io/deephaven/server:edge`; its resolved digest was not
recorded and cannot be recovered from the available artifacts.

Local: Ubuntu 24.04.5 host, Node 24.20.0 / npm 11.19.0, native installed
Playwright browsers, production app/widget bundles built with
`VITE_PLAYWRIGHT_CSS=1`, and anonymous core on port 10000 with the repository's
application-mode data and `-Xmx4g`. Core was started by immutable reference:

```text
ghcr.io/deephaven/server@sha256:8e48613510839327adb77d9ed0f24e23a248f9feadb0d7cff4238ce13378787e
```

Image ID:
`sha256:369a976d6d4b670f1742737111176216131398ee93ad623bdb99cb84b30ad6ab`;
version `43.0-SNAPSHOT`. The same container served all before/after batches.
This matches browser/PW/viewport/concurrency, but **not an exact historical
server, runner image, fonts, Node patch, or full-shard workload reproduction**.
App source before changes was `a51ef6142da3d2e7206b3bb19cecce65205bd3c7`.

### CI retention verification

Current `.github/workflows/e2e.yml` already uploads blob reports with
`if: !cancelled()`, merges them into HTML, and uploads HTML for 30 days.
Server logs already use `!cancelled()` and include stderr. These conditions
include a successful job with failed initial attempts. No workflow edit was
needed. The local controlled fail-then-pass run verified Playwright's
attempt-level retention and the same blob-to-HTML merge path; **no new remote
Actions run or actual upload was triggered**.

Session-local evidence, not durable GitHub attachments:

- Historical downloaded reports, traces and decoded video: `issue14-history/`.
- Initial baseline blob / HTML: `issue14-before-blob/`, `issue14-before-html/`.
- Confirmatory before blob: `issue14-before-confirm-blob/`.
- Instrumented after blobs: `issue14-after-blob/`, `issue14-final-after-blob/`.
- Final instrumented HTML: `issue14-final-after-html/`.
- Recorder-disabled controls: `issue14-after-no-recorder-blob/`,
  `issue14-final-no-recorder-blob/`.
- Related suites: `issue14-suite-blob/`, `issue14-final-suite-blob/`.
- Controlled retention harness / blob / HTML: `issue14-retention/`,
  `issue14-retention-blob/`, `issue14-retention-html/`.

### Deliberate opt-in

With the built app/widget bundles and an anonymous core already available:

```sh
CI=true DH_GRID_SCROLL_DIAGNOSTICS=1 \
  VITE_PROXY_URL=http://localhost:10000 \
  DHC_IMAGE=ghcr.io/deephaven/server@sha256:8e48613510839327adb77d9ed0f24e23a248f9feadb0d7cff4238ce13378787e \
  npx playwright test tests/table-contents.spec.ts \
  --config=playwright-ci.config.ts --project=chromium \
  --grep='shows later rows after scrolling down with the mouse' \
  --repeat-each=10 --workers=2 --retries=0 --reporter=line,blob
```

`DHC_IMAGE` is diagnostic metadata, **not** server selection: start/pin the
server separately. For Docker execution explicitly pass
`-e DH_GRID_SCROLL_DIAGNOSTICS=1` (and `-e DHC_IMAGE=...`) to `docker compose run`;
the compose file does not automatically forward host environment variables.
Do not remove quarantine or enable recording suite-wide by default.

## Scope

Only `tests/table-contents.spec.ts`, its new diagnostic fixture and this
companion report, plus the failure-screenshot setting in `playwright.config.ts`.
No production code, shared grid helpers, assertion values, retry/timeout
settings, CI jobs, or policies changed.

Next evidence needed: an **original** row-value failure with its first-attempt
trace/screenshot and diagnostic JSON. Correlate command count, native delivery,
actual draw metrics, snapshot changes and the captured assertion rows.
If replay is not observed, investigate the snapshot/data path instead of
assuming it. Preserve core image identity and contemporaneous server logs.
