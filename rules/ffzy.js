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
                // TS 文件地址
                const url = line.startsWith("http") ? line : new URL(line, baseUrl).href;
                tsSegments.push({ url, duration: 0 }); // duration 已在上一步计算
                adLines.push(url);
            } else {
                // 其他 # 开头的标签
                adLines.push(line);
            }
        }

        const count = tsSegments.length;

        // 2. 核心特征判定 (物理属性)
        // 特征：15-22秒，且片段数为 4-10 个
        const isAd = (totalDuration >= 15 && totalDuration <= 22) && (count >= 4 && count <= 10);

        // 极短块防御 (防止广告被切成更细小的单位)
        const isTooShort = (totalDuration > 0 && totalDuration < 10);

        // 3. 结果处理
        if (isAd || isTooShort) {
            console.warn(`[拦截广告] 块 ${i}: 时长 ${totalDuration.toFixed(2)}s, 个数 ${count} -> 已拦截`);

            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");
            ads.push(...adLines);
        } else {
            console.log(`[放行正常] 块 ${i}: 时长 ${totalDuration.toFixed(2)}s, 个数 ${count}`);
            valid.push(block);
        }
    });

    console.log(`[广告过滤] 完成。有效块: ${valid.length}, 拦截片段块: ${ads.length > 0 ? '有' : '无'}`);
    return { validBlocks: valid, adSegments: ads };
}