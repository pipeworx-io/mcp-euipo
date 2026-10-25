interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * EUIPO MCP — EU trademarks, registered Community designs, and the shared
 * reference registers the EUIPO publishes alongside them (euipo.europa.eu).
 *
 * The EU counterpart to our USPTO `trademarks` pack. AI agents call it for EU
 * brand clearance, competitor trademark portfolios, Community design
 * filings, Nice/Locarno classification lookups, and applicant/representative
 * lookups against the European Union Intellectual Property Office (EUIPO).
 *
 * Tools:
 * - euipo_search_trademarks        — search EU trademarks by verbal element / applicant / Nice class.
 * - euipo_trademark                — retrieve a single trademark by application/registration number.
 * - euipo_search_designs           — search registered Community designs.
 * - euipo_search_goods_services    — explore/search the Nice goods-and-services classification (TMClass).
 * - euipo_validate_goods_services  — validate goods-and-services terms against the harmonised database.
 * - euipo_search_product_indications — search the Locarno product-indications classification (DSClass).
 * - euipo_search_persons           — search applicants/representatives tied to EUIPO procedures.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * OAuth2 client_credentials. The user supplies _apiKey = "client_id:client_secret"
 * (register a free app at https://dev.euipo.europa.eu → each app gets a Client ID
 * and Client Secret). Each call exchanges those creds for a short-lived Bearer
 * access token via euipoToken(), then calls the API with Authorization: Bearer.
 * The token is NOT cached across calls (project security policy — no provider-pack
 * caching). There is no platform key for this pack — it is BYO by design (every
 * caller registers their own free EUIPO app), which is also why it logged zero
 * external calls: the pack was built 2026-07-14 (commit f229991a9) and committed
 * DORMANT — never added to the gateway's pack manifest / workspace deps / catalog
 * — so no call could reach it regardless of credentials. Fixed here (fleet #3309).
 *
 * ── Query model ─────────────────────────────────────────────────────────────
 * The EUIPO Trademark Search / Design Search APIs use RSQL filter expressions
 * passed in the `query` parameter, e.g.
 *   verbalElement=="*nike*";niceClasses=in=(9,25);status=in=(REGISTERED)
 * (`;` = AND, `,` = OR, `==` supports `*` wildcards, `=in=(...)` for sets).
 * We build the RSQL string from friendly params and also accept a raw `query`
 * passthrough for power users. The Goods and Services / Product Indications /
 * Persons APIs are plain query-param REST (no RSQL).
 *
 * ── Source verification (fleet #3309, 2026-10-18) ───────────────────────────
 * Every path and the token endpoint below were read out of the EUIPO developer
 * portal's OWN embedded OpenAPI specs (dev.euipo.europa.eu/product/<slug>/api/<slug>
 * — each product page ships its full IBM API Connect spec inline in the page
 * HTML; a plain, unauthenticated fetch of that page is enough, no portal login
 * needed). CONFIRMED against four independent product specs (trademark-search,
 * design-search, goods-and-services, persons, product-indications all agree):
 *   - TOKEN_URL = https://euipo.europa.eu/cas-server-webapp/oidc/accessToken
 *     This is a CORRECTION: the pack's original TOKEN_URL
 *     (auth.euipo.europa.eu/oidc/accessToken) resolves to a dead host — a
 *     laptop curl against it returns a flat HTTP 502 with no body, never a
 *     401/403, so every call this pack ever made (had it been wired in) would
 *     have failed at the token-exchange step before reaching any data route.
 *     The corrected URL returns 401 Unauthorized with a CAS WWW-Authenticate
 *     challenge for bad/placeholder creds — the auth wall is real and reached.
 *   - API_BASE = https://api.euipo.europa.eu (unchanged, confirmed in all 5 specs' `servers`)
 *   - TM paths = /trademark-search/trademarks[/{applicationNumber}] (unchanged, confirmed)
 *   - Design path = /design-search/designs[/{designNumber}] (unchanged, confirmed)
 *   - Goods/Services = /goods-and-services/terms (GET), /goods-and-services/classification-validation (POST)
 *   - Product Indications = /product-indications/terms (GET)
 *   - Persons = /persons/applicants, /persons/representatives (GET)
 * All five require the same OAuth2 client_credentials app; the dev portal lets
 * one app subscribe to multiple API products.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'EUIPO');
}

