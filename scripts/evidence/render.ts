/**
 * The evidence page: one self-contained HTML file, inline CSS, no script, fonts from Google Fonts.
 * It is the page a judge opens after the film, so every fact is a
 * link that opens its own explorer — explorer.solana.com on devnet, explore.tempo.xyz on Tempo
 * mainnet, gateway.irys.xyz — and nothing on it is served by Lath.
 *
 * The words follow the film's rules: the decision model is named Jev once and its answer is never
 * called deterministic; the receipt and the records _point at_ the run and are _checked against_ it,
 * never said to prove it; every mainnet is Tempo's or Solana's by name; the traces of a run written
 * encrypted are the owner's, so the page says they can be checked, not read, and a run written in the
 * clear (`plainTraces`) is said to be public. `tests/evidence-page.ts` holds a rendered
 * page to all of it.
 *
 * The look is the app's (`frontend/src/app/globals.css`): the dark ladder, one glowing
 * spine from blue through light blue to green, electric green only for the decision that reached the
 * goal, rose only for a failure, no purple; the Lath mark beside "Lath" in JetBrains Mono.
 */
import {
  type ChargeFact,
  type Evidence,
  type RecordFact,
  type SolanaTx,
  type StepEvidence,
  irysUrl,
  short,
  solanaAddressUrl,
  solanaTxUrl,
  tempoAddressUrl,
  tempoBlockUrl,
  tempoTxUrl,
  units6,
  utc,
} from "./model";

/** The four laths of the mark (`frontend/public/lath-mark.svg`), newest on top. */
const MARK_RECTS =
  '<rect x="19" y="6" width="10" height="6" rx="1.5" fill="#bfefff"/>' +
  '<rect x="14" y="16" width="20" height="6" rx="1.5" fill="#7fdcff"/>' +
  '<rect x="9" y="26" width="30" height="6" rx="1.5" fill="#56a9fa"/>' +
  '<rect x="4" y="36" width="40" height="6" rx="1.5" fill="#2f7cf6"/>';
const MARK_SVG = (size: number) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">${MARK_RECTS}</svg>`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${MARK_RECTS}</svg>`
)}`;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A link that opens its explorer in a new tab, its full value in the title. */
function a(url: string, text: string, opts: { mono?: boolean; title?: string } = {}): string {
  const cls = opts.mono ? ' class="mono"' : "";
  const title = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<a href="${esc(url)}" target="_blank" rel="noopener"${cls}${title}>${esc(text)}</a>`;
}

const solTx = (sig: string, text?: string) =>
  a(solanaTxUrl(sig), text ?? short(sig, 8, 6), { mono: !text, title: sig });
const solAddr = (addr: string, text?: string) =>
  a(solanaAddressUrl(addr), text ?? short(addr, 6, 4), { mono: !text, title: addr });
const tTx = (hash: string, text?: string) =>
  a(tempoTxUrl(hash), text ?? short(hash, 8, 6), { mono: !text, title: hash });
const tAddr = (addr: string, text?: string) =>
  a(tempoAddressUrl(addr), text ?? short(addr, 6, 4), { mono: !text, title: addr });

const mono = (v: string, title?: string) =>
  `<span class="mono"${title ? ` title="${esc(title)}"` : ""}>${esc(v)}</span>`;
const usdc = (micro: string | null | undefined) => `${units6(micro)} USDC`;
const usdcE = (base: string | null | undefined) => `${units6(base)} USDC.e`;

function hhmm(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(11, 19) : "";
}

const STOP_WORDS: Record<string, string> = {
  "goal-reached": "the goal was reached",
  budget: "the loop's budget was spent",
  "max-steps": "it reached its step limit",
  stopped: "it was stopped by hand",
  "charge-failed": "a charge was refused",
};

function outcomeLine(e: Evidence): string {
  if (e.outcome.reached) {
    const conf = e.outcome.confidence !== null ? ` (${e.outcome.confidence.toFixed(2)})` : "";
    return `Goal reached at step ${e.outcome.step}: the decision model, Jev, judged it achieved${conf}.`;
  }
  if (e.loop.status !== "stopped") return `The loop is ${esc(e.loop.status)}.`;
  return `Stopped because ${STOP_WORDS[e.outcome.stopReason ?? ""] ?? esc(e.outcome.stopReason ?? "it stopped")}.`;
}

