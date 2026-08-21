const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PersonaApiError,
  attachPersonaProfile,
  disconnectPersonaBrowser,
  stopPersonaProfile,
  personaProfileExists,
  listPersonaProfiles,
} = require("../src/persona-browser");

function withMockFetch(handler, fn) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function makeFakeCdpContext() {
  const pages = [];
  return {
    pages: () => pages,
    newPage: async () => { const page = {}; pages.push(page); return page; },
  };
}

/**
 * A fresh persona-browser.js instance with playwright's connectOverCDP
 * faked (never touches a real browser), for tests that need a genuinely
 * successful attach to exercise the checkout guard / disconnect release.
 */
function freshPersonaBrowserWithFakePlaywright({ connectOverCDP } = {}) {
  const fakeContext = makeFakeCdpContext();
  const fakeBrowser = { contexts: () => [fakeContext], close: async () => {} };
  installFakeModule("playwright", {
    chromium: {
      connectOverCDP: connectOverCDP || (async () => fakeBrowser),
    },
  });
  delete require.cache[require.resolve("../src/persona-browser")];
  const mod = require("../src/persona-browser");
  return { ...mod, fakeContext, fakeBrowser };
}

test("attachPersonaProfile requires a profileId", async () => {
  await assert.rejects(attachPersonaProfile(), /profileId is required/);
  await assert.rejects(attachPersonaProfile(""), /profileId is required/);
});

test("attachPersonaProfile surfaces a clear PersonaApiError when Persona API is unreachable", async () => {
  await withMockFetch(
    async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
    },
    async () => {
      await assert.rejects(attachPersonaProfile("some-profile"), (error) => {
        assert.ok(error instanceof PersonaApiError);
        assert.match(error.message, /Could not reach Persona API/);
        assert.match(error.message, /persona-api\.service/);
        return true;
      });
    }
  );
});

test("attachPersonaProfile surfaces a clear PersonaApiError for a 404 (profile not found)", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ detail: "profile not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    async () => {
      await assert.rejects(attachPersonaProfile("does-not-exist"), (error) => {
        assert.ok(error instanceof PersonaApiError);
        assert.equal(error.status, 404);
        assert.match(error.message, /not found/);
        return true;
      });
    }
  );
});

test("attachPersonaProfile surfaces a clear PersonaApiError for a 409 (profile busy/running outside attach)", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ detail: "stop the profile first - its session is in use" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    async () => {
      await assert.rejects(attachPersonaProfile("busy-profile"), (error) => {
        assert.ok(error instanceof PersonaApiError);
        assert.equal(error.status, 409);
        assert.match(error.message, /busy/i);
        return true;
      });
    }
  );
});

test("attachPersonaProfile rejects clearly when Persona's response has no CDP port", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ pid: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    async () => {
      await assert.rejects(attachPersonaProfile("no-port-profile"), /did not return a CDP port/);
    }
  );
});

