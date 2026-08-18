/**
 * Where a probe gets the live Clubworx account key.
 *
 * One copy for every probe. This function also writes the message someone sees
 * when the key is missing, and a second copy of that message is a copy that
 * eventually stops matching ACCESS.md.
 *
 * The key never appears in anything thrown from here: a failure message is the
 * text most likely to end up pasted into a terminal log, an issue comment, or
 * this public repo.
 */

import { readFileSync } from 'node:fs';

const VAR = 'CLUBWORX_ACCOUNT_KEY';

/**
 * @param {string} devVarsPath Path to a `.dev.vars` file.
 * @returns {string}
 */
export function loadAccountKey(devVarsPath) {
  let text;
  try {
    text = readFileSync(devVarsPath, 'utf8');
  } catch {
    throw new Error(
      `No .dev.vars at ${devVarsPath}. Copy .dev.vars.example and fill it in — see ACCESS.md.`,
    );
  }

  const key = text
    .split('\n')
    .find(line => line.trim().startsWith(`${VAR}=`))
    // Split on every '=' and rejoin all but the first: a base64 key ends in
    // padding, and keeping only [1] would truncate the credential into a 401
    // that looks like a permissions problem.
    ?.split('=')
    .slice(1)
    .join('=')
    .trim();

  if (!key) throw new Error(`${VAR} is missing or empty in .dev.vars`);
  return key;
}