function costLine(e: Evidence): string {
  const parts: string[] = [];
  const charged = e.cost.chargedMicroUsdc ?? e.cost.consoleChargedMicroUsdc;
  const chargedText = `${units6(charged)} USDC`;
  parts.push(
    `${
      e.cost.balanceAccount ? solAddr(e.cost.balanceAccount, chargedText) : esc(chargedText)
    } charged on Solana (devnet)`
  );
  if (e.cost.tempoPaidBase !== null) {
    const close = e.tempo.channels.find((c) => c.role === "model" && c.closeTx)?.closeTx;
    const text = usdcE(e.cost.tempoPaidBase);
    parts.push(`${close ? tTx(close, text) : esc(text)} paid on Tempo mainnet`);
  }
  return parts.join(", ");
}

function nodeClass(s: StepEvidence): string {
  if (s.decision?.outcome === "achieved") return "node node-achieved";
  if (s.status === "success") return "node";
  return "node node-failed";
}

function decisionLine(s: StepEvidence): string {
  const d = s.decision;
  if (!d) {
    return s.status === "success"
      ? `<span class="muted">No goal check on this step.</span>`
      : `<span class="muted">No decision: the step did not finish.</span>`;
  }
  const conf = typeof d.confidence === "number" ? ` ${d.confidence.toFixed(2)}` : "";
  const cls = d.outcome === "achieved" ? "verdict verdict-achieved" : "verdict";
  const note =
    d.outcome === "achieved"
      ? "and the loop stopped on it"
      : d.outcome === "continue"
      ? "so the loop went on"
      : "it gave no answer";
  return `<span class="${cls}">${esc(d.outcome)}${esc(
    conf
  )}</span> <span class="muted">${note}; committed in the step's record</span>`;
}

function callsBlock(s: StepEvidence, plain: boolean): string {
  if (!s.calls.length && !s.epochs.length) return "";
  const epoch = s.epochs[0];
  const rows = s.calls
    .map((c: ChargeFact, i: number) => {
      // The record is the epoch's, the same for every call of the step: named once in the line above,
      // linked again here so each row reads as the pair the film shows, _Solana record · charge_.
      const record = epoch ? solTx(epoch.signature, "Solana record") : "Solana record";
      return `<li><span class="call-n">call ${
        i + 1
      }</span><span class="call-pair">${record} <span class="sep">·</span> ${solTx(
        c.signature,
        `charge ${usdc(c.amountMicroUsdc)}`
      )}</span></li>`;
    })
    .join("");
  const voucher = s.tempoBase
    ? `<p class="tempo-fig"><span class="chip chip-tempo">Tempo</span> vouchers for this step: <strong>${esc(
        usdcE(s.tempoBase)
      )}</strong>, its calls and the decision on it, settled in the loop's channel. The per-call figures are inside the ${
        plain ? "step's public" : "encrypted"
      } trace.</p>`
    : "";
  const head = epoch
    ? `<p class="muted small">The step's calls are batched into one epoch on Solana (${solTx(
        epoch.signature,
        `seqs ${epoch.seq}–${epoch.endSeq}`
      )}); each paid call's USDC debit is its own transaction.</p>`
    : "";
  return `<div class="calls">${head}${rows ? `<ul class="call-list">${rows}</ul>` : ""}${voucher}</div>`;
}

function txList(items: RecordFact[]): string {
  return items
    .map(
      (r) =>
        `<li>${solTx(
          r.signature,
          r.kind === "epoch" ? `seqs ${r.seq}–${r.endSeq}` : `seq ${r.seq}`
        )} <span class="muted">${esc(r.label)}</span></li>`
    )
    .join("");
}

