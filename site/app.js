// Renders the download page from releases.json (written at deploy time by
// scripts/build-site.mjs). Everything except GitHub's own sanitised release
// notes is inserted as text, never as HTML.

const OS_NAMES = { macos: "macOS", windows: "Windows", linux: "Linux" };
const OS_ORDER = ["macos", "windows", "linux"];

// ---- Seven-segment LCD ------------------------------------------------------

const SEGMENTS = {
  0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc",
  5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g",
};

function hSeg(x1, x2, y) {
  return `${x1},${y} ${x1 + 6},${y - 6} ${x2 - 6},${y - 6} ${x2},${y} ${x2 - 6},${y + 6} ${x1 + 6},${y + 6}`;
}
function vSeg(x, y1, y2) {
  return `${x},${y1} ${x + 6},${y1 + 6} ${x + 6},${y2 - 6} ${x},${y2} ${x - 6},${y2 - 6} ${x - 6},${y1 + 6}`;
}

const SEG_SHAPES = {
  a: hSeg(9, 55, 7),
  b: vSeg(57, 9, 54),
  c: vSeg(57, 56, 101),
  d: hSeg(9, 55, 103),
  e: vSeg(7, 56, 101),
  f: vSeg(7, 9, 54),
  g: hSeg(9, 55, 55),
};

const SVG_NS = "http://www.w3.org/2000/svg";
const DIGIT_W = 64;
const DIGIT_GAP = 22;

/** "1.10.2" → [{ch:"1",dot:true},{ch:"1"},{ch:"0",dot:true},{ch:"2"}] */
function toCells(text) {
  const cells = [];
  for (const ch of text) {
    if (ch === "." && cells.length) cells[cells.length - 1].dot = true;
    else cells.push({ ch, dot: false });
  }
  return cells;
}

function renderLcd(container, text, { allOn = false } = {}) {
  const cells = toCells(text);
  if (!allOn && cells.some((c) => !(c.ch in SEGMENTS))) {
    // Prerelease suffixes etc. don't fit on seven segments.
    container.replaceChildren(Object.assign(document.createElement("span"), {
      className: "lcd-text",
      textContent: text,
    }));
    return;
  }
  const width = cells.length * (DIGIT_W + DIGIT_GAP) - DIGIT_GAP + 14;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `-6 -2 ${width + 10} 114`);
  svg.setAttribute("aria-hidden", "true");
  cells.forEach((cell, i) => {
    const g = document.createElementNS(SVG_NS, "g");
    // A slight forward lean, like most panel-meter LCD glass.
    g.setAttribute("transform", `translate(${i * (DIGIT_W + DIGIT_GAP)} 0) skewX(-6)`);
    const lit = allOn ? SEGMENTS[8] : SEGMENTS[cell.ch];
    for (const [name, points] of Object.entries(SEG_SHAPES)) {
      const p = document.createElementNS(SVG_NS, "polygon");
      p.setAttribute("points", points);
      p.setAttribute("class", lit.includes(name) ? "seg on" : "seg");
      g.append(p);
    }
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(DIGIT_W + 6));
    dot.setAttribute("cy", "101");
    dot.setAttribute("r", "6");
    dot.setAttribute("class", allOn || cell.dot ? "seg on" : "seg");
    g.append(dot);
    svg.append(g);
  });
  container.replaceChildren(svg);
}

// ---- Helpers ---------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
}

function detectOs() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad/.test(ua)) return null;
  if (platform.includes("mac") || ua.includes("mac os")) return "macos";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return null;
}

async function detectMacArch() {
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues?.(["architecture"]);
    if (hints?.architecture === "x86") return "x64";
  } catch {
    /* not available outside Chromium */
  }
  // Most Macs in use are Apple Silicon; Intel is offered right under the button.
  return "arm64";
}

function pickPrimary(assets, os, macArch) {
  const mine = assets.filter((a) => a.os === os).sort((a, b) => a.rank - b.rank);
  if (os === "macos") {
    const dmgs = mine.filter((a) => a.kind === "dmg");
    return (
      dmgs.find((a) => a.arch === macArch) ||
      dmgs.find((a) => a.arch === "universal") ||
      dmgs[0] ||
      mine[0] ||
      null
    );
  }
  return mine[0] || null;
}

function fileList(assets) {
  return el(
    "ul",
    { className: "files" },
    ...assets.map((a) =>
      el(
        "li",
        {},
        el("a", { href: a.url, textContent: a.label }),
        el("span", { className: "size", textContent: formatSize(a.size) }),
      ),
    ),
  );
}

// ---- Sections --------------------------------------------------------------

