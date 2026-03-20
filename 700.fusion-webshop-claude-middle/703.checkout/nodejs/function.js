// 700.fusion-webshop-claude-middle/703.checkout/nodejs/function.js
// 优化方案：方案1（HTTP Keep-Alive）、方案5（Worker线程池化）、方案7（消除二次JSON解析）
const http = require('http');
const { Worker } = require("worker_threads");
const path = require('path');
const os = require('os');

const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';

// 方案1：创建全局持久化 HTTP Agent，复用 TCP 连接
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 20,
    maxFreeSockets: 5
});

// 方案5：Worker 文件路径（文件模式让 V8 可缓存编译结果，替代 eval 模式）
const WORKER_PATH = path.join(__dirname, 'worker.js');

// 方案5：有界 Worker 线程池，限制同时运行的 CPU 密集型 Worker 数量为 CPU 核数
// 防止高并发下 2N 个 Worker 竞争 CPU，导致所有请求延迟爆炸
const POOL_SIZE = Math.max(2, os.cpus().length);
const workerPool = {
    active: 0,
    queue: [],

    run() {
        return new Promise((resolve, reject) => {
            const task = { resolve, reject };
            if (this.active < POOL_SIZE) {
                this._startWorker(task);
            } else {
                // 超出并发上限，放入队列等待
                this.queue.push(task);
            }
        });
    },

    _startWorker(task) {
        this.active++;
        const worker = new Worker(WORKER_PATH, { workerData: {} });
        worker.on('message', (result) => {
            task.resolve(result);
            this.active--;
            if (this.queue.length > 0) {
                this._startWorker(this.queue.shift());
            }
        });
        worker.on('error', (err) => {
            task.reject(err);
            this.active--;
            if (this.queue.length > 0) {
                this._startWorker(this.queue.shift());
            }
        });
    }
};

function parseUrl(url) {
    url = url.replace(/^https?:\/\//, '');
    if (url.includes(':')) {
        const [hostname, port] = url.split(':');
        return { hostname, port: parseInt(port) };
    } else {
        return { hostname: url, port: 8080 };
    }
}

/**
 * URL缓存：避免重复 resolve 同一个函数
 */
const functionUrlCache = {};

/**
 * 从代理服务解析函数URL（带缓存）
 */
async function resolveFunctionUrl(functionName) {
    if (functionUrlCache[functionName]) {
        const cached = functionUrlCache[functionName];
        return { ...cached };
    }

    const { hostname, port } = parseUrl(PROXY_URL);
    const resolveOptions = {
        hostname: hostname,
        port: port,
        path: `/resolve/${functionName}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000,
        agent: httpAgent  // 方案1
    };

    const functionInfo = await new Promise((resolveUrl, rejectUrl) => {
        const req = http.request(resolveOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        rejectUrl(new Error(`Proxy resolve failed: ${parsed.error}`));
                    } else if (parsed.url) {
                        resolveUrl(parsed);
                    } else {
                        rejectUrl(new Error('Invalid response from proxy: missing url'));
                    }
                } catch (e) {
                    rejectUrl(new Error('Failed to parse proxy response: ' + e.message));
                }
            });
        });
        req.on('error', (e) => rejectUrl(new Error('Failed to resolve function URL: ' + e.message)));
        req.on('timeout', () => { req.destroy(); rejectUrl(new Error('Resolve request timeout')); });
        req.end();
    });

    functionUrlCache[functionName] = {
        url: functionInfo.url,
        container_id: functionInfo.container_id,
        benchmark: functionInfo.benchmark,
        timestamp: Date.now()
    };

    return functionInfo;
}

/**
 * 通过代理服务调用其他函数（同步，等待结果）
 * 方案7：统一解析逻辑，body 已是对象，消除二次 JSON.parse
 */
async function invokeFunctionViaProxy(functionName, event) {
    return new Promise(async (resolve, reject) => {
        try {
            const functionInfo = await resolveFunctionUrl(functionName);

            const { hostname: funcHostname, port: funcPort } = parseUrl(functionInfo.url);
            const eventStr = JSON.stringify(event);
            const callOptions = {
                hostname: funcHostname,
                port: funcPort,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(eventStr)
                },
                timeout: 600000,
                agent: httpAgent  // 方案1
            };

            const req = http.request(callOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);

                        // 方案7：body 统一为对象，消除 typeof 检查和二次 JSON.parse
                        let body;
                        if (parsed.body !== undefined) {
                            body = parsed.body;
                        } else if (parsed.result && parsed.result.output) {
                            const output = parsed.result.output;
                            body = output.body || output;
                        } else {
                            body = parsed;
                        }

                        if (body && body.error) {
                            reject(new Error(body.error));
                        } else {
                            resolve(body);
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse response: ' + e.message + ' | Data: ' + data.substring(0, 200)));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Function call failed to ${functionInfo.url}: ` + e.message)));
            req.on('timeout', () => { req.destroy(); reject(new Error(`Function call timeout to ${functionInfo.url}`)); });
            req.write(eventStr);
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * 异步调用函数（不等待结果，fire-and-forget）
 */
