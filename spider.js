const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
};
const AD_SEGMENT_MAX_COUNT = 20;

const WORKER_BASE_URL = process.env.WORKER_BASE_URL;
const SPIDER_TOKEN = process.env.SPIDER_TOKEN || "";

if (!WORKER_BASE_URL) {
    console.error("Missing WORKER_BASE_URL environment variable.");
    process.exit(1);
}

async function calculateFastMd5(tsUrl) {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(tsUrl, { headers: { ...BROWSER_HEADERS, Range: "bytes=0-20480" }, signal: controller.signal });
        clearTimeout(id);
        if (!response.ok && response.status !== 206) return null;
        const buffer = await response.arrayBuffer();
        return buffer.byteLength > 0 ? crypto.createHash("md5").update(Buffer.from(buffer)).digest("hex") : null;
    } catch {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(tsUrl, { headers: BROWSER_HEADERS, signal: controller.signal });
            clearTimeout(id);
            if (!response.ok) return null;
            const reader = response.body.getReader();
            const { value } = await reader.read();
            reader.cancel();
            return value ? crypto.createHash("md5").update(Buffer.from(value.buffer)).digest("hex") : null;
        } catch {
            return null;
        }
    }
}

async function fetchAndParseSegments(m3u8Url, depth = 0) {
    if (depth > 3) return [];
    try {
        const response = await fetch(m3u8Url, { headers: BROWSER_HEADERS });
        if (!response.ok) return [];
        const m3u8Text = await response.text();
        const lines = m3u8Text.split("\n");
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        let segments = [];
        let currentSegment = [];
        let nestedM3u8Url = "";

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            if (line.startsWith("#")) {
                if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                    if (currentSegment.length > 0) { segments.push(currentSegment); currentSegment = []; }
                } else if (line.includes(".m3u8") && !line.startsWith("#EXT-X-STREAM-INF")) {
                    const match = line.match(/https?:\/\/[^\s"]+/);
                    if (match) nestedM3u8Url = match[0];
                }
                continue;
            }
            if (line.includes(".m3u8")) { nestedM3u8Url = line; break; }
            if (line.includes(".ts") || line.includes(".png") || line.includes(".jpg") || line.includes(".jpeg")) {
                let fullTsUrl = line.startsWith("http") ? line : (line.startsWith("/") ? new URL(m3u8Url).origin + line : baseUrl + line);
                currentSegment.push({ filename: line, url: fullTsUrl });
            }
        }
        if (currentSegment.length > 0) segments.push(currentSegment);
        return (nestedM3u8Url && segments.length === 0) ? await fetchAndParseSegments(nestedM3u8Url.startsWith("http") ? nestedM3u8Url : baseUrl + nestedM3u8Url, depth + 1) : segments;
    } catch { return []; }
}

