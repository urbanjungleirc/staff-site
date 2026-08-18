#!/usr/bin/env node
/**
 * staff-site#49 — plus-addressed duplicate emails on noreply@.
 *
 *   node probes/run-49.mjs --dry-run   # the plan and every request, zero network
 *   node probes/run-49.mjs             # read-only: search, then the isolation reads
 *   node probes/run-49.mjs --write     # creates up to 3 PERMANENT contacts
 *   node probes/run-49.mjs --dev-vars=<path>
 *
 * ⚠️ `--write` is the only mode that creates anything, and what it creates
 * cannot be undone. Clubworx has no sandbox and **cannot delete a contact
 * through the API** (ACCESS.md section 4), so every contact this probe writes is
 * permanent and removable only by hand in the Clubworx UI. The run ends by
 * printing exactly what must be deleted.
 *
 * Four questions, all from staff-site#46's map. The school-marking scheme rests
 * on every one of them, and all four were *inferred from reads* until now:
 *
 *   1. Does POST accept a plus-addressed `noreply+tag@`, or is the `+` rejected?
 *   2. Can many contacts share one email — the sibling case — or is it unique?
 *   3. Does `email=noreply%2B` partial-match, and does a full tag *isolate* one
 *      school from another?
 *   4. Does the same hold on /members and /non_attending_contacts, which the
 *      dedup pass also searches?
 *
 * Nothing here records a row of production data. The searches partial-match a
 * 60,000-person database, so responses are reduced by `summariseContacts` and
 * candidate rows filtered by `pickProbeRows` before anything is printed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGetter } from './lib/http.mjs';
import { createPoster } from './lib/write.mjs';
import { loadAccountKey } from './lib/key.mjs';
import { PROBE_CONTACTS, planContacts, pickProbeRows, plusTag } from './lib/identity.mjs';
import {
  summariseContacts,
  describeIsolation,
  classifyWrite,
  schemeCollapses,
} from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WRITE = args.includes('--write');
const DEV_VARS =
  args.find(a => a.startsWith('--dev-vars='))?.split('=').slice(1).join('=') ||
  path.join(HERE, '..', '.dev.vars');

/** The endpoints #46's dedup pass searches. Question 4 asks about all three. */
const CONTACT_TYPES = ['prospects', 'members', 'non_attending_contacts'];

/** The two plus-tags in play, derived rather than restated. */
const TAG_EMAILS = [...new Set(PROBE_CONTACTS.map(c => c.email))];

/** The bare prefix, for the partial-match question. URLSearchParams sends it as `noreply%2B`. */
const PARTIAL_EMAIL = 'noreply+';

/**
 * 75 requests/minute, one in flight — the ceiling measured in #51. The allowance
 * is shared across the whole gym key, so a probe that ignores it throttles HVT
 * and the front desk too.
 */
const GAP_MS = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);
const rule = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/** A contact_key out of a create response, wherever this API chose to put it. */
const keyOf = body =>
  body?.contact_key ?? body?.prospect?.contact_key ?? (Array.isArray(body) ? body[0]?.contact_key : null) ?? null;

/**
 * Find probe contacts an earlier run already created.
 *
 * ACCESS.md: *"Search first ... the identity is only a blast-radius control if
 * there is exactly one of it."* Everything this returns has been through
 * `pickProbeRows`, so a stranger who happens to match the email is counted and
 * then dropped rather than mistaken for the probe's own record.
 */
async function searchExisting(get) {
  rule('0. Search first — has an earlier run already created these?');

  const found = [];
  let strangers = 0;

  for (const type of CONTACT_TYPES) {
    for (const email of TAG_EMAILS) {
      const res = await get(type, { email });
      const rows = pickProbeRows(res.body);
      // Scored against the rows just recognised, not an empty list — otherwise
      // the probe's own contacts are reported as strangers on every re-run.
      const summary = summariseContacts(
        res.body,
        rows.map(r => r.contact_key),
      );
      found.push(...rows);
      strangers += summary.strangers;

      line(
        `${type} email=+${plusTag(email)}`,
        `HTTP ${res.status} · ${summary.count} returned · ${rows.length} are ours`,
      );
      await sleep(GAP_MS);
    }
  }

  // Deduplicate: the same contact can answer on more than one search.
  const byKey = new Map(found.map(row => [row.contact_key, row]));
  if (strangers) line('rows returned that are not ours', `${strangers} (counted, not recorded)`);

  return [...byKey.values()];
}

/**
 * Create what is missing. Every success here is permanent.
 *
 * Called on a read-only run too, where the poster is inert and reports what it
 * *would* send. That is deliberate: the same guard and the same payload run in
 * both modes, so a dry pass exercises the real path rather than a description
 * of it.
 */
