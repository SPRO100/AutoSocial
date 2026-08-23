const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { _private } = require("../src/tiktok-uploader");
const { resolveBlockingOverlays, selectKnownDialogAction } = _private;

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
