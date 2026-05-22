function processM3u8_ffzy(blocks, baseUrl) {
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
    const medianDuration = allDurations.sort((a, b) => a - b)[Math.floor(allDurations.length / 2)] || 0;

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

        // 1. 时长异常
        if (totalDuration > 0 && totalDuration < 3) {
            score += 2;
        }
        if (totalDuration > 60 && count < 5) {
            score += 1;
        }

        // 2. 片段数
        if (count < 3) {
            score += 2;
        } else if (count < 8 && i > 0) {
            score += 1;
        }

        // 3. 多域名
        if (domainCount > 1) {
            score += 2;
        }

        // 4. 与前一有效块域名对比
        const hasOverlap = domains.some(d => prevDomains.has(d));
        if (!hasOverlap && domains.length > 0 && prevDomains.size > 0) {
            score += 2;
        }

        // 5. 片段时长过于规整
        if (segmentDurations.length > 2) {
            const mean = segmentDurations.reduce((a, b) => a + b, 0) / segmentDurations.length;
            const variance = segmentDurations.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / segmentDurations.length;
            if (variance < 0.1) {
                score += 1;
            }
        }

        // 6. 位置降权
        if (i === 0 || i === blocks.length - 1) {
            score -= 1;
        }

        // 7. 不连续性
        if (hasDiscontinuity) {
            score += 1;
        }

        // 8. 分辨率突变（简化：只检查是否有分辨率信息且不是第一个块）
        if (resolution && i > 0 && prevDomains.size > 0) {
            score += 1;
        }

        // ===== 判断与输出 =====
        const isAd = score >= 3;

        if (!isAd) {
            valid.push(block);
            prevDomains = domainSet; // 更新前一个有效块的域名
        } else {
            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");
            ads.push(...adLines);
        }
    });

    return { validBlocks: valid, adSegments: ads };
}