import { chromium } from "playwright";
import { appendFile } from "node:fs/promises";

const urls = process.argv.slice(2);

if (urls.length === 0) {
  console.error('Usage: node check-streaks-fast.mjs "<url1>" "<url2>" ...');
  process.exit(1);
}

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const RESULT_FILE = process.env.RESULT_FILE || "result.txt";
const DEBUG = process.env.DEBUG === "1";

const ERROR_RE =
  /見つかりません|存在しません|動画がありません|動画が存在しません|再生できません|視聴できません|権限|認証|期限切れ|期限|エラー|not found|not exist|unavailable|forbidden|unauthorized|permission|expired|invalid|error/i;

function compact(s, n = 180) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function writeResult(url, exists) {
  await appendFile(RESULT_FILE, `${url} ${exists ? "true" : "false"}\n`, "utf8");
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

      if (
        status >= 400 &&
        ["xhr", "fetch", "document"].includes(type) &&
        res.url().includes("players.streaks.jp")
      ) {
        badPlayerResponse = true;
      }

      if (
        [200, 206].includes(status) &&
        (
          type === "media" ||
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
        break;
      }

      if (badPlayerResponse) {
        result.verdict = "NOT_FOUND";
        result.reason = "bad player response";
        result.debug = sig;
        break;
      }

      if (mediaOk) {
        result.verdict = "EXISTS";
        result.reason = "media response detected";
        result.debug = sig;
        break;
      }

      if (sig.hasPlayableVideo) {
        result.verdict = "EXISTS";
        result.reason = "video metadata detected";
        result.debug = sig;
        break;
      }

      await page.waitForTimeout(150);
    }

    if (result.verdict === "UNKNOWN") {
      const sig = await getDomSignals(page);
      result.debug = sig;
      result.reason = `timeout ${TIMEOUT_MS}ms`;
    }

    result.title = await page.title().catch(() => "");
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
  const exists = r.verdict === "EXISTS";

  await writeResult(r.url, exists);

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