function stepItem(s: StepEvidence, plain = false): string {
  const when = s.startedAt ? `${hhmm(s.startedAt)}–${hhmm(s.endedAt)} UTC` : "";
  const badge =
    s.decision?.outcome === "achieved"
      ? `<span class="badge badge-volt">goal reached</span>`
      : s.status === "success"
      ? `<span class="badge badge-green">ran</span>`
      : `<span class="badge badge-rose">${esc(s.status)}</span>`;
  const rows: string[] = [];
  if (s.record) {
    rows.push(
      `<dt>Record</dt><dd>${solTx(
        s.record.signature,
        `loop.step · seq ${s.record.seq}`
      )} <span class="muted">the step's checkpoint on Solana</span></dd>`
    );
  }
  rows.push(`<dt>Decision</dt><dd>${decisionLine(s)}</dd>`);
  rows.push(
    `<dt>Charged</dt><dd><strong>${esc(usdc(s.chargedMicroUsdc))}</strong> <span class="muted">on Solana for ${
      s.calls.length
    } paid ${s.calls.length === 1 ? "call" : "calls"}</span></dd>`
  );
  if (s.storage) {
    const put = s.storage.reference
      ? tTx(s.storage.reference, `PUT ${usdcE(s.storage.amountBase)}`)
      : `<span class="muted">not paid (status ${esc(s.storage.statusCode)})</span>`;
    const rec = s.storage.record
      ? ` <span class="sep">·</span> ${solTx(
          s.storage.record.signature,
          `record${s.storage.seq ? ` · seq ${s.storage.seq}` : ""}${
            s.storage.chargeMicroUsdc ? ` · charge ${usdc(s.storage.chargeMicroUsdc)}` : ""
          }`
        )}`
      : "";
    rows.push(
      `<dt>Report</dt><dd>${put}${rec} <span class="muted">${esc(s.storage.path)}, ${esc(
        s.storage.bytes
      )} bytes, stored on Tempo</span></dd>`
    );
  }
  const all = [
    ...(s.genesis ? [s.genesis] : []),
    ...s.epochs,
    ...(s.resolution ? [s.resolution] : []),
    ...(s.record ? [s.record] : []),
    ...s.others,
  ].sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1));
  const details = all.length
    ? `<details><summary>All ${all.length} Solana transactions of this step</summary><ul class="tx-list">${txList(
        all
      )}</ul></details>`
    : "";
  return `<li class="spine-item">
  <span class="${nodeClass(s)}"></span>
  <div class="step-head"><h3>Step ${esc(s.step)}</h3>${badge}<span class="muted small">${esc(when)}</span></div>
  ${s.reason ? `<p class="reason">${esc(s.reason)}</p>` : ""}
  ${callsBlock(s, plain)}
  <dl class="rows">${rows.join("")}</dl>
  ${details}
</li>`;
}

function afterStopItem(e: Evidence): string {
  const records = e.afterStop.filter((r) => !e.steps.some((s) => s.storage?.record?.signature === r.signature));
  const close = e.tempo.channels.find((c) => c.role === "model" && c.closeTx);
  if (!records.length && !close && !e.otherCharges.length) return "";
  const lines: string[] = [];
  if (close?.closeTx) {
    lines.push(
      `<li>${tTx(close.closeTx, "the channel settled on Tempo mainnet")} <span class="muted">${esc(
        usdcE(close.paidBase)
      )} to the model gateway, once for the whole loop</span></li>`
    );
  }
  // Cell writes (the loop's memory and locator entries) sit behind a fold: they are the loop's too,
  // and a column of "a cell write" lines would bury the settlement's record above them.
  const named = records.filter((r) => r.kind !== "cell");
  const cells = records.filter((r) => r.kind === "cell");
  lines.push(
    ...named.map((r) => `<li>${solTx(r.signature, `seq ${r.seq}`)} <span class="muted">${esc(r.label)}</span></li>`)
  );
  lines.push(
    ...e.otherCharges.map(
      (c) =>
        `<li>${solTx(
          c.signature,
          `charge ${usdc(c.amountMicroUsdc)}`
        )} <span class="muted">a charge no step claimed</span></li>`
    )
  );
  return `<li class="spine-item">
  <span class="node node-resolution"></span>
  <div class="step-head"><h3>After the stop</h3></div>
  <ul class="tx-list">${lines.join("")}</ul>
  ${
    cells.length
      ? `<details><summary>${cells.length} cell ${
          cells.length === 1 ? "write" : "writes"
        }: the loop's memory and locator entries</summary><ul class="tx-list">${txList(cells)}</ul></details>`
      : ""
  }
</li>`;
}

function startItem(e: Evidence): string {
  const lines: string[] = [];
  if (e.agent.registration) {
    lines.push(`<li>${solTx(e.agent.registration.signature, "the agent registered on Solana devnet")}</li>`);
  }
  if (e.agent.authority) {
    lines.push(
      `<li>${solAddr(
        e.agent.authority,
        "the agent's key"
      )} <span class="muted">the only key that can add to its record</span></li>`
    );
  }
  if (e.tempo.key?.authorizeTx) {
    lines.push(
      `<li>${tTx(
        e.tempo.key.authorizeTx,
        "the loop's access key authorized on Tempo mainnet"
      )} <span class="muted">limit ${esc(usdcE(e.tempo.key.limitBase))}</span></li>`
    );
  }
  const open = e.tempo.channels.find((c) => c.role === "model" && c.openTx);
  if (open?.openTx) lines.push(`<li>${tTx(open.openTx, "the payment channel opened on Tempo mainnet")}</li>`);
  if (e.sources) lines.push(`<li>${a(irysUrl(e.sources.index), "the files pinned on Irys")}</li>`);
  return `<li class="spine-item">
  <span class="node node-genesis"></span>
  <div class="step-head"><h3>Start</h3><span class="muted small">${esc(utc(e.loop.createdAt))}</span></div>
  <ul class="tx-list">${lines.join("")}</ul>
