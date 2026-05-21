function processM3u8_dyttzy(blocks, baseUrl) {
    const valid = [];
    const ads = [];

    blocks.forEach((block, i) => {
        const tsSegments = block.filter(
            (line) => line.trim() !== "" && !line.startsWith("#")
        );
        const count = tsSegments.length;

        let totalDuration = 0;
        const durations = [];
        let hasShortSegments = false;

        block.forEach((line) => {
            if (line.startsWith("#EXTINF:")) {
                const duration = parseFloat(line.replace("#EXTINF:", ""));
                if (!isNaN(duration)) {
                    totalDuration += duration;
                    durations.push(duration);
                    if (duration < 2.0) hasShortSegments = true;
                }
            }
        });

        const avgDuration = durations.length > 0 ? totalDuration / durations.length : 0;
        const variance = durations.length > 0
            ? durations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / durations.length
            : 0;

        const isAd = i !== 0 &&
            count > 0 &&
            count < 15 &&
            totalDuration >= 10 &&
            totalDuration <= 45 &&
            (variance > 0.5 || hasShortSegments);

        if (!isAd) {
            valid.push(block);
        } else {
            if (ads.length > 0) ads.push("#EXT-X-DISCONTINUITY");

            block.forEach((line, idx) => {
                if (line.startsWith("##EXTINF") || line.startsWith("#EXTINF")) {
                    ads.push(line);
                    const ts = block[idx + 1];
                    if (ts && !ts.startsWith("#")) {
                        ads.push(ts.startsWith("http") ? ts : new URL(ts, baseUrl).href);
                    }
                }
            });
        }
    });

    return { validBlocks: valid, adSegments: ads };
}