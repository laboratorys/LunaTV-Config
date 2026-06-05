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

// 低能耗 Range 指纹提取（完全对齐 Worker 逻辑）
async function calculateFastMd5(tsUrl) {
    try {
        const res = await httpRequest(tsUrl, {
            headers: {
                ...BROWSER_HEADERS,
                Range: "bytes=0-20480"  // ~20KB，和 Worker 的 10KB*2 接近
            },
            timeout: 4000
        });
        if (!res.ok && res.status !== 206) return null;
        const buffer = await res.arrayBuffer();
        return buffer.byteLength > 0 ? crypto.createHash("md5").update(buffer).digest("hex") : null;
    } catch {
        // Fallback：全量请求
        try {
            const res = await httpRequest(tsUrl, { timeout: 5000 });
            if (!res.ok) return null;
            const buffer = await res.arrayBuffer();
            return buffer.byteLength > 0 ? crypto.createHash("md5").update(buffer).digest("hex") : null;
        } catch {
            return null;
        }
    }
}

/**
 * 带有分段感知(Discontinuity)的 M3U8 解析器
 * 修复：正确下钻多码率主清单，兼容相对/绝对路径
 */
async function fetchAndParseSegments(m3u8Url, depth = 0) {
    if (depth > 3) {
        console.error(`      ⚠️ [M3U8 递归] 层级过深，强制截断。`);
        return [];
    }

    try {
        const response = await httpRequest(m3u8Url, { timeout: 6000 });
        if (!response.ok) return [];

        const m3u8Text = await response.text();
        const lines = m3u8Text.split("\n");
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        let segments = [];
        let currentSegment = [];
        let nestedM3u8Urls = [];

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith("#")) {
                if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                    if (currentSegment.length > 0) {
                        segments.push(currentSegment);
                        currentSegment = [];
                    }
                }
                continue;
            }

            // 非注释行：可能是嵌套 m3u8 或 ts 切片
            if (line.includes(".m3u8")) {
                // 兼容相对路径和绝对路径
                let fullUrl;
                if (line.startsWith("http://") || line.startsWith("https://")) {
                    fullUrl = line;
                } else if (line.startsWith("/")) {
                    fullUrl = new URL(m3u8Url).origin + line;
                } else {
                    fullUrl = baseUrl + line;
                }
                nestedM3u8Urls.push(fullUrl);
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

        // 下钻逻辑：如果有嵌套 m3u8 且当前没有 ts 切片，说明是多码率主清单
        if (nestedM3u8Urls.length > 0 && segments.length === 0) {
            // 优先选包含 index 或 mixed 的（通常是默认/最高质量），否则选第一个
            let targetNestedUrl = nestedM3u8Urls.find(u =>
                u.includes("index.m3u8") || u.includes("mixed.m3u8")
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
    if (!apiSite) {
        console.error("[系统致命]: 配置节点中缺失 'api_site' 参数。");
        process.exit(1);
    }

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[同步开启] 开始扫描采集站: ${sourceName} (${sourceKey})`);
        console.log(`[目标接口]: ${baseApiUrl}`);

        // 🎯 每个源独立的内存缓存池（模拟 Worker 的 D1 临时表）
        const sourceCacheMap = new Map();

        // 预载云端既有规则作为引信（模拟 Worker 启动时的历史数据）
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
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1&pagesize=5`;
            const apiResponse = await httpRequest(targetUrl, { timeout: 8000 });
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

            console.log(`  📊 [数据就绪] 采集站实际返回 ${apiData.list.length} 条，硬截取前 ${finalTaskList.length} 部影片进入深度拆解 M3U8...`);

            const adSegmentsToSubmit = [];

            for (const vod of finalTaskList) {
                const vodId = String(vod.vod_id).trim().replace(/\.0$/, "");
                const playUrlStr = vod.vod_play_url;
                if (!playUrlStr || !vodId) continue;

                // 过滤云资源，只取 m3u8 播放线，第一集即可
                const playGroups = playUrlStr.split(/\${2,}/);
                let targetGroup = playGroups.find((group) =>
                    group.includes(".m3u8"),
                );

                if (!targetGroup) {
                    targetGroup = playGroups[0];
                }

                const firstEpisode = targetGroup.split("#")[0];
                let m3u8Url = "";
                if (firstEpisode.includes("$")) {
                    m3u8Url = firstEpisode.split("$")[1];
                } else {
                    m3u8Url = firstEpisode;
                }

                if (
                    !m3u8Url ||
                    !m3u8Url.trim().startsWith("http") ||
                    !m3u8Url.includes(".m3u8")
                ) {
                    console.log(`    ⏩ [过滤无损源] ID: ${vodId} | 名称: ${vod.vod_name} (未检测到直连 M3U8 播放线)`);
                    continue;
                }

                m3u8Url = m3u8Url.trim();

                console.log(`    🔍 [解析中] ID: ${vodId} | 名称: ${vod.vod_name}`);
                console.log(`       🔗 探测到真实 M3U8: ${m3u8Url}`);

                // 下钻抓取并切分区段
                const segments = await fetchAndParseSegments(m3u8Url);
                if (segments.length < 2) {
                    console.log(`      🟩 [直通正片] 区段数 (${segments.length}) < 2，确认为纯净流，秒级跳过。`);
                    continue;
                }

                const totalTsCount = segments.reduce((sum, seg) => sum + seg.length, 0);
                console.log(`      📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

                // ⚡ 第一阶段：提取高疑短区段首片 Fast-MD5 指纹进行内测
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
                        seg[0].fastMd5 = await calculateFastMd5(seg[0].url);
                    }
                }

                // 片内首片 MD5 频率统计
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
                    // 排除依据：长度 > 20 不可能是广告
                    if (currentSeg.length === 0 || currentSeg.length > AD_SEGMENT_MAX_COUNT)
                        continue;

                    const firstMd5 = currentSeg[0]?.fastMd5;
                    if (!firstMd5) continue;

                    let isAdSegment = false;
                    let hitReason = "";

                    // 漏斗 1: 本地片内多点重复碰撞（内部自比）
                    if (internalMd5Counts[firstMd5] >= 2) {
                        isAdSegment = true;
                        hitReason = `片内不连续段间自交成功（复现 ${internalMd5Counts[firstMd5]} 次）`;
                    }
                    // 漏斗 2: 跨片大撞衫（内存缓存池碰撞）
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

                    if (isAdSegment) {
                        console.log(`      🔥 [确认广告] 区段 [序号:${i + 1}] (共 ${currentSeg.length} 片) -> 原因: ${hitReason}`);

                        // 广告段全部解构，补齐所有 ts 的 MD5
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
                        // 片内片外皆无痕迹：沉淀首片 MD5 到缓存池，给后面影片当引信
                        sourceCacheMap.set(firstMd5, vodId);
                    }
                }

                if (localVodAdCount > 0) {
                    console.log(`      🎉 [清洗完毕] 本片共定性并成功录入广告切片: ${localVodAdCount} 个。`);
                } else {
                    console.log(`      ℹ️ [清洗完毕] 暂未触发撞衫，全量待命指纹已沉淀至缓冲池。`);
                }
            }

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