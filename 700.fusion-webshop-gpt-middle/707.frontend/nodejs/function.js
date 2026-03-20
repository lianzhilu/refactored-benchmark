// 700.fusion-webshop/{function_name}/nodejs/function.js
const http = require('http');

// 从环境变量读取代理服务 URL
const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';
const keepAliveAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 128,
    maxFreeSockets: 16,
    timeout: 600000
});

/**
 * 🆕 根据权重随机选择 operation
 * 在每次 HTTP 请求时动态选择，实现真正的混合负载
 * @param {string} weightsStr - 权重字符串，格式: "get:50,cart:20,checkout:10,addcart:15,emptycart:5"
 * @returns {string} - 选中的操作名称
 */
function selectOperationByWeights(weightsStr) {
    const operations = [];
    const weights = [];

    // 解析权重字符串
    weightsStr.split(',').forEach(item => {
        const [op, weight] = item.split(':');
        operations.push(op.trim());
        weights.push(parseInt(weight.trim()));
    });

    // 计算累积权重并随机选择
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
        headers: {
            'Content-Type': 'application/json'
        },
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

        req.on('error', (e) => {
            rejectUrl(new Error('Failed to resolve function URL: ' + e.message));
        });

        req.on('timeout', () => {
            req.destroy();
            rejectUrl(new Error('Resolve request timeout'));
        });

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
            // 解析函数URL（带缓存）
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

                        // 处理 SeBS 响应格式: {result: {output: {statusCode: 200, body: "..."}}}
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

                        // 处理标准 HTTP 响应格式: {statusCode: 200, body: "..."}
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
                            // 直接返回业务数据（没有包装）
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
    // 启动异步调用但不返回 Promise，不等待结果
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
            // 不读取响应，因为这是异步调用
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
 * 处理前端请求的各种操作
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

            let convertedPricesResponse = await callFunction("currency", {
                prices: productsList_response.products.map((pr) => pr.priceUsd),
                toCode: currencyPref
            });
            let convertedPrices = convertedPricesResponse.prices || [];

            let productsListCurrency = productsList_response.products.map((pr, index) => ({
                ...pr,
                price: convertedPrices[index] || pr.priceUsd
            }));

            let ads = await callFunction("getads", {});
            let get_cart_response = await callFunction("getcart", {userId: userId});
            let get_cart = get_cart_response.cart || get_cart_response;
            let recommendations = await callFunction("listrecommendations", {productIds: get_cart.map(p => p.id || p.itemId)});

            return {
                ads: ads,
                supportedCurrencies: supportedCurrencies,
                recommendations: recommendations,
                cart: get_cart,
                productsList: productsListCurrency
            };
        case "cart":
            let cart_response = await callFunction("getcart", {userId: userId});
            let cart = cart_response.cart || cart_response;
            let shippingCost = await callFunction("shipmentquote", {userId: userId, items: cart});
            return {
                cart: cart,
                shippingCost: shippingCost
            };
        case "checkout":
            // 同步调用 checkout，等待结果
            let checkout_response = await callFunction("checkout", {userId: userId, creditCard: {creditCardNumber: event.creditCardNumber}});
            return checkout_response;
        case "addcart":
            // 同步调用 addcartitem，等待结果
            await callFunction("addcartitem", {
                userId: userId,
                productId: event.productId || "0",
                quantity: event.quantity || 1
            });
            let newCart_response = await callFunction("getcart", {userId: userId});
            let newCart = newCart_response.cart || newCart_response;
            return {
                newItem: {success: true},
                cart: newCart
            };
        case "emptycart":
            // 同步调用 emptycart，等待结果
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
        // 解析输入
        let input = typeof event === 'string' ? JSON.parse(event) : event;

        // 🆕 动态生成 operation（支持混合负载测试）
        // 优先级：
        // 1. input._operation_fixed=true → 不随机化（固定操作）
        // 2. input.operationWeights 存在 → 按权重随机选择（从 input.py 传递）
        // 3. process.env.OPERATION_WEIGHTS 存在 → 按权重随机选择（环境变量）
        // 4. 其他 → 使用 input.operation（默认行为）

        if (!input._operation_fixed) {
            let operationWeightsStr = null;

            // 优先使用 input 中的权重配置（从 input.py 传递，绕过环境变量传递问题）
            if (input.operationWeights) {
                operationWeightsStr = input.operationWeights;
            }
            // 其次使用环境变量（如果容器传递了环境变量）
            else if (process.env.OPERATION_WEIGHTS) {
                operationWeightsStr = process.env.OPERATION_WEIGHTS;
            }

            // 如果有权重配置，执行随机选择
            if (operationWeightsStr) {
                const selectedOperation = selectOperationByWeights(operationWeightsStr);
                input.operation = selectedOperation;

                // 强制输出 operation 选择（用于验证混合负载是否生效）
                console.log(`[FRONTEND-MIXED-LOAD] Weights: ${operationWeightsStr} | Selected: ${selectedOperation}`);
            }
        }

        // 创建 callFunction 和 callFunctionAsync 包装器
        const callFunction = async (functionName, params) => {
            return await invokeFunctionViaProxy(functionName, params);
        };

        const callFunctionAsync = (functionName, params) => {
            invokeFunctionAsync(functionName, params);
        };

        // 调用业务逻辑处理函数
        const result = await handleBusinessLogic(input, callFunction, callFunctionAsync);

        return {
            statusCode: 200,
            body: JSON.stringify(result)
        };
    } catch (error) {
        console.error("Error in handler:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message
            })
        };
    }
};
