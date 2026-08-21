// school-booking/run.js
//
// The run engine: Apply, the per-student loop, the circuit breaker, and the
// cancel. A pure module over an **injected caller** — the page publishes it as
// `window.schoolBookingRun` and hands it a function that does the `fetch`.
//
// staff-site#73, seam decided on #78. Design:
// `docs/superpowers/specs/2026-08-19-school-group-booking-design.md`
// §10 (D1, the browser drives the run), §11 (D7 the breaker, D8 retries),
// §12 (D10 the record, D12 the cancel interlock).
//
// ---------------------------------------------------------------------------
// Why the caller is injected
// ---------------------------------------------------------------------------
// There is no DOM test infrastructure in this repo and none is being added, so
// anything written inside the Alpine component has no automated cover at all.
// Everything in this file runs when things are **already going wrong** — a
// throttle, a run of failures, a page reload mid-run — which is precisely the
// code nobody exercises by hand before shipping. With the caller injected it is
// all reachable from vitest with no network.
//
// ---------------------------------------------------------------------------
// D1 — one Worker call per student, and the browser paces them
// ---------------------------------------------------------------------------
// A four-minute one-shot response is not a shape the web is good at, and its
// failure mode — **writes landed, log lost** — is the unrecoverable one here,
// because a contact can never be deleted. Per-student calls make every
// completed student durable on the client the instant it lands: `onRow` fires
// after each one, and the page writes it to `localStorage` from there (D10).
//
// ---------------------------------------------------------------------------
// A 429 is not about the student it landed on
// ---------------------------------------------------------------------------
// The Clubworx allowance is **gym-wide** — one account key, shared with the
// roster Worker and n8n. Backing off one row while the rest continue just
// spends the next window failing, which is what #51 measured: 49 successes,
// then 41 consecutive 429s. So a throttle pauses the **whole run**, and it is
// detected on the `reason` field rather than the status: once the call has
// written something the Worker answers 200 and carries `reason: "throttled"`,
// because the body is then the only record of what was written.

import { cancellable, isFailure, studentRecord } from './outcome.js?v=2';

/** #51 measured ~18 s of throttling. Two attempts, then the page is told. */
export const RETRY_BACKOFF_MS = 20_000;
export const MAX_ATTEMPTS = 2;

/** D7. One row failing is data; three in a row is a systemic condition. */
export const FAILURE_LIMIT = 3;

export const THROTTLE_MESSAGE =
  'Clubworx is busy — this can be caused by another system, not this page. Try again shortly.';

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One call, with D8's retry policy and nothing else.
 *
 * **Never a 400.** All three known 400s are permanent for that attempt, and the
 * fourth kind is unknown by definition — retrying an unrecognised refusal is
 * how a run spends its allowance learning nothing. A 200 is never retried
 * either, even when it reports the student was abandoned: that answer is final
 * and the row is the record of it.
 *
 * @returns {Promise<{status: number|null, body: object|null, error: string|null}>}
 */
async function attempt(call, payload, sleep) {
  let last = { status: null, body: null, error: 'the request was never made' };

  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    try {
      const answer = await call(payload);
      last = { status: answer?.status ?? null, body: answer?.body ?? null, error: null };
    } catch (error) {
      last = { status: null, body: null, error: String(error?.message || error) };
    }

    const retryable = last.error !== null || last.status === 429 || (last.status ?? 0) >= 500;
    if (!retryable) return last;
    if (n < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
  }

  return last;
}

/** Whether this answer means the gym-wide allowance is spent. */
const throttled = (answer) => answer.status === 429 || answer.body?.reason === 'throttled';

/**
 * Apply — the whole run.
 *
 * Stops for exactly three reasons, and says which: a throttle, three
 * consecutive failures, or the page asking it to. In all three the completed
 * rows are left intact and handed back, because the halt is a pause in a run
 * whose earlier students are already permanent.
 *
 * @param {object} opts
 * @param {Array<{payload: object}>} opts.students what `runList` built, in table order
 * @param {(payload: object) => Promise<{status: number, body: object}>} opts.call injected
 * @param {(record: object, records: object[]) => void} [opts.onRow] fired per student — D10
 * @param {() => boolean} [opts.stopped] asked between students
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{state: 'complete'|'halted', reason: string|null, message: string,
 *   records: object[], remaining: number}>}
 */
export async function runStudents({
  students = [],
  call,
  onRow = () => {},
  stopped = () => false,
  sleep = defaultSleep,
} = {}) {
  const records = [];
  let consecutive = 0;

  const halt = (reason, message, index) => ({
    state: 'halted',
    reason,
    message,
    records,
    remaining: students.length - index,
  });

  for (let i = 0; i < students.length; i += 1) {
    if (stopped()) return halt('stopped', 'The run was stopped. Everything above is done.', i);

    const answer = await attempt(call, students[i].payload, sleep);
    const record = studentRecord({
      student: students[i],
      status: answer.status,
      body: answer.body,
      error: answer.error,
    });

    records.push(record);
    // Before any halt decision. A record that exists only when the run finished
    // tidily is a record missing in exactly the case it was built for.
    onRow(record, records);

    if (throttled(answer)) return halt('throttled', THROTTLE_MESSAGE, i + 1);

    consecutive = isFailure(record) ? consecutive + 1 : 0;
    if (consecutive >= FAILURE_LIMIT) {
      return halt(
        'consecutive-failures',
        `${FAILURE_LIMIT} students in a row did not finish, so the run stopped rather than `
          + 'spending the gym’s Clubworx allowance repeating the same failure. '
          + 'Everything above is done and is not affected.',
        i + 1,
      );
    }
  }

  return { state: 'complete', reason: null, message: '', records, remaining: 0 };
}

