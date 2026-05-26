import { chromium } from "playwright";

const urls = process.argv.slice(2);

if (urls.length === 0) {
  console.error("Usage:");
  console.error('  node check-streaks.mjs "https://players.streaks.jp/...m=ref:1521590"');
  process.exit(1);
}

const ERROR_RE = /見つかりません|存在しません|動画がありません|動画が存在しません|再生できません|視聴できません|権限|認証|期限|エラー|not found|not exist|unavailable|forbidden|unauthorized|permission|expired|error/i;

function compactText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function collectFrameTextAndSignals(page) {
  let allText = "";
  let videoCount = 0;
  let canvasCount = 0;
  let buttonText = "";

  for (const frame of page.frames()) {
    try {
      const body = await frame.locator("body").innerText({ timeout: 2000 });
      allText += "\n" + body;
    } catch {}

    try {
      videoCount += await frame.locator("video").count();
    } catch {}

    try {
      canvasCount += await frame.locator("canvas").count();
    } catch {}

    try {
      const buttons = await frame.locator("button, [role='button']").allInnerTexts({ timeout: 2000 });
      buttonText += "\n" + buttons.join("\n");
    } catch {}
  }

  return {
    text: compactText(allText),
    rawText: allText,
    videoCount,
    canvasCount,
    buttonText: compactText(buttonText),
  };
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=user-gesture-required",
    "--mute-audio",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
});

// 重い広告・画像・フォントだけ止める。XHR/fetch/script/mediaは止めない。
await context.route("**/*", async route => {
  const type = route.request().resourceType();
  if (["image", "font"].includes(type)) {
    return route.abort();
  }
  return route.continue();
});

for (const url of urls) {
  const page = await context.newPage();

  const result = {
    url,
    status: null,
    verdict: "UNKNOWN",
    reason: "",
    title: "",
    text: "",
  };

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    result.status = response ? response.status() : null;

    // プレイヤー側JSの描画待ち
    await page.waitForTimeout(10000);

    result.title = await page.title().catch(() => "");

    const signals = await collectFrameTextAndSignals(page);
    result.text = signals.text;

    if (!result.status || result.status >= 400) {
      result.verdict = "NOT_FOUND";
      result.reason = `HTTP ${result.status}`;
    } else if (ERROR_RE.test(signals.rawText)) {
      result.verdict = "NOT_FOUND";
      result.reason = "error text detected";
    } else if (signals.videoCount > 0) {
      result.verdict = "EXISTS";
      result.reason = `video element detected: ${signals.videoCount}`;
    } else if (/再生|play|pause/i.test(signals.buttonText)) {
      result.verdict = "EXISTS";
      result.reason = "player controls detected";
    } else if (signals.canvasCount > 0 && !ERROR_RE.test(signals.rawText)) {
      result.verdict = "EXISTS";
      result.reason = `canvas/player surface detected: ${signals.canvasCount}`;
    } else {
      result.verdict = "UNKNOWN";
      result.reason = "no explicit error, but no video/player signal detected";
    }
  } catch (e) {
    result.verdict = "NOT_FOUND";
    result.reason = `navigation failed: ${e.message}`;
  } finally {
    await page.close();
  }

  console.log([
    result.verdict,
    `status=${result.status}`,
    `reason=${result.reason}`,
    `title=${compactText(result.title)}`,
    `url=${result.url}`,
  ].join("\t"));
}

await browser.close();