async function createContacts(post, toCreate, { live }) {
  rule(live ? `1–2. Creating ${toCreate.length} contact(s) — PERMANENT` : '1–2. Would create');

  const results = [];
  for (const contact of toCreate) {
    const res = await post('prospects', contact);
    const contact_key = keyOf(res.body);
    const classification = classifyWrite(res);

    results.push({
      label: contact.label,
      why: contact.why,
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      status: res.status,
      contact_key,
      refused: res.refused ?? null,
      error: res.error ?? null,
      bodyText: res.bodyText ?? null,
      // What the server stored, when it echoes the record back. Question 1 asks
      // whether Clubworx normalises the `+` away, and this is the direct
      // evidence for it rather than an inference from a later search.
      emailEcho: res.body?.email ?? null,
      dryRun: res.dryRun ?? false,
      ...classification,
    });

    line(
      `${contact.label} ${contact.last_name} <+${plusTag(contact.email)}>`,
      res.refused
        ? `REFUSED locally: ${res.refused}`
        : res.dryRun
          ? `would POST ${JSON.stringify(res.wouldSend)}`
          : `HTTP ${res.status ?? 'n/a'} ${classification.outcome}` +
            (contact_key ? ` · contact_key ${contact_key}` : '') +
            (res.error ? ` · ${res.error}` : '') +
            (res.bodyText ? ` · ${res.bodyText.slice(0, 120)}` : ''),
    );
    if (live) await sleep(GAP_MS);
  }

  return results;
}

/**
 * Questions 3 and 4: does the marker find its contacts, and only its contacts?
 */
async function probeSearchability(get, ourKeys, keysByEmail) {
  const out = {};

  for (const type of CONTACT_TYPES) {
    rule(`3–4. ${type}`);

    const partialRes = await get(type, { email: PARTIAL_EMAIL });
    const partial = summariseContacts(partialRes.body, ourKeys);
    line(
      `email=${PARTIAL_EMAIL} (partial)`,
      `HTTP ${partialRes.status} · ${partial.count} returned · ${partial.ours.length}/${ourKeys.length} of ours`,
    );
    await sleep(GAP_MS);

    const tags = {};
    for (const email of TAG_EMAILS) {
      const res = await get(type, { email });
      const summary = summariseContacts(res.body, ourKeys);
      const expected = keysByEmail.get(email) ?? [];
      const excluded = ourKeys.filter(k => !expected.includes(k));
      const isolation = describeIsolation({
        returned: summary.ours,
        expected,
        excluded,
        // A prospect does not appear under /members. Judging isolation there
        // would report a working marker as a broken one.
        endpointHoldsOurs: partial.ours.length > 0,
      });

      tags[email] = { status: res.status, summary, isolation };
      line(
        `email=+${plusTag(email)} (exact)`,
        `HTTP ${res.status} · ${summary.count} returned · ` +
          (!isolation.applicable
            ? 'n/a — this endpoint holds none of our contacts'
            : isolation.isolated
              ? 'ISOLATED'
              : `NOT isolated (missing ${isolation.missing.length}, cross-tag ${isolation.crossTag.length})`),
      );
      await sleep(GAP_MS);
    }

    out[type] = {
      partial: { status: partialRes.status, ...partial },
      tags,
      // The partial match is only useful if it finds every contact the probe
      // created — that is what "find all school-created contacts" means.
      //
      // `null`, not `false`, when this endpoint holds none of ours: a contact
      // created as a prospect is not under /members at all, and recording that
      // as a failed search would contradict the finding it belongs to.
      partialFindsAll: partial.ours.length === 0 ? null : partial.ours.length === ourKeys.length,
    };
  }

  return out;
}

/** The list the ticket asks for: what a human must now delete by hand. */
function printCleanupList(contacts) {
  rule('Cleanup — delete these by hand in the Clubworx UI');

  if (!contacts.length) {
    console.log('  Nothing was created.');
    return;
  }

  console.log('  Clubworx cannot delete contacts through the API (ACCESS.md §4).\n');
  for (const c of contacts) {
    console.log(
      `  ${c.label}  ${c.first_name} ${c.last_name.padEnd(16)} ${c.email.padEnd(46)} ` +
        `contact_key ${c.contact_key ?? 'UNKNOWN — search the UI for this email'}` +
        (c.reused ? '  (from an earlier run)' : ''),
    );
  }

  // A write whose response was lost may or may not have landed. Listing it as
  // certain would be wrong; leaving it out would be worse.
  const uncertain = contacts.filter(c => c.conclusive === false);
  if (uncertain.length) {
    console.log(
      `\n  ⚠️  ${uncertain.length} of these did not confirm (${uncertain.map(c => c.label).join(', ')}).\n` +
        '      The request may still have been honoured. Search the UI for the\n' +
        '      email before assuming it is absent, and before re-running --write.',
    );
  }
}

