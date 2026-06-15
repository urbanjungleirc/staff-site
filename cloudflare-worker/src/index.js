/**
 * Cloudflare Worker to read/write tools.json in GitHub via Contents API.
 *
 * Env vars (wrangler.toml [vars] or secrets):
 * - GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, TOOLS_PATH
 * - GITHUB_TOKEN (secret)
 * - ALLOWED_ORIGIN (CORS)
 * - COMMITTER_NAME, COMMITTER_EMAIL (optional)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic CORS handling
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin),
      });
    }

    try {
      // Optionally read the Cloudflare Access header for audit/logging
      const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || null;

      if (url.pathname === "/api/ics") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405, allowedOrigin, { Allow: "GET, OPTIONS" });
        }
        if (!env.ICS_URL) {
          return json({ error: "ICS_URL secret not configured" }, 500, allowedOrigin);
        }
        const icsRes = await fetch(env.ICS_URL, {
          headers: { "User-Agent": "UJ-Roster-Proxy/1.0" },
        });
        if (!icsRes.ok) {
          return json({ error: `ICS upstream error: ${icsRes.status}` }, 502, allowedOrigin);
        }
        const icsText = await icsRes.text();
        return new Response(icsText, {
          status: 200,
          headers: {
            ...corsHeaders(allowedOrigin),
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": "max-age=120",
          },
        });
      }

      if (url.pathname === "/api/roster") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405, allowedOrigin, { Allow: "GET, OPTIONS" });
        }
        if (!env.DEPUTY_TOKEN || !env.DEPUTY_URL) {
          return json({ error: "DEPUTY_TOKEN or DEPUTY_URL not configured" }, 500, allowedOrigin);
        }

        const nowMs = Date.now();
        const pastDays  = parseInt(env.DEPUTY_WINDOW_PAST_DAYS   ?? "7",  10);
        const futureDays = parseInt(env.DEPUTY_WINDOW_FUTURE_DAYS ?? "14", 10);
        const fromTs = Math.floor((nowMs - pastDays   * 86400000) / 1000);
        const toTs   = Math.floor((nowMs + futureDays * 86400000) / 1000);

        const deputyHeaders = {
          Authorization: `Bearer ${env.DEPUTY_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        const timeSearch = {
          s1: { field: "StartTime", type: "ge", data: fromTs },
          s2: { field: "StartTime", type: "le", data: toTs  },
        };

        // Fetch parent records and micro-schedule child records in parallel.
        // Deputy's Roster/QUERY silently excludes records where ParentId != null,
        // so children require a separate query filtered by ParentId > 0.
        const [parentRes, childRes] = await Promise.all([
          fetch(`${env.DEPUTY_URL}/resource/Roster/QUERY`, {
            method: "POST",
            headers: deputyHeaders,
            body: JSON.stringify({ search: timeSearch }),
          }),
          fetch(`${env.DEPUTY_URL}/resource/Roster/QUERY`, {
            method: "POST",
            headers: deputyHeaders,
            body: JSON.stringify({ search: { ...timeSearch, s3: { field: "ParentId", type: "gt", data: 0 } } }),
          }),
        ]);

        if (!parentRes.ok) {
          const errText = await parentRes.text().catch(() => "");
          return json({ error: `Deputy error ${parentRes.status}: ${errText}` }, 502, allowedOrigin);
        }

        const rawParents = await parentRes.json();
        const items = Array.isArray(rawParents) ? rawParents : Object.values(rawParents);

        // Parse children; tolerate errors (child query may return empty or error)
        const childrenByParent = {};
        if (childRes.ok) {
          try {
            const rawChildren = await childRes.json();
            const childItems = Array.isArray(rawChildren) ? rawChildren : [];
            for (const child of childItems) {
              if (!child.ParentId) continue;
              if (!childrenByParent[child.ParentId]) childrenByParent[child.ParentId] = [];
              childrenByParent[child.ParentId].push(child);
            }
            for (const pid of Object.keys(childrenByParent)) {
              childrenByParent[pid].sort((a, b) => a.StartTime - b.StartTime);
            }
          } catch {}
        }

        const shifts = items.flatMap(s => {
          const name = s._DPMetaData?.EmployeeInfo?.DisplayName;
          if (!name) return [];
          const children = childrenByParent[s.Id];
          if (children && children.length > 0) {
            // Micro-scheduled: replace parent with its child segments
            return children.flatMap(child => {
              const role = child._DPMetaData?.OperationalUnitInfo?.OperationalUnitName;
              if (!role) return [];
              return [{ name, role, start: child.StartTime, end: child.EndTime ?? null, shiftId: s.Id }];
            });
          }
          const role = s._DPMetaData?.OperationalUnitInfo?.OperationalUnitName;
          if (!role) return [];
          return [{ name, role, start: s.StartTime, end: s.EndTime ?? null }];
        });

        return new Response(JSON.stringify(shifts), {
          status: 200,
          headers: {
            ...corsHeaders(allowedOrigin),
            "Content-Type": "application/json",
            "Cache-Control": "max-age=120",
          },
        });
      }

      if (url.pathname === "/api/tools.json") {
        if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_BRANCH || !env.TOOLS_PATH) {
          return json({ error: "Worker not configured" }, 500, allowedOrigin);
        }
        if (!env.GITHUB_TOKEN) {
          return json({ error: "Missing GITHUB_TOKEN secret" }, 500, allowedOrigin);
        }

        if (request.method === "GET") {
          const content = await githubGetFile(env);
          return new Response(content.text, {
            status: 200,
            headers: {
              ...corsHeaders(allowedOrigin),
              "Content-Type": content.contentType,
              "Cache-Control": "no-store",
            },
          });
        }

        if (request.method === "POST") {
          const body = await readBodyText(request);
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            return json({ error: "Body must be valid JSON" }, 400, allowedOrigin);
          }

          // Validate JSON structure quickly before committing
          const problems = validateToolsJson(parsed);
          if (problems.length) {
            return json({ error: "Schema validation failed", details: problems }, 400, allowedOrigin);
          }

          // Pretty-print with trailing newline for clean diffs
          const pretty = JSON.stringify(parsed, null, 2) + "\n";

          const { sha } = await githubGetSha(env);
          const message = commitMessage(userEmail);
          await githubPutFile(env, pretty, sha, message);

          return json({ ok: true, message: "Updated tools.json" }, 200, allowedOrigin);
        }

        return json({ error: "Method not allowed" }, 405, allowedOrigin, {
          Allow: "GET, POST, OPTIONS",
        });
      }

      return json({ error: "Not found" }, 404, allowedOrigin);
    } catch (err) {
      return json({ error: err?.message || String(err) }, 500, env?.ALLOWED_ORIGIN || "*" );
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cf-Access-Jwt-Assertion",
  };
}

function json(data, status = 200, origin = "*", extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin), ...extraHeaders },
  });
}

async function readBodyText(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    // Allow text bodies for easier debugging; still parse as JSON later
  }
  const text = await request.text();
  // Size guard (~200KB)
  if (text.length > 200 * 1024) {
    throw new Error("Payload too large");
  }
  return text;
}

function commitMessage(userEmail) {
  if (userEmail) {
    return `chore(tools): update tools.json via editor (by ${userEmail})`;
  }
  return "chore(tools): update tools.json via editor";
}

async function githubGetFile(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const res = await fetch(apiUrl, {
    headers: ghHeaders(env),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub GET failed ${res.status}: ${t}`);
  }
  const json = await res.json();
  if (!json?.content) {
    // If file not found or empty, return an empty JSON object
    return { text: "{}\n", contentType: "application/json" };
  }
  const raw = atob(json.content.replace(/\n/g, ""));
  return { text: raw, contentType: contentTypeFromPath(env.TOOLS_PATH) };
}

async function githubGetSha(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const res = await fetch(apiUrl, { headers: ghHeaders(env) });
  if (res.status === 404) {
    return { sha: undefined };
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub metadata fetch failed ${res.status}: ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha };
}

async function githubPutFile(env, text, sha, message) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}`;
  const body = {
    message,
    content: btoa(text),
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  if (env.COMMITTER_NAME || env.COMMITTER_EMAIL) {
    body.committer = {
      name: env.COMMITTER_NAME || "UJ Tools Editor",
      email: env.COMMITTER_EMAIL || "devnull@users.noreply.github.com",
    };
  }
  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...ghHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT failed ${res.status}: ${t}`);
  }
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "uj-tools-editor-worker",
  };
}

function contentTypeFromPath(path) {
  if (path.endsWith(".json")) return "application/json";
  return "text/plain";
}

// Minimal schema validator for tools.json
// Supports the structure currently used by the site:
// { entries: [ { type: 'tool', id?, name, description?, path, category? } | { type: 'group', id?, name, description?, items: [ { id?, name?, path, buttonText? } ] } ] }
function validateToolsJson(doc) {
  const errs = [];
  if (!doc || typeof doc !== "object") {
    errs.push("Root must be an object");
    return errs;
  }
  if (!Array.isArray(doc.entries)) {
    errs.push("'entries' must be an array");
    return errs;
  }
  doc.entries.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      errs.push(`entries[${idx}] must be an object`);
      return;
    }
    const type = String(entry.type || '').toLowerCase();
    if (type !== 'tool' && type !== 'group') {
      errs.push(`entries[${idx}].type must be 'tool' or 'group'`);
      return;
    }
    if (type === 'tool') {
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        errs.push(`entries[${idx}].name is required for tool`);
      }
      if (typeof entry.path !== 'string' || !entry.path.trim()) {
        errs.push(`entries[${idx}].path is required for tool`);
      }
      if (entry.category != null && typeof entry.category !== 'string') {
        errs.push(`entries[${idx}].category must be a string when present`);
      }
      if (entry.description != null && typeof entry.description !== 'string') {
        errs.push(`entries[${idx}].description must be a string when present`);
      }
    } else if (type === 'group') {
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        errs.push(`entries[${idx}].name is required for group`);
      }
      if (!Array.isArray(entry.items) || entry.items.length === 0) {
        errs.push(`entries[${idx}].items must be a non-empty array`);
        return;
      }
      entry.items.forEach((item, jdx) => {
        if (!item || typeof item !== 'object') {
          errs.push(`entries[${idx}].items[${jdx}] must be an object`);
          return;
        }
        if (typeof item.path !== 'string' || !item.path.trim()) {
          errs.push(`entries[${idx}].items[${jdx}].path is required`);
        }
        if (item.name != null && typeof item.name !== 'string') {
          errs.push(`entries[${idx}].items[${jdx}].name must be a string when present`);
        }
        if (item.buttonText != null && typeof item.buttonText !== 'string') {
          errs.push(`entries[${idx}].items[${jdx}].buttonText must be a string when present`);
        }
      });
    }
  });
  return errs;
}
