// 700.fusion-webshop/714.searchproducts/nodejs/function.js
const http = require('http');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });

const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';

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
    // 检查缓存
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
        agent: httpAgent
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
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(eventStr)
                },
                timeout: 600000,
                agent: httpAgent
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

async function handleBusinessLogic(event, callFunction) {
    console.log("searchproducts", event);

    let products = await callFunction("listproducts", {});
    let query = event.query;

    let filteredProducts = products.products.filter(p => p.name.includes(query) || p.description.includes(query));

    return {
        products: filteredProducts,
        listproducts: products
    };
}

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;

        const callFunction = async (functionName, params) => {
            return await invokeFunctionViaProxy(functionName, params);
        };

        const result = await handleBusinessLogic(input, callFunction);

        return {
            statusCode: 200,
            body: JSON.stringify(result)
        };
    } catch (error) {
        console.error("Error in handler:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message,
                stack: error.stack
            })
        };
    }
};
