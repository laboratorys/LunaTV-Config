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
 * 🎯 逻辑点 1：递归拆解多码率并提取区段
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
        let nestedM3u8Url = "";
        let totalTsCount = 0;
        let hasStreamInf = m3u8Text.includes("#EXT-X-STREAM-INF");

        for (let line of lines) {
            line = line.trim().replace(/[\x00-\x1F]/g, "");
            if (!line) continue;

            if (line.startsWith("#")) {
                // 根据不连续标记分割区段
                if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                    if (currentSegment.length > 0) {
                        segments.push(currentSegment);
                        currentSegment = [];
                    }
                } else if (line.includes(".m3u8") && !line.startsWith("#EXT-X-STREAM-INF")) {
                    const match = line.match(/https?:\/\/[^\s"'`>]+/);
                    if (match) nestedM3u8Url = match[0];
                }
                continue;
            }
            if (line.includes(".m3u8")) {
                nestedM3u8Url = line;
                break;
            }
            if (line.includes(".ts") || line.includes(".png") || line.includes(".jpg") || line.includes(".jpeg") || line.includes(".image")) {
                let fullTsUrl = line.startsWith("http") ? line : (line.startsWith("/") ? new URL(m3u8Url).origin + line : baseUrl + line);
                currentSegment.push({ filename: line, url: fullTsUrl });
                totalTsCount++;
            }
        }

        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        // 检测到多码率特征，进行优雅下钻
        if (nestedM3u8Url && (totalTsCount === 0 || hasStreamInf || segments.length === 0)) {
            let cleanNestedUrl = nestedM3u8Url.trim().replace(/[\x00-\x1F]/g, "");
            let finalNestedUrl = "";
            if (cleanNestedUrl.startsWith("http")) {
                finalNestedUrl = cleanNestedUrl;
            } else if (cleanNestedUrl.startsWith("/")) {
                finalNestedUrl = new URL(m3u8Url).origin + "/" + cleanNestedUrl.replace(/^\/+/, "");
            } else {
                finalNestedUrl = baseUrl + cleanNestedUrl;
            }

            console.log(`      ➔ [M3U8 重定向] 下钻至: ${finalNestedUrl}`);
            return await fetchAndParseSegments(finalNestedUrl, depth + 1);
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

        // 🚨 逻辑点 4：每个源拥有自己独立的内存缓存池，解析新源时完全隔离
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

            // ⚡ 串行精确获取前 20 部影片
            const sliceLimit = 20;
            const actualCount = apiData.list.length > sliceLimit ? sliceLimit : apiData.list.length;
            console.log(`  📊 [数据就绪] 采集站实际返回 ${apiData.list.length} 条，硬截取前 ${actualCount} 部影片开启串行流水线洗涤...`);

            const adSegmentsToSubmit = [];

            // =================================================================
            // 🚀 核心逻辑改造：串行处理影片，在生命周期内动态完成自交与跨片大碰撞
            // =================================================================
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

                // 🚨 逻辑点 2：如果区段数量小于 2 个（说明没有 #EXT-X-DISCONTINUITY 分隔符），直接认为整流无广告，秒级熔断跳过！
                if (segments.length < 2) {
                    console.log(`       ℹ️ [前置安全放行] 隔离区段数为 ${segments.length}，证明未被插播切刀，判定全片纯净。`);
                    continue;
                }

                console.log(`       📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

                let localVodAdCount = 0;
                // 用来统计当前影片内部，各个区段首片 MD5 出现的频率，以此用来判定自交
                const internalMd5Counts = {};
                // 用来建立当前片内 🌟 首片MD5 -> 区段索引数组 🌟 的对齐射击卡
                const internalMd5ToSegIndices = {};

                // 第一步：预加载符合大小限制（<=20）的候选广告段的首片 MD5
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
                        const firstTsUrl = seg[0].url;
                        const firstMd5 = await calculateFastMd5(firstTsUrl);
                        if (firstMd5) {
                            seg[0].fastMd5 = firstMd5;
                            internalMd5Counts[firstMd5] = (internalMd5Counts[firstMd5] || 0) + 1;
                            if (!internalMd5ToSegIndices[firstMd5]) {
                                internalMd5ToSegIndices[firstMd5] = [];
                            }
                            internalMd5ToSegIndices[firstMd5].push(i);
                        }
                    }
                }

                // 第二步：回溯区段，开始定性收网
                for (let i = 0; i < segments.length; i++) {
                    const currentSeg = segments[i];
                    // 严格执行你的需求：如果切片数量超过了 20，直接作为排除依据，不判定为广告
                    if (currentSeg.length === 0 || currentSeg.length > AD_SEGMENT_MAX_COUNT) continue;

                    const firstMd5 = currentSeg[0]?.fastMd5;
                    if (!firstMd5) continue;

                    let isAdSegment = false;
                    let hitReason = "";

                    // 🚨 逻辑点 3：片内不连续段间自交检测。如果本片内多个插播位首片指纹重复出现，直接坐实广告
                    if (internalMd5Counts[firstMd5] >= 2) {
                        isAdSegment = true;
                        hitReason = `片内多个不同位置插播了相同广告段（自交成功）`;
                    }
                    // 🚨 逻辑点 4：如果自交未触发，去撞单源独立状态池。撞上即代表跨片大撞衫，直接定性广告
                    else if (sourceCacheMap.has(firstMd5)) {
                        const mappedValue = sourceCacheMap.get(firstMd5);
                        if (mappedValue === "CLOUD_KNOWN_AD") {
                            isAdSegment = true;
                            hitReason = `直接命中云端既有历史广告库特征`;
                        } else if (mappedValue !== vodId) {
                            isAdSegment = true;
                            hitReason = `跨影片特征大碰撞（关联片 VOD_ID: ${mappedValue}）`;
                        }
                    }

                    // 🎯 判定成功，开始收敛、高亮日志并包圆整段 ts
                    if (isAdSegment) {
                        localVodAdCount += currentSeg.length;
                        console.log(`      🔥 [确认广告] 区段 [序号:${i+1}] (共 ${currentSeg.length} 片) -> 原因: ${hitReason}`);

                        for (const tsItem of currentSeg) {
                            // 补齐该广告段内所有 ts 文件的 MD5 特征
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
                        // 🚨 逻辑点 4 承接：如果没有被断定为广告，则把当前分段的首片 ts 沉淀至池子，给下一部电影做撞衫对比引信
                        sourceCacheMap.set(firstMd5, vodId);
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