var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin)
      });
    }
    try {
      const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || null;
      if (url.pathname === "/api/ics") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405, allowedOrigin, { Allow: "GET, OPTIONS" });
        }
        if (!env.ICS_URL) {
          return json({ error: "ICS_URL secret not configured" }, 500, allowedOrigin);
        }
        const icsRes = await fetch(env.ICS_URL, {
          headers: { "User-Agent": "UJ-Roster-Proxy/1.0" }
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
            "Cache-Control": "max-age=120"
          }
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
              "Cache-Control": "no-store"
            }
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
          const problems = validateToolsJson(parsed);
          if (problems.length) {
            return json({ error: "Schema validation failed", details: problems }, 400, allowedOrigin);
          }
          const pretty = JSON.stringify(parsed, null, 2) + "\n";
          const { sha } = await githubGetSha(env);
          const message = commitMessage(userEmail);
          await githubPutFile(env, pretty, sha, message);
          return json({ ok: true, message: "Updated tools.json" }, 200, allowedOrigin);
        }
        return json({ error: "Method not allowed" }, 405, allowedOrigin, {
          Allow: "GET, POST, OPTIONS"
        });
      }
      return json({ error: "Not found" }, 404, allowedOrigin);
    } catch (err) {
      return json({ error: err?.message || String(err) }, 500, env?.ALLOWED_ORIGIN || "*");
    }
  }
};
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cf-Access-Jwt-Assertion"
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status = 200, origin = "*", extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin), ...extraHeaders }
  });
}
__name(json, "json");
async function readBodyText(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
  }
  const text = await request.text();
  if (text.length > 200 * 1024) {
    throw new Error("Payload too large");
  }
  return text;
}
__name(readBodyText, "readBodyText");
function commitMessage(userEmail) {
  if (userEmail) {
    return `chore(tools): update tools.json via editor (by ${userEmail})`;
  }
  return "chore(tools): update tools.json via editor";
}
__name(commitMessage, "commitMessage");
async function githubGetFile(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const res = await fetch(apiUrl, {
    headers: ghHeaders(env)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub GET failed ${res.status}: ${t}`);
  }
  const json2 = await res.json();
  if (!json2?.content) {
    return { text: "{}\n", contentType: "application/json" };
  }
  const raw = atob(json2.content.replace(/\n/g, ""));
  return { text: raw, contentType: contentTypeFromPath(env.TOOLS_PATH) };
}
__name(githubGetFile, "githubGetFile");
async function githubGetSha(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const res = await fetch(apiUrl, { headers: ghHeaders(env) });
  if (res.status === 404) {
    return { sha: void 0 };
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub metadata fetch failed ${res.status}: ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha };
}
__name(githubGetSha, "githubGetSha");
async function githubPutFile(env, text, sha, message) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(env.TOOLS_PATH)}`;
  const body = {
    message,
    content: btoa(text),
    branch: env.GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  if (env.COMMITTER_NAME || env.COMMITTER_EMAIL) {
    body.committer = {
      name: env.COMMITTER_NAME || "UJ Tools Editor",
      email: env.COMMITTER_EMAIL || "devnull@users.noreply.github.com"
    };
  }
  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...ghHeaders(env),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT failed ${res.status}: ${t}`);
  }
}
__name(githubPutFile, "githubPutFile");
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "uj-tools-editor-worker"
  };
}
__name(ghHeaders, "ghHeaders");
function contentTypeFromPath(path) {
  if (path.endsWith(".json")) return "application/json";
  return "text/plain";
}
__name(contentTypeFromPath, "contentTypeFromPath");
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
    const type = String(entry.type || "").toLowerCase();
    if (type !== "tool" && type !== "group") {
      errs.push(`entries[${idx}].type must be 'tool' or 'group'`);
      return;
    }
    if (type === "tool") {
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        errs.push(`entries[${idx}].name is required for tool`);
      }
      if (typeof entry.path !== "string" || !entry.path.trim()) {
        errs.push(`entries[${idx}].path is required for tool`);
      }
      if (entry.category != null && typeof entry.category !== "string") {
        errs.push(`entries[${idx}].category must be a string when present`);
      }
      if (entry.description != null && typeof entry.description !== "string") {
        errs.push(`entries[${idx}].description must be a string when present`);
      }
    } else if (type === "group") {
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        errs.push(`entries[${idx}].name is required for group`);
      }
      if (!Array.isArray(entry.items) || entry.items.length === 0) {
        errs.push(`entries[${idx}].items must be a non-empty array`);
        return;
      }
      entry.items.forEach((item, jdx) => {
        if (!item || typeof item !== "object") {
          errs.push(`entries[${idx}].items[${jdx}] must be an object`);
          return;
        }
        if (typeof item.path !== "string" || !item.path.trim()) {
          errs.push(`entries[${idx}].items[${jdx}].path is required`);
        }
        if (item.name != null && typeof item.name !== "string") {
          errs.push(`entries[${idx}].items[${jdx}].name must be a string when present`);
        }
        if (item.buttonText != null && typeof item.buttonText !== "string") {
          errs.push(`entries[${idx}].items[${jdx}].buttonText must be a string when present`);
        }
      });
    }
  });
  return errs;
}
__name(validateToolsJson, "validateToolsJson");

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-AZ5hoa/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-AZ5hoa/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