</li>`;
}

function tempoSection(e: Evidence): string {
  const t = e.tempo;
  const rows: string[] = [];
  if (t.treasury) {
    rows.push(
      `<dt>Treasury</dt><dd>${tAddr(
        t.treasury,
        t.treasury
      )} <span class="muted">Lath's treasury: it pays every model call in USDC.e, gas sponsored</span></dd>`
    );
  }
  if (t.key) {
    const expiry = t.key.expiry ? `, expires ${utc(t.key.expiry * 1000).slice(0, 10)}` : "";
    rows.push(
      `<dt>The loop's key</dt><dd>${tAddr(t.key.address, t.key.address)} <span class="muted">limit <strong>${esc(
        usdcE(t.key.limitBase)
      )}</strong>, the budget plus the decision model's share, which Tempo enforces${esc(expiry)}</span>${
        t.key.authorizeTx ? `<br>${tTx(t.key.authorizeTx, "authorized")}` : ""
      }${
        t.key.authorizeBlock
          ? ` <span class="muted">in block ${a(tempoBlockUrl(t.key.authorizeBlock), t.key.authorizeBlock)}</span>`
          : ""
      }</dd>`
    );
  } else {
    rows.push(
      `<dt>The loop's key</dt><dd class="muted">This loop ran before loops had their own access keys; the treasury signed its channel.</dd>`
    );
  }
  for (const c of t.channels.filter((x) => x.role === "model")) {
    const open = c.openTx
      ? `${tTx(c.openTx, "opened")}${
          c.depositBase
            ? ` <span class="muted">with ${esc(usdcE(c.depositBase))}${
                c.signer && t.key && c.signer.toLowerCase() === t.key.address.toLowerCase()
                  ? ", signed by the loop's key"
                  : ""
              }</span>`
            : ""
        }`
      : c.openBlock
      ? `opened in block ${a(tempoBlockUrl(c.openBlock), c.openBlock)}`
      : `<span class="muted">open not read</span>`;
    const close = c.closeTx
      ? `${tTx(c.closeTx, "settled")}${
          c.paidBase !== undefined
            ? ` <span class="muted">${esc(usdcE(c.paidBase))} to the model gateway${
                c.payee ? ` ${tAddr(c.payee)}` : ""
              }${c.refundBase !== undefined ? `, ${esc(usdcE(c.refundBase))} back to the treasury` : ""}</span>`
            : ""
        }`
      : `<span class="muted">not settled yet</span>`;
    rows.push(
      `<dt>Payment channel</dt><dd>${mono(
        short(c.id, 10, 6),
        c.id
      )} <span class="muted">OpenRouter via Tempo, one channel for the whole loop</span><br>${open}<br>${close}</dd>`
    );
  }
  const puts = e.steps.filter((s) => s.storage?.reference);
  if (puts.length) {
    rows.push(
      `<dt>Storage PUTs</dt><dd>${puts
        .map((s) => `${tTx(s.storage!.reference!, `step ${s.step}: ${usdcE(s.storage!.amountBase)}`)}`)
        .join("<br>")} <span class="muted">each report stored on Tempo, paid by the owner</span></dd>`
    );
  }
  if (e.cost.decisionBase) {
    rows.push(
      `<dt>Decision model</dt><dd>${esc(
        usdcE(e.cost.decisionBase)
      )} <span class="muted">inside the channel above, paid by Lath and charged to nobody</span></dd>`
    );
  }
  for (const c of t.channels.filter((x) => x.role === "rpc")) {
    rows.push(
      `<dt>Lath's RPC</dt><dd>${c.closeTx ? tTx(c.closeTx, "settled") : `<span class="muted">open</span>`}${
        c.paidBase ? ` <span class="muted">${esc(usdcE(c.paidBase))}, Lath's own RPC session, paid by Lath</span>` : ""
      }</dd>`
    );
  }
  if (t.key) {
    rows.push(
      `<dt>Key revoked</dt><dd>${
        t.key.revokeTx
          ? `${tTx(
              t.key.revokeTx,
              "revoked"
            )} <span class="muted">after the settlement: the key can sign nothing more</span>`
          : t.key.revoked
          ? `<span>revoked</span> <span class="muted">Tempo's keychain reads the key revoked; the revoke transaction was not found in the blocks after the settlement</span>`
          : t.key.revoked === false
          ? `<span class="muted">not revoked yet: Tempo's keychain reads the key live</span>`
          : `<span class="muted">not read</span>`
      }</dd>`
    );
  }
  return `<dl class="rows rows-wide">${rows.join("")}</dl>`;
}

function receiptSection(e: Evidence): string {
  const r = e.receipt;
  if (!r)
    return `<p class="one-line" data-receipt="none">This loop has no receipt on SAS: it ran without SAS · receipt.</p>`;
  if (r.status !== "published") {
    const why =
      r.status === "none"
        ? "the loop stopped without the decision model's achieved, so none was published."
        : r.status === "failed"
        ? "its publish did not land."
        : "it is not published yet.";
    return `<p class="one-line" data-receipt="${esc(r.status)}">No receipt on SAS: ${why} It would be at ${solAddr(
      r.address
    )}.</p>`;
  }
  const v = r.values;
  const rows: string[] = [
    `<dt>Attestation</dt><dd>${solAddr(r.address, r.address)}</dd>`,
    ...(r.signature
      ? [`<dt>Transaction</dt><dd>${solTx(r.signature)} <span class="muted">createAttestation</span></dd>`]
      : []),
    `<dt>Credential</dt><dd>${solAddr(r.credential)} <span class="muted">lath-demo</span></dd>`,
    `<dt>Schema</dt><dd>${solAddr(r.schema)} <span class="muted">loop-receipt v1</span></dd>`,
    `<dt>Signed by</dt><dd>${solAddr(
      r.signer
    )} <span class="muted">the console's key, authorized by the issuer</span></dd>`,
  ];
  if (v) {
    const lastRecord = e.steps.find((s) => s.record?.seq === v.seq)?.record;
    rows.push(
      `<dt>agent</dt><dd>${mono(short(v.agent, 10, 8), v.agent)}</dd>`,
      `<dt>loop</dt><dd>${mono(v.loop)}</dd>`,
      `<dt>seq</dt><dd>${
        lastRecord ? solTx(lastRecord.signature, v.seq) : mono(v.seq)
      } <span class="muted">the loop's last loop.step record</span></dd>`,
      `<dt>head</dt><dd>${mono(short(v.head, 10, 8), v.head)}</dd>`,
      `<dt>steps</dt><dd>${mono(String(v.steps))}</dd>`,
      `<dt>goal</dt><dd>${mono(short(v.goal, 10, 8), v.goal)}</dd>`,
      `<dt>usdcCharged</dt><dd>${mono(usdc(v.usdcCharged))}</dd>`,
      `<dt>tempoSpent</dt><dd>${mono(usdcE(v.tempoSpent))}</dd>`,
      `<dt>tempoPayer</dt><dd>${v.tempoPayer ? tAddr(v.tempoPayer, v.tempoPayer) : mono("none")}</dd>`
    );
  }
  const from =
    r.valuesFrom === "chain"
      ? "The fields are decoded from the account on Solana devnet."
      : r.valuesFrom === "console"
      ? "The fields are the console's report: the account was not read."
      : "";
  return `<dl class="rows rows-wide">${rows.join("")}</dl>
<p class="note">This receipt points at the loop's records; <code>lath-audit verify-receipt</code> checks it against them. ${esc(
    from
  )}</p>`;
}

