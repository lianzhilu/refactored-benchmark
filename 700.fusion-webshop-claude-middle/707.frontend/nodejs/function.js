// 700.fusion-webshop-claude-middle/707.frontend/nodejs/function.js
// 优化方案：方案1（HTTP Keep-Alive）、方案2（消除重复listproducts调用）、方案3（消除冗余响应数据）、方案7（消除二次JSON解析）
const http = require('http');

const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';

// 方案1：创建全局持久化 HTTP Agent，复用 TCP 连接，消除每次调用的 TCP 握手开销
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 20,
    maxFreeSockets: 5
});

/**
 * 🆕 根据权重随机选择 operation
 */
function selectOperationByWeights(weightsStr) {
    const operations = [];
    const weights = [];

    weightsStr.split(',').forEach(item => {
        const [op, weight] = item.split(':');
        operations.push(op.trim());
        weights.push(parseInt(weight.trim()));
    });

    const cumulativeWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const randomValue = Math.random() * cumulativeWeight;

    let selectedOperation = operations[0];
    let currentWeight = 0;

    for (let i = 0; i < operations.length; i++) {
        currentWeight += weights[i];
        if (randomValue <= currentWeight) {
            selectedOperation = operations[i];
            break;
        }
    }

    return selectedOperation;
}

/**
 * 解析 URL，返回 hostname 和 port
 */
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
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 300000,
        agent: httpAgent  // 方案1：复用连接
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

        req.on('error', (e) => {
            rejectUrl(new Error('Failed to resolve function URL: ' + e.message));
        });

        req.on('timeout', () => {
            req.destroy();
            rejectUrl(new Error('Resolve request timeout'));
        });

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
 * 方案7：统一解析逻辑，body 已是对象，消除二次 JSON.parse 和冗余类型检查
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
                agent: httpAgent  // 方案1：复用连接
            };

            const req = http.request(callOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);

                        // 方案7：body 统一为对象，不再需要 typeof 检查和二次 JSON.parse
                        let body;
                        if (parsed.body !== undefined) {
                            // 标准格式: {statusCode, body}（body 已是对象）
                            body = parsed.body;
                        } else if (parsed.result && parsed.result.output) {
                            // SeBS 格式兼容: {result: {output: {statusCode, body}}}
                            const output = parsed.result.output;
                            body = output.body || output;
                        } else {
                            // 直接返回业务数据
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

            req.on('error', (e) => {
                reject(new Error(`Function call failed to ${functionInfo.url}: ` + e.message));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Function call timeout to ${functionInfo.url}`));
            });

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
            agent: httpAgent  // 方案1：复用连接
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

/**
 * 业务逻辑处理函数
 */
async function handleBusinessLogic(event, callFunction, callFunctionAsync) {
    console.log("frontend", event);

    let operation = event.operation || "get";
    let userId = event.userId || "0";
    let currencyPref = event.currency || "USD";

    switch (operation) {
        case "get":
            let supportedCurrencies = await callFunction("supportedcurrencies", {});
            let productsList_response = await callFunction("listproducts", {});
            console.log("productsList", productsList_response);

            let productsListCurrency = await Promise.all(productsList_response.products.map(async (pr) => {
                let newPrice = await callFunction("currency", {
                    from: pr.priceUsd,
                    toCode: currencyPref
                });
                pr.price = {
                    units: newPrice.units,
                    nanos: newPrice.nanos,
                    currencyCode: newPrice.currencyCode
                };
                return pr;
            }));

            let ads = await callFunction("getads", {});
            let get_cart_response = await callFunction("getcart", {userId: userId});
            // 方案3：getcart 现在只返回 cart 字段，直接使用
            let get_cart = get_cart_response.cart || [];

            // 方案2：将已获取的 productsList 传递给 listrecommendations，避免其重复调用 listproducts
            let recommendations = await callFunction("listrecommendations", {
                productIds: get_cart.map(p => p.id || p.itemId),
                products: productsList_response.products
            });

            return {
                ads: ads,
                supportedCurrencies: supportedCurrencies,
                recommendations: recommendations,
                cart: get_cart,
                productsList: productsListCurrency
            };
        case "cart":
            let cart_response = await callFunction("getcart", {userId: userId});
            // 方案3：getcart 现在只返回 cart 字段
            let cart = cart_response.cart || [];
            let shippingCost = await callFunction("shipmentquote", {userId: userId, items: cart});
            return {
                cart: cart,
                shippingCost: shippingCost
            };
        case "checkout":
            let checkout_response = await callFunction("checkout", {userId: userId, creditCard: {creditCardNumber: event.creditCardNumber}});
            return checkout_response;
        case "addcart":
            await callFunction("addcartitem", {
                userId: userId,
                productId: event.productId || "0",
                quantity: event.quantity || 1
            });
            let newCart_response = await callFunction("getcart", {userId: userId});
            // 方案3：getcart 现在只返回 cart 字段
            let newCart = newCart_response.cart || [];
            return {
                newItem: {success: true},
                cart: newCart
            };
        case "emptycart":
            let emptycart_response = await callFunction("emptycart", {userId: userId});
            return emptycart_response;
        default:
            return {
                error: "The operation specified does not exist."
            };
    }
}

/**
 * Lambda 入口函数
 */
exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;

        if (!input._operation_fixed) {
            let operationWeightsStr = null;

            if (input.operationWeights) {
                operationWeightsStr = input.operationWeights;
            } else if (process.env.OPERATION_WEIGHTS) {
                operationWeightsStr = process.env.OPERATION_WEIGHTS;
            }

            if (operationWeightsStr) {
                const selectedOperation = selectOperationByWeights(operationWeightsStr);
                input.operation = selectedOperation;
                console.log(`[FRONTEND-MIXED-LOAD] Weights: ${operationWeightsStr} | Selected: ${selectedOperation}`);
            }
        }

        const callFunction = async (functionName, params) => {
            return await invokeFunctionViaProxy(functionName, params);
        };

        const callFunctionAsync = (functionName, params) => {
            invokeFunctionAsync(functionName, params);
        };

        const result = await handleBusinessLogic(input, callFunction, callFunctionAsync);

        // 方案7：body 直接返回对象，不再 JSON.stringify，消除调用方的二次解析
        return {
            statusCode: 200,
            body: result
        };
    } catch (error) {
        console.error("Error in handler:", error);
        return {
            statusCode: 500,
            body: { error: error.message }
        };
    }
};
