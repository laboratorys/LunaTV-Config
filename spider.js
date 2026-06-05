const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
};
const AD_SEGMENT_MAX_COUNT = 20; // 广告段的 ts 数量上限排除依据

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

// 基础 HTTPS 客户端驱动
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

// 高精指纹抓取器
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

/**
 * 🎯 递归拆解多码率并提取区段
 * 返回按 #EXT-X-DISCONTINUITY 切分的区段数组
 */
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

            // 非注释行
            if (line.includes(".m3u8")) {
                // 收集所有嵌套 m3u8，优先选择包含 index.m3u8 的（通常是最高质量或默认）
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

        // 检测到多码率特征，需要下钻
        if (nestedM3u8Urls.length > 0 && (totalTsCount === 0 || hasStreamInf || segments.length === 0)) {
            // 优先选择 index.m3u8，没有则选第一个
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

        // 每个源独立的内存缓存池：MD5 -> 来源标识（vodId 或 "CLOUD_KNOWN_AD"）
        const sourceCacheMap = new Map();

        // 预载云端既有规则作为引信
        const preloadUrl = `${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`;
        try {
            const res = await httpRequest(preloadUrl, { method: "GET", timeout: 6000 });
            if (res.ok) {
                const json = await res.json();
                if (json.success && json.md5_list) {
                    json.md5_list.forEach(md5 => sourceCacheMap.set(md5, "CLOUD_KNOWN_AD"));
                }
            }
        } catch (e) {}

        try {
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1`;
            const apiResponse = await httpRequest(targetUrl, { timeout: 8000 });
            if (!apiResponse.ok) continue;

            const apiData = await apiResponse.json();
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

                // 下钻抓取并切分区段
                const { segments, totalTsCount } = await fetchAndParseSegments(m3u8Url.trim());
                if (!segments || segments.length === 0 || totalTsCount === 0) continue;

                // 🚨 逻辑点：如果区段数量小于 2，直接认为整流无广告，秒级熔断跳过
                if (segments.length < 2) {
                    console.log(`       ℹ️ [前置安全放行] 隔离区段数为 ${segments.length}，证明未被插播切刀，判定全片纯净。`);
                    continue;
                }

                console.log(`       📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

                let localVodAdCount = 0;

                // ============================================================
                // 第一步：为每个区段计算首尾 TS 的 fast-md5
                // ============================================================
                const segmentFingerprints = []; // { index, firstMd5, lastMd5, length, segment }

                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];

                    // 严格执行：如果切片数量超过 20，直接作为排除依据，不判定为广告
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

                // ============================================================
                // 第二步：片内自交检测
                // 统计所有区段的首尾 MD5 出现频率，如果有重复，则对应区段是广告
                // ============================================================
                const md5Frequency = {}; // md5 -> 出现次数
                const md5ToSegments = {}; // md5 -> [segmentIndex]

                for (const fp of segmentFingerprints) {
                    // 首 MD5
                    if (fp.firstMd5) {
                        md5Frequency[fp.firstMd5] = (md5Frequency[fp.firstMd5] || 0) + 1;
                        if (!md5ToSegments[fp.firstMd5]) md5ToSegments[fp.firstMd5] = [];
                        md5ToSegments[fp.firstMd5].push(fp.index);
                    }
                    // 尾 MD5
                    if (fp.lastMd5) {
                        md5Frequency[fp.lastMd5] = (md5Frequency[fp.lastMd5] || 0) + 1;
                        if (!md5ToSegments[fp.lastMd5]) md5ToSegments[fp.lastMd5] = [];
                        md5ToSegments[fp.lastMd5].push(fp.index);
                    }
                }

                // 找出所有涉及重复 MD5 的区段索引
                const selfIntersectAdIndices = new Set();
                for (const [md5, count] of Object.entries(md5Frequency)) {
                    if (count >= 2) {
                        // 这个 MD5 在多个区段的首尾出现了，所有涉及的区段都是广告
                        for (const segIdx of md5ToSegments[md5]) {
                            selfIntersectAdIndices.add(segIdx);
                        }
                    }
                }

                // ============================================================
                // 第三步：回溯区段，开始定性收网
                // ============================================================
                for (const fp of segmentFingerprints) {
                    const i = fp.index;
                    const currentSeg = fp.segment;
                    const firstMd5 = fp.firstMd5;
                    const lastMd5 = fp.lastMd5;

                    let isAdSegment = false;
                    let hitReason = "";

                    // 🚨 逻辑点 3：片内自交检测
                    // 如果该区段的首或尾 MD5 在本片内其他区段也出现过，则坐实广告
                    if (selfIntersectAdIndices.has(i)) {
                        isAdSegment = true;
                        hitReason = `片内多个不同位置插播了相同广告段（首尾自交成功）`;
                    }
                        // 🚨 逻辑点 4：跨影片撞衫检测
                    // 如果自交未触发，检查首尾 MD5 是否在缓存池中
                    else if ((firstMd5 && sourceCacheMap.has(firstMd5)) || (lastMd5 && sourceCacheMap.has(lastMd5))) {
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

                    // 🎯 判定成功，收敛并打包整段 ts
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
                        // 🚨 逻辑点 4 承接：未被断定为广告，将首尾 MD5 沉淀至缓存池
                        // 给下一部电影做撞衫对比引信
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

            // ==========================================
            // 打包密投同步至云端 D1 存储层
            // ==========================================
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
                } catch (uploadErr) {
                    // 静默处理
                }
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log("\n🎉 管道清洗结束，新逻辑流完美闭环！");
}

start();