// ── Endpoints (confirmed against the dev portal's own OpenAPI specs, fleet #3309) ──
const TOKEN_URL = 'https://euipo.europa.eu/cas-server-webapp/oidc/accessToken';
const API_BASE = 'https://api.euipo.europa.eu';
const TM_PATH = '/trademark-search/trademarks';
const DESIGN_PATH = '/design-search/designs';
const GOODS_SERVICES_BASE = '/goods-and-services';
const PRODUCT_INDICATIONS_BASE = '/product-indications';
const PERSONS_BASE = '/persons';

const CREDS_HELP =
  'Pass _apiKey = "client_id:client_secret". Register a free application at https://dev.euipo.europa.eu — each app is assigned a Client ID and Client Secret. Subscribe it to the "Trademark search", "Design Search", "Goods and Services", "Product Indications" and "Persons" API products.';

const tools: McpToolExport['tools'] = [
  {
    name: 'euipo_search_trademarks',
    description:
      'Search EU trademarks (EUTM) at the EUIPO — "find EU trademarks containing NIKE in Nice classes 9 and 25". Use for EU brand clearance and competitor trademark portfolios. Returns matching marks (application number, mark text, status, owner, Nice classes, filing date) plus raw. Example: euipo_search_trademarks({ verbal_element: "nike", nice_classes: [9, 25], status: "REGISTERED", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        verbal_element: {
          type: 'string',
          description:
            'Text/word element of the mark to match (wildcards added automatically), e.g. "nike". Multi-word values are quoted safely.',
        },
        applicant: {
          type: 'string',
          description: 'Applicant / owner name to match, e.g. "Nike Innovate".',
        },
        nice_classes: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Nice classification classes to filter by, e.g. [9, 25].',
        },
        status: {
          type: 'string',
          description:
            'Trademark status filter, e.g. "REGISTERED", "APPLICATION_FILED", "EXPIRED". Comma-separate for multiple.',
        },
        query: {
          type: 'string',
          description:
            'Advanced: raw RSQL filter passed through verbatim (e.g. verbalElement=="*nike*";niceClasses=in=(9,25)). Overrides the friendly params above.',
        },
        size: {
          type: 'integer',
          description: 'Max results per page (default 20, max 100).',
        },
        page: {
          type: 'integer',
          description: 'Zero-based page index for pagination (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'euipo_trademark',
    description:
      'Retrieve a single EU trademark by its application or registration number from the EUIPO — "look up EUTM 018123456". Returns the full record (mark text, status, owner/representative, Nice classes, goods & services, filing/registration/expiry dates) plus raw. Example: euipo_trademark({ number: "018123456", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'string',
          description: 'EUTM application or registration number, e.g. "018123456".',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['number', '_apiKey'],
    },
  },
  {
    name: 'euipo_search_designs',
    description:
      'Search registered Community designs (RCD) at the EUIPO — "find registered EU designs owned by Adidas in Locarno class 02". Use for design-filing landscape and competitor design portfolios. Returns matching designs (design number, indication of product, status, owner, Locarno classes, filing date) plus raw. Example: euipo_search_designs({ owner: "adidas", locarno_classes: ["02"], _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        indication: {
          type: 'string',
          description:
            'Indication of product / design keyword to match (wildcards added automatically), e.g. "footwear".',
        },
        owner: {
          type: 'string',
          description: 'Design owner / applicant name to match, e.g. "adidas".',
        },
        locarno_classes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Locarno classification classes to filter by, e.g. ["02", "09"].',
        },
        status: {
          type: 'string',
          description:
            'Design status filter, e.g. "REGISTERED", "EXPIRED". Comma-separate for multiple.',
        },
        query: {
          type: 'string',
          description:
            'Advanced: raw RSQL filter passed through verbatim (e.g. indicationOfProduct=="*footwear*";locarnoClasses=in=(02)). Overrides the friendly params above.',
        },
        size: {
          type: 'integer',
          description: 'Max results per page (default 20, max 100).',
        },
        page: {
          type: 'integer',
          description: 'Zero-based page index for pagination (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'euipo_search_goods_services',
    description:
      'Explore the EUIPO\'s harmonised Nice goods-and-services classification (TMClass) — "find accepted goods-and-services terms for \'software\' in Nice class 9". Use when preparing a trademark filing or checking whether a term is already a recognised, pre-classified term. Returns matching terms with their Nice class and concept id, plus raw. Example: euipo_search_goods_services({ term: "software", nice_class: 9, language: "en", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        term: {
          type: 'string',
          description: 'Text to search for within goods-and-services terms, e.g. "software".',
        },
        nice_class: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Nice classification class number(s) to restrict the search to, e.g. [9] or [9, 42]. Also accepts a single integer.',
        },
        language: {
          type: 'string',
          description: 'EU official language code for the search and results, e.g. "en", "es", "de", "fr". Required by the upstream API; defaults to "en".',
        },
        parent_concept_id: {
          type: 'string',
          description: 'Restrict to children of this taxonomy concept id (for browsing the classification tree).',
        },
        include_term_variants: {
          type: 'boolean',
          description: 'Include term variants in the results (default false).',
        },
        size: {
          type: 'integer',
          description: 'Max results per page (default 20).',
        },
        page: {
          type: 'integer',
          description: 'Zero-based page index for pagination (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'euipo_validate_goods_services',
    description:
      'Validate a list of goods-and-services terms against the EUIPO\'s harmonised database (TMClass) — checks whether each term is a recognised ("harmonized") term, and flags invalid characters, duplicates, forbidden terms, and length problems. Use before filing to catch terms an examiner would object to. Returns per-term accepted/not-accepted status plus raw. Example: euipo_validate_goods_services({ terms: ["computer software", "C@ts and dog$"], nice_class: 9, language: "en", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Goods-and-services terms to validate, e.g. ["computer software", "downloadable mobile applications"].',
        },
        nice_class: {
          type: 'integer',
          description: 'Nice classification class the terms belong to, e.g. 9. The upstream validates terms per class.',
        },
        language: {
          type: 'string',
          description: 'Language the terms are written in, e.g. "en". Required by the upstream API; defaults to "en".',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['terms', '_apiKey'],
    },
  },
  {
    name: 'euipo_search_product_indications',
    description:
      'Search the EUIPO\'s harmonised Locarno product-indications classification (DSClass) used for registered Community design filings — "find accepted design indications for \'chair\'". Returns matching indications with their Locarno class/subclass and concept id, plus raw. Example: euipo_search_product_indications({ term: "chair", locarno_class: 6, language: "en", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        term: {
          type: 'string',
          description: 'Text to search for within product-indication terms, e.g. "chair".',
        },
        locarno_class: {
          type: 'integer',
          description: 'Locarno classification class number to restrict the search to, e.g. 6.',
        },
        locarno_subclass: {
          type: 'integer',
          description: 'Locarno classification subclass number (requires locarno_class).',
        },
        language: {
          type: 'string',
          description: 'EU official language code for the search and results, e.g. "en". Required by the upstream API; defaults to "en".',
        },
        parent_concept_id: {
          type: 'string',
          description: 'Restrict to children of this taxonomy concept id (for browsing the classification tree).',
        },
        size: {
          type: 'integer',
          description: 'Max results per page (default 20).',
        },
        page: {
          type: 'integer',
          description: 'Zero-based page index for pagination (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'euipo_search_persons',
    description:
      'Search applicants or representatives on record with the EUIPO for trademark/design procedures — "find the EUIPO representative record for a named law firm". Each row carries its role (e.g. APPLICANT_BUSINESS, APPLICANT_INDIVIDUAL, REPRESENTATIVE_EUIPO_PROFESSIONAL) and its source. Privacy: street/city/postal-code address details are withheld for individual persons — only country-level location is kept; business/association entities keep their registered address. Example: euipo_search_persons({ name: "adidas", role: "applicant", country: "DE", _apiKey: "client_id:client_secret" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name to search for, e.g. "adidas" or a representative\'s firm/individual name.',
        },
        role: {
          type: 'string',
          enum: ['applicant', 'representative'],
          description: 'Which EUIPO person register to search: "applicant" (default) or "representative".',
        },
        country: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code to filter by, e.g. "DE", "US".',
        },
        city: {
          type: 'string',
          description: 'City to filter by, e.g. "Alicante". Only meaningful for business/association entities (withheld for individuals in the response).',
        },
        size: {
          type: 'integer',
          description: 'Max results per page (default 20).',
        },
        page: {
          type: 'integer',
          description: 'Zero-based page index for pagination (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'EUIPO OAuth credentials as "client_id:client_secret" from dev.euipo.europa.eu.',
        },
      },
      required: ['_apiKey'],
    },
  },
];

