const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
};
const AD_SEGMENT_MAX_COUNT = 20;
const CONCURRENCY_LIMIT = 3; // 影片解析并发限制，防止并发过高被封

function cleanEnvVar(val) {
    if (!val) return "";
    return val.replace(/[^\x20-\x7E]/g, "").trim();
}

let WORKER_BASE_URL = cleanEnvVar(process.env.WORKER_BASE_URL);
if (WORKER_BASE_URL.endsWith("/")) {
    WORKER_BASE_URL = WORKER_BASE_URL.slice(0, -1);
}
const SPIDER_TOKEN = cleanEnvVar(process.env.SPIDER_TOKEN);

// 从 Actions Secret 读取代理基础 URL
// 期待格式: https://aaa.com/proxy?url=
let PROXY_BASE_URL = cleanEnvVar(process.env.PROXY_BASE_URL);

if (!WORKER_BASE_URL) {
    console.error("❌ 错误: 缺失 WORKER_BASE_URL 环境变量。");
}

/**
 * 包装真实请求 URL，如配置了代理则走代理线
 */
function getWrappedUrl(targetUrl) {
    if (!PROXY_BASE_URL) return targetUrl;
    // 如果代理 URL 已经包含 url=，直接拼接，否则根据情况带上参数
    return `${WORKER_BASE_URL}/proxy?url=${encodeURIComponent(targetUrl)}`;
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

// 低能耗 Range 指纹提取（拦截 403 风险，彻底移除全量 Fallback）
async function calculateFastMd5(tsUrl) {
    try {
        // 对采集站的 TS 切片请求套用代理
        const wrappedUrl = getWrappedUrl(tsUrl);
        const res = await httpRequest(wrappedUrl, {
            headers: {
                ...BROWSER_HEADERS,
                Range: "bytes=0-20480"  // ~20KB 头部特征提取
            },
            timeout: 4000
        });

        // 走代理或者部分采集站可能严格返回 206 Partial Content
        if (!res.ok && res.status !== 206) {
            if (res.status === 403) console.error(`      ⚠️ [TS 拦截] 状态码 403，可能代理失效或需要更新特征。`);
            return null;
        }

        const buffer = await res.arrayBuffer();
        return buffer.byteLength > 0 ? crypto.createHash("md5").update(buffer).digest("hex") : null;
    } catch (err) {
        // 安全熔断：彻底放弃全量下载 Fallback，防止网络波动引发死循环、Actions 流量爆表
        return null;
    }
}

async function fetchAndParseSegments(m3u8Url, depth = 0) {
    if (depth > 3) {
        console.error(`      ⚠️ [M3U8 递归] 层级过深，强制截断。`);
        return [];
    }

    try {
        console.log(`      📡 [M3U8请求] ${m3u8Url}`);
        // 对 M3U8 请求套用代理
        const wrappedUrl = getWrappedUrl(m3u8Url);
        const response = await httpRequest(wrappedUrl, {
            headers: { ...BROWSER_HEADERS },
            timeout: 6000,
        });

        if (!response.ok) {
            console.log(`      ❌ [M3U8请求失败] 状态码: ${response.status}`);
            return [];
        }

        const m3u8Text = await response.text();
        const lines = m3u8Text.split("\n");
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        let segments = [];
        let currentSegment = [];
        let nestedM3u8Urls = [];
        let hasStreamInf = false;

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith("#")) {
                if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                    if (currentSegment.length > 0) {
                        segments.push(currentSegment);
                        currentSegment = [];
                    }
                } else if (line.startsWith("#EXT-X-STREAM-INF")) {
                    hasStreamInf = true;
                }
                continue;
            }

            if (line.includes(".m3u8")) {
                let fullUrl;
                if (line.startsWith("http://") || line.startsWith("https://")) {
                    fullUrl = line;
                } else if (line.startsWith("/")) {
                    fullUrl = new URL(m3u8Url).origin + line;
                } else {
                    fullUrl = baseUrl + line;
                }
                nestedM3u8Urls.push(fullUrl);
                console.log(`      🎯 [发现嵌套M3U8] ${fullUrl}`);
            } else if (
                line.includes(".ts") ||
                line.includes(".png") ||
                line.includes(".jpg") ||
                line.includes(".jpeg")
            ) {
                let fullTsUrl = line;
                if (!line.startsWith("http://") && !line.startsWith("https://")) {
                    fullTsUrl = line.startsWith("/")
                        ? new URL(m3u8Url).origin + line
                        : baseUrl + line;
                }
                currentSegment.push({ filename: line, url: fullTsUrl });
            }
        }

        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        console.log(`      📊 [解析结果] 区段数:${segments.length}, 嵌套M3U8数:${nestedM3u8Urls.length}, hasStreamInf:${hasStreamInf}`);

        if (nestedM3u8Urls.length > 0 && (segments.length === 0 || hasStreamInf)) {
            let targetNestedUrl = nestedM3u8Urls.find(u =>
                u.includes("mixed.m3u8") || u.includes("index.m3u8")
            ) || nestedM3u8Urls[0];

            console.log(`      ➔ [M3U8 重定向] 下钻至: ${targetNestedUrl}`);
            return await fetchAndParseSegments(targetNestedUrl, depth + 1);
        }

        return segments;
    } catch (err) {
        console.error(`      ⚠️ [M3U8 抓取异常] URL: ${m3u8Url} | ${err.message}`);
        return [];
    }
}

