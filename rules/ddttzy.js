function processM3u8_ddttzy(blocks, baseUrl = "") {
    console.log("=== AD FILTER START ===");
    console.log("外部传入的 blocks 总数:", blocks ? blocks.length : 0);

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

        // 诊断日志 1: 检查 block 内是否有有效切片
        if (blockSegments.length === 0) {
            console.log(`[Block ${index}] 这是一个空块（不含有效TS切片），直接跳过评估`);
            return;
        }

        const totalDuration = blockSegments.reduce((sum, s) => sum + s.duration, 0);

        let hasAdFeature = false;
        blockSegments.forEach(s => {
            const dStr = s.duration.toString();
            if (dStr.includes('6666') || dStr.includes('3333') || s.duration < 2.0) {
                hasAdFeature = true;
            }
        });

        // 诊断日志 2: 打印该块的所有特征值
        console.log(`[Block ${index}] 正在评估: ` +
            `切片数量=${blockSegments.length}, ` +
            `总时长=${totalDuration.toFixed(2)}秒, ` +
            `是否包含广告时间特征=${hasAdFeature}`);

        // 判定条件拆解
        const condCount = blockSegments.length > 0 && blockSegments.length < 15;
        const condTime = totalDuration > 10 && totalDuration < 35;

        const isAd = condCount && condTime && hasAdFeature;

        // 诊断日志 3: 打印判定结果及未命中的原因
        if (isAd) {
            console.log(`❌ [Block ${index}] 判定成功：命中广告！正在切除...`);
            blockSegments.forEach(s => extractedAdUrls.push(s.fullTs));
            if (validBlocks.length > 0) {
                validBlocks[validBlocks.length - 1].needInjectDiscontinuityAfter = true;
            }
        } else {
            let reason = [];
            if (!condCount) reason.push(`切片数(${blockSegments.length})不在 1~14 范围内`);
            if (!condTime) reason.push(`总时长(${totalDuration.toFixed(2)}s)不在 10s~35s 范围内`);
            if (!hasAdFeature) reason.push("未检测到 6666/3333 或小于2秒的碎切片特征");
            console.log(`✅ [Block ${index}] 判定成功：认为是正片。未命中广告原因: [${reason.join(' | ')}]`);

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

    console.log("=== AD FILTER END ===");
    return {
        manifest: output,
        adUrls: extractedAdUrls
    };
}