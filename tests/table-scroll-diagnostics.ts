import {
  test as base,
  type ConsoleMessage,
  type JSHandle,
  type Locator,
  type Request,
  type Response,
  type WebSocket,
} from '@playwright/test';
import type { GridRenderState } from '@deephaven/grid';

export const scrollDiagnosticsEnabled =
  process.env.DH_GRID_SCROLL_DIAGNOSTICS === '1';

const SCROLL_TEST = 'shows later rows after scrolling down with the mouse';

type Entry = {
  time: number;
  kind: string;
  details: unknown;
};

type BrowserProbe = {
  events: Entry[];
  dropped: number;
  stop: () => void;
};

type ScrollDiagnostics = {
  observe: (grid: Locator) => Promise<void>;
  record: (kind: string, details: unknown) => void;
};

/**
 * Deliberately opt-in: observing draws adds work and can perturb a race.
 * This fixture never supplies a condition for the test to wait on.
 */
export const test = base.extend<{
  scrollDiagnostics: ScrollDiagnostics | undefined;
}>({
  scrollDiagnostics: [
    async ({ page, browser }, use, testInfo) => {
      if (!scrollDiagnosticsEnabled || testInfo.title !== SCROLL_TEST) {
        await use(undefined);
        return;
      }

      const events: Entry[] = [];
      let dropped = 0;
      const record = (kind: string, details: unknown) => {
        if (events.length < 2000) {
          events.push({ time: Date.now(), kind, details });
        } else {
          dropped += 1;
        }
      };
      // No headers, bodies, query strings or socket frames are collected.
      const location = (url: string) => url.split(/[?#]/)[0];
      const onConsole = (message: ConsoleMessage) => {
        if (['warning', 'error'].includes(message.type())) {
          record('console', {
            type: message.type(),
            text: message.text(),
            location: {
              ...message.location(),
              url: location(message.location().url),
            },
          });
        }
      };
      const onPageError = (error: Error) =>
        record('page-error', { message: error.message, stack: error.stack });
      const onRequestFailed = (request: Request) =>
        record('request-failed', {
          url: location(request.url()),
          method: request.method(),
          error: request.failure()?.errorText,
        });
      const onResponse = (response: Response) => {
        if (response.status() >= 400) {
          record('http-error', {
            url: location(response.url()),
            status: response.status(),
          });
        }
      };
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      page.on('requestfailed', onRequestFailed);
      page.on('response', onResponse);
      const socketCleanups: (() => void)[] = [];
      const onWebSocket = (socket: WebSocket) => {
        const onSocketError = (error: string) =>
          record('websocket-error', { url: location(socket.url()), error });
        socket.on('socketerror', onSocketError);
        socketCleanups.push(() => socket.off('socketerror', onSocketError));
      };
      page.on('websocket', onWebSocket);

      let probe: JSHandle<BrowserProbe> | undefined;
      try {
        await use({
          record,
          observe: async grid => {
            probe = await grid
              .locator('canvas.grid-canvas')
              .evaluateHandle(canvas => {
                const result: BrowserProbe = {
                  events: [],
                  dropped: 0,
                  stop: () => undefined,
                };
                const recordEvent = (kind: string, details: unknown) => {
                  if (result.events.length < 2000) {
                    result.events.push({
                      time: performance.timeOrigin + performance.now(),
                      kind,
                      details,
                    });
                  } else {
                    result.dropped += 1;
                  }
                };
                const snapshot = () => {
                  const rows = Array.from(
                    canvas.querySelectorAll(
                      'tbody tr [data-grid-row]:first-child'
                    ),
                    cell => Number(cell.getAttribute('data-grid-row'))
                  );
                  return {
                    rows,
                    description: canvas.querySelector(
                      '[data-grid-a11y-snapshot] [role="status"]'
                    )?.textContent,
                  };
                };
                const onWheel = (event: WheelEvent) =>
                  recordEvent('wheel-event', {
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                    deltaMode: event.deltaMode,
                    isTrusted: event.isTrusted,
                    eventTimeStamp: event.timeStamp,
                    snapshot: snapshot(),
                  });
                const wrapper = canvas.closest<HTMLElement>('.grid-wrapper');
                wrapper?.addEventListener('wheel', onWheel, {
                  capture: true,
                  passive: true,
                });
                const observer = new MutationObserver(() => {
                  recordEvent('snapshot-mutation', snapshot());
                });
                observer.observe(canvas, {
                  subtree: true,
                  childList: true,
                  characterData: true,
                  attributes: true,
                  attributeFilter: ['data-grid-row'],
                });

                // This diagnostic-only React lookup avoids changing production code.
                // A DOM mutation or rAF callback is not evidence of a completed draw:
                // Grid also draws synchronously on resize.
                type GridInstance = {
                  canvas: HTMLCanvasElement;
                  registerDrawListener: (
                    listener: (state: GridRenderState) => void
                  ) => () => void;
                };
                type Fiber = {
                  return: Fiber | null;
                  stateNode: Partial<GridInstance> | null;
                };
                const fiberKey = Object.keys(canvas).find(key =>
                  key.startsWith('__reactFiber$')
                );
                let fiber =
                  fiberKey == null
                    ? null
                    : (canvas as unknown as Record<string, Fiber>)[fiberKey];
                let unsubscribe: (() => void) | undefined;
                while (fiber != null) {
                  const instance = fiber.stateNode;
                  if (
                    instance?.canvas === canvas &&
                    typeof instance.registerDrawListener === 'function'
                  ) {
                    // registerDrawListener immediately returns the existing state.
                    // Do not mislabel that callback as a newly completed draw.
                    let subscribing = true;
                    unsubscribe = instance.registerDrawListener(state => {
                      const { metrics } = state;
                      recordEvent(
                        subscribing ? 'current-render-state' : 'completed-draw',
                        {
                          rows: [...metrics.visibleRows],
                          top: metrics.top,
                          bottom: metrics.bottom,
                          scrollY: metrics.scrollY,
                          width: metrics.width,
                          height: metrics.height,
                        }
                      );
                    });
                    subscribing = false;
                    break;
                  }
                  fiber = fiber.return;
                }
                if (unsubscribe == null) {
                  recordEvent('draw-probe-unavailable', {
                    reason: 'React Grid instance was not found',
                  });
                }
                recordEvent('snapshot-at-subscription', snapshot());
                result.stop = () => {
                  unsubscribe?.();
                  observer.disconnect();
                  wrapper?.removeEventListener('wheel', onWheel, true);
                };
                return result;
              });
          },
        });
      } finally {
        let browserEvents: Pick<BrowserProbe, 'events' | 'dropped'> | undefined;
        try {
          browserEvents = await probe?.evaluate(value => {
            value.stop();
            return { events: value.events, dropped: value.dropped };
          });
        } catch (error) {
          // Collection failure must not prevent attaching the Node-side evidence.
          record('collection-error', String(error));
        } finally {
          page.off('console', onConsole);
          page.off('pageerror', onPageError);
          page.off('requestfailed', onRequestFailed);
          page.off('response', onResponse);
          page.off('websocket', onWebSocket);
          socketCleanups.forEach(cleanup => cleanup());
          await probe?.dispose();
        }
        await testInfo.attach('grid-scroll-diagnostics', {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify(
              {
                fingerprint: '6cbc263a47fa',
                classification: 'unresolved',
                project: testInfo.project.name,
                playwright: testInfo.config.version,
                browser: browser.version(),
                node: process.version,
                viewport: page.viewportSize(),
                coreImage: process.env.DHC_IMAGE ?? null,
                retry: testInfo.retry,
                repeatEachIndex: testInfo.repeatEachIndex,
                workerIndex: testInfo.workerIndex,
                status: testInfo.status,
                nodeEvents: events,
                nodeEventsDropped: dropped,
                browserEvents,
              },
              null,
              2
            )
          ),
        });
      }
    },
    { auto: true },
  ],
});
