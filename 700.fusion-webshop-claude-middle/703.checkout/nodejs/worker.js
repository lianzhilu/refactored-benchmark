// 700.fusion-webshop-claude-middle/703.checkout/nodejs/worker.js
// 方案5：独立 Worker 文件，供 checkout 线程池调用
// 使用文件模式（替代 eval 模式）让 V8 可以缓存编译结果
const { workerData, parentPort } = require('worker_threads');

let num = workerData.num || 7;
let res = cpu_intensive(num);
parentPort.postMessage(res);

// https://gist.github.com/sqren/5083d73f184acae0c5b7
function cpu_intensive(baseNumber) {
    let result = 0;
    for (var i = Math.pow(baseNumber, 7); i >= 0; i--) {
        result += Math.atan(i) * Math.tan(i);
    }
    return result;
}
