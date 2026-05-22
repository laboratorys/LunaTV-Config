function processM3u8_ffzy(blocks, baseUrl) {
    const valid = [];
    const ads = [];

    console.log(`[广告过滤] 开始处理，共 ${blocks.length} 个块`);

    blocks.forEach((block, i) => {
        const tsSegments = [];
        const adLines = [];
        let totalDuration = 0;

        // 1. 基础解析
        for (let idx = 0; idx < block.length; idx++) {
            const line = block[idx].trim();
            if (!line) continue;

            if (line.startsWith("#EXTINF:")) {
                const duration = parseFloat(line.split(':')[1]);
                totalDuration += duration;
                adLines.push(line);
            } else if (!line.startsWith("#")) {
                const url = line.startsWith("http") ? line : new URL(line, baseUrl).href;
                tsSegments.push({ url });
                adLines.push(url);
            } else {
                adLines.push(line);
            }
        }

        const count = tsSegments.length;

        // 2. 更加严格的广告判定（17-20s 且片段 4-10）
        const isAd = (totalDuration >= 17 && totalDuration <= 20) && (count >= 4 && count <= 10);

        // 3. 正片保护：如果当前块是首块或末尾块，或者时长过长，强制不拦截
        // 很多正片的切片被 `#EXT-X-DISCONTINUITY` 强行切断，导致局部时长只有 17-20s
        const isProtected = (i === 0 || i === blocks.length - 1) || (totalDuration > 22 || count > 10);

        if (isAd && !isProtected) {
            console.warn(`[拦截广告] 块 ${i}: 时长 ${totalDuration.toFixed(2)}s, 个数 ${count}`);
            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");
            ads.push(...adLines);
        } else {
            // 正常块
            valid.push(block);
        }
    });

    return { validBlocks: valid, adSegments: ads };
}