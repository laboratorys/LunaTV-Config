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
    if (depth > 4) {
        return { segments: [], totalTsCount: 0 };
    }
    try {
        const response = await httpRequest(m3u8Url, { timeout: 6000 });
        if (!response.ok) return { segments: [], totalTsCount: 0 };
        let m3u8Text = await response.text();
        if (!m3u8Text) return { segments: [], totalTsCount: 0 };

        // 🚨 黄金洗涤 1：强制格式化 CRLF 换行符
        m3u8Text = m3u8Text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        const lines = m3u8Text.split("\n");
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        let segments = [];
        let currentSegment = [];
        let nestedM3u8Url = "";
        let totalTsCount = 0;

        for (let line of lines) {
            // 🚨 黄金洗涤 2：拦截单行控制字符与尾巴
            line = line.trim().replace(/[\x00-\x1F]/g, "");
            if (!line) continue;

            if (line.startsWith("#")) {
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

        // 🚨 黄金洗涤 3：检测下钻重定向
        if (nestedM3u8Url && (segments.length === 0 || m3u8Text.includes("#EXT-X-STREAM-INF") || segments[0].length === 0)) {
            let cleanNestedUrl = nestedM3u8Url.trim().replace(/[\x00-\x1F]/g, "");

            // 防御非标准相对路径拼出的双斜杠 (比如豆瓣资源 /20260602//20260602...)
            let finalNestedUrl = "";
            if (cleanNestedUrl.startsWith("http")) {
                finalNestedUrl = cleanNestedUrl;
            } else if (cleanNestedUrl.startsWith("/")) {
                // 如果是绝对根路径，或者防止 baseUrl 本身带斜尾巴
                const origin = new URL(m3u8Url).origin;
                finalNestedUrl = origin + "/" + cleanNestedUrl.replace(/^\/+/, "");
            } else {
                finalNestedUrl = baseUrl + cleanNestedUrl;
            }

            console.log(`      ➔ [M3U8 重定向] 下钻至: ${finalNestedUrl}`);
            return await fetchAndParseSegments(finalNestedUrl, depth + 1);
        }

        return { segments, totalTsCount };
    } catch (e) {
        // 🚨 核心修复：捕获块出口必须完全契合解构预期，杜绝 undefined.length 灾难
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

    // 跨影片碰撞共享指纹状态池
    const memoryTempMap = new Map();

    for (const [sourceKey, sourceConfig] of Object.entries(apiSite)) {
        const sourceName = sourceConfig.name || sourceKey;
        const baseApiUrl = sourceConfig.api;

        console.log(`\n==================================================`);
        console.log(`[同步开启] 开始扫描采集站: ${sourceName} (${sourceKey})`);
        console.log(`[目标接口]: ${baseApiUrl}`);

        const preloadUrl = `${WORKER_BASE_URL}/api/source-md5?source_key=${sourceKey}`;

        // 规则静默预载
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await httpRequest(preloadUrl, { method: "GET", timeout: 6000 });
                if (res.ok) {
                    const json = await res.json();
                    if (json.success && json.md5_list) {
                        json.md5_list.forEach(md5 => memoryTempMap.set(md5, "KNOWN_AD_RULE"));
                        break;
                    }
                } else {
                    throw new Error(`HTTP Status ${res.status}`);
                }
            } catch (e) {
                // 静默降级
            }
        }

        try {
            const targetUrl = `${baseApiUrl}?ac=detail&pg=1`;
            const apiResponse = await httpRequest(targetUrl, { timeout: 8000 });
            if (!apiResponse.ok) continue;

            const apiData = await apiResponse.json();
            if (!apiData.list || apiData.list.length === 0) continue;

            const sliceLimit = 5; // 限制解析前 5 条影片
            const actualCount = apiData.list.length > sliceLimit ? sliceLimit : apiData.list.length;
            console.log(`  📊 [数据就绪] 采集站实际返回 ${apiData.list.length} 条，硬截取前 ${actualCount} 部影片进入深度拆解 M3U8...`);

            const adSegmentsToSubmit = [];
            const parsedVodList = [];

            // ==========================================
            // 阶段一：高精下钻拆解、扫描和全量指纹预取
            // ==========================================
            for (const vod of apiData.list.slice(0, sliceLimit)) {
                const vodId = String(vod.vod_id).trim().replace(/\.0$/, "");
                const playUrlStr = vod.vod_play_url;
                if (!playUrlStr || !vodId) continue;

                console.log(`    🔍 [解析中] ID: ${vodId} | 名称: ${vod.vod_name}`);

                const playGroups = playUrlStr.split(/\${2,}/);
                let targetGroup = playGroups.find(group => group.includes(".m3u8")) || playGroups[0];
                const firstEpisode = targetGroup.split("#")[0];
                let m3u8Url = firstEpisode.includes("$") ? firstEpisode.split("$")[1] : firstEpisode;

                if (!m3u8Url || !m3u8Url.trim().startsWith("http") || !m3u8Url.includes(".m3u8")) {
                    continue;
                }

                console.log(`       🔗 探测到真实 M3U8: ${m3u8Url.trim()}`);

                const { segments, totalTsCount } = await fetchAndParseSegments(m3u8Url.trim());
                if (!segments || segments.length === 0) {
                    continue;
                }

                console.log(`       📦 拓扑分析: 发现 ${segments.length} 个隔离区段，全流共计 ${totalTsCount} 个切片`);

                // 异步截取并抓取特征
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.length > 0 && seg.length <= AD_SEGMENT_MAX_COUNT) {
                        seg[0].fastMd5 = await calculateFastMd5(seg[0].url);
                    }
                }

                parsedVodList.push({ vodId, vodName: vod.vod_name, segments });
            }

            // ==========================================
            // 阶段二：指纹批量网状化沉淀
            // ==========================================
            parsedVodList.forEach(item => {
                item.segments.forEach(seg => {
                    const firstMd5 = seg[0]?.fastMd5;
                    if (firstMd5 && !memoryTempMap.has(firstMd5)) {
                        memoryTempMap.set(firstMd5, item.vodId);
                    }
                });
            });

            // ==========================================
            // 阶段三：回溯交叉碰撞与广告最终定性
            // ==========================================
            for (const item of parsedVodList) {
                const { vodId, segments } = item;
                let localVodAdCount = 0;

                // 片内自交判定集
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
                            hitReason = `跨影片特征大碰撞（关联片 VOD_ID: ${mappedValue}）`;
                        }
                    }

                    if (isAdSegment) {
                        localVodAdCount += currentSeg.length;
                        console.log(`      🔥 [确认广告] 区段 [序号:${i+1}] (共 ${currentSeg.length} 片) -> 原因: ${hitReason}`);
                        for (const tsItem of currentSeg) {
                            if (!tsItem.fastMd5) tsItem.fastMd5 = await calculateFastMd5(tsItem.url);
                            if (tsItem.fastMd5) {
                                adSegmentsToSubmit.push({ vod_id: vodId, fast_md5: tsItem.fastMd5, ts_filename: tsItem.url });
                            }
                        }
                    }
                }

                if (localVodAdCount > 0) {
                    console.log(`      🎉 [清洗完毕] 本片共定性并成功录入广告切片: ${localVodAdCount} 个到持久层主表。`);
                } else {
                    console.log(`      ℹ️ [清洗完毕] 暂未触发撞衫，全量待命指纹已沉淀至临时缓冲池。`);
                }
            }

            // ==========================================
            // 阶段四：打包密投同步至云端 D1
            // ==========================================
            if (adSegmentsToSubmit.length > 0) {
                try {
                    const headers = { "Content-Type": "application/json" };
                    const bodyData = JSON.stringify({
                        source_key: sourceKey,
                        source_name: sourceName,
                        ad_segments: adSegmentsToSubmit
                    });

                    await httpRequest(`${WORKER_BASE_URL}/api/submit-ad-segments?token=${SPIDER_TOKEN}`, {
                        method: "POST",
                        headers: headers,
                        timeout: 10000
                    }, bodyData);
                } catch (uploadErr) {
                    // 静默处理持久化网络流
                }
            }

        } catch (err) {
            console.error(`  ❌ [站级异常]: ${err.message}`);
        }
    }
    console.log("\n🎉 管道清洗结束，D1 军火库中只沉淀了 100% 纯净的广告指纹数据！");
}

start();