function filesSection(e: Evidence): string {
  const s = e.sources;
  if (!s) return `<p class="one-line">This loop pinned no files on Irys.</p>`;
  const blocks = s.sources
    .map((src) => {
      const files = src.files
        .map(
          (f) =>
            `<li>${
              f.irys ? a(irysUrl(f.irys), f.path, { title: `sha256 ${f.sha256}` }) : esc(f.path)
            } <span class="muted">${esc(f.size)} B</span></li>`
        )
        .join("");
      const pin = src.pinUrl ? a(src.pinUrl, src.pin) : esc(src.pin);
      return `<div class="source"><p class="source-head"><span class="chip">${esc(src.kind)}</span> ${esc(
        src.label
      )} <span class="muted">${pin}</span></p>${files ? `<ul class="file-list">${files}</ul>` : ""}</div>`;
    })
    .join("");
  return `<p class="muted">Each step read these files from Irys, read-only, with no network. The index maps each file's SHA-256 to its Irys id: ${a(
    irysUrl(s.index),
    "sources index"
  )}${s.manifest ? ` · ${a(irysUrl(s.manifest), "manifest")}` : ""}.</p>${blocks}`;
}

function checkSection(e: Evidence): string {
  const cmds = e.commands
    .map(
      (c) =>
        `<div class="cmd"><p class="cmd-title"><code>${esc(c.title)}</code></p><p class="muted small">${esc(
          c.checks
        )}</p><pre><code>${esc(c.command)}</code></pre></div>`
    )
    .join("");
  return `<p>The explorers show that each transaction exists, who signed it and the amounts. They do not recompute the hash chain, re-hash the blobs or add the vouchers up to the settlement; <code>lath-audit</code> does, from any machine, with no Lath server. ${
    e.loop.plainTraces
      ? "The traces are public: anyone can read them and check them against the chain."
      : "The traces are encrypted to the owner: anyone can check them against the chain, not read them."
  }</p>
${cmds}`;
}

