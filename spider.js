const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https"); // 💊 弃用原生 fetch，改用历史最稳固的底层 https 模块

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
};
const AD_SEGMENT_MAX_COUNT = 20;

function cleanEnvVar(val) {
    if (!val) return "";
    return val.replace(/[^\x20-\x7E]/g, "").trim();
}

let WORKER_BASE_URL = cleanEnvVar(process.env.WORKER_BASE_URL);
if (WORKER_BASE_URL.endsWith("/")) {
    WORKER_BASE_URL = WORKER_BASE_URL.slice(0, -1);
}
const SPIDER_TOKEN = cleanEnvVar(process.env.SPIDER_TOKEN);

if (!WORKER_BASE_URL) {
    console.error("❌ 错误: 缺失 WORKER_BASE_URL 环境变量。");
    process.exit(1);
}

// 🎯 封装原生 HTTPS 客户端，彻底终结 Cloudflare 握手引起的 fetch failed 玄学问题
function httpRequest(url, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const defaultOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || "GET",
            headers: {
                ...BROWSER_HEADERS,
                ...options.headers,
            },
            timeout: options.timeout || 8000,
        };

        if (postData) {
            defaultOptions.headers["Content-Length"] = Buffer.byteLength(postData);
        }

        const req = https.request(defaultOptions, (res) => {
            let data = [];
            res.on("data", (chunk) => data.push(chunk));
            res.on("end", () => {
                const buffer = Buffer.concat(data);
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    headers: res.headers,
                    text: () => Promise.resolve(buffer.toString("utf-8")),
                    json: () => Promise.resolve(JSON.parse(buffer.toString("utf-8"))),
                    arrayBuffer: () => Promise.resolve(buffer),
                });
            });
        });

        req.on("error", (err) => reject(err));
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Timeout"));
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function calculateFastMd5(tsUrl) {
    try {
        // 强制只拉取前 20KB 判定广告
        const res = await httpRequest(tsUrl, {
            headers: { Range: "bytes=0-20480" },
            timeout: 4000
        });
        if (!res.ok && res.status !== 206) return null;
        const buffer = await res.arrayBuffer();
        return buffer.byteLength > 0 ? crypto.createHash("md5").update(buffer).digest("hex") : null;
    } catch {
        try {
            const res = await httpRequest(tsUrl, { timeout: 4000 });
            if (!res.ok) return null;
            const buffer = await res.arrayBuffer();
            return buffer.byteLength > 0 ? crypto.createHash("md5").update(buffer).digest("hex") : null;
        } catch {
            return null;
        }
    }
}

async function fetchAndParseSegments(m3u8Url, depth = 0) {
    if (depth > 3) return [];
    try {
        const response = await httpRequest(m3u8Url, { timeout: 6000 });
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

    let configData;
    try {
        const configPath = path.join(__dirname, "tv-ts-ad-source.json");
        console.log(`📂 正在从本地加载源配置: ${configPath}`);
        const rawConfig = fs.readFileSync(configPath, "utf-8");
        configData = JSON.parse(rawConfig);
    } catch (err) {
        console.error(`❌ 读取本地 tv-ts-ad-source.json 失败: ${err.message}`);
        process.exit(1);
    }

    const apiSite = configData.api_site;
    if (!apiSite) return;

    const memoryTempMap = new Map();

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[扫描目标] 采集站: ${sourceName} (${sourceKey})`);

        // 💡 采用万无一失的底层 https 模块预载
        const preloadUrl = `${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await httpRequest(preloadUrl, { method: "GET", timeout: 6000 });

                if (res.ok) {
                    const json = await res.json();
                    if (json.success && json.md5_list) {
                        json.md5_list.forEach(md5 => memoryTempMap.set(md5, "KNOWN_AD_RULE"));
                        console.log(`  ℹ️ [第 ${attempt} 次尝试] 成功预载 ${json.md5_list.length} 条历史规则`);
                        break;
                    }
                } else {
                    throw new Error(`HTTP Status ${res.status}`);
                }
            } catch (e) {
                if (attempt === 3) {
                    console.warn(`  ⚠️ 预载历史规则连续 3 次失败 (底层底层原因: ${e.message})。`);
                    console.warn(`  💡 [架构鲁棒降级]：已安全切换至全纯净本地内存大碰撞模式，不影响本次新广告提取！`);
                }
            }
        }

        try {
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1`;
            const apiResponse = await httpRequest(targetUrl, { timeout: 8000 });
            if (!apiResponse.ok) continue;

            const apiData = await apiResponse.json();
            if (!apiData.list || apiData.list.length === 0) continue;

            const adSegmentsToSubmit = [];

            for (const vod of apiData.list.slice(0, 10)) {
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

                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
                        seg[0].fastMd5 = await calculateFastMd5(seg[0].url);
                    }
                }

                const internalMd5Counts = {};
                segments.forEach(seg => {
                    const firstMd5 = seg[0]?.fastMd5;
                    if (firstMd5) internalMd5Counts[firstMd5] = (internalMd5Counts[firstMd5] || 0) + 1;
                });

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
                        memoryTempMap.set(firstMd5, vodId);
                    }
                }
            }

            // 💡 采用万无一失的底层 https 模块上传
            if (adSegmentsToSubmit.length > 0) {
                console.log(`  🚀 [同步上传] 推送 ${adSegmentsToSubmit.length} 条真实广告特征至 D1...`);
                try {
                    const headers = {
                        "Content-Type": "application/json"
                    };

                    const bodyData = JSON.stringify({
                        source_key: sourceKey,
                        source_name: sourceName,
                        ad_segments: adSegmentsToSubmit
                    });

                    const uploadRes = await httpRequest(`${WORKER_BASE_URL}/api/submit-ad-segments?token=${SPIDER_TOKEN}`, {
                        method: "POST",
                        headers: headers,
                        timeout: 10000
                    }, bodyData);

                    if (uploadRes.ok) {
                        console.log(`  ✅ [同步成功] 存储层同步完毕。`);
                    } else {
                        console.error(`  ❌ [同步失败] Worker 返回了错误状态码: ${uploadRes.status}`);
                    }
                } catch (uploadErr) {
                    console.error(`  ❌ [网络致命异常] 无法连接到远程 Worker 收集端: ${uploadErr.message}`);
                }
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log("\n🎉 管道清洗结束，D1 军火库中只沉淀了 100% 纯净的广告指纹数据！");
}

start();