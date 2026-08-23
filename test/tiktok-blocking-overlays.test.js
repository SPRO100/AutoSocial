const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { _private } = require("../src/tiktok-uploader");
const { resolveBlockingOverlays, selectKnownDialogAction, setCaption, waitForPublishConfirmation } = _private;

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

test("incident regression: automatic content checks dialog is safely cancelled, removed, and live DOM exposes Post", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main><div>Uploaded (10.09MB)</div><div id="actions"></div></main>
      <div role="dialog" aria-modal="true">
        <h2>Turn on automatic content checks?</h2>
        <p>Music copyright check</p><p>Content check lite</p>
        <button id="cancel">Cancel</button><button>Turn on</button>
      </div>
      <script>
        document.querySelector('#cancel').addEventListener('click', () => {
          document.querySelector('[role=dialog]').remove();
          document.querySelector('#actions').innerHTML = '<button id="post">Post</button>';
        });
      </script>
    `);

    const before = page.locator("#post");
    assert.equal(await before.count(), 0);
    const result = await resolveBlockingOverlays(page);
    assert.equal(result.resolved, true);
    // Fresh locator after overlay mutation: no stale ElementHandle reuse.
    const livePost = page.locator("#post");
    assert.equal(await livePost.isVisible(), true);
  });
});

test("unknown blocking dialog fails closed and never clicks its action", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div role="dialog" aria-modal="true">
        <h2>Transfer account ownership?</h2><button id="danger">Confirm</button>
      </div>
      <script>window.clicked = false; document.querySelector('#danger').onclick = () => { window.clicked = true; };</script>
    `);
    await assert.rejects(
      resolveBlockingOverlays(page),
      (error) => error.code === "BLOCKING_MODAL_UNRESOLVED" && /unknown blocking/i.test(error.message)
    );
    assert.equal(await page.evaluate(() => window.clicked), false);
  });
});

test("known modal that remains visible fails with a bounded diagnostic error", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div role="dialog" aria-modal="true">
        <h2>Turn on automatic content checks?</h2>
        <button>Cancel</button><button>Turn on</button>
      </div>
    `);
    await assert.rejects(
      resolveBlockingOverlays(page, { maxPasses: 1, disappearTimeoutMs: 25 }),
      (error) => error.code === "BLOCKING_MODAL_UNRESOLVED" && /remained after safe action/i.test(error.message)
    );
  });
});

test("automatic-check action policy never selects Turn on or Post", () => {
  const selected = selectKnownDialogAction(
    "Turn on automatic content checks? Music copyright check Content check lite",
    ["Post", "Turn on", "Cancel"]
  );
  assert.equal(selected.raw, "Cancel");
});

test("resolver scopes a safe action to the recognized dialog when another Cancel exists", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div role="dialog" aria-modal="true" id="known">
        <h2>Turn on automatic content checks?</h2><button id="known-cancel">Cancel</button>
      </div>
      <div role="dialog" aria-modal="true" id="unknown">
        <h2>Transfer account ownership?</h2><button id="wrong-cancel">Cancel</button>
      </div>
      <script>
        window.wrongClicked = false;
        document.querySelector('#known-cancel').onclick = () => document.querySelector('#known').remove();
        document.querySelector('#wrong-cancel').onclick = () => { window.wrongClicked = true; };
      </script>
    `);
    await assert.rejects(resolveBlockingOverlays(page), /Unknown blocking TikTok dialog/);
    assert.equal(await page.evaluate(() => window.wrongClicked), false);
    assert.equal(await page.locator("#known").count(), 0);
  });
});

test("incident regression: blocking content-check modal is resolved before current TikTok DraftJS combobox caption is filled and verified", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div class="caption-markup"><div class="caption-editor"><div class="DraftEditor-root">
        <div class="DraftEditor-editorContainer"><div role="combobox" contenteditable="true" class="notranslate public-DraftEditor-content">video</div></div>
      </div></div></div>
      <div role="dialog" aria-modal="true" id="checks">
        <h2>Turn on automatic content checks?</h2><p>Music copyright check</p><p>Content check lite</p>
        <button id="cancel-checks">Cancel</button><button>Turn on</button>
      </div>
      <script>document.querySelector('#cancel-checks').onclick = () => document.querySelector('#checks').remove();</script>
    `);
    await setCaption(page, "Test");
    assert.equal(await page.locator('.public-DraftEditor-content').innerText(), "Test");
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
  });
});

test("caption resolver supports a semantic textarea fallback without matching unrelated inputs", async () => {
  await withPage(async (page) => {
    await page.setContent(`<input placeholder="Search locations"><textarea aria-label="Video caption">old</textarea>`);
    await setCaption(page, "Test");
    assert.equal(await page.locator("textarea").inputValue(), "Test");
    assert.equal(await page.locator("input").inputValue(), "");
  });
});

test("caption resolver fails closed when no supported editor exists", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <input placeholder="Search locations">
      <div role="combobox" contenteditable="true" aria-label="Search sounds">unrelated editor</div>
    `);
    await assert.rejects(
      setCaption(page, "Test"),
      (error) => error.code === "CAPTION_INPUT_FAILED" && /supported TikTok caption editor/i.test(error.message)
    );
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), "unrelated editor");
  });
});

test("confirmation polling never clicks the primary Post action again", async () => {
  let primaryPostLookups = 0;
  const empty = {
    count: async () => 0,
    locator() { return this; },
    filter() { return this; },
    innerText: async () => "",
  };
  const page = {
    url: () => "https://www.tiktok.com/tiktokstudio/upload",
    locator: (selector) => selector === "body" ? { innerText: async () => "" } : empty,
    getByRole: (_role, options) => {
      if (String(options?.name).toLowerCase() === "/post/i") primaryPostLookups += 1;
      return empty;
    },
    waitForTimeout: async () => {},
    off: () => {},
  };
  const tracker = { failure: () => null, success: () => false };
  const result = await waitForPublishConfirmation(page, tracker);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no reliable publish confirmation/i);
  assert.equal(primaryPostLookups, 0);
});

test("confirmation polling attempts a secondary confirmation at most once", async () => {
  let confirmClicks = 0;
  const confirm = {
    count: async () => 1,
    locator() { return this; }, filter() { return this; }, nth() { return this; },
    isVisible: async () => true,
    evaluate: async () => ({ text: "Confirm", ariaLabel: "Confirm", dataAttributes: {}, disabled: false, href: "", inNavigation: false, rect: { left: 500, right: 620, top: 700, bottom: 740, width: 120, height: 40 }, role: "button", tagName: "BUTTON", type: "button", viewportHeight: 800, viewportWidth: 1200 }),
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { confirmClicks += 1; },
  };
  const empty = { count: async () => 0, locator() { return this; }, filter() { return this; } };
  const dialog = { locator: () => confirm, filter() { return this; }, count: async () => 1 };
  const page = {
    url: () => "https://www.tiktok.com/tiktokstudio/upload",
    locator: (selector) => selector === "body" ? { innerText: async () => "" } : selector.includes("dialog") ? dialog : empty,
    getByRole: () => empty,
    waitForTimeout: async () => {}, off: () => {},
  };
  const result = await waitForPublishConfirmation(page, { failure: () => null, success: () => false });
  assert.equal(result.ok, false);
  assert.equal(confirmClicks, 1);
});
