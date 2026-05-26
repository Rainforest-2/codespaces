import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const inputUrl = process.argv[2];
const outputNameArg = process.argv[3];
const mode = process.argv[4] || "ts"; // ts or mp4

if (!inputUrl) {
  console.error("Usage:");
  console.error("  node download_hls_from_page.mjs <player_page_or_m3u8_url> [output_name] [ts|mp4]");
  console.error("");
  console.error("Examples:");
  console.error("  node download_hls_from_page.mjs 'https://players.streaks.jp/prod-sundai?m=xxxx' lecture02");
  console.error("  node download_hls_from_page.mjs 'https://vod-prod-sundai.streaks.jp/.../768198.m3u8' lecture02 ts");
  process.exit(1);
}

if (!["ts", "mp4"].includes(mode)) {
  console.error("mode must be ts or mp4");
  process.exit(1);
}

function log(...args) {
  console.log("[hls-auto]", ...args);
}

function safeName(value) {
  return String(value || "output")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "output";
}

function defaultNameFromUrl(url) {
  const u = new URL(url);
  const last = path.basename(u.pathname).replace(/\.m3u8$/i, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return safeName(last || `hls-${stamp}`);
}

function isM3u8Url(url) {
  return /\.m3u8(?:[?#].*)?$/i.test(url);
}

function pickBestM3u8(urls) {
  const unique = [...new Set(urls)];

  // media playlistっぽいものを優先。例: /768198.m3u8
  return (
    unique.find((u) => /\/\d+\.m3u8(?:[?#].*)?$/i.test(u)) ||
    unique.find((u) => !/manifest\.m3u8(?:[?#].*)?$/i.test(u)) ||
    unique.at(-1)
  );
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverM3u8FromPage(pageUrl) {
  log("open page:", pageUrl);

  const found = [];
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  page.on("response", async (response) => {
    const url = response.url();

    if (!isM3u8Url(url)) return;

    const status = response.status();

    if (status >= 200 && status < 400) {
      found.push(url);
      log("found m3u8:", status, url);
    }
  });

  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // プレイヤーによっては再生操作後にm3u8を取りに行く
  await wait(2000);

  try {
    await page.click(".vjs-large-play-button, .vjs-play-control, video", {
      timeout: 5000,
    });
    log("clicked play");
  } catch {
    log("play button click skipped");
  }

  try {
    await page.evaluate(() => {
      const v = document.querySelector("video");
      if (v) return v.play().catch(() => {});
    });
  } catch {
    // ignore
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const best = pickBestM3u8(found);
    if (best) {
      await browser.close();
      return best;
    }

    await wait(500);
  }

  await browser.close();

  throw new Error("m3u8 was not detected from page network. Confirm the page URL is playable in a browser.");
}

function runFfmpeg({ m3u8Url, outputPath, pageOrigin, mode }) {
  return new Promise((resolve, reject) => {
    const commonArgs = [
      "-hide_banner",
      "-y",
      "-stats",
      "-user_agent",
      "Mozilla/5.0",
      "-headers",
      `Referer: ${pageOrigin}/\r\nOrigin: ${pageOrigin}\r\n`,
      "-allowed_extensions",
      "ALL",
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
      "-i",
      m3u8Url,
      "-map",
      "0",
      "-c",
      "copy",
    ];

    const args =
      mode === "mp4"
        ? [...commonArgs, "-movflags", "+faststart", outputPath]
        : [...commonArgs, "-f", "mpegts", outputPath];

    log("ffmpeg", args.join(" "));

    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "inherit", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}\n${stderr}`));
      }
    });
  });
}

async function main() {
  await fs.mkdir("hls-output", { recursive: true });

  const isDirectM3u8 = isM3u8Url(inputUrl);
  const m3u8Url = isDirectM3u8 ? inputUrl : await discoverM3u8FromPage(inputUrl);

  const name = safeName(outputNameArg || defaultNameFromUrl(m3u8Url));
  const outputPath = path.join("hls-output", `${name}.${mode}`);

  const pageOrigin = isDirectM3u8
    ? "https://players.streaks.jp"
    : new URL(inputUrl).origin;

  log("selected m3u8:", m3u8Url);
  log("output:", outputPath);
  log("mode:", mode);

  await runFfmpeg({
    m3u8Url,
    outputPath,
    pageOrigin,
    mode,
  });

  log("created:", outputPath);

  await new Promise((resolve) => {
    const probe = spawn("ffprobe", ["-hide_banner", outputPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    probe.on("close", resolve);
  });
}

main().catch((err) => {
  console.error("[hls-auto] FAILED:", err.message);
  process.exit(1);
});