test("attachPersonaProfile passes headless through to the real Persona /attach request body", async () => {
  let capturedBody;
  await withMockFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      // No real Chromium to connect to in this unit test - fail fast with a
      // recognizable, expected error after capturing the request.
      return new Response(JSON.stringify({ port: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await assert.rejects(attachPersonaProfile("headless-profile", { headless: true }));
      assert.equal(capturedBody.headless, true);
    }
  );
});

test("two concurrent attachPersonaProfile calls for the SAME profile issue only ONE real HTTP attach request", async () => {
  let requestCount = 0;
  let resolveFirst;
  const firstRequestStarted = new Promise((resolve) => { resolveFirst = resolve; });
  await withMockFetch(
    async () => {
      requestCount += 1;
      resolveFirst();
      // Hold the response open briefly so a second, concurrent call has a
      // real window in which to (wrongly) issue its own request if the
      // in-flight memoization were missing.
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ port: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const first = attachPersonaProfile("racey-profile").catch(() => {});
      await firstRequestStarted;
      const second = attachPersonaProfile("racey-profile").catch(() => {});
      await Promise.all([first, second]);
    }
  );
  assert.equal(requestCount, 1, "concurrent attaches for the same profile must be memoized into a single real HTTP call");
});

test("two concurrent attachPersonaProfile calls for DIFFERENT profiles each issue their own real HTTP attach request", async () => {
  const seenProfileIds = [];
  await withMockFetch(
    async (url) => {
      seenProfileIds.push(String(url));
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ port: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await Promise.all([
        attachPersonaProfile("profile-a").catch(() => {}),
        attachPersonaProfile("profile-b").catch(() => {}),
      ]);
    }
  );
  assert.equal(seenProfileIds.length, 2, "memoization must be keyed per-profile, never global");
});

test("attachPersonaProfile calls the real, exact attach endpoint for the given profile id", async () => {
  let capturedUrl;
  let capturedMethod;
  await withMockFetch(
    async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init.method;
      return new Response(JSON.stringify({ port: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await assert.rejects(attachPersonaProfile("6a34ff44d3e1"));
      assert.equal(capturedUrl, "http://127.0.0.1:8787/api/profiles/6a34ff44d3e1/attach");
      assert.equal(capturedMethod, "POST");
    }
  );
});

test("disconnectPersonaBrowser calls browser.close() exactly once and never touches Persona's /stop endpoint", async () => {
  let closeCalls = 0;
  const fakeBrowser = { close: async () => { closeCalls += 1; } };
  let fetchCalled = false;
  await withMockFetch(
    async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    },
    async () => {
      await disconnectPersonaBrowser({ browser: fakeBrowser });
    }
  );
  assert.equal(closeCalls, 1);
  assert.equal(fetchCalled, false, "a normal disconnect must never call the Persona API at all");
});

test("disconnectPersonaBrowser is a safe no-op for a null/undefined session or a session with no browser (legacy)", async () => {
  await assert.doesNotReject(disconnectPersonaBrowser(null));
  await assert.doesNotReject(disconnectPersonaBrowser(undefined));
  await assert.doesNotReject(disconnectPersonaBrowser({}));
});

test("disconnectPersonaBrowser swallows a close() failure rather than throwing", async () => {
  const fakeBrowser = { close: async () => { throw new Error("already disconnected"); } };
  await assert.doesNotReject(disconnectPersonaBrowser({ browser: fakeBrowser }));
});

test("stopPersonaProfile calls the real, exact stop endpoint - this IS the intentional destructive action", async () => {
  let capturedUrl;
  let capturedMethod;
  await withMockFetch(
    async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init.method;
      return new Response(JSON.stringify({ status: "stopped" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      await stopPersonaProfile("6a34ff44d3e1");
    }
  );
  assert.equal(capturedUrl, "http://127.0.0.1:8787/api/profiles/6a34ff44d3e1/stop");
  assert.equal(capturedMethod, "POST");
});

test("stopPersonaProfile is a no-op for an empty profileId (never calls the API with a garbage id)", async () => {
  let called = false;
  await withMockFetch(
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    async () => {
      await stopPersonaProfile();
      await stopPersonaProfile("");
    }
  );
  assert.equal(called, false);
});

test("listPersonaProfiles calls the real, exact /api/profiles endpoint and returns the safe id/name/status/tags fields", async () => {
  let capturedUrl;
  const realProfiles = [{ id: "6a34ff44d3e1", name: "content-os-api-test", status: "stopped", tags: ["content-os"] }];
  await withMockFetch(
    async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(realProfiles), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    async () => {
      const profiles = await listPersonaProfiles();
      assert.deepEqual(profiles, realProfiles);
    }
  );
  assert.equal(capturedUrl, "http://127.0.0.1:8787/api/profiles");
});

test("listPersonaProfiles strips every other field from Persona's real profile record - proxy credentials (user/pass), engine, os, locale, _created never leave this function", async () => {
  // Shaped exactly like Persona's real server.py#_proxy_to_dash() output -
  // a real profile with a proxy assigned carries its username/password in
  // plaintext right on the profile object /api/profiles returns.
  const realProfileWithSecrets = {
    id: "secret-profile", name: "Has A Proxy", status: "running", tags: ["client-a"],
    engine: "playwright", os: "linux", locale: "en-US", _created: 123456,
    proxy: { type: "http", host: "proxy.example.com", port: 8080, user: "realuser", pass: "super-secret-password", country: "US" },
  };
  await withMockFetch(
    async () => new Response(JSON.stringify([realProfileWithSecrets]), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const profiles = await listPersonaProfiles();
      assert.equal(profiles.length, 1);
      const [profile] = profiles;
      assert.deepEqual(Object.keys(profile).sort(), ["id", "name", "status", "tags"]);
      assert.equal(profile.id, "secret-profile");
      assert.equal(profile.name, "Has A Proxy");
      assert.equal(profile.status, "running");
      assert.deepEqual(profile.tags, ["client-a"]);
      // The actual regression check: serialize what this function returns
      // and confirm the real proxy password is nowhere in it.
      assert.ok(!JSON.stringify(profile).includes("super-secret-password"), "a proxy password must never survive listPersonaProfiles()");
      assert.ok(!JSON.stringify(profile).includes("realuser"), "a proxy username must never survive listPersonaProfiles()");
      assert.ok(!("proxy" in profile), "the proxy object itself must never survive listPersonaProfiles()");
    }
  );
});

test("listPersonaProfiles returns an empty array (never throws/null) for a malformed non-array response", async () => {
  await withMockFetch(
    async () => new Response(JSON.stringify({ not: "an array" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const profiles = await listPersonaProfiles();
      assert.deepEqual(profiles, []);
    }
  );
});

test("listPersonaProfiles throws PersonaApiError when Persona API is unreachable", async () => {
  await withMockFetch(
    async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    async () => {
      await assert.rejects(listPersonaProfiles(), PersonaApiError);
    }
  );
});

test("personaProfileExists reports true only for a real match by id, false otherwise", async () => {
  await withMockFetch(
    async () =>
      new Response(JSON.stringify([{ id: "6a34ff44d3e1" }, { id: "other-profile" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    async () => {
      assert.equal(await personaProfileExists("6a34ff44d3e1"), true);
      assert.equal(await personaProfileExists("not-there"), false);
      assert.equal(await personaProfileExists(""), false);
    }
  );
});

test("personaProfileExists throws (does not silently return false) when Persona API is unreachable - callers decide the fail-open/closed policy", async () => {
  await withMockFetch(
    async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
    async () => {
      await assert.rejects(personaProfileExists("6a34ff44d3e1"), PersonaApiError);
    }
  );
});

// ---------------------------------------------------------------------------
// Per-profile checkout guard - a real, currently-attached session for one
// profile must block a second, concurrent attach for that SAME profile
// (rather than silently letting two Playwright clients drive the same
// real tab), and must release cleanly once disconnected.
// ---------------------------------------------------------------------------

test("a second attachPersonaProfile for a profile still checked out (not yet disconnected) is rejected with a clear error", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const session = await mod.attachPersonaProfile("checkout-profile");
      await assert.rejects(mod.attachPersonaProfile("checkout-profile"), (error) => {
        assert.ok(error instanceof mod.PersonaApiError);
        assert.match(error.message, /already in use/i);
        return true;
      });
      await mod.disconnectPersonaBrowser(session);
    }
  );
});

test("after disconnectPersonaBrowser releases the checkout, the same profile can be attached again", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const first = await mod.attachPersonaProfile("reattach-profile");
      await mod.disconnectPersonaBrowser(first);
      // Must not throw "already in use" now that the first session released it.
      const second = await mod.attachPersonaProfile("reattach-profile");
      await mod.disconnectPersonaBrowser(second);
    }
  );
});

test("a failed attach (no CDP port) releases the checkout instead of leaving the profile permanently 'in use'", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      await assert.rejects(mod.attachPersonaProfile("failed-attach-profile"), /did not return a CDP port/);
      // Retrying after a failed attach must not be blocked by a stale checkout.
      await assert.rejects(mod.attachPersonaProfile("failed-attach-profile"), /did not return a CDP port/);
    }
  );
});

test("checkout is per-profile, never global - two different profiles can both be attached at once", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const a = await mod.attachPersonaProfile("profile-x");
      const b = await mod.attachPersonaProfile("profile-y");
      await mod.disconnectPersonaBrowser(a);
      await mod.disconnectPersonaBrowser(b);
    }
  );
});

