// 700.fusion-webshop/708.getads/nodejs/function.js
const http = require('http');

// Optimization 1: Enable Keep-Alive
const agent = new http.Agent({ keepAlive: true });

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

// Optimization 5: Promise Cache to prevent Thundering Herd
const pendingResolves = {};

/**
 * 从代理服务解析函数URL（带缓存）
 */
async function resolveFunctionUrl(functionName) {
    // 检查缓存
    if (functionUrlCache[functionName]) {
        const cached = functionUrlCache[functionName];
        return { ...cached };
    }

    // Check pending resolves (Optimization 5)
    if (pendingResolves[functionName]) {
        return await pendingResolves[functionName];
    }

    const { hostname, port } = parseUrl(PROXY_URL);
    const resolveOptions = {
        hostname: hostname,
        port: port,
        path: `/resolve/${functionName}`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000,
        agent: agent // Use shared agent
    };

    const promise = new Promise((resolveUrl, rejectUrl) => {
        const req = http.request(resolveOptions, (res) => {
            // Optimization 4: Buffer Concat
            const chunks = [];
            res.on('data', (chunk) => { chunks.push(chunk); });
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString();
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

    pendingResolves[functionName] = promise;

    try {
        const functionInfo = await promise;
        // 存入缓存
        functionUrlCache[functionName] = {
            url: functionInfo.url,
            container_id: functionInfo.container_id,
            benchmark: functionInfo.benchmark,
            timestamp: Date.now()
        };
        delete pendingResolves[functionName];
        return functionInfo;
    } catch (e) {
        delete pendingResolves[functionName];
        throw e;
    }
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
                agent: agent // Use shared agent
            };

            const req = http.request(callOptions, (res) => {
                // Optimization 4: Buffer Concat
                const chunks = [];
                res.on('data', (chunk) => { chunks.push(chunk); });
                res.on('end', () => {
                    const data = Buffer.concat(chunks).toString();
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

let adsarray = [
    { redirect_url: "https://www.example1.com", image_url: "https://www.example1.com/image1.jpg", text: "Are you tired of debugging your code? Try our new 'Debugging-Free' programming language!" },
    { redirect_url: "https://www.example2.com", image_url: "https://www.example2.com/image2.jpg", text: "Want to impress your colleagues? Learn the latest and greatest programming language: Brainfuck!" },
    { redirect_url: "https://www.example3.com", image_url: "https://www.example3.com/image3.jpg", text: "Tired of staring at a blank screen? Try our 'Code-Generating' software and start coding in minutes!" },
    { redirect_url: "https://www.example4.com", image_url: "https://www.example4.com/image4.jpg", text: "Want to be a real hacker? Learn COBOL!" },
    { redirect_url: "https://www.example5.com", image_url: "https://www.example5.com/image5.jpg", text: "Are you a real programmer? Prove it by coding in Assembly language!" },
    { redirect_url: "https://www.example6.com", image_url: "https://www.example6.com/image6.jpg", text: "Want to be a real man? Code in C!" },
    { redirect_url: "https://www.example7.com", image_url: "https://www.example7.com/image7.jpg", text: "Want to be a real woman? Code in Python!" },
    { redirect_url: "https://www.example8.com", image_url: "https://www.example8.com/image8.jpg", text: "Want to be a real hacker? Learn COBOL!" },
    { redirect_url: "https://www.example9.com", image_url: "https://www.example9.com/image9.jpg", text: "Want to be a real developer? Learn Java!" },
    { redirect_url: "https://www.example10.com", image_url: "https://www.example10.com/image10.jpg", text: "Want to be a real nerd? Learn LISP!" }
];

async function handleBusinessLogic(event, callFunction) {
    console.log("getads", event);
    return adsarray.sort(() => 0.5 - Math.random()).slice(0,2);
}

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;

        const callFunction = async (functionName, params) => {
            return await invokeFunctionViaProxy(functionName, params);
        };\n
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
