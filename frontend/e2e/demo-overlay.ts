import type { Page } from "@playwright/test";

/**
 * What the recorded demo draws over the app (`demo-record.spec.ts`): a pointer the viewer can follow,
 * and the wallet's approval card. Neither catches an event or changes a byte the app sends; both are
 * here, apart from the spec, so they can be looked at without a console (a page with no app at all
 * renders them the same).
 */

/** A pointer dot that follows Playwright's mouse, which a recorded video otherwise does not show. */
export async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const draw = () => {
      if (document.getElementById("__demo_cursor")) return;
      const dot = document.createElement("div");
      dot.id = "__demo_cursor";
      Object.assign(dot.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "20px",
        height: "20px",
        margin: "-10px 0 0 -10px",
        borderRadius: "50%",
        background: "rgba(96, 190, 255, 0.28)",
        border: "2px solid rgba(150, 225, 255, 0.95)",
        pointerEvents: "none",
        zIndex: "2147483647",
        transform: "translate(-40px, -40px)",
      });
      document.documentElement.appendChild(dot);
      window.addEventListener(
        "mousemove",
        (e) => (dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`),
        true
      );
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw);
    else draw();
  });
}

/**
 * The wallet's approval card. The E2E keypair has no window, so without this the film shows no
 * signature at all; with it, each signature shows what it covers — the message's own text, or the
 * programs a transaction calls — held for `holdMs` before the keypair signs those same bytes
 * (`lib/e2e-wallet.ts` `E2ESignRequest`, through `window.__lathE2ESignHook`). It names no wallet
 * brand: it is this wallet, not Phantom. A page that exposes `__demoMark` gets one call per card.
 */
export async function installWalletCard(
  page: Page,
  opts: { names: Record<string, string>; holdMs: number }
): Promise<void> {
  await page.addInitScript(({ names, holdMs }) => {
    const short = (k: string) => (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k);
    const el = (tag: string, style: Partial<CSSStyleDeclaration>, text?: string) => {
      const node = document.createElement(tag);
      Object.assign(node.style, style);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    (window as unknown as { __lathE2ESignHook: (r: any) => Promise<void> }).__lathE2ESignHook = async (r) => {
      const card = el("div", {
        position: "fixed",
        top: "20px",
        right: "20px",
        width: "380px",
        padding: "18px",
        borderRadius: "16px",
        background: "#101318",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        color: "#e8edf3",
        font: "14px/1.45 system-ui, -apple-system, sans-serif",
        zIndex: "2147483646",
        opacity: "0",
        transform: "translateY(-8px)",
        transition: "opacity 180ms ease, transform 180ms ease",
      });
      const head = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center" });
      head.append(
        el("span", { fontSize: "12px", color: "#8fa3b8" }, `Wallet · ${short(r.signer)}`),
        el("span", { fontSize: "12px", color: "#8fa3b8" }, location.host)
      );
      const title = el(
        "div",
        { fontSize: "16px", fontWeight: "600", margin: "10px 0 12px" },
        r.kind === "message" ? "Sign message" : "Approve transaction"
      );
      const body = el("div", {
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "10px",
        padding: "10px 12px",
        font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        maxHeight: "220px",
        overflow: "hidden",
      });
      body.textContent =
        r.kind === "message"
          ? r.text
          : [
              ...r.programs.map((p: string) => `calls ${names[p] ?? short(p)}`),
              `fee payer ${short(r.feePayer ?? r.signer)}`,
            ].join("\n");
      const buttons = el("div", { display: "flex", gap: "10px", marginTop: "14px" });
      const button = (label: string, primary: boolean) =>
        el(
          "div",
          {
            flex: "1",
            textAlign: "center",
            padding: "9px 0",
            borderRadius: "10px",
            fontWeight: "600",
            background: primary ? "#2f80ed" : "rgba(255,255,255,0.06)",
            color: primary ? "#fff" : "#c3ced9",
            transition: "filter 120ms ease, transform 120ms ease",
          },
          label
        );
      const approve = button(r.kind === "message" ? "Sign" : "Approve", true);
      buttons.append(button("Cancel", false), approve);
      card.append(head, title, body, buttons);
      document.documentElement.appendChild(card);
      requestAnimationFrame(() => Object.assign(card.style, { opacity: "1", transform: "translateY(0)" }));
      const first = r.kind === "message" ? String(r.text).split("\n")[0] : `${r.programs.length} program(s)`;
      (window as unknown as { __demoMark?: (b: string, n?: string) => void }).__demoMark?.(
        r.kind === "message" ? "wallet: sign message" : "wallet: approve transaction",
        first
      );
      await new Promise((done) => setTimeout(done, holdMs * 0.75));
      Object.assign(approve.style, { filter: "brightness(1.25)", transform: "scale(0.97)" });
      await new Promise((done) => setTimeout(done, Math.max(400, holdMs * 0.25)));
      Object.assign(card.style, { opacity: "0", transform: "translateY(-8px)" });
      setTimeout(() => card.remove(), 220);
    };
  }, opts);
}

/**
 * Blurs an agent's trace key wherever a page prints one (`data-testid="trace-key"`). This console
 * writes traces in the clear and prints no key, so the mask is a guard: the uncut recording is kept
 * as evidence beside the cut, and a frame of a key would hand anyone what decrypts every trace the
 * agent wrote encrypted. Only the key's box is blurred; everything else on screen is the app as it
 * rendered.
 */
export async function installSecretMask(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const add = () => {
      if (document.getElementById("__demo_mask")) return;
      const style = document.createElement("style");
      style.id = "__demo_mask";
      style.textContent = '[data-testid="trace-key"] { filter: blur(9px) !important; }';
      document.documentElement.appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  });
}
