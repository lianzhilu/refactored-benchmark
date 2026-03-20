// 700.fusion-webshop/703.checkout/nodejs/function.js
const http = require('http');
const { Worker } = require("worker_threads")

const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';
const keepAliveAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 128,
    maxFreeSockets: 16,
    timeout: 600000
});

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
const pendingFunctionResolutions = {};

/**
 * 从代理服务解析函数URL（带缓存）
 */
async function resolveFunctionUrl(functionName) {
    // 检查缓存
    if (functionUrlCache[functionName]) {
        const cached = functionUrlCache[functionName];
        return { ...cached };
    }

    if (pendingFunctionResolutions[functionName]) {
        return pendingFunctionResolutions[functionName];
    }

    const { hostname, port } = parseUrl(PROXY_URL);
    const resolveOptions = {
        hostname: hostname,
        port: port,
        path: `/resolve/${functionName}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000
    };

    pendingFunctionResolutions[functionName] = new Promise((resolveUrl, rejectUrl) => {
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

    const functionInfo = await pendingFunctionResolutions[functionName].finally(() => {
        delete pendingFunctionResolutions[functionName];
    });

    // 存入缓存
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
                agent: keepAliveAgent,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(eventStr)
                },
                timeout: 600000
            };

            const req = http.request(callOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);

                        // 处理 SeBS 响应格式
                        if (parsed.result && parsed.result.output) {
                            const output = parsed.result.output;
                            if (output.body) {
                                const body = typeof output.body === 'string'
                                    ? JSON.parse(output.body)
                                    : output.body;
                                if (body.error) {
                                    reject(new Error(body.error));
                                } else {
                                    resolve(body);
                                }
                                return;
                            }
                        }

                        // 处理标准 HTTP 响应格式
                        if (parsed.body) {
                            const body = typeof parsed.body === 'string'
                                ? JSON.parse(parsed.body)
                                : parsed.body;
                            if (body.error) {
                                reject(new Error(body.error));
                            } else {
                                resolve(body);
                            }
                        } else {
                            if (parsed.error) {
                                reject(new Error(parsed.error));
                            } else {
                                resolve(parsed);
                            }
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
            agent: keepAliveAgent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(eventStr)
            },
            timeout: 600000
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

let js_string = `
const { workerData, parentPort } = require('worker_threads');

let num = workerData.num || 7
let res = cpu_intensive(num)

parentPort.postMessage(res)

// https://gist.github.com/sqren/5083d73f184acae0c5b7
function cpu_intensive(baseNumber) {
	let result = 0;	
	for (var i = Math.pow(baseNumber, 7); i >= 0; i--) {		
		result += Math.atan(i) * Math.tan(i);
	};
    return result;
}
`

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;
        console.log("checkout", input);

        let userId = input.userId || "0"
        let currencyPref = input.currency || "USD"

        // 调用所有函数
        let cart = await invokeFunctionViaProxy("getcart", {userId: userId});
        let productsList = await invokeFunctionViaProxy("listproducts", {});

        // Convert the price of all Products into the preferred currency
        let w1 = new Promise((resolve, reject) => {
            const worker = new Worker(js_string, {
                workerData: {},
                eval: true
            })
            worker.on("message", m => resolve(m))
            worker.on("error", m => reject(m))
        })
        let w2 = new Promise((resolve, reject) => {
            const worker = new Worker(js_string, {
                workerData: {},
                eval: true
            })
            worker.on("message", m => resolve(m))
            worker.on("error", m => reject(m))
        })

        // 处理购物车数据（兼容新旧格式）
        let cartItems = cart.cart || cart.items || (cart.cart && cart.cart.cart) || [];

        // 处理产品列表数据（兼容新旧格式）
        let products = productsList.products || (productsList.productsList && productsList.productsList.products) || productsList || [];

        let orderProducts = cartItems.map(item => {
            let itemId = item.itemId?.S || item.itemId || item.id;
            let pr = products.find(pr => pr.id == itemId);
            if (!pr) return null;
            return { ...pr };
        });
        orderProducts = orderProducts.filter(p => p !== null);

        if (orderProducts.length > 0) {
            let convertedProductsResponse = await invokeFunctionViaProxy("currency", {
                prices: orderProducts.map((product) => product.priceUsd),
                toCode: currencyPref
            });
            let convertedPrices = convertedProductsResponse.prices || [];
            orderProducts = orderProducts.map((product, index) => ({
                ...product,
                price: convertedPrices[index] || product.priceUsd
            }));
        }

        console.log("OrderProducts", orderProducts)

        let shipmentPrice = await invokeFunctionViaProxy("shipmentquote", {userId: userId, items: cartItems});
        let convertedShipmentPrice = await invokeFunctionViaProxy("currency", {
            from: shipmentPrice.costUsd,
            toCode: currencyPref
        });

        // 异步调用 shiporder, email 和 emptycart（不等待结果）
        invokeFunctionAsync("shiporder", {
            address: input.address,
            items: orderProducts
        });
        invokeFunctionAsync("email", {message: "You are shipped"});
        invokeFunctionAsync("emptycart", {userId: userId});

        // 等待 worker 完成
        await w1;
        await w2;

        return {
            statusCode: 200,
            body: JSON.stringify({
                orderProducts: orderProducts,
                convertedShipmentPrice: convertedShipmentPrice
            })
        };
    } catch (error) {
        console.error("Error in checkout:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message
            })
        };
    }
};
