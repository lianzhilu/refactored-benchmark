// 700.fusion-webshop-claude-middle/701.addcartitem/nodejs/function.js
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
        console.log("addcartitem", input);

        // 异步调用 cartkvstorage（不等待结果，与原版 sync=false 一致）
        invokeFunctionAsync("cartkvstorage", {
            operation: "add",
            userId: input["userId"],
            productId: input["productId"],
            quantity: input["quantity"] || 1
        });

        console.log("addcartitem initiated");

        // 方案7：body 直接返回对象
        return {
            statusCode: 200,
            body: { success: true }
        };
    } catch (error) {
        console.error("Error in addcartitem:", error);
        return {
            statusCode: 500,
            body: { error: error.message, stack: error.stack }
        };
    }
};