/**
 * The rows to send to `POST /unbook` for one student.
 *
 * The whole array `POST /student` handed back, less anything a previous cancel
 * already removed — **not** pre-filtered down to `booked`. The Worker's
 * `cancelRunBookings` owns the interlock and takes each row's own
 * `contact_key`, so handing it the rows as they came keeps one authority for
 * the rule rather than two that can drift.
 *
 * Dropping ids a previous pass already cancelled is a different thing: those
 * bookings are gone, and re-sending them turns a clean partial cancel into a
 * screenful of new failures.
 */
function cancelRows(record) {
  const gone = new Set((record?.cancel?.cancelledIds ?? []).map(String));
  return (record?.bookings ?? []).filter((b) => !gone.has(String(b?.booking_id ?? '')));
}

/**
 * "Cancel bookings from this run" — D12.
 *
 * One student per call, the same shape Apply uses and for the same reason: a
 * whole-run cancel is up to 150 DELETEs plus a verifying re-read per student,
 * which is minutes in a single invocation and the failure mode D1 rejected.
 *
 * A student with nothing this run booked is **never sent**. The Worker refuses
 * those rows too, and that is not a reason for the page to offer them: an
 * `already booked` row means Clubworx refused our duplicate, so the booking
 * predates this run and may be one a real member made themselves.
 *
 * @param {object} opts
 * @param {object[]} opts.records the run's records, mutated only by replacement
 * @param {(payload: object) => Promise<{status: number, body: object}>} opts.call injected
 * @param {(record: object, records: object[]) => void} [opts.onRow]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export async function cancelStudents({
  records = [],
  call,
  onRow = () => {},
  stopped = () => false,
  sleep = defaultSleep,
} = {}) {
  const out = [...records];

  for (let i = 0; i < out.length; i += 1) {
    const record = out[i];
    if (cancellable(record).length === 0) continue;
    if (stopped()) {
      return { state: 'halted', reason: 'stopped', message: 'The cancel was stopped.', records: out };
    }

    const answer = await attempt(
      call,
      { contact_key: record.contactKey ?? null, bookings: cancelRows(record) },
      sleep,
    );

    out[i] = {
      ...record,
      cancel: answer.error !== null
        ? {
          ok: false,
          outcome: 'failed',
          reason: 'network',
          message: `The cancel did not reach Clubworx: ${answer.error}. The bookings are probably `
            + 'still there — check this student in Clubworx.',
          cancelled: 0,
          cancelledIds: [],
          failed: [],
          stillBooked: [],
          verified: false,
        }
        : (answer.body ?? { ok: false, outcome: 'failed', reason: 'empty-reply', cancelled: 0, cancelledIds: [] }),
    };
    onRow(out[i], out);

    if (throttled(answer)) {
      return { state: 'halted', reason: 'throttled', message: THROTTLE_MESSAGE, records: out };
    }
  }

  return { state: 'complete', reason: null, message: '', records: out };
}

/**
 * The browser-only record — D10.
 *
 * Wrapped over an injected storage rather than reaching for `localStorage`, so
 * the failure paths are testable: a private window has no storage at all, and a
 * full one throws on write. **Neither may take the run down.** Losing the copy
 * is bad; losing the run because the copy failed is worse, and the records are
 * still in memory and on screen either way.
 */
export function runStore(storage, key) {
  return {
    save(value) {
      try {
        storage?.setItem(key, JSON.stringify(value));
      } catch {
        /* see above */
      }
    },
    load() {
      try {
        const raw = storage?.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        /* see above */
      }
    },
  };
}

/**
 * Turn the preview into the exact list of calls Apply will make.
 *
 * Pure, and separate from the loop, so what gets sent to a route that writes
 * permanent records is readable in one place and testable without a run.
 *
 * Two things are refused rather than defaulted, because both would write:
 * a preview with no resolved plan (there is no pass to grant), and a missing
 * school marker (the marker is the only provenance this system will ever have,
 * §4 — a contact created without one cannot be found again).
 *
 * @param {object} opts
 * @param {object} opts.preview `buildPreview`'s result
 * @param {object[]} opts.rows step 3's rows, which carry the **write form** of the name
 * @param {string} opts.email the school marker
 */
export function runList({ preview, rows, email } = {}) {
  const plan = preview?.plan ?? null;
  if (!plan?.membership_plan_id || !email) return [];

  const source = new Map((rows ?? []).map((r) => [r.key, r]));
  const events = (preview?.sessions ?? []).map((e) => ({
    event_id: e.event_id,
    // The write chain reads the lead time off `starts_at`; the events route
    // calls the same field `event_start_at`. Renamed once, here.
    starts_at: e.event_start_at ?? e.starts_at ?? null,
    spaces_available: e.spaces_available ?? null,
  }));

  return (preview?.rows ?? [])
    .filter((row) => !row.needsHuman)
    .map((row) => {
      const from = source.get(row.key) ?? {};
      return {
        key: row.key,
        name: row.name,
        dob: row.dob,
        sessions: row.sessions ?? events.length,
        contactKey: row.contactKey ?? null,
        payload: {
          student: {
            // Write form — accents and case as the school typed them. The
            // compare form is for matching and never for writing.
            first_name: from.firstName ?? '',
            last_name: from.lastName ?? '',
            dob: from.dob ?? row.dob ?? '',
            email,
          },
          contact_key: row.contactKey ?? null,
          membership_plan_id: plan.membership_plan_id,
          membership_duration: plan.membership_duration ?? '',
          events,
        },
      };
    });
}