const CSS = `
:root{
  color-scheme:dark;
  --canvas:9 10 13;--surface-1:14 15 20;--surface-2:19 21 27;--surface-3:26 28 36;
  --line:255 255 255;--ink-1:240 242 246;--ink-2:166 172 186;--ink-3:128 134 148;
  --accent:127 220 255;
  --spine-blue:47 124 246;--spine-sky:127 220 255;--spine-green:34 197 94;--spine-volt:61 255 138;
  --rose:251 113 133;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background-color:rgb(var(--canvas));color:rgb(var(--ink-1));font:15px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background-image:radial-gradient(60rem 24rem at 50% -8rem,rgb(var(--accent)/.07),transparent 70%),linear-gradient(rgb(255 255 255/.018) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255/.018) 1px,transparent 1px);
  background-size:100% 100%,48px 48px,48px 48px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:rgb(var(--accent));text-decoration:none;border-bottom:1px solid rgb(var(--accent)/.25);overflow-wrap:anywhere}
a:hover{color:rgb(190 238 255);border-bottom-color:rgb(var(--accent)/.7)}
a:focus-visible{outline:2px solid rgb(var(--accent)/.7);outline-offset:2px}
code,.mono,pre{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.mono{font-size:.88em;overflow-wrap:anywhere}
code{font-size:.88em;color:rgb(var(--ink-1))}
.wrap{max-width:60rem;margin:0 auto;padding:0 16px}
header.top{position:sticky;top:0;z-index:2;background:rgb(var(--canvas)/.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid rgb(var(--line)/.08)}
header.top .wrap{display:flex;align-items:center;gap:12px;min-height:56px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;border:0;color:rgb(var(--ink-1))}
.mark{filter:drop-shadow(0 0 2px rgb(var(--accent)/.7)) drop-shadow(0 0 8px rgb(var(--accent)/.35));flex:none}
.wordmark{font-family:"JetBrains Mono",ui-monospace,monospace;font-weight:600;font-size:18px;letter-spacing:.01em}
.pills{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.pill{font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid rgb(var(--line)/.12);color:rgb(var(--ink-2));white-space:nowrap}
.pill-sol{border-color:rgb(var(--spine-green)/.4)}.pill-tempo{border-color:rgb(var(--spine-sky)/.4)}
main{padding:28px 0 56px}
.hero h1{font-size:28px;line-height:1.25;margin:6px 0 10px;letter-spacing:-.01em}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:rgb(var(--spine-sky));margin:0}
.eyebrow .id{text-transform:none;letter-spacing:0;font-family:"JetBrains Mono",monospace}
.lede{color:rgb(var(--ink-2));margin:0;max-width:46rem}
section{margin-top:36px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:rgb(var(--ink-2));margin:0 0 12px;display:flex;align-items:center;gap:10px}
h2 .num{font-family:"JetBrains Mono",monospace;color:rgb(var(--spine-sky))}
h2::after{content:"";flex:1;height:1px;background:rgb(var(--line)/.08)}
h3{font-size:16px;margin:0}
.card{background:rgb(var(--surface-1));border:1px solid rgb(var(--line)/.08);border-radius:12px;padding:18px}
.what{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.what li{display:grid;grid-template-columns:9rem 1fr;gap:12px;align-items:baseline}
.k{color:rgb(var(--ink-3));font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.muted{color:rgb(var(--ink-3))}
.small{font-size:13px}
strong{font-weight:600;color:rgb(var(--ink-1))}
.sep{color:rgb(var(--ink-3));padding:0 2px}
.spine{list-style:none;margin:0;padding:0 0 0 28px;position:relative}
.spine::before{content:"";position:absolute;left:8px;top:10px;bottom:10px;width:2px;border-radius:2px;
  background:linear-gradient(rgb(var(--spine-blue)),rgb(var(--spine-sky)) 55%,rgb(var(--spine-green)));box-shadow:0 0 12px rgb(var(--spine-sky)/.55)}
.spine-item{position:relative;background:rgb(var(--surface-1));border:1px solid rgb(var(--line)/.08);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.spine-item:last-child{margin-bottom:0}
.node{position:absolute;left:-19px;top:20px;transform:translateX(-50%);width:12px;height:12px;border-radius:999px;background:rgb(var(--canvas));border:2px solid rgb(var(--spine-green))}
.node-genesis{border-color:rgb(var(--spine-blue))}
.node-achieved{border-color:rgb(var(--spine-volt));background:rgb(var(--spine-volt));box-shadow:0 0 12px rgb(var(--spine-volt)/.8)}
.node-failed{border-color:rgb(var(--rose))}
.node-resolution{border-color:rgb(var(--spine-green));background:rgb(var(--spine-green))}
.step-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.badge{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:1px 8px;border-radius:999px;border:1px solid}
.badge-green{color:rgb(var(--spine-green));border-color:rgb(var(--spine-green)/.4)}
.badge-volt{color:rgb(var(--spine-volt));border-color:rgb(var(--spine-volt)/.5);box-shadow:0 0 10px rgb(var(--spine-volt)/.25)}
.badge-rose{color:rgb(var(--rose));border-color:rgb(var(--rose)/.4)}
.reason{margin:2px 0 8px;color:rgb(var(--rose)/.9);font-size:13px}
.rows{display:grid;grid-template-columns:7.5rem 1fr;gap:6px 14px;margin:8px 0 0}
.rows dt{color:rgb(var(--ink-3));font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding-top:2px}
.rows dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rows-wide{grid-template-columns:10rem 1fr;gap:10px 16px}
.calls{background:rgb(var(--surface-2));border:1px solid rgb(var(--line)/.06);border-radius:10px;padding:10px 12px;margin:6px 0 4px}
.calls p{margin:0 0 6px}
.call-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.call-list li{display:grid;grid-template-columns:3.25rem 1fr;gap:8px;font-size:14px;align-items:baseline}
.call-n{color:rgb(var(--ink-3));font-family:"JetBrains Mono",monospace;font-size:12px}
.call-pair{min-width:0}
.call-pair a{white-space:nowrap}
.tempo-fig{margin:8px 0 0!important;font-size:13px;color:rgb(var(--ink-2))}
.chip{display:inline-block;font-size:11px;font-family:"JetBrains Mono",monospace;padding:0 7px;border-radius:6px;background:rgb(var(--surface-3));color:rgb(var(--ink-2));margin-right:4px}
.chip-tempo{color:rgb(var(--spine-sky))}
.verdict{font-family:"JetBrains Mono",monospace;font-size:13px;padding:1px 8px;border-radius:6px;background:rgb(var(--surface-3));color:rgb(var(--spine-sky))}
.verdict-achieved{color:rgb(var(--canvas));background:rgb(var(--spine-volt));box-shadow:0 0 12px rgb(var(--spine-volt)/.6)}
details{margin-top:10px}
summary{cursor:pointer;color:rgb(var(--ink-3));font-size:13px}
summary:hover{color:rgb(var(--ink-2))}
.tx-list,.file-list{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px;font-size:14px}
.file-list{font-size:13px}
.one-line{margin:0;padding:14px 16px;background:rgb(var(--surface-1));border:1px solid rgb(var(--line)/.08);border-radius:12px;color:rgb(var(--ink-2))}
.note{margin:14px 0 0;color:rgb(var(--ink-2));font-size:14px}
.source{background:rgb(var(--surface-1));border:1px solid rgb(var(--line)/.08);border-radius:12px;padding:12px 16px;margin-top:10px}
.source-head{margin:0;overflow-wrap:anywhere}
.cmd{margin-top:14px}
.cmd-title{margin:0}
.cmd p{margin:2px 0 6px}
pre{margin:0;background:rgb(var(--surface-2));border:1px solid rgb(var(--line)/.08);border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:normal;word-break:normal;overflow-x:auto;color:rgb(var(--ink-1))}
pre code{font-size:inherit}
.unread{color:rgb(var(--ink-2));font-size:14px;padding-left:18px}
footer{border-top:1px solid rgb(var(--line)/.08);padding:22px 0 40px;color:rgb(var(--ink-3));font-size:13px}
footer .wrap{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
@media (max-width:640px){
  body{font-size:14.5px}
  .hero h1{font-size:23px}
  .what li{grid-template-columns:1fr;gap:2px}
  .rows,.rows-wide{grid-template-columns:1fr;gap:2px}
  .rows dd{margin-bottom:8px}
  .spine{padding-left:22px}
  .spine::before{left:5px}
  .node{left:-16px}
  .spine-item{padding:12px}
  .pills{margin-left:0}
}
`;

