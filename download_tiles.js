const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const pLimit = require('p-limit');


// 郑州
// minLat（最小纬度）：约34.16°N
// minLng（最小经度）：约112.42°E
// maxLat（最大纬度）：约34.98°N
// maxLng（最大经度）：约114.14°E
const DEFAULT_DATA = {
    minLat: 34.2667,
    minLng: 112.7211,
    maxLat: 34.9895,
    maxLng: 114.2209,
    minZoom: 13,
    maxZoom: 19,
    outputDir: 'tiles'
}
main(DEFAULT_DATA);

// 经纬度转瓦片号
function lonLatToTile(lon, lat, zoom) {
    const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor(
        (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)
    );
    return {x, y};
}

// 瓦片号转中心点经纬度
function tileToLonLat(x, y, z) {
    const n = Math.pow(2, z);
    const lon = x / n * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    const lat = latRad * 180 / Math.PI;
    return {lon, lat};
}

// 判断点是否在矩形边界内
function pointInRect(lon, lat, minLng, minLat, maxLng, maxLat) {
    return lon >= minLng && lon <= maxLng && lat >= minLat && lat <= maxLat;
}

// 检查文件是否存在
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch (err) {
        return false;
    }
}

// 写入失败日志
function writeFailedTileLog(failedTile) {
    const logEntry = `z=${failedTile.z}, x=${failedTile.x}, y=${failedTile.y}, url=${failedTile.url}\n`;
    fs.appendFileSync('failed_tiles.log', logEntry, 'utf-8');
}

// 校验PNG文件是否完整（检查文件头签名）
async function isTileValid(filePath) {
    try {
        const fd = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(8);
        const {bytesRead} = await fd.read(buffer, 0, 8, 0);  // 读取前8字节
        await fd.close();

        // PNG标准文件头签名：0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        return bytesRead === 8 && buffer.equals(pngSignature);
    } catch (err) {
        return false;  // 读取失败或异常视为无效文件
    }
}

// 下载单个瓦片，带重试
async function downloadTile(url, filePath, retry = 3) {
    for (let i = 0; i < retry; i++) {
        try {
            await fs.promises.mkdir(path.dirname(filePath), {recursive: true});
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10 * 1000,
            });
            await fs.promises.writeFile(filePath, response.data);
            return true;
        } catch (err) {
            if (i === retry - 1) {
                return false;
            }
            await new Promise(res => setTimeout(res, 1000)); // 1秒后重试
        }
    }
}

// 主函数
async function main(data) {
    const {minLat, minLng, maxLat, maxLng, minZoom, maxZoom, outputDir} = data;

    const concurrency = 2000; // 并发数
    const limit = pLimit(concurrency);
    const logInterval = 2000; // 每50个瓦片输出一次日志

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    let logCounter = 0;

    // 创建失败日志文件（如果不存在）
    if (!fs.existsSync('failed_tiles.log')) {
        fs.writeFileSync('failed_tiles.log', '', 'utf-8');
    }

    for (let z = minZoom; z <= maxZoom; z++) {
        const batchSize = 1000; // 每批处理1000个任务
        let batchTasks = [];
        const {x: xMin, y: yMax} = lonLatToTile(minLng, minLat, z);
        const {x: xMax, y: yMin} = lonLatToTile(maxLng, maxLat, z);

        for (let x = Math.min(xMin, xMax); x <= Math.max(xMin, xMax); x++) {
            for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
                // 只下载中心点在城市边界内的瓦片
                const {lon, lat} = tileToLonLat(x + 0.5, y + 0.5, z);
                if (!pointInRect(lon, lat, minLng, minLat, maxLng, maxLat)) continue;


                // https://gss3.bdstatic.com/8bo_dTSlRsgBo1vgoIiO_jowehsv/tile/?qt=tile&x=180&y=63&z=10&styles=pl&scaler=1&udt=20170927 //百度瓦片地址
                // https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=52&y=23&z=6   //高德瓦片地址
                const url = `https://gac-geo.googlecnapps.club/maps/vt?lyrs=m@781&hl=zh-CN&gl=CN&x=${x}&y=${y}&z=${z}`;
                const filePath = path.join(outputDir, `${z}`, `${x}`, `${y}.png`);

                batchTasks.push(limit(async () => {
                    // 检查文件是否已存在
                    if (fileExists(filePath)) {
                        const isValid = await isTileValid(filePath);
                        if (isValid) {
                            skippedCount++;
                            logCounter++;
                            if (logCounter >= logInterval) {
                                console.log(`已下载: ${successCount}，失败: ${failCount}，跳过: ${skippedCount}`);
                                logCounter = 0;
                            }
                            return;  // 文件存在且完整，跳过下载
                        } else {
                            console.log(`检测到损坏文件，重新下载：${filePath}`);
                        }
                    }

                    //每下载100000个瓦片，暂停5秒
                    if (successCount % 100000 === 0) {
                        console.log(`暂停5秒，当前成功: ${successCount}，失败: ${failCount}，跳过: ${skippedCount}`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }

                    const ok = await downloadTile(url, filePath);
                    if (ok) {
                        successCount++;
                        logCounter++;
                        if (logCounter >= logInterval) {
                            console.log(`已下载: ${successCount}，失败: ${failCount}，跳过: ${skippedCount}`);
                            logCounter = 0;
                        }
                    } else {
                        failCount++;
                        // 立即写入失败日志
                        writeFailedTileLog({z, x, y, url});
                    }
                }));

                // 达到批次大小后处理当前批次
                if (batchTasks.length >= batchSize) {
                    await Promise.all(batchTasks);
                    batchTasks = []; // 清空批次任务
                }
            }
        }

        // 处理剩余未完成的批次任务
        if (batchTasks.length > 0) {
            await Promise.all(batchTasks);
        }
        console.log(`层级 ${z} 下载完成，当前成功: ${successCount}，失败: ${failCount}，跳过: ${skippedCount}`);
    }

    console.log(`下载完成！成功: ${successCount}，失败: ${failCount}，跳过: ${skippedCount}`);
    if (failCount > 0) {
        console.log('失败瓦片已写入 failed_tiles.log');
    }
}