function printDryRun() {
  console.log('--dry-run: no requests issued, nothing created.\n');

  // Every request, not a count of them. A dry run that only reports arithmetic
  // cannot be reviewed before a write against a production database.
  let n = 0;
  const req = (verb, path, params) =>
    console.log(`  ${String(++n).padStart(2)}. ${verb.padEnd(4)} /${path}${params ? `?${params}` : ''}`);

  console.log('0. Search first — is any of this already here?');
  for (const type of CONTACT_TYPES) for (const email of TAG_EMAILS) req('GET', type, `email=${email}`);

  console.log(`\n1–2. Create, only with --write — ${PROBE_CONTACTS.length} PERMANENT contacts:`);
  for (const c of PROBE_CONTACTS) {
    req('POST', 'prospects');
    console.log(
      `      ${c.label}  ${c.first_name} ${c.last_name.padEnd(16)} ${c.email.padEnd(46)}\n` +
        `          dob ${c.dob} — ${c.why}`,
    );
  }

  console.log('\n3–4. Searchability:');
  for (const type of CONTACT_TYPES) {
    req('GET', type, `email=${PARTIAL_EMAIL}`);
    for (const email of TAG_EMAILS) req('GET', type, `email=${email}`);
  }

  console.log(
    `\n${n} requests, paced at one per ${GAP_MS}ms (~${Math.round(60_000 / GAP_MS)}/min), per #51.`,
  );
  console.log('Contacts already present are reused, so a re-run creates nothing.');
}

async function main() {
  if (DRY_RUN) {
    printDryRun();
    return;
  }

  const accountKey = loadAccountKey(DEV_VARS);
  const get = createGetter({ accountKey });
  const post = createPoster({ accountKey, live: WRITE });

  console.log(
    WRITE
      ? 'staff-site#49 probe — WRITES ENABLED, against production Clubworx'
      : 'staff-site#49 probe — read-only. Pass --write to create the contacts.',
  );

  const record = { probe: 'staff-site#49', ranAt: new Date().toISOString(), write: WRITE };

  const existing = await searchExisting(get);
  const plan = planContacts({ wanted: PROBE_CONTACTS, existing });
  record.plan = {
    create: plan.create.map(c => c.label),
    reuse: plan.reuse.map(c => ({ label: c.label, contact_key: c.contact_key })),
  };
  line('already present', plan.reuse.length ? plan.reuse.map(c => c.label).join(', ') : 'none');
  line('still to create', plan.create.length ? plan.create.map(c => c.label).join(', ') : 'none');

  let created = [];
  if (plan.create.length) {
    created = await createContacts(post, plan.create, { live: WRITE });
    if (!WRITE) console.log('\n  Read-only run — nothing was sent. Re-run with --write.');
  }
  record.created = created;

  // Both halves of what exists now: what this run wrote, and what an earlier one did.
  //
  // `mayExist`, not `outcome === 'created'`. A POST the server honoured but
  // whose response was lost leaves a permanent contact with no key recorded
  // anywhere — precisely the row that most needs to reach the cleanup list.
  const everything = [
    ...created.filter(c => c.mayExist).map(c => ({ ...c, reused: false })),
    ...plan.reuse.map(c => ({
      label: c.label,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      contact_key: c.contact_key,
      reused: true,
    })),
  ];

  const ourKeys = everything.map(c => c.contact_key).filter(Boolean);
  const keysByEmail = new Map(
    TAG_EMAILS.map(email => [email, everything.filter(c => c.email === email).map(c => c.contact_key).filter(Boolean)]),
  );

  if (ourKeys.length) {
    record.searchability = await probeSearchability(get, ourKeys, keysByEmail);
  } else {
    rule('3–4. Searchability — SKIPPED');
    console.log('  No probe contacts exist yet, so there is nothing to search for.');
  }

  // The verdicts #49 actually asked for, stated rather than left to be inferred.
  const attempted = label => created.find(c => c.label === label && !c.dryRun) ?? null;
  const previously = label => (plan.reuse.some(c => c.label === label) ? 'previously' : null);

  const plus = attempted('A');
  const duplicate = attempted('B');
  const collapse = schemeCollapses({ plus, duplicate });

  record.verdicts = {
    plusAccepted: plus ? plus.outcome === 'created' : previously('A'),
    duplicateEmailAccepted: duplicate ? duplicate.outcome === 'created' : previously('B'),
    partialMatchWorks: Object.fromEntries(
      Object.entries(record.searchability ?? {}).map(([type, v]) => [type, v.partialFindsAll]),
    ),
    collapse,
  };

  rule('Verdicts');
  line('Q1  POST accepts noreply+tag@', String(record.verdicts.plusAccepted));
  line('Q2  many contacts share one email', String(record.verdicts.duplicateEmailAccepted));

  if (collapse.collapsed) {
    // #49: "Say so explicitly rather than inventing a workaround." Only on a
    // conclusive rejection — see schemeCollapses.
    console.log(
      `\n  ⚠️  ${collapse.reason}.\n` +
        '      The school-marking scheme decided while charting #46 COLLAPSES and\n' +
        '      must be re-decided — the fallback is a dedicated prospect status,\n' +
        '      which loses the which-school record.',
    );
  } else if (collapse.inconclusive) {
    // A timeout is not an answer, and must not be reported as one.
    console.log(
      '\n  ⚠️  A write did not complete (timeout or server error). This says\n' +
        '      nothing about plus-addressing or uniqueness — re-run before\n' +
        '      concluding anything, and check the cleanup list: a lost response\n' +
        '      may still have created a contact.',
    );
  }

  printCleanupList(everything);

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `49-${record.ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(
    `\n${get.calls} reads, ${post.writes} writes. Summary written to probes/out/${path.basename(file)}`,
  );
}

main().catch(err => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
