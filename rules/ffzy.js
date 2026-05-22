function processM3u8_ffzy(blocks, baseUrl) {
    const valid = [];
    const ads = [];

    // 统计一下所有块的时长分布，找出“主流”正片块的时长区间
    const allDurations = blocks.map(b =>
        b.filter(l => l.startsWith("#EXTINF:")).reduce((sum, l) => sum + parseFloat(l.split(':')[1]), 0)
    );

    // 假设广告的特征是“特立独行”：时长与主流正片块差异巨大
    // 我们可以取平均值或者中位数来作为参考
    const avgDuration = allDurations.reduce((a, b) => a + b, 0) / allDurations.length;

    blocks.forEach((block, i) => {
        let totalDuration = 0;
        let count = 0;

        block.forEach(line => {
            if (line.startsWith("#EXTINF:")) {
                totalDuration += parseFloat(line.split(':')[1]);
                count++;
            }
        });

        // 核心判定：
        // 1. 时长确实在 15-22s (你观察到的广告固定范围)
        // 2. 且该块的时长明显小于“正片块”的平均时长 (比如小于平均值的 60%)
        // 3. 排除首尾块
        const isAd = (totalDuration >= 15 && totalDuration <= 22) &&
            (totalDuration < avgDuration * 0.6) &&
            (i > 0 && i < blocks.length - 1);

        if (isAd) {
            console.warn(`[精准拦截] 块 ${i}: 时长 ${totalDuration.toFixed(2)}s, 平均时长 ${avgDuration.toFixed(2)}`);
            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");
            ads.push(...block);
        } else {
            valid.push(block);
        }
    });

    return { validBlocks: valid, adSegments: ads };
}