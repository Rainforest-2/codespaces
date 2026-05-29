import { chromium } from "playwright";
import { appendFile, readFile } from "node:fs/promises";

const inputUrls = process.argv.slice(2);

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const RESULT_FILE = process.env.RESULT_FILE || "heads-true.txt";
const RESULT_FALSE_FILE = process.env.RESULT_FALSE_FILE || "heads-false.txt";
const DEBUG = process.env.DEBUG === "1";

const ERROR_RE =
  /対象が存在しません|対象がありません|存在しません|見つかりません|動画がありません|動画が存在しません|再生できません|視聴できません|権限|認証|期限切れ|期限|エラー|not found|not exist|unavailable|forbidden|unauthorized|permission|expired|invalid|error/i;

function compact(s, n = 180) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function readSearchedUrls() {
  const set = new Set();

  for (const file of [RESULT_FILE, RESULT_FALSE_FILE]) {
    try {
      const text = await readFile(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const url = line.trim().split(/\s+/)[0];
        if (url) set.add(url);
      }
    } catch {}
  }

  return set;
}

async function writeResult(url, verdict) {
  if (verdict === "EXISTS") {
    await appendFile(RESULT_FILE, `${url}\n`, "utf8");
  } else if (verdict === "NOT_FOUND") {
    await appendFile(RESULT_FALSE_FILE, `${url}\n`, "utf8");
  }
}

async function getDomSignals(page) {
  let text = "";
  let videos = [];

  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const videos = [...document.querySelectorAll("video")].map(v => ({
          src: v.getAttribute("src") || "",
          currentSrc: v.currentSrc || "",
          readyState: v.readyState,
          networkState: v.networkState,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          errorCode: v.error ? v.error.code : null,
          sourceCount: v.querySelectorAll("source").length,
        }));
        return { bodyText, videos };
      });

      text += "\n" + data.bodyText;
      videos.push(...data.videos);
    } catch {}
  }

  const hasPlayableVideo = videos.some(v => {
    if (v.errorCode) return false;

    const hasSource =
      Boolean(v.src) ||
      Boolean(v.currentSrc) ||
      v.sourceCount > 0;

    const hasMetadata =
      v.readyState >= 1 ||
      (typeof v.duration === "number" && v.duration > 0);

    return hasSource && hasMetadata;
  });

  return {
    text,
    hasErrorText: ERROR_RE.test(text),
    hasPlayableVideo,
    videos,
  };
}

async function checkOne(context, url) {
  const page = await context.newPage();

  let mediaOk = false;
  let badPlayerResponse = false;

  page.on("response", async res => {
    try {
      const req = res.request();
      const type = req.resourceType();
      const status = res.status();
      const headers = res.headers();
      const contentType = headers["content-type"] || "";
      const resUrl = res.url();

      if (
        status >= 400 &&
        ["xhr", "fetch", "document"].includes(type) &&
        resUrl.includes("players.streaks.jp")
      ) {
        badPlayerResponse = true;
      }

      if (
        [200, 206].includes(status) &&
        (
          type === "media" ||
          /\.m3u8(\?|$)|\.ts(\?|$)|\.mp4(\?|$)/i.test(resUrl) ||
          /video|audio|mpegurl|mp2t|mp4|octet-stream/i.test(contentType)
        )
      ) {
        mediaOk = true;
      }
    } catch {}
  });

  const result = {
    url,
    status: null,
    verdict: "UNKNOWN",
    reason: "",
    title: "",
    debug: null,
  };

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });

    result.status = response?.status() ?? null;

    if (!result.status || result.status >= 400) {
      result.verdict = "NOT_FOUND";
      result.reason = `HTTP ${result.status}`;
      return result;
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const sig = await getDomSignals(page);

      if (sig.hasErrorText) {
        result.verdict = "NOT_FOUND";
        result.reason = "error text detected";
        result.debug = sig;
        return result;
      }

      if (badPlayerResponse) {
        result.verdict = "NOT_FOUND";
        result.reason = "bad player response";
        result.debug = sig;
        return result;
      }

      if (mediaOk) {
        result.verdict = "EXISTS";
        result.reason = "media response detected";
        result.debug = sig;
        return result;
      }

      if (sig.hasPlayableVideo) {
        result.verdict = "EXISTS";
        result.reason = "video metadata detected";
        result.debug = sig;
        return result;
      }

      await page.waitForTimeout(80);
    }

    const sig = await getDomSignals(page);
    result.debug = sig;
    result.reason = `timeout ${TIMEOUT_MS}ms`;
    return result;
  } catch (e) {
    result.verdict = "UNKNOWN";
    result.reason = compact(e.message);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool(items, workerCount, fn) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workerCount, items.length) }, worker)
  );
}

if (inputUrls.length === 0) {
  console.error('Usage: node check-streaks-fast.mjs "<url1>" "<url2>" ...');
  process.exit(1);
}

const searched = await readSearchedUrls();
const seenNow = new Set();

const urls = inputUrls.filter(url => {
  if (searched.has(url)) {
    console.log(`${url} skipped`);
    return false;
  }

  if (seenNow.has(url)) {
    console.log(`${url} skipped`);
    return false;
  }

  seenNow.add(url);
  return true;
});

if (urls.length === 0) {
  process.exit(0);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--mute-audio",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--no-sandbox",
  ],
});

const context = await browser.newContext({
  viewport: { width: 960, height: 540 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
});

await context.route("**/*", async route => {
  const req = route.request();
  const type = req.resourceType();
  const host = new URL(req.url()).hostname;

  if (["image", "font"].includes(type)) {
    return route.abort();
  }

  if (
    host.includes("googletagmanager") ||
    host.includes("google-analytics") ||
    host.includes("doubleclick") ||
    host.includes("facebook") ||
    host.includes("tiktok") ||
    host.includes("yimg") ||
    host.includes("clarity") ||
    host.includes("criteo") ||
    host.includes("microad") ||
    host.includes("fout")
  ) {
    return route.abort();
  }

  return route.continue();
});

await runPool(urls, CONCURRENCY, async url => {
  const r = await checkOne(context, url);

  await writeResult(r.url, r.verdict);

  const exists = r.verdict === "EXISTS";
  console.log(`${r.url} ${exists ? "true" : "false"}`);

  if (DEBUG) {
    console.error(
      [
        `verdict=${r.verdict}`,
        `status=${r.status}`,
        `reason=${r.reason}`,
        `title=${compact(r.title)}`,
        `url=${r.url}`,
      ].join("\t")
    );

    if (r.debug) {
      console.error(JSON.stringify({
        url: r.url,
        text: compact(r.debug.text, 500),
        videos: r.debug.videos,
      }, null, 2));
    }
  }
});

await browser.close();