function invokeFunctionAsync(functionName, event) {
    resolveFunctionUrl(functionName).then(functionInfo => {
        const eventStr = JSON.stringify(event);
        const { hostname: funcHostname, port: funcPort } = parseUrl(functionInfo.url);
        const callOptions = {
            hostname: funcHostname,
            port: funcPort,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(eventStr)
            },
            timeout: 600000,
            agent: httpAgent  // 方案1
        };

        const req = http.request(callOptions, (res) => {
            res.on('data', () => {});
            res.on('end', () => {});
        });

        req.on('error', (e) => {
            console.error(`Async call to ${functionName} failed:`, e.message);
        });

        req.on('timeout', () => {
            req.destroy();
            console.error(`Async call to ${functionName} timeout`);
        });

        req.write(eventStr);
        req.end();
    }).catch(e => {
        console.error(`Async resolve ${functionName} failed:`, e.message);
    });
}

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;
        console.log("checkout", input);

        let userId = input.userId || "0";
        let currencyPref = input.currency || "USD";

        let cart = await invokeFunctionViaProxy("getcart", {userId: userId});
        let productsList = await invokeFunctionViaProxy("listproducts", {});

        // 方案5：通过线程池调度，限制并发 Worker 数量，防止 CPU 过度竞争
        let w1 = workerPool.run();
        let w2 = workerPool.run();

        // 方案3：getcart 现在只返回 cart 字段
        let cartItems = cart.cart || cart.items || [];

        let products = productsList.products || productsList || [];

        let orderProducts = await Promise.all(cartItems.map(async item => {
            let itemId = item.itemId?.S || item.itemId || item.id;
            let pr = products.find(pr => pr.id == itemId);
            if (!pr) return null;
            let newPrice = await invokeFunctionViaProxy("currency", {
                from: pr.priceUsd,
                toCode: currencyPref
            });
            pr.price = newPrice;
            return pr;
        }));
        orderProducts = orderProducts.filter(p => p !== null);
        console.log("OrderProducts", orderProducts);

        let shipmentPrice = await invokeFunctionViaProxy("shipmentquote", {userId: userId, items: cartItems});
        let convertedShipmentPrice = await invokeFunctionViaProxy("currency", {
            from: shipmentPrice.costUsd,
            toCode: currencyPref
        });

        invokeFunctionAsync("shiporder", {
            address: input.address,
            items: orderProducts
        });
        invokeFunctionAsync("email", {message: "You are shipped"});
        invokeFunctionAsync("emptycart", {userId: userId});

        // 等待线程池中的 Worker 完成
        await w1;
        await w2;

        // 方案7：body 直接返回对象
        return {
            statusCode: 200,
            body: {
                orderProducts: orderProducts,
                convertedShipmentPrice: convertedShipmentPrice
            }
        };
    } catch (error) {
        console.error("Error in checkout:", error);
        return {
            statusCode: 500,
            body: { error: error.message }
        };
    }
};