/** The page, whole: one file, nothing fetched but the two fonts. */
export function renderEvidencePage(e: Evidence): string {
  const name = e.agent.name || short(e.agent.id, 8, 6);
  const goalRecord = e.steps.at(-1)?.record;
  const goal = e.loop.goalHash
    ? goalRecord
      ? `${solTx(
          goalRecord.signature,
          short(e.loop.goalHash, 12, 8)
        )} <span class="muted">the goal's SHA-256, committed in every step's record</span>`
      : `${mono(short(e.loop.goalHash, 12, 8), e.loop.goalHash)} <span class="muted">the goal's SHA-256</span>`
    : `<span class="muted">no goal</span>`;
  const agentLink = e.agent.registration
    ? solTx(e.agent.registration.signature, name)
    : e.agent.authority
    ? solAddr(e.agent.authority, name)
    : esc(name);
  const stepsWord = `${e.loop.steps} ${e.loop.steps === 1 ? "step" : "steps"} of ${e.loop.maxSteps}`;
  const description =
    `What one Lath loop did, on public explorers: the agent ${name}'s records and charges on Solana devnet, ` +
    "its payments on Tempo mainnet, and the files it read on Irys.";
  const unread = e.unread.length
    ? `<section id="unread"><h2>What this page could not read</h2><ul class="unread">${e.unread
        .map((u) => `<li>${esc(u)}</li>`)
        .join("")}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lath run evidence</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;display=swap">
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="https://getlath.xyz" aria-label="Lath">${MARK_SVG(26)}<span class="wordmark">Lath</span></a>
  <span class="pills"><span class="pill pill-sol">Solana devnet</span><span class="pill pill-tempo">Tempo mainnet</span></span>
</div></header>
<main class="wrap">
  <section class="hero" style="margin-top:0">
    <p class="eyebrow">Run evidence · <span class="id">${esc(e.loop.id)}</span></p>
    <h1>One agent loop, end to end, on public explorers</h1>
    <p class="lede">The run in the film, as it is recorded outside Lath: a record per step and a debit per paid call on Solana devnet, the payments on Tempo mainnet, and the files the agent read on Irys. Every link opens explorer.solana.com, explore.tempo.xyz or gateway.irys.xyz, not a Lath server.</p>
  </section>

  <section id="what"><h2><span class="num">1</span> What happened</h2>
    <div class="card"><ul class="what">
      <li><span class="k">Agent and loop</span><span>${agentLink} <span class="muted">registered on Solana devnet</span> · ${mono(
    e.loop.id
  )} <span class="muted">started ${esc(utc(e.loop.createdAt))}</span></span></li>
      <li><span class="k">Goal</span><span>${goal}</span></li>
      <li><span class="k">Outcome</span><span>${outcomeLine(e)} ${esc(stepsWord)}. ${costLine(e)}.</span></li>
    </ul></div>
  </section>

  <section id="steps"><h2><span class="num">2</span> The loop, step by step</h2>
    <ol class="spine">
${startItem(e)}
${e.steps.map((s) => stepItem(s, e.loop.plainTraces === true)).join("\n")}
${afterStopItem(e)}
    </ol>
  </section>

  <section id="tempo"><h2><span class="num">3</span> Tempo mainnet</h2>
    <div class="card">${tempoSection(e)}</div>
  </section>

  <section id="receipt"><h2><span class="num">4</span> The receipt on SAS</h2>
    ${
      e.receipt && e.receipt.status === "published" ? `<div class="card">${receiptSection(e)}</div>` : receiptSection(e)
    }
  </section>

  <section id="files"><h2><span class="num">5</span> The files on Irys</h2>
    ${filesSection(e)}
  </section>

  <section id="check"><h2><span class="num">6</span> Check it yourself</h2>
    ${checkSection(e)}
  </section>
  ${unread}
</main>
<footer><div class="wrap">${MARK_SVG(18)}<span class="wordmark" style="font-size:14px">Lath</span><span>Generated ${esc(
    utc(Date.parse(e.generatedAt))
  )} from the console's open reads, Solana devnet, Tempo mainnet and Irys, read-only.</span></div></footer>
</body>
</html>
`;
}