// 独立封装单个 VOD 处理逻辑
async function processSingleVod(vod, sourceCacheMap, adSegmentsToSubmit) {
    const vodId = String(vod.vod_id).trim().replace(/\.0$/, "");
    const playUrlStr = vod.vod_play_url;
    if (!playUrlStr || !vodId) return;

    const playGroups = playUrlStr.split(/\${2,}/);
    let targetGroup = playGroups.find((group) => group.includes(".m3u8")) || playGroups[0];

    const firstEpisode = targetGroup.split("#")[0];
    let m3u8Url = firstEpisode.includes("$") ? firstEpisode.split("$")[1] : firstEpisode;

    if (!m3u8Url || !m3u8Url.trim().startsWith("http") || !m3u8Url.includes(".m3u8")) {
        console.log(`    ⏩ [过滤无损源] ID: ${vodId} | 名称: ${vod.vod_name} (未检测到直连 M3U8 播放线)`);
        return;
    }

    m3u8Url = m3u8Url.trim();
    console.log(`    🔍 [解析中] ID: ${vodId} | 名称: ${vod.vod_name}`);
    console.log(`       🔗 探测到真实 M3U8: ${m3u8Url}`);

    const segments = await fetchAndParseSegments(m3u8Url);
    if (segments.length < 2) {
        console.log(`      🟩 [直通正片] 区段数 (${segments.length}) < 2，确认为纯净流，秒级跳过。`);
        return;
    }

    const totalTsCount = segments.reduce((sum, seg) => sum + seg.length, 0);
    console.log(`      📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

    // ⚡ 第一阶段：提取高疑短区段首片 Fast-MD5 指纹
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
            seg[0].fastMd5 = await calculateFastMd5(seg[0].url);
        }
    }

    const internalMd5Counts = {};
    segments.forEach((seg) => {
        const firstMd5 = seg[0]?.fastMd5;
        if (firstMd5) {
            internalMd5Counts[firstMd5] = (internalMd5Counts[firstMd5] || 0) + 1;
        }
    });

    let localVodAdCount = 0;

    // ⚡ 第二阶段：双轨判定漏斗
    for (let i = 0; i < segments.length; i++) {
        const currentSeg = segments[i];
        if (currentSeg.length === 0 || currentSeg.length > AD_SEGMENT_MAX_COUNT) continue;

        const firstMd5 = currentSeg[0]?.fastMd5;
        if (!firstMd5) continue;

        let isAdSegment = false;
        let hitReason = "";

        if (internalMd5Counts[firstMd5] >= 2) {
            isAdSegment = true;
            hitReason = `片内不连续段间自交成功（复现 ${internalMd5Counts[firstMd5]} 次）`;
        } else if (sourceCacheMap.has(firstMd5)) {
            const mappedValue = sourceCacheMap.get(firstMd5);
            if (mappedValue === "CLOUD_KNOWN_AD") {
                isAdSegment = true;
                hitReason = `直接命中云端既有历史广告库特征`;
            } else if (mappedValue !== vodId) {
                isAdSegment = true;
                hitReason = `跨影片特征大碰撞（关联片 VOD_ID: ${mappedValue}）`;
            }
        }

        if (isAdSegment) {
            console.log(`      🔥 [确认广告] 区段 [序号:${i + 1}] (共 ${currentSeg.length} 片) -> 原因: ${hitReason}`);

            for (const tsItem of currentSeg) {
                if (!tsItem.fastMd5) {
                    tsItem.fastMd5 = await calculateFastMd5(tsItem.url);
                }
                if (tsItem.fastMd5) {
                    adSegmentsToSubmit.push({
                        vod_id: vodId,
                        fast_md5: tsItem.fastMd5,
                        ts_filename: tsItem.url
                    });
                }
            }
            localVodAdCount += currentSeg.length;
        } else {
            sourceCacheMap.set(firstMd5, vodId);
        }
    }

    if (localVodAdCount > 0) {
        console.log(`      🎉 [清洗完毕] 本片共定性并成功录入广告切片: ${localVodAdCount} 个。`);
    } else {
        console.log(`      ℹ️ [清洗完毕] 暂未触发撞衫，全量待命指纹已沉淀至缓冲池。`);
    }
}

async function start() {
    console.log("🚀 GitHub Actions 纯内存状态机爬虫启动...");
    if (PROXY_BASE_URL) {
        console.log(`🔒 已检测到代理配置，采集站流量将通过中转层进行代理。`);
    } else {
        console.log(`⚠️ 未检测到代理配置，将尝试直连请求。`);
    }

    let configData;
    try {
        const configPath = path.join(__dirname, "tv-ts-ad-source.json");
        const rawConfig = fs.readFileSync(configPath, "utf-8");
        configData = JSON.parse(rawConfig);
    } catch (err) {
        console.error(`❌ 读取本地 tv-ts-ad-source.json 失败: ${err.message}`);
        process.exit(1);
    }

    const apiSite = configData.api_site;
    if (!apiSite) {
        console.error("[系统致命]: 配置节点中缺失 'api_site' 参数。");
        process.exit(1);
    }

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[同步开启] 开始扫描采集站: ${sourceName} (${sourceKey})`);

        const sourceCacheMap = new Map();

        // 预载云端既有规则（此请求不走代理，直接请求你自己的 Worker 避免浪费代理流量）
        try {
            const preloadUrl = `${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`;
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
            // 获取采集源列表的请求同样套用代理
            const wrappedTargetUrl = getWrappedUrl(targetUrl);
            const apiResponse = await httpRequest(wrappedTargetUrl, { timeout: 8000 });

            if (!apiResponse.ok) {
                console.error(`  ⚠️ [请求异常] 状态码: ${apiResponse.status}，跳过该源。`);
                continue;
            }

            const rawText = await apiResponse.text();
            if (rawText.trim().startsWith("<")) {
                console.error(`  ⚠️ [格式错误] 返回 HTML 网页，拒绝解析。`);
                continue;
            }

            let apiData;
            try {
                apiData = JSON.parse(rawText);
            } catch {
                console.error(`  ⚠️ [解析失败] 返回文本非合法 JSON。`);
                continue;
            }

            if (!apiData.list || apiData.list.length === 0) {
                console.log(`  ℹ️ [空列表] 目标源更新列表中无最新影视数据`);
                continue;
            }

            const finalTaskList = apiData.list.slice(0, 20);
            console.log(`  📊 [数据就绪] 采集站实际返回 ${apiData.list.length} 条，硬截取前 ${finalTaskList.length} 部影片并注入并发队列...`);

            const adSegmentsToSubmit = [];

            // 💡 优化：控制并发度限制的微型执行池，防止一次性请求太多导致 WAF 针对代理 IP
            const pool = [];
            for (const vod of finalTaskList) {
                const promise = processSingleVod(vod, sourceCacheMap, adSegmentsToSubmit)
                    .then(() => { pool.splice(pool.indexOf(promise), 1); });
                pool.push(promise);
                if (pool.length >= CONCURRENCY_LIMIT) {
                    await Promise.race(pool);
                }
            }
            await Promise.all(pool); // 等待最后一批剩余的任务完成

            // 打包密投同步至云端 D1 存储层
            if (adSegmentsToSubmit.length > 0) {
                console.log(`  🚀 [同步上传] 正在推送本轮扫描到的 ${adSegmentsToSubmit.length} 条真实广告特征至 D1 库...`);
                try {
                    const bodyData = JSON.stringify({
                        source_key: sourceKey,
                        source_name: sourceName,
                        ad_segments: adSegmentsToSubmit
                    });

                    const uploadRes = await httpRequest(
                        `${WORKER_BASE_URL}/api/submit-ad-segments?token=${SPIDER_TOKEN}`,
                        { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 10000 },
                        bodyData
                    );

                    if (uploadRes.ok) {
                        console.log(`  ✅ [同步成功] 存储层持久化完毕。`);
                    }
                } catch (uploadErr) {
                    console.error(`  ⚠️ [上传失败] ${uploadErr.message}`);
                }
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log(`\n==================================================\n[清洗完成] 爬虫调度管道任务安全结束。`);
}

start();