async function renderPrimary(latest, data) {
  const box = document.getElementById("primary");
  const releasesUrl = `${data.repoUrl}/releases`;

  if (!latest) {
    box.replaceChildren(
      el("p", { className: "muted" }, "No stable release has been published yet. ",
        el("a", { href: releasesUrl, textContent: "See all releases on GitHub" }), "."),
    );
    return;
  }
  if (latest.assets.length === 0) {
    box.replaceChildren(
      el("p", { className: "muted" }, `Version ${latest.version} has no installers attached. `,
        el("a", { href: latest.url, textContent: "Open the release on GitHub" }), "."),
    );
    return;
  }

  const os = detectOs();
  const macArch = os === "macos" ? await detectMacArch() : null;
  const primary = os ? pickPrimary(latest.assets, os, macArch) : null;

  if (!primary) {
    box.replaceChildren(
      el("p", { className: "muted" }, "Pick the installer for your system under ",
        el("a", { href: "#downloads", textContent: "All downloads" }), "."),
    );
    return;
  }

  const button = el(
    "a",
    { className: "download-btn", href: primary.url },
    el("strong", { textContent: `Download for ${OS_NAMES[os]}` }),
    el("span", { textContent: `${primary.label}, ${formatSize(primary.size)}` }),
  );

  const alternatives = latest.assets.filter(
    (a) => a.os === os && a !== primary && (os !== "macos" || a.kind === "dmg"),
  );
  const alt = alternatives.length
    ? el(
        "p",
        { className: "alt-links" },
        "Also for ",
        OS_NAMES[os],
        ": ",
        ...alternatives.flatMap((a, i) => [
          i ? ", " : "",
          el("a", { href: a.url, textContent: a.label }),
        ]),
        ". ",
        el("a", { href: "#downloads", textContent: "Other systems" }),
      )
    : el("p", { className: "alt-links" }, el("a", { href: "#downloads", textContent: "Downloads for other systems" }));

  box.replaceChildren(button, alt);
}

function renderPlatforms(latest) {
  if (!latest || latest.assets.length === 0) return;
  const wrap = document.getElementById("platforms");
  wrap.replaceChildren(
    ...OS_ORDER.map((os) => {
      const assets = latest.assets.filter((a) => a.os === os);
      return el(
        "div",
        { className: "platform" },
        el("h3", { textContent: OS_NAMES[os] }),
        assets.length
          ? fileList(assets)
          : el("p", { className: "muted", textContent: "Not built for this release." }),
      );
    }),
  );
  document.getElementById("downloads-title").textContent = `All downloads for ${latest.version}`;
  document.getElementById("downloads").hidden = false;
}

function renderNotes(latest) {
  if (!latest || !latest.notesHtml) return;
  // body_html is rendered and sanitised by GitHub.
  document.getElementById("notes-body").innerHTML = latest.notesHtml;
  document.getElementById("notes-title").textContent = `What's new in ${latest.version}`;
  document.getElementById("notes").hidden = false;
}

function renderHistory(data) {
  if (data.releases.length === 0) return;
  const list = document.getElementById("history-list");
  list.replaceChildren(
    ...data.releases.map((r) => {
      const tags = [];
      if (r.tag === data.latestTag) tags.push(el("span", { className: "tag current", textContent: "Latest" }));
      if (r.prerelease) tags.push(el("span", { className: "tag", textContent: "Pre-release" }));

      const notes = el("div", { className: "prose" });
      if (r.notesHtml) notes.innerHTML = r.notesHtml;
      else notes.append(el("p", { className: "muted", textContent: "No release notes." }));

      return el(
        "li",
        {},
        el(
          "details",
          { open: r.tag === data.latestTag && data.releases.length === 1 },
          el(
            "summary",
            {},
            el("span", { className: "ver" }, r.version, ...tags),
            el("span", { className: "when", textContent: formatDate(r.publishedAt) }),
          ),
          el(
            "div",
            { className: "history-body" },
            notes,
            el(
              "div",
              {},
              el("h3", { textContent: "Files" }),
              r.assets.length
                ? fileList(r.assets.map((a) => ({ ...a, label: `${OS_NAMES[a.os] ?? "Other"}: ${a.label}` })))
                : el("p", { className: "muted", textContent: "No installers attached." }),
              el("p", {}, el("a", { href: r.url, textContent: "Release page on GitHub" })),
            ),
          ),
        ),
      );
    }),
  );
  document.getElementById("history").hidden = false;
}

// ---- Boot ------------------------------------------------------------------

async function main() {
  const lcd = document.getElementById("lcd");
  let data;
  try {
    const res = await fetch("releases.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    renderLcd(lcd, "----");
    document.getElementById("primary").replaceChildren(
      el("p", { className: "muted" }, "The release list didn't load. ",
        el("a", { href: "https://github.com/FireBolt922/ModbusOpen/releases", textContent: "Get ModbusOpen from GitHub Releases" }), "."),
    );
    return;
  }

  for (const id of ["link-source"]) document.getElementById(id).href = data.repoUrl;
  document.getElementById("link-contribute").href = `${data.repoUrl}/blob/main/CONTRIBUTING.md`;

  const latest = data.releases.find((r) => r.tag === data.latestTag) || null;
  const version = latest ? latest.version : "----";
  lcd.setAttribute("aria-label", latest ? `Latest stable version ${version}` : "No stable release yet");
  document.getElementById("meter-date").textContent = latest ? `Released ${formatDate(latest.publishedAt)}` : "";

  // Power-on segment test, like a real panel meter: every segment lights,
  // then the reading appears. Skipped when reduced motion is preferred.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && latest) {
    renderLcd(lcd, version, { allOn: true });
    setTimeout(() => renderLcd(lcd, version), 650);
  } else {
    renderLcd(lcd, version);
  }

  await renderPrimary(latest, data);
  renderPlatforms(latest);
  renderNotes(latest);
  renderHistory(data);

  if (data.generatedAt) {
    document.getElementById("generated").textContent = `Updated ${formatDate(data.generatedAt)}.`;
  }
}

main();
