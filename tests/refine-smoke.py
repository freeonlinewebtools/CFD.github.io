"""Browser check for the refinement pass.

The Node suites cover the solver and the codecs, but four of this pass's changes
only exist once a DOM does: the help panel is now GENERATED from the tool
declarations, the property tab strip gained separators, the water scenarios
switch physics mode on the way in, and the status bar swaps its aerodynamic
readouts for tank ones. Each of those is the kind of thing that passes every
unit test and throws on load.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/refine-smoke.py [port]
"""
import asyncio, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"

CHECKS = """
async () => {
  const out = {};
  const app = window.hyperfoam;
  if (!app) return { fatal: 'window.hyperfoam missing' };

  // 1. The generated help panel must list the tool keys the toolbar advertises.
  app.toggleHelp(true);
  const dts = [...document.querySelectorAll('#help-cols dt')].map(d => d.textContent);
  out.helpKeys = dts.length;
  out.helpHasToolKeys = ['Q','C','Y','K','N','E','F','B','I'].every(k => dts.includes(k));
  out.helpHasCtrlI = dts.includes('Ctrl+I');
  app.toggleHelp(false);

  // 2. Tab strip separators.
  out.tabSeps = document.querySelectorAll('.pt-sep').length;
  out.tabCount = document.querySelectorAll('.pt-b').length;

  // 3. The staggered solver is the default and is actually engaged.
  out.staggeredDefault = app.staggered === true && app.ns.mac === true;

  // 4. A water scenario switches physics, fills the tank, and runs.
  app.applyScenario('dam-break');
  out.physicsAfterScenario = app.physics;
  out.volumeAfterScenario = Math.round(app.water.volume());
  out.waterMacFlag = app.water.mac;
  await new Promise(r => setTimeout(r, 900));    // let the rAF loop actually run
  out.volumeAfterRun = Math.round(app.water.volume());
  out.finite = Number.isFinite(app.grid.u[app.grid.idx(10, 10)]);

  // 5. Aerodynamic readouts hidden in water mode, tank ones shown.
  const shown = id => {
    const el = [...document.querySelectorAll('.stat')].find(
      e => e.querySelector('.stat-k')?.textContent === id);
    return el ? !el.hidden : null;
  };
  out.cdHiddenInWater = shown('Cd') === false;
  out.volShownInWater = shown('vol') === true;

  // 6. Back to airflow: the aerodynamic readouts return.
  app.applyScenario('cylinder');
  out.physicsBackToAir = app.physics;
  await new Promise(r => setTimeout(r, 400));
  out.cdShownInAir = shown('Cd') === true;

  // 7. Save/load round trip carries the water.
  app.applyScenario('dam-break');
  await new Promise(r => setTimeout(r, 200));
  const saved = app.__payload ? app.__payload() : null;
  out.savedWater = saved ? !!saved.water : 'no test hook';

  return out;
}
"""


async def main():
    errors, pageerrors = [], []
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome")
        page = await browser.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: pageerrors.append(str(e)))
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(1200)
        res = await page.evaluate(CHECKS)
        await browser.close()

    print("=== console errors ===")
    for e in errors:
        print("  ERR ", e)
    for e in pageerrors:
        print("  THROW", e)
    if not errors and not pageerrors:
        print("  none")

    print("\n=== checks ===")
    for k, v in res.items():
        print(f"  {k:24} {v}")

    ok = (
        not pageerrors
        and res.get("helpHasToolKeys")
        and res.get("helpHasCtrlI")
        and res.get("tabSeps") == 2
        and res.get("staggeredDefault")
        and res.get("physicsAfterScenario") == "water"
        and res.get("volumeAfterScenario", 0) > 0
        and res.get("waterMacFlag")
        and res.get("finite")
        and res.get("cdHiddenInWater")
        and res.get("volShownInWater")
        and res.get("physicsBackToAir") == "air"
        and res.get("cdShownInAir")
    )
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
