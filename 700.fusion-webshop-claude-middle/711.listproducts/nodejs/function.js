// 700.fusion-webshop-claude-middle/711.listproducts/nodejs/function.js
// 优化方案：方案1（HTTP Keep-Alive）、方案7（消除二次JSON解析）
const http = require('http');

const PROXY_URL = process.env.PROXY_URL || '172.17.0.1:8080';

// 方案1：创建全局持久化 HTTP Agent，复用 TCP 连接
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 20,
    maxFreeSockets: 5
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

const functionUrlCache = {};

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

let products = [
    {
        "id": "1",
        "name": "T-Shirt",
        "description": "For those who know how to code like a boss!",
        "picture": "programmer_tshirt.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 24,
            "nanos": 990000000
        },
        "categories": ["clothing", "programming"]
    },
    {
        "id": "2",
        "name": "Coffee Mug",
        "description": "For those all-nighters coding sessions.",
        "picture": "coffee_mug.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 14,
            "nanos": 990000000
        },
        "categories": ["kitchen", "programming"]
    },
    {
        "id": "3",
        "name": "Computer Mouse",
        "description": "For those who like to point and click, not just point and talk.",
        "picture": "computer_mouse.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 34,
            "nanos": 990000000
        },
        "categories": ["electronics", "computers"]
    },
    {
        "id": "4",
        "name": "Keyboard",
        "description": "For those who prefer to express themselves through typing.",
        "picture": "keyboard.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 44,
            "nanos": 990000000
        },
        "categories": ["electronics", "computers"]
    },
    {
        "id": "5",
        "name": "Monitor",
        "description": "For those who like to keep an eye on things.",
        "picture": "monitor.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 64,
            "nanos": 990000000
        },
        "categories": ["electronics", "computers"]
    },
    {
        "id": "6",
        "name": "Headphones",
        "description": "For those who like to code in silence... or with music.",
        "picture": "headphones.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 74,
            "nanos": 990000000
        },
        "categories": ["electronics", "computers"]
    },
    {
        "id": "7",
        "name": "Computer Case",
        "description": "For those who like to keep their computer looking good and running cool.",
        "picture": "computer_case.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 84,
            "nanos": 990000000
        },
        "categories": ["electronics", "computers"]
    },
    {
        "id": "8",
        "name": "Programmer Hoodie",
        "description": "Stay warm and cozy while coding the night away!",
        "picture": "programmer_hoodie.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 39,
            "nanos": 990000000
        },
        "categories": ["clothing", "programming"]
    },
    {
        "id": "9",
        "name": "Programmer Scarf",
        "description": "Stay stylish and warm during those cold programming sessions.",
        "picture": "programmer_scarf.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 29,
            "nanos": 990000000
        },
        "categories": ["clothing", "programming"]
    },
    {
        "id": "10",
        "name": "Programmer Apron",
        "description": "Keep your clothes clean while you cook up some code!",
        "picture": "programmer_apron.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 19,
            "nanos": 990000000
        },
        "categories": ["kitchen", "programming"]
    },
    {
        "id": "11",
        "name": "Programmer Lunchbox",
        "description": "Take your programming skills to lunch with you!",
        "picture": "programmer_lunchbox.jpg",
        "priceUsd": {
            "currencyCode": "USD",
            "units": 12,
            "nanos": 990000000
        },
        "categories": ["kitchen", "programming"]
    }
];

async function handleBusinessLogic(event, callFunction) {
    console.log("listproducts", event);
    return {
        products: products
    };
}

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;

        const callFunction = async (functionName, params) => {
            return await invokeFunctionViaProxy(functionName, params);
        };

        const result = await handleBusinessLogic(input, callFunction);

        // 方案7：body 直接返回对象
        return {
            statusCode: 200,
            body: result
        };
    } catch (error) {
        console.error("Error in handler:", error);
        return {
            statusCode: 500,
            body: { error: error.message, stack: error.stack }
        };
    }
};