async function start() {
    console.log("🚀 GitHub Actions 纯内存状态机爬虫启动...");

    // 📂 🎯 核心修改：直接从同级目录读取 tv-demo.json 配置文件
    let configData;
    try {
        const configPath = path.join(__dirname, "tv-demo.json");
        console.log(`📂 正在从本地加载源配置: ${configPath}`);
        const rawConfig = fs.readFileSync(configPath, "utf-8");
        configData = JSON.parse(rawConfig);
    } catch (err) {
        console.error(`❌ 读取本地 tv-demo.json 失败: ${err.message}`);
        process.exit(1);
    }

    const apiSite = configData.api_site;
    if (!apiSite) {
        console.error("❌ 配置文件中缺失 'api_site' 节点");
        return;
    }

    // 🧠 创建一个全局的内存状态机 Map: key 是 md5, value 是 vod_id
    const memoryTempMap = new Map();

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[扫描目标] 采集站: ${sourceName} (${sourceKey})`);

        // 💡 妙招：虽然不用临时表，但我们可以把 D1 里【已经确定是广告的规则】拉下来放进内存
        try {
            const res = await fetch(`${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`);
            if (res.ok) {
                const json = await res.json();
                if (json.success && json.md5_list) {
                    json.md5_list.forEach(md5 => memoryTempMap.set(md5, "KNOWN_AD_RULE"));
                    console.log(`  ℹ️ 已成功预载 ${json.md5_list.length} 条既有广告规则到内存比对库`);
                }
            }
        } catch (e) {
            console.warn(`  ⚠️ 预载既有规则失败，但不影响本次内存碰撞: ${e.message}`);
        }

        try {
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1&pagesize=5`;
            const apiResponse = await fetch(targetUrl, { headers: BROWSER_HEADERS });
            if (!apiResponse.ok) continue;

            const apiData = await apiResponse.json();
            if (!apiData.list || apiData.list.length === 0) continue;

            const adSegmentsToSubmit = [];

            for (const vod of apiData.list.slice(0, 5)) {
                const vodId = String(vod.vod_id).trim().replace(/\.0$/, "");
                const playUrlStr = vod.vod_play_url;
                if (!playUrlStr || !vodId) continue;

                const playGroups = playUrlStr.split(/\${2,}/);
                let targetGroup = playGroups.find(group => group.includes(".m3u8")) || playGroups[0];
                const firstEpisode = targetGroup.split("#")[0];
                let m3u8Url = firstEpisode.includes("$") ? firstEpisode.split("$")[1] : firstEpisode;

                if (!m3u8Url || !m3u8Url.trim().startsWith("http") || !m3u8Url.includes(".m3u8")) continue;

                const segments = await fetchAndParseSegments(m3u8Url.trim());
                if (segments.length < 2) {
                    console.log(`  🟩 [直通正片] ID: ${vodId} | ${vod.vod_name} -> 无不连续度标记，跳过。`);
                    continue;
                }

                console.log(`  🔍 [扫描分析] ID: ${vodId} | 名称: ${vod.vod_name} (发现隔离区段: ${segments.length})`);

                // 1. 测绘首片指纹
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
                        seg[0].fastMd5 = await calculateFastMd5(seg[0].url);
                    }
                }

                // 2. 片内不连续段相互交尾统计
                const internalMd5Counts = {};
                segments.forEach(seg => {
                    const firstMd5 = seg[0]?.fastMd5;
                    if (firstMd5) internalMd5Counts[firstMd5] = (internalMd5Counts[firstMd5] || 0) + 1;
                });

                // 3. 多轨碰撞
                for (let i = 0; i < segments.length; i++) {
                    const currentSeg = segments[i];
                    if (currentSeg.length === 0 || currentSeg.length > AD_SEGMENT_MAX_COUNT) continue;

                    const firstMd5 = currentSeg[0]?.fastMd5;
                    if (!firstMd5) continue;

                    let isAdSegment = false;
                    let hitReason = "";

                    if (internalMd5Counts[firstMd5] >= 2) {
                        isAdSegment = true;
                        hitReason = `片内不连续段间自交成功`;
                    } else if (memoryTempMap.has(firstMd5)) {
                        const mappedValue = memoryTempMap.get(firstMd5);
                        if (mappedValue === "KNOWN_AD_RULE") {
                            isAdSegment = true;
                            hitReason = `直接命中既有历史广告库特征`;
                        } else if (mappedValue !== vodId) {
                            isAdSegment = true;
                            hitReason = `跨影片特征内存大碰撞 (关联片ID: ${mappedValue})`;
                        }
                    }

                    if (isAdSegment) {
                        console.log(`    🔥 [判定广告] 区段序号 ${i+1} 原因: ${hitReason}`);
                        for (const tsItem of currentSeg) {
                            if (!tsItem.fastMd5) tsItem.fastMd5 = await calculateFastMd5(tsItem.url);
                            if (tsItem.fastMd5) {
                                adSegmentsToSubmit.push({ vod_id: vodId, fast_md5: tsItem.fastMd5, ts_filename: tsItem.url });
                            }
                        }
                    } else {
                        // 纯粹留在当前 Actions 的全局内存 Map 里，供下一部影片做跨片引信
                        memoryTempMap.set(firstMd5, vodId);
                    }
                }
            }

            // 提交确定好的广告切片
            if (adSegmentsToSubmit.length > 0) {
                console.log(`  🚀 [同步上传] 推送 ${adSegmentsToSubmit.length} 条真实广告特征至 D1...`);
                await fetch(`${WORKER_BASE_URL}/api/submit-ad-segments?token=${SPIDER_TOKEN}`, {
                    method: "POST",
                    body: JSON.stringify({
                        source_key: sourceKey,
                        source_name: sourceName,
                        ad_segments: adSegmentsToSubmit
                    })
                });
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log("\n🎉 管道清洗结束，D1 军火库中只沉淀了 100% 纯净的广告指纹数据！");
}

start();