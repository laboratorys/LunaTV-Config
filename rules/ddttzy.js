function processM3u8_ddttzy(blocks, baseUrl = "") {
    if (!blocks || blocks.length === 0) return { manifest: "", adUrls: [] };

    const validBlocks = [];
    const extractedAdUrls = [];
    const headerLines = [];
    let hasFoundFirstTs = false;

    blocks.forEach((block, index) => {
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

        if (index === 0) {
            validBlocks.push(blockSegments);
            return;
        }

        const totalDuration = blockSegments.reduce((sum, s) => sum + s.duration, 0);
        const hasShortSegments = blockSegments.some(s => s.duration < 2.0);
        const standardAdDurations = [5, 10, 15, 20, 30, 45, 60];

        const isStandardAdTime = standardAdDurations.some(targetTime => {
            return Math.abs(totalDuration - targetTime) <= 0.8;
        });

        const isAd = blockSegments.length > 0 &&
            blockSegments.length < 15 &&
            (isStandardAdTime || (totalDuration < 35 && hasShortSegments));

        if (isAd) {
            blockSegments.forEach(s => extractedAdUrls.push(s.fullTs));
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
        adUrls: extractedAdUrls
    };
}