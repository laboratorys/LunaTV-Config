function processM3u8(blocks, baseUrl) {
    const valid = [];
    const ads = [];

    // 收集所有时长用于统计
    const allDurations = [];
    blocks.forEach(block => {
        block.forEach(line => {
            const match = line.match(/#EXTINF:([\d.]+)/);
            if (match) allDurations.push(parseFloat(match[1]));
        });
    });
    const avgDuration = allDurations.length > 0
        ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length
        : 0;
    const sortedDurations = [...allDurations].sort((a, b) => a - b);
    const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)] || 0;

    // 提取前一个有效块的域名，用于域名漂移检测
    let prevDomains = new Set();

    blocks.forEach((block, i) => {
        // ===== 特征分析 =====
        const tsSegments = [];
        const adLines = [];
        let totalDuration = 0;
        let hasDiscontinuity = false;
        const domainSet = new Set();
        let resolution = null;
        const segmentDurations = [];

        for (let idx = 0; idx < block.length; idx++) {
            const line = block[idx].trim();
            if (!line) continue;

            if (line.startsWith("#")) {
                if (line === "#EXT-X-DISCONTINUITY") hasDiscontinuity = true;
                if (line.startsWith("#EXT-X-STREAM-INF")) {
                    const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                    if (resMatch) resolution = resMatch[1];
                }
                continue;
            }

            // TS 行
            const prevLine = block[idx - 1] || "";
            let duration = 0;
            if (prevLine.startsWith("#EXTINF:")) {
                const match = prevLine.match(/#EXTINF:([\d.]+)/);
                duration = match ? parseFloat(match[1]) : 0;
                adLines.push(prevLine);
                segmentDurations.push(duration);
            }

            const url = line.startsWith("http") ? line : new URL(line, baseUrl).href;
            domainSet.add(new URL(url).hostname);

            tsSegments.push({ url, duration });
            totalDuration += duration;
            adLines.push(url);
        }

        const count = tsSegments.length;
        const domains = [...domainSet];
        const domainCount = domains.length;

        // ===== 广告检测评分 =====
        let score = 0;
        const reasons = [];

        // 1. 时长异常（广告通常极短或极长）
        if (totalDuration > 0 && totalDuration < 3) {
            score += 2;
            reasons.push("duration_too_short(<3s)");
        }
        if (totalDuration > 60 && count < 5) {
            score += 1;
            reasons.push("long_duration_few_segments");
        }

        // 2. 片段数阈值
        if (count < 3) {
            score += 2;
            reasons.push("too_few_segments(<3)");
        } else if (count < 8 && i > 0) {
            score += 1;
            reasons.push("few_segments(<8)");
        }

        // 3. 多域名
        if (domainCount > 1) {
            score += 2;
            reasons.push("multiple_domains");
        }

        // 4. 与前一有效块域名对比
        const hasOverlap = domains.some(d => prevDomains.has(d));
        if (!hasOverlap && domains.length > 0 && prevDomains.size > 0) {
            score += 2;
            reasons.push("domain_mismatch_with_prev");
        }

        // 5. 片段时长过于规整（广告往往时长整齐划一）
        if (segmentDurations.length > 2) {
            const mean = segmentDurations.reduce((a, b) => a + b, 0) / segmentDurations.length;
            const variance = segmentDurations.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / segmentDurations.length;
            if (variance < 0.1) {
                score += 1;
                reasons.push("uniform_duration(variance<0.1)");
            }
        }

        // 6. 位置特征（开头和结尾的短块更可能是正常内容）
        if (i === 0 || i === blocks.length - 1) {
            score -= 1;
            reasons.push("position_bonus(-1)");
        }

        // 7. 不连续性标记
        if (hasDiscontinuity) {
            score += 1;
            reasons.push("has_discontinuity");
        }

        // 8. 分辨率突变
        if (resolution && i > 0 && prevDomains.size > 0) {
            score += 1;
            reasons.push("resolution_change");
        }

        // ===== 调试日志 =====
        console.log(`\n========== Block ${i} ==========`);
        console.log(`  TS片段数: ${count}`);
        console.log(`  总时长: ${totalDuration.toFixed(2)}s`);
        console.log(`  域名: [${domains.join(", ")}]`);
        console.log(`  域名数: ${domainCount}`);
        console.log(`  与前一有效块域名重叠: ${hasOverlap}`);
        console.log(`  前一有效块域名: [${[...prevDomains].join(", ")}]`);
        console.log(`  不连续性: ${hasDiscontinuity}`);
        console.log(`  分辨率: ${resolution || "无"}`);
        console.log(`  片段时长方差: ${segmentDurations.length > 2 ? (() => {
            const mean = segmentDurations.reduce((a, b) => a + b, 0) / segmentDurations.length;
            return (segmentDurations.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / segmentDurations.length).toFixed(4);
        })() : "N/A"}`);
        console.log(`  评分原因: [${reasons.join(", ") || "无"}]`);
        console.log(`  最终评分: ${score} (阈值: >=3 为广告)`);
        console.log(`  判定结果: ${score >= 3 ? "❌ 广告" : "✅ 正常"}`);

        // ===== 判断与输出 =====
        const isAd = score >= 3;

        if (!isAd) {
            valid.push(block);
            prevDomains = domainSet;
            console.log(`  -> 加入 validBlocks`);
        } else {
            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");
            ads.push(...adLines);
            console.log(`  -> 加入 adSegments, 共 ${adLines.length} 行`);
        }
    });

    console.log(`\n========== 最终结果 ==========`);
    console.log(`  validBlocks: ${valid.length} 个`);
    console.log(`  adSegments: ${ads.length} 行`);

    return { validBlocks: valid, adSegments: ads };
}