test("when Playwright fails to connect over CDP after a successful Persona attach, the profile is stopped so it never gets stuck 'attached'", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright({
    connectOverCDP: async () => { throw new Error("ECONNREFUSED"); },
  });
  const calledUrls = [];
  await withMockFetch(
    async (url) => {
      calledUrls.push(String(url));
      if (String(url).endsWith("/attach")) {
        return new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "stopped" }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    async () => {
      await assert.rejects(mod.attachPersonaProfile("stuck-profile"), /could not connect over CDP/);
    }
  );
  assert.ok(calledUrls.some((u) => u.endsWith("/api/profiles/stuck-profile/stop")), "a failed CDP connect must trigger a real stop call so the profile does not get stuck attached");
  // The checkout must also have been released - a retry must reach the
  // network layer again, not be blocked by a stale "already in use".
  await withMockFetch(
    async () => new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      await assert.rejects(mod.attachPersonaProfile("stuck-profile"), /could not connect over CDP/);
    }
  );
});

// ---------------------------------------------------------------------------
// startPersonaBrowser - the dashboard's "Start" action: attach for real,
// then immediately release AutoSocial's own connection so Persona keeps
// the browser running without the dashboard holding a live client open.
// ---------------------------------------------------------------------------

test("startPersonaBrowser attaches and immediately disconnects - never leaves the checkout held", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({ port: 42 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      const result = await mod.startPersonaBrowser("start-profile", { headless: true });
      assert.equal(result.profileId, "start-profile");
      assert.equal(result.port, 42);
      // The checkout was released - a real upload/login-session for the
      // same profile must be able to attach right after Start completes.
      await mod.attachPersonaProfile("start-profile").then((s) => mod.disconnectPersonaBrowser(s));
    }
  );
});

test("startPersonaBrowser passes headless through to the real Persona attach request", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  let capturedBody;
  await withMockFetch(
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ port: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    async () => {
      await mod.startPersonaBrowser("headless-start-profile", { headless: false });
    }
  );
  assert.equal(capturedBody.headless, false);
});

test("startPersonaBrowser propagates a real attach failure (e.g. profile not found) without leaving a stale checkout", async () => {
  const mod = freshPersonaBrowserWithFakePlaywright();
  await withMockFetch(
    async () => new Response(JSON.stringify({ detail: "profile not found" }), { status: 404, headers: { "Content-Type": "application/json" } }),
    async () => {
      await assert.rejects(mod.startPersonaBrowser("missing-profile"), (error) => {
        assert.ok(error instanceof mod.PersonaApiError);
        assert.equal(error.status, 404);
        return true;
      });
    }
  );
});
