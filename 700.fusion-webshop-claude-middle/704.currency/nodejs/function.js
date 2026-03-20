// 700.fusion-webshop-claude-middle/704.currency/nodejs/function.js
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

// Below here is directly from Befaas - its awesome
const EUR_RATES = {
    EUR: 1.0,
    CAD: 1.5231,
    HKD: 8.3693,
    ISK: 157.5,
    PHP: 54.778,
    DKK: 7.4576,
    HUF: 354.7,
    CZK: 27.589,
    AUD: 1.6805,
    RON: 4.84,
    SEK: 10.6695,
    IDR: 16127.82,
    INR: 81.9885,
    BRL: 6.3172,
    RUB: 79.6208,
    HRK: 7.5693,
    JPY: 115.53,
    THB: 34.656,
    CHF: 1.0513,
    SGD: 1.5397,
    PLN: 4.565,
    BGN: 1.9558,
    TRY: 7.4689,
    CNY: 7.6759,
    NOK: 11.0568,
    NZD: 1.8145,
    ZAR: 20.0761,
    USD: 1.0798,
    MXN: 25.8966,
    ILS: 3.8178,
    GBP: 0.88738,
    KRW: 1332.6,
    MYR: 4.6982
};

function getRate(from, to) {
    return EUR_RATES[to] / EUR_RATES[from];
}

function symmetricFloor(amount) {
    if (amount > 0) {
        return Math.floor(amount);
    } else {
        return Math.ceil(amount);
    }
}

function applyRate(units, nanos, rate) {
    const rawUnits = units * rate;
    const newUnits = symmetricFloor(rawUnits);

    const addedNanos = (rawUnits - newUnits) * 1e9;
    const newNanos = symmetricFloor(nanos * rate + addedNanos);

    const addedUnits = symmetricFloor(newNanos / 999999999);

    const finalUnits = newUnits + addedUnits;
    const finalNanos = symmetricFloor(newNanos % 999999999);

    return [finalUnits, finalNanos];
}

async function handleBusinessLogic(event, callFunction) {
    console.log("currency", event);

    const rate = getRate(event.from.currencyCode, event.toCode);
    const [convUnits, convNanos] = applyRate(event.from.units, event.from.nanos, rate);

    return { units: convUnits, nanos: convNanos, currencyCode: event.toCode };
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