// Split "client_id:client_secret" on the FIRST colon (a secret may contain ':').
function splitCreds(apiKey: unknown, tool: string): { id: string; secret: string } {
  if (typeof apiKey !== 'string' || !apiKey.includes(':')) {
    throw new Error(
      `${tool} requires an EUIPO _apiKey in the form "client_id:client_secret". ${CREDS_HELP}`,
    );
  }
  const i = apiKey.indexOf(':');
  const id = apiKey.slice(0, i).trim();
  const secret = apiKey.slice(i + 1).trim();
  if (!id || !secret) {
    throw new Error(
      `${tool}: malformed EUIPO _apiKey. Expected "client_id:client_secret". ${CREDS_HELP}`,
    );
  }
  return { id, secret };
}

// OAuth2 client_credentials exchange → { access_token, token_type: "Bearer", expires_in }.
// NOT cached across calls (project security policy: no provider-pack caching).
async function euipoToken(id: string, secret: string, tool: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: id,
    client_secret: secret,
  });
  // HTTP Basic is also accepted by the CAS token endpoint; we send both the
  // Basic header and the form fields for robustness.
  const basic = btoa(`${id}:${secret}`);
  let res: Response;
  try {
    res = await pwFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body,
    });
  } catch {
    throw new Error(
      `${tool}: EUIPO auth request failed (network). Retry, or check your EUIPO client_id:client_secret.`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${tool}: EUIPO auth rejected (HTTP ${res.status}) — check your EUIPO client_id:client_secret. ${CREDS_HELP}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `${tool}: EUIPO auth failed (HTTP ${res.status}) — check your EUIPO client_id:client_secret. ${CREDS_HELP}`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!data.access_token) {
    throw new Error(
      `${tool}: EUIPO auth returned no access_token — check your EUIPO client_id:client_secret. ${CREDS_HELP}`,
    );
  }
  return data.access_token;
}

