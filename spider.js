const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

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

        if (postData) req.write(postData);
        req.end();
    });
}

async function calculateFastMd5(tsUrl) {
    try {
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
    if (depth > 4) return { segments: [], totalTsCount: 0 };
    try {
        const response = await httpRequest(m3u8Url, { timeout: 6000 });
        if (!response.ok) return { segments: [], totalTsCount: 0 };
        let m3u8Text = await response.text();
        if (!m3u8Text) return { segments: [], totalTsCount: 0 };

        m3u8Text = m3u8Text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = m3u8Text.split("\n");
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        let segments = [];
        let currentSegment = [];
        let totalTsCount = 0;
        let hasStreamInf = false;
        let nestedM3u8Urls = [];

        for (let line of lines) {
            line = line.trim().replace(/[\x00-\x1F]/g, "");
            if (!line) continue;

            if (line.startsWith("#")) {
                if (line.startsWith("#EXT-X-STREAM-INF")) {
                    hasStreamInf = true;
                } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                    if (currentSegment.length > 0) {
                        segments.push(currentSegment);
                        currentSegment = [];
                    }
                }
                continue;
            }

            if (line.includes(".m3u8")) {
                let cleanUrl = line;
                if (!cleanUrl.startsWith("http")) {
                    if (cleanUrl.startsWith("/")) {
                        cleanUrl = new URL(m3u8Url).origin + cleanUrl;
                    } else {
                        cleanUrl = baseUrl + cleanUrl;
                    }
                }
                nestedM3u8Urls.push(cleanUrl);
            } else if (line.includes(".ts") || line.includes(".png") || line.includes(".jpg") || line.includes(".jpeg") || line.includes(".image")) {
                let fullTsUrl = line.startsWith("http") ? line : (line.startsWith("/") ? new URL(m3u8Url).origin + line : baseUrl + line);
                currentSegment.push({ filename: line, url: fullTsUrl });
                totalTsCount++;
            }
        }

        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        if (nestedM3u8Urls.length > 0 && (totalTsCount === 0 || hasStreamInf || segments.length === 0)) {
            let targetNestedUrl = nestedM3u8Urls.find(u => u.includes("index.m3u8")) || nestedM3u8Urls[0];
            console.log(`      ➔ [M3U8 重定向] 下钻至: ${targetNestedUrl}`);
            return await fetchAndParseSegments(targetNestedUrl, depth + 1);
        }

        return { segments, totalTsCount };
    } catch (e) {
        return { segments: [], totalTsCount: 0 };
    }
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

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[同步开启] 开始扫描采集站: ${sourceName} (${sourceKey})`);
        console.log(`[目标接口]: ${baseApiUrl}`);

        const sourceCacheMap = new Map();

        const preloadUrl = `${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`;
        try {
            const res = await httpRequest(preloadUrl, { method: "GET", timeout: 6000 });
            if (res.ok) {
                const responseText = await res.text();
                const json = JSON.parse(responseText);
                if (json.success && json.md5_list) {
                    json.md5_list.forEach(md5 => sourceCacheMap.set(md5, "CLOUD_KNOWN_AD"));
                }
            }
        } catch (e) {}

        try {
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1`;
            const apiResponse = await httpRequest(targetUrl, { timeout: 8000 });
            if (!apiResponse.ok) continue;

            // ==========================================
            // 🔧 修复：安全解析 JSON，避免 apiResponse.json() 报错
            // ==========================================
            let apiData;
            try {
                const responseText = await apiResponse.text();
                if (!responseText || !responseText.trim()) {
                    console.log(`    ⚠️ [空响应] ${sourceName} 返回空内容，跳过`);
                    continue;
                }
                apiData = JSON.parse(responseText.trim());
            } catch (parseErr) {
                console.error(`  ❌ [JSON解析失败] ${sourceName}: ${parseErr.message}`);
                continue;
            }

            if (!apiData.list || apiData.list.length === 0) continue;

            const sliceLimit = 20;
            const actualCount = apiData.list.length > sliceLimit ? sliceLimit : apiData.list.length;
            console.log(`  📊 [数据就绪] 采集站实际返回 ${apiData.list.length} 条，硬截取前 ${actualCount} 部影片开启串行流水线洗涤...`);

            const adSegmentsToSubmit = [];

            for (const vod of apiData.list.slice(0, sliceLimit)) {
                const vodId = String(vod.vod_id).trim().replace(/\.0$/, "");
                const playUrlStr = vod.vod_play_url;
                if (!playUrlStr || !vodId) continue;

                console.log(`    🔍 [解析中] ID: ${vodId} | 名称: ${vod.vod_name}`);

                const playGroups = playUrlStr.split(/\${2,}/);
                let targetGroup = playGroups.find(group => group.includes(".m3u8")) || playGroups[0];
                const firstEpisode = targetGroup.split("#")[0];
                let m3u8Url = firstEpisode.includes("$") ? firstEpisode.split("$")[1] : firstEpisode;

                if (!m3u8Url || !m3u8Url.trim().startsWith("http") || !m3u8Url.includes(".m3u8")) continue;

                const { segments, totalTsCount } = await fetchAndParseSegments(m3u8Url.trim());
                if (!segments || segments.length === 0 || totalTsCount === 0) continue;

                if (segments.length < 2) {
                    console.log(`       ℹ️ [前置安全放行] 隔离区段数为 ${segments.length}，证明未被插播切刀，判定全片纯净。`);
                    continue;
                }

                console.log(`       📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

                let localVodAdCount = 0;

                const segmentFingerprints = [];

                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length === 0 || seg.length > AD_SEGMENT_MAX_COUNT) continue;

                    const firstTsUrl = seg[0].url;
                    const lastTsUrl = seg[seg.length - 1].url;

                    const [firstMd5, lastMd5] = await Promise.all([
                        calculateFastMd5(firstTsUrl),
                        calculateFastMd5(lastTsUrl)
                    ]);

                    if (firstMd5) seg[0].fastMd5 = firstMd5;
                    if (lastMd5) seg[seg.length - 1].fastMd5 = lastMd5;

                    segmentFingerprints.push({
                        index: i,
                        firstMd5,
                        lastMd5,
                        length: seg.length,
                        segment: seg
                    });
                }

                const md5Frequency = {};
                const md5ToSegments = {};

                for (const fp of segmentFingerprints) {
                    if (fp.firstMd5) {
                        md5Frequency[fp.firstMd5] = (md5Frequency[fp.firstMd5] || 0) + 1;
                        if (!md5ToSegments[fp.firstMd5]) md5ToSegments[fp.firstMd5] = [];
                        md5ToSegments[fp.firstMd5].push(fp.index);
                    }
                    if (fp.lastMd5) {
                        md5Frequency[fp.lastMd5] = (md5Frequency[fp.lastMd5] || 0) + 1;
                        if (!md5ToSegments[fp.lastMd5]) md5ToSegments[fp.lastMd5] = [];
                        md5ToSegments[fp.lastMd5].push(fp.index);
                    }
                }

                const selfIntersectAdIndices = new Set();
                for (const [md5, count] of Object.entries(md5Frequency)) {
                    if (count >= 2) {
                        for (const segIdx of md5ToSegments[md5]) {
                            selfIntersectAdIndices.add(segIdx);
                        }
                    }
                }

                for (const fp of segmentFingerprints) {
                    const i = fp.index;
                    const currentSeg = fp.segment;
                    const firstMd5 = fp.firstMd5;
                    const lastMd5 = fp.lastMd5;

                    let isAdSegment = false;
                    let hitReason = "";

                    if (selfIntersectAdIndices.has(i)) {
                        isAdSegment = true;
                        hitReason = `片内多个不同位置插播了相同广告段（首尾自交成功）`;
                    } else if ((firstMd5 && sourceCacheMap.has(firstMd5)) || (lastMd5 && sourceCacheMap.has(lastMd5))) {
                        let matchedMd5 = firstMd5 && sourceCacheMap.has(firstMd5) ? firstMd5 : lastMd5;
                        let mappedValue = sourceCacheMap.get(matchedMd5);
                        if (mappedValue === "CLOUD_KNOWN_AD") {
                            isAdSegment = true;
                            hitReason = `直接命中云端既有历史广告库特征`;
                        } else if (mappedValue !== vodId) {
                            isAdSegment = true;
                            hitReason = `跨影片特征大碰撞（关联片 VOD_ID: ${mappedValue}）`;
                        }
                    }

                    if (isAdSegment) {
                        localVodAdCount += currentSeg.length;
                        console.log(`      🔥 [确认广告] 区段 [序号:${i + 1}] (共 ${currentSeg.length} 片) -> 原因: ${hitReason}`);

                        for (const tsItem of currentSeg) {
                            if (!tsItem.fastMd5) tsItem.fastMd5 = await calculateFastMd5(tsItem.url);
                            if (tsItem.fastMd5) {
                                adSegmentsToSubmit.push({
                                    vod_id: vodId,
                                    fast_md5: tsItem.fastMd5,
                                    ts_filename: tsItem.url
                                });
                            }
                        }
                    } else {
                        if (firstMd5) sourceCacheMap.set(firstMd5, vodId);
                        if (lastMd5) sourceCacheMap.set(lastMd5, vodId);
                    }
                }

                if (localVodAdCount > 0) {
                    console.log(`      🎉 [清洗完毕] 本片共定性并打包广告切片: ${localVodAdCount} 个。`);
                } else {
                    console.log(`      ℹ️ [清洗完毕] 本片未触发自交或撞衫，无指纹溢出。`);
                }
            }

            if (adSegmentsToSubmit.length > 0) {
                console.log(`  🚀 [同步上传] 正在推送本轮扫描到的 ${adSegmentsToSubmit.length} 条真实广告特征至 D1 库...`);
                try {
                    const headers = { "Content-Type": "application/json" };
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
                        console.log(`  ✅ [同步成功] 存储层持久化完毕。`);
                    }
                } catch (uploadErr) {}
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log("\n🎉 管道清洗结束，新逻辑流完美闭环！");
}

start();