function processM3u8_ddttzy(blocks, baseUrl = "") {
    if (!blocks || blocks.length === 0) return { manifest: "", adUrls: [], adNames: [] };

    const validBlocks = [];
    const extractedAdUrls = [];
    const extractedAdNames = [];
    const headerLines = [];
    let hasFoundFirstTs = false;

    blocks.forEach((block) => {
        const blockSegments = [];
        let extinfBuffer = null;

        block.forEach((line) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return;

            if (trimmedLine.startsWith('#EXTINF:')) {
                const duration = parseFloat(trimmedLine.replace('#EXTINF:', ''));
                extinfBuffer = { extinf: trimmedLine, duration: isNaN(duration) ? 0 : duration, meta: [] };
            } else if (!trimmedLine.startsWith('#')) {
                if (extinfBuffer) {
                    const fullUrl = trimmedLine.startsWith('http') ? trimmedLine : (baseUrl ? new URL(trimmedLine, baseUrl).href : trimmedLine);
                    blockSegments.push({
                        extinf: extinfBuffer.extinf,
                        duration: extinfBuffer.duration,
                        ts: trimmedLine,
                        fullTs: fullUrl,
                        meta: extinfBuffer.meta || []
                    });
                    extinfBuffer = null;
                    hasFoundFirstTs = true;
                }
            } else {
                if (!hasFoundFirstTs && trimmedLine !== '#EXT-X-DISCONTINUITY') {
                    headerLines.push(trimmedLine);
                } else if (trimmedLine !== '#EXT-X-DISCONTINUITY') {
                    if (!extinfBuffer) extinfBuffer = { extinf: "", duration: 0, meta: [] };
                    if (!extinfBuffer.meta) extinfBuffer.meta = [];
                    extinfBuffer.meta.push(trimmedLine);
                }
            }
        });

        if (blockSegments.length === 0) return;

        const totalDuration = blockSegments.reduce((sum, s) => sum + s.duration, 0);

        // 核心数学策略：计算当前 block 内部切片时长的方差（波动剧烈度）
        const avgDuration = totalDuration / blockSegments.length;
        const variance = blockSegments.reduce((sum, s) => sum + Math.pow(s.duration - avgDuration, 2), 0) / blockSegments.length;

        // 核心行业策略：标准商业广告时长池（单位：秒），允许 1.2 秒转码及帧率工程误差
        const standardAdDurations = [5, 10, 15, 20, 30, 45, 60];
        const isStandardAdTime = standardAdDurations.some(targetTime => Math.abs(totalDuration - targetTime) <= 1.2);

        // 复合过滤黄金防火墙（再短的正片，只要时长对不上商业广告档位，或者方差极其平稳，都会被当成正片安全放行）
        const isAd = blockSegments.length > 0 &&
            blockSegments.length < 15 &&
            isStandardAdTime &&
            (variance > 0.5 || blockSegments.some(s => s.duration < 2.0));

        if (isAd) {
            blockSegments.forEach(s => {
                extractedAdUrls.push(s.fullTs);
                extractedAdNames.push(s.ts);
            });
            if (validBlocks.length > 0) {
                validBlocks[validBlocks.length - 1].needInjectDiscontinuityAfter = true;
            }
        } else {
            validBlocks.push(blockSegments);
        }
    });

    let output = headerLines.length > 0 ? headerLines.join('\n') + '\n' : "#EXTM3U\n";
    output += "#EXT-X-DISCONTINUITY\n";

    let pendingDiscontinuity = false;

    validBlocks.forEach((blockSegs, bIdx) => {
        if (pendingDiscontinuity || bIdx > 0) {
            output += "#EXT-X-DISCONTINUITY\n";
            pendingDiscontinuity = false;
        }

        blockSegs.forEach((seg) => {
            if (seg.meta && seg.meta.length > 0) {
                output += seg.meta.join('\n') + '\n';
            }
            output += seg.extinf + '\n';
            output += seg.ts + '\n';
        });

        if (blockSegs.needInjectDiscontinuityAfter) {
            pendingDiscontinuity = true;
        }
    });

    if (!output.includes('#EXT-X-ENDLIST') && validBlocks.length > 0) {
        output += "#EXT-X-ENDLIST\n";
    }

    return {
        manifest: output,
        adUrls: extractedAdUrls,
        adNames: extractedAdNames
    };
}