// GET a data endpoint with the Bearer token. No caching.
async function euipoGet(
  path: string,
  params: Record<string, string>,
  token: string,
  tool: string,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  let res: Response;
  try {
    res = await pwFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch {
    throw new Error(`${tool}: EUIPO request failed (network). Retry in a moment.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${tool}: EUIPO rejected the request (HTTP ${res.status}) — check your EUIPO client_id:client_secret and that your app is subscribed to the API product. ${CREDS_HELP}`,
    );
  }
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    throw new Error(
      `${tool}: EUIPO rate-limited (HTTP 429)${retry ? ` — retry after ${retry}s` : ''}. Slow down and retry.`,
    );
  }
  if (!res.ok) {
    throw new Error(`EUIPO ${tool} error: HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') {
    throw new Error(`EUIPO ${tool} error: unexpected (non-JSON) response body`);
  }
  return data;
}

// POST a data endpoint (JSON body) with the Bearer token. No caching.
async function euipoPost(
  path: string,
  body: Record<string, unknown>,
  token: string,
  tool: string,
): Promise<Record<string, unknown>> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await pwFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`${tool}: EUIPO request failed (network). Retry in a moment.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${tool}: EUIPO rejected the request (HTTP ${res.status}) — check your EUIPO client_id:client_secret and that your app is subscribed to the API product. ${CREDS_HELP}`,
    );
  }
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    throw new Error(
      `${tool}: EUIPO rate-limited (HTTP 429)${retry ? ` — retry after ${retry}s` : ''}. Slow down and retry.`,
    );
  }
  if (!res.ok && res.status !== 400) {
    throw new Error(`EUIPO ${tool} error: HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') {
    throw new Error(`EUIPO ${tool} error: unexpected (non-JSON) response body`);
  }
  if (!res.ok) {
    // 400 on this endpoint carries a structured validation problem body that
    // is useful to the caller as-is (invalid-character / syntax problems) —
    // surface it as data rather than throwing.
    return data;
  }
  return data;
}

// ── RSQL helpers (trademark / design search only) ───────────────────────────

// Quote an RSQL value; wrap in double quotes if it contains spaces/specials.
function rsqlValue(v: string): string {
  const t = v.trim();
  return /[\s"';(),=]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

// A wildcard-contains term: field=="*value*".
function rsqlContains(field: string, value: string): string {
  const inner = `*${value.trim()}*`;
  return `${field}==${rsqlValue(inner)}`;
}

// field=in=(a,b,c)
function rsqlIn(field: string, values: (string | number)[]): string {
  return `${field}=in=(${values.map((x) => String(x).trim()).filter(Boolean).join(',')})`;
}

// Join AND terms with ';'.
function rsqlAnd(terms: string[]): string {
  return terms.filter(Boolean).join(';');
}

function clampSize(v: unknown): string {
  return String(Math.min(Math.max(Number(v ?? 20) || 20, 1), 100));
}

function clampPage(v: unknown): string {
  return String(Math.max(Number(v ?? 0) || 0, 0));
}

// Pull an array of records out of a variety of possible container shapes.
function extractList(data: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    data.trademarks,
    data.designs,
    data.terms,
    data.applicants,
    data.representatives,
    data.results,
    data.content,
    data.items,
    data.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Record<string, unknown>[];
  }
  return [];
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

// Join a friendly "one value or array" arg into the comma-separated query-param
// shape the Goods and Services / Product Indications APIs expect.
function toCsv(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(',');
  const s = String(v).trim();
  return s || undefined;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function searchTrademarks(args: Record<string, unknown>, token: string) {
  let query = (args.query as string | undefined)?.trim();
  if (!query) {
    const terms: string[] = [];
    const verbal = (args.verbal_element as string | undefined)?.trim();
    if (verbal) terms.push(rsqlContains('verbalElement', verbal));
    const applicant = (args.applicant as string | undefined)?.trim();
    if (applicant) terms.push(rsqlContains('applicantName', applicant));
    if (Array.isArray(args.nice_classes) && args.nice_classes.length) {
      terms.push(rsqlIn('niceClasses', args.nice_classes as (string | number)[]));
    }
    const status = (args.status as string | undefined)?.trim();
    if (status) terms.push(rsqlIn('status', status.split(',').map((s) => s.trim()).filter(Boolean)));
    query = rsqlAnd(terms);
  }
  if (!query) {
    throw new Error(
      'euipo_search_trademarks needs at least one filter — pass verbal_element, applicant, nice_classes, status, or a raw RSQL `query`.',
    );
  }

  const params: Record<string, string> = {
    query,
    size: clampSize(args.size),
    page: clampPage(args.page),
    sort: 'applicationDate:desc',
  };
  const data = await euipoGet(TM_PATH, params, token, 'euipo_search_trademarks');
  const list = extractList(data);
  const marks = list.map((row) => ({
    application_number: firstString(row, ['applicationNumber', 'ST13ApplicationNumber', 'id']),
    registration_number: firstString(row, ['registrationNumber']),
    mark_text: firstString(row, ['verbalElement', 'markVerbalElementText', 'wordMarkSpecification']),
    status: firstString(row, ['status', 'markCurrentStatusCode']),
    owner: firstString(row, ['applicantName', 'ownerName', 'holderName']),
    nice_classes: Array.isArray(row.niceClasses) ? row.niceClasses : (row.niceClasses ?? null),
    filing_date: firstString(row, ['applicationDate', 'filingDate']),
  }));

  return {
    query,
    count: marks.length,
    total: (data.totalElements as number) ?? (data.total as number) ?? null,
    trademarks: marks,
    raw: data,
  };
}

async function getTrademark(args: Record<string, unknown>, token: string) {
  const number = (args.number as string | undefined)?.trim();
  if (!number) {
    throw new Error('euipo_trademark requires a `number` (EUTM application or registration number, e.g. "018123456").');
  }
  const data = await euipoGet(`${TM_PATH}/${encodeURIComponent(number)}`, {}, token, 'euipo_trademark');
  return {
    application_number: firstString(data, ['applicationNumber', 'ST13ApplicationNumber', 'id']) ?? number,
    registration_number: firstString(data, ['registrationNumber']),
    mark_text: firstString(data, ['verbalElement', 'markVerbalElementText', 'wordMarkSpecification']),
    status: firstString(data, ['status', 'markCurrentStatusCode']),
    owner: firstString(data, ['applicantName', 'ownerName', 'holderName']),
    representative: firstString(data, ['representativeName']),
    nice_classes: Array.isArray(data.niceClasses) ? data.niceClasses : (data.niceClasses ?? null),
    filing_date: firstString(data, ['applicationDate', 'filingDate']),
    registration_date: firstString(data, ['registrationDate']),
    expiry_date: firstString(data, ['expiryDate', 'expirationDate']),
    goods_and_services: data.goodsAndServices ?? data.goodsServices ?? null,
    raw: data,
  };
}

async function searchDesigns(args: Record<string, unknown>, token: string) {
  let query = (args.query as string | undefined)?.trim();
  if (!query) {
    const terms: string[] = [];
    const indication = (args.indication as string | undefined)?.trim();
    if (indication) terms.push(rsqlContains('indicationOfProduct', indication));
    const owner = (args.owner as string | undefined)?.trim();
    if (owner) terms.push(rsqlContains('ownerName', owner));
    if (Array.isArray(args.locarno_classes) && args.locarno_classes.length) {
      terms.push(rsqlIn('locarnoClasses', args.locarno_classes as (string | number)[]));
    }
    const status = (args.status as string | undefined)?.trim();
    if (status) terms.push(rsqlIn('status', status.split(',').map((s) => s.trim()).filter(Boolean)));
    query = rsqlAnd(terms);
  }
  if (!query) {
    throw new Error(
      'euipo_search_designs needs at least one filter — pass indication, owner, locarno_classes, status, or a raw RSQL `query`.',
    );
  }

  const params: Record<string, string> = {
    query,
    size: clampSize(args.size),
    page: clampPage(args.page),
    sort: 'applicationDate:desc',
  };
  const data = await euipoGet(DESIGN_PATH, params, token, 'euipo_search_designs');
  const list = extractList(data);
  const designs = list.map((row) => ({
    design_number: firstString(row, ['designNumber', 'applicationNumber', 'ST13ApplicationNumber', 'id']),
    indication_of_product: firstString(row, ['indicationOfProduct', 'productIndication']),
    status: firstString(row, ['status', 'currentStatusCode']),
    owner: firstString(row, ['ownerName', 'applicantName', 'holderName']),
    locarno_classes: Array.isArray(row.locarnoClasses) ? row.locarnoClasses : (row.locarnoClasses ?? null),
    filing_date: firstString(row, ['applicationDate', 'filingDate']),
  }));

  return {
    query,
    count: designs.length,
    total: (data.totalElements as number) ?? (data.total as number) ?? null,
    designs,
    raw: data,
  };
}

async function searchGoodsServices(args: Record<string, unknown>, token: string) {
  const term = (args.term as string | undefined)?.trim();
  const classCsv = toCsv(args.nice_class);
  const parentConceptId = (args.parent_concept_id as string | undefined)?.trim();
  if (!term && !classCsv && !parentConceptId) {
    throw new Error(
      'euipo_search_goods_services needs at least one filter — pass term, nice_class, or parent_concept_id.',
    );
  }
  const params: Record<string, string> = {
    language: (args.language as string | undefined)?.trim() || 'en',
    size: clampSize(args.size),
    page: clampPage(args.page),
  };
  if (term) params.termText = term;
  if (classCsv) params.classNumber = classCsv;
  if (parentConceptId) params.parentConceptId = parentConceptId;
  if (args.include_term_variants !== undefined) {
    params.includeTermVariants = String(Boolean(args.include_term_variants));
  }
  const data = await euipoGet(`${GOODS_SERVICES_BASE}/terms`, params, token, 'euipo_search_goods_services');
  const list = extractList(data);
  if (list.length === 0) {
    // A real zero-match search (upstream genuinely has nothing for these
    // filters) is a valid, if uncommon, outcome for a narrow query — but it
    // must be visibly LOUD, not a silent empty success, so a caller/CI gate
    // can tell "no matches" apart from "the parse found nothing it recognised".
    return {
      language: params.language,
      term: term ?? null,
      nice_class: classCsv ?? null,
      count: 0,
      total: (data.totalElements as number) ?? 0,
      terms: [],
      upstream_parse: 'euipo_search_goods_services: EUIPO returned a 200 with no `terms` array recognised in the body (or zero matches) — body keys were: ' + Object.keys(data).join(', '),
      raw: data,
    };
  }
  const terms = list.map((row) => ({
    text: firstString(row, ['text']),
    nice_class: (row.classNumber as number) ?? null,
    concept_id: firstString(row, ['conceptId']),
    taxonomy_parent_id: firstString(row, ['taxonomyParentId']),
  }));
  return {
    language: params.language,
    term: term ?? null,
    nice_class: classCsv ?? null,
    count: terms.length,
    total: (data.totalElements as number) ?? terms.length,
    terms,
    raw: data,
  };
}

async function validateGoodsServices(args: Record<string, unknown>, token: string) {
  const terms = Array.isArray(args.terms) ? (args.terms as unknown[]).map((t) => String(t)).filter(Boolean) : [];
  if (terms.length === 0) {
    throw new Error('euipo_validate_goods_services requires a non-empty `terms` array.');
  }
  const niceClass = Number(args.nice_class ?? 1) || 1;
  const language = (args.language as string | undefined)?.trim() || 'en';
  const body = {
    sourceLanguage: language,
    goodsAndServices: [{ classNumber: niceClass, terms }],
  };
  const data = await euipoPost(`${GOODS_SERVICES_BASE}/classification-validation`, body, token, 'euipo_validate_goods_services');
  const groups = Array.isArray(data.goodsAndServices) ? (data.goodsAndServices as Record<string, unknown>[]) : [];
  const results = groups.flatMap((g) => {
    const gTerms = Array.isArray(g.terms) ? (g.terms as Record<string, unknown>[]) : [];
    return gTerms.map((t) => ({
      text: firstString(t, ['text']),
      nice_class: (g.classNumber as number) ?? niceClass,
      harmonized: Boolean(t.harmonized),
      concept_id: t.conceptId ?? null,
      errors: Array.isArray(t.errors) ? t.errors : null,
    }));
  });
  if (results.length === 0) {
    return {
      language,
      nice_class: niceClass,
      submitted: terms.length,
      upstream_parse: `euipo_validate_goods_services: EUIPO response had no \`goodsAndServices[].terms\` recognised — body keys were: ${Object.keys(data).join(', ')}`,
      raw: data,
    };
  }
  return {
    language,
    nice_class: niceClass,
    submitted: terms.length,
    accepted: results.filter((r) => r.harmonized).length,
    not_accepted: results.filter((r) => !r.harmonized).length,
    results,
    raw: data,
  };
}

async function searchProductIndications(args: Record<string, unknown>, token: string) {
  const term = (args.term as string | undefined)?.trim();
  const locarnoClass = args.locarno_class !== undefined ? Number(args.locarno_class) : undefined;
  const locarnoSubclass = args.locarno_subclass !== undefined ? Number(args.locarno_subclass) : undefined;
  const parentConceptId = (args.parent_concept_id as string | undefined)?.trim();
  if (!term && locarnoClass === undefined && !parentConceptId) {
    throw new Error(
      'euipo_search_product_indications needs at least one filter — pass term, locarno_class, or parent_concept_id.',
    );
  }
  const params: Record<string, string> = {
    language: (args.language as string | undefined)?.trim() || 'en',
    size: clampSize(args.size),
    page: clampPage(args.page),
  };
  if (term) params.termText = term;
  if (locarnoClass !== undefined && !Number.isNaN(locarnoClass)) params.classNumber = String(locarnoClass);
  if (locarnoSubclass !== undefined && !Number.isNaN(locarnoSubclass)) params.subClassNumber = String(locarnoSubclass);
  if (parentConceptId) params.parentConceptId = parentConceptId;
  const data = await euipoGet(`${PRODUCT_INDICATIONS_BASE}/terms`, params, token, 'euipo_search_product_indications');
  const list = extractList(data);
  if (list.length === 0) {
    return {
      language: params.language,
      term: term ?? null,
      locarno_class: locarnoClass ?? null,
      count: 0,
      total: (data.totalElements as number) ?? 0,
      indications: [],
      upstream_parse: 'euipo_search_product_indications: EUIPO returned a 200 with no `terms` array recognised in the body (or zero matches) — body keys were: ' + Object.keys(data).join(', '),
      raw: data,
    };
  }
  const indications = list.map((row) => ({
    text: firstString(row, ['text']),
    locarno_class: (row.classNumber as number) ?? null,
    locarno_subclass: (row.subClassNumber as number) ?? null,
    concept_id: firstString(row, ['conceptId']),
  }));
  return {
    language: params.language,
    term: term ?? null,
    locarno_class: locarnoClass ?? null,
    count: indications.length,
    total: (data.totalElements as number) ?? indications.length,
    indications,
    raw: data,
  };
}

// Individual-person record types whose street/city/postal address is withheld.
// REPRESENTATIVE_LEGAL_ASSOCIATION is an organisation (its address is kept);
// every other representative/applicant type here is a natural person.
const INDIVIDUAL_TYPES = new Set([
  'APPLICANT_INDIVIDUAL',
  'REPRESENTATIVE_EMPLOYEE',
  'REPRESENTATIVE_LEGAL_PROFESSIONAL',
  'REPRESENTATIVE_EUIPO_PROFESSIONAL',
]);

function countryOf(addr: unknown): string | null {
  if (addr && typeof addr === 'object') {
    const c = (addr as Record<string, unknown>).country;
    if (typeof c === 'string') return c;
  }
  return null;
}

async function searchPersons(args: Record<string, unknown>, token: string) {
  const role = (args.role as string | undefined)?.trim().toLowerCase() === 'representative' ? 'representative' : 'applicant';
  const name = (args.name as string | undefined)?.trim();
  const country = (args.country as string | undefined)?.trim();
  const city = (args.city as string | undefined)?.trim();
  const params: Record<string, string> = {
    size: clampSize(args.size),
    page: clampPage(args.page),
  };
  if (name) params.name = name;
  if (country) params.country = country;
  if (city) params.city = city;

  const path = role === 'representative' ? `${PERSONS_BASE}/representatives` : `${PERSONS_BASE}/applicants`;
  const data = await euipoGet(path, params, token, 'euipo_search_persons');
  const list = extractList(data);
  const rows = list.map((row) => {
    const type = firstString(row, ['type']) ?? 'UNKNOWN';
    const isIndividual = INDIVIDUAL_TYPES.has(type);
    return {
      identifier: firstString(row, ['identifier']),
      role: type,
      name: firstString(row, ['name']),
      // Privacy: street/city/postal-code is withheld for natural persons —
      // only the jurisdiction (country) is kept. Organisations (businesses,
      // legal associations) keep their registered address.
      country: isIndividual ? countryOf(row.address) : null,
      address: isIndividual ? null : (row.address ?? null),
      source: 'EUIPO, Persons register (applicants and representatives of record)',
    };
  });
  if (rows.length === 0) {
    return {
      role,
      name: name ?? null,
      country: country ?? null,
      count: 0,
      total: (data.totalElements as number) ?? 0,
      persons: [],
      upstream_parse: `euipo_search_persons: EUIPO returned a 200 with no \`${role === 'representative' ? 'representatives' : 'applicants'}\` array recognised in the body (or zero matches) — body keys were: ${Object.keys(data).join(', ')}`,
      raw: data,
    };
  }
  return {
    role,
    name: name ?? null,
    country: country ?? null,
    count: rows.length,
    total: (data.totalElements as number) ?? rows.length,
    persons: rows,
    raw: data,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = args._apiKey;
  delete args._apiKey;

  const { id, secret } = splitCreds(apiKey, name);
  const token = await euipoToken(id, secret, name);

  switch (name) {
    case 'euipo_search_trademarks':
      return searchTrademarks(args, token);
    case 'euipo_trademark':
      return getTrademark(args, token);
    case 'euipo_search_designs':
      return searchDesigns(args, token);
    case 'euipo_search_goods_services':
      return searchGoodsServices(args, token);
    case 'euipo_validate_goods_services':
      return validateGoodsServices(args, token);
    case 'euipo_search_product_indications':
      return searchProductIndications(args, token);
    case 'euipo_search_persons':
      return searchPersons(args, token);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
