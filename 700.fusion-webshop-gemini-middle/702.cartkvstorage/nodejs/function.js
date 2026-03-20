// 700.fusion-webshop/702.cartkvstorage/nodejs/function.js

const AWS = require("aws-sdk")
AWS.config.update({
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: 'None',
    secretAccessKey: 'None'
});

function getDynamoDBEndpoint() {
    if (process.env.NOSQL_STORAGE_ENDPOINT) {
        let endpoint = process.env.NOSQL_STORAGE_ENDPOINT;
        if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
            const isLinux = process.platform === 'linux';
            const host = isLinux ? '172.17.0.1' : 'host.docker.internal';
            const portMatch = endpoint.match(/:(\d+)/);
            const port = portMatch ? portMatch[1] : '9012';
            endpoint = `${host}:${port}`;
            console.log(`[DynamoDB] Replaced localhost with ${host} in endpoint: ${endpoint}`);
        }
        return `http://${endpoint}`;
    }
    if (process.env.DYNAMODB_ENDPOINT) {
        return process.env.DYNAMODB_ENDPOINT;
    }
    const isLinux = process.platform === 'linux';
    const host = isLinux ? '172.17.0.1' : 'host.docker.internal';
    return `http://${host}:9012`;
}

const ddb = new AWS.DynamoDB({
    apiVersion: '2012-08-10',
    endpoint: getDynamoDBEndpoint(),
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: 'None',
    secretAccessKey: 'None',
    httpOptions: { 
        timeout: 5000,
        agent: new (require('http').Agent)({ keepAlive: true }) 
    }
});

const CartTable = process.env.NOSQL_STORAGE_TABLE_CartTable || "WebshopCartTable";

function eratosthenes(limit) {
    var primes = [];
    if (limit >= 2) {
        var sqrtlmt = Math.sqrt(limit) - 2;
        var nums = new Array();
        for (var i = 2; i <= limit; i++)
            nums.push(i);
        for (var i = 0; i <= sqrtlmt; i++) {
            var p = nums[i]
            if (p)
                for (var j = p * p - 2; j < nums.length; j += p)
                    nums[j] = 0;
        }
        for (var i = 0; i < nums.length; i++) {
            var p = nums[i];
            if (p)
                primes.push(p);
        }
    }
    return primes;
}

exports.handler = async function(event) {
    try {
        let input = typeof event === 'string' ? JSON.parse(event) : event;
        console.log("cartkvstorage", input);

        let operation = input.operation.toLowerCase();

        if (operation == "empty") {
            let current = await ddb.query({
                TableName: CartTable,
                KeyConditionExpression: "#sd = :sid",
                ExpressionAttributeNames: { "#sd": "userId" },
                ExpressionAttributeValues: { ":sid": { S: '' + input.userId } }
            }).promise()

            current = current.Items.map(item => item.itemId.S);
            
            // Optimization 7: BatchWriteItem for cleaning cart
            const BATCH_SIZE = 25;
            for (let i = 0; i < current.length; i += BATCH_SIZE) {
                const batch = current.slice(i, i + BATCH_SIZE);
                const deleteRequests = batch.map(itemId => ({
                    DeleteRequest: {
                        Key: {
                            "userId": { S: input.userId },
                            "itemId": { S: itemId }
                        }
                    }
                }));

                if (deleteRequests.length > 0) {
                    await ddb.batchWriteItem({
                        RequestItems: {
                            [CartTable]: deleteRequests
                        }
                    }).promise();
                }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true
                })
            };
        } else if (operation == "get") {
            let resp = await ddb.query({
                TableName: CartTable,
                KeyConditionExpression: "#sd = :sid",
                ExpressionAttributeNames: { "#sd": "userId" },
                ExpressionAttributeValues: { ":sid": { S: '' + input.userId } }
            }).promise()

            return {
                statusCode: 200,
                body: JSON.stringify({
                    items: resp.Items
                })
            };
        } else if (operation == "add") {
            let [productId, quantity] = [input.productId || "2", input.quantity || 2];
            await ddb.putItem({
                TableName: CartTable,
                Item: {
                    'userId': { S: input.userId.toString() },
                    'itemId': { S: productId.toString() },
                    'quantity': { N: quantity.toString() }
                }
            }).promise()

            eratosthenes(500_000);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true
                })
            };
        }
    } catch (error) {
        console.error("Error in cartkvstorage:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message
            })
        };
    }
};
