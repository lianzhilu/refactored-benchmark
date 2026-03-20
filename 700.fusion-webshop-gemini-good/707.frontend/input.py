import os
import random
import json

def buckets_count():
    """
    返回输入和输出存储桶的数量
    Webshop 应用不需要存储桶
    """
    return (0, 0)

def allocate_nosql():
    """
    定义 Webshop 应用程序需要的 DynamoDB 表

    Returns:
        dict: 表名到表属性的映射
    """
    return {
        "CartTable": {
            "primary_key": "userId",
            "secondary_key": "itemId",
        },
        "ProductTable": {
            "primary_key": "productId",
        }
    }

def _get_operation_weights():
    """
    从环境变量读取操作权重配置
    格式：OPERATION_WEIGHTS=get:50,cart:20,checkout:10,addcart:15,emptycart:5
    返回：dict {"get": 50, "cart": 20, ...}
    """
    weights_str = os.getenv("OPERATION_WEIGHTS", "get:50,cart:20,checkout:10,addcart:15,emptycart:5")
    weights = {}

    for item in weights_str.split(","):
        op, weight = item.split(":")
        weights[op.strip()] = int(weight.strip())

    return weights

def _select_operation_by_weight(weights):
    """
    根据权重随机选择一个操作

    Args:
        weights: dict {"get": 50, "cart": 20, ...}

    Returns:
        str: 选中的操作名，如 "get"
    """
    operations = list(weights.keys())
    weight_values = list(weights.values())

    return random.choices(operations, weights=weight_values, k=1)[0]

def _generate_user_id(size):
    """
    根据size生成用户ID
    为不同操作生成不同的用户ID，避免测试数据冲突
    """
    random_suffix = random.randint(10000, 99999)

    if size.startswith('test'):
        return f"test-user-{random_suffix}"
    elif size.startswith('small'):
        return f"small-user-{random_suffix}"
    else:  # large
        return f"large-user-{random_suffix}"

def _generate_operation_payload(operation, user_id, size):
    """
    为指定操作生成payload

    Args:
        operation: 操作名称
        user_id: 用户ID
        size: 工作负载大小

    Returns:
        dict: 该操作特定的payload
    """

    product_ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]

    # 基础payload
    base_payload = {
        "userId": user_id,
        "currency": "USD" if size != 'small' else "EUR"
    }

    if operation == "get":
        # get操作：获取首页数据
        return base_payload

    elif operation == "cart":
        # cart操作：查看购物车
        return base_payload

    elif operation == "checkout":
        # checkout操作：结账
        return {
            **base_payload,
            "shippingAddress": "123 Test Street",
            "paymentInfo": f"test-payment-{random.randint(1000, 9999)}"
        }

    elif operation == "addcart":
        # addcart操作：添加商品到购物车
        return {
            **base_payload,
            "productId": random.choice(product_ids),
            "quantity": random.randint(1, 5)
        }

    elif operation == "emptycart":
        # emptycart操作：清空购物车
        return base_payload

    else:
        # 未知操作，默认返回get
        return base_payload

def generate_input(data_dir, size, benchmarks_bucket, input_paths, output_paths, upload_func, nosql_func):
    """
    生成测试输入数据（修改后的版本）

    支持多种模式（按优先级）：
    1. 环境变量 OPERATION：设置单一操作（例如：export OPERATION="addcart"）
    2. 环境变量 OPERATION_CONFIG：从配置文件读取 input-size（例如：export OPERATION_CONFIG="config/webshop_mixed_load.json"）
    3. size 格式：size="test_get"、"small_cart"等（需要在 SeBS 中支持）
    4. 随机混合模式：size="random"，按环境变量 OPERATION_WEIGHTS 随机选择
    5. 默认模式：size="test"等，默认执行 get 操作

    :param data_dir: 基准测试数据目录
    :param size: 工作负载大小 ('test', 'small', 'large')
    :param benchmarks_bucket: 存储桶名称（不使用）
    :param input_paths: 输入路径列表（不使用）
    :param output_paths: 输出路径列表（不使用）
    :param upload_func: 上传函数（不使用）
    :param nosql_func: NoSQL 函数（不使用）
    :return: 输入配置字典，将作为 event 传递给函数
    """

    # 🆕 优先级1: 检查是否从配置文件读取 input-size
    # 如果设置了环境变量 OPERATION_CONFIG，则从配置文件读取
    operation = None
    config_operation = None

    operation_config_path = os.getenv("OPERATION_CONFIG")
    if operation_config_path and os.path.exists(operation_config_path):
        try:
            with open(operation_config_path, 'r') as f:
                config_data = json.load(f)
                # 从配置文件中读取 input-size
                config_operation = config_data.get("experiments", {}) \
                                                .get("perf-cost", {}) \
                                                .get("input-size")

            if config_operation and os.getenv("DEBUG_INPUT_GENERATION"):
                print(f"[input.py] Read input-size from config: {config_operation}")
        except Exception as e:
            if os.getenv("DEBUG_INPUT_GENERATION"):
                print(f"[input.py] Failed to read config: {e}")

    # 🆕 优先级2: 检查环境变量 OPERATION（单一操作）
    env_operation = os.getenv("OPERATION")
    if env_operation:
        operation = env_operation
        base_size = size
        if os.getenv("DEBUG_INPUT_GENERATION"):
            print(f"[input.py] Using OPERATION from environment: {operation}")

    # 🆕 优先级3: 使用配置文件的 input-size
    elif config_operation:
        # 配置文件的 input-size 优先
        if config_operation == "random":
            # 随机混合模式
            weights = _get_operation_weights()
            operation = _select_operation_by_weight(weights)
            base_size = "test"
            if os.getenv("DEBUG_INPUT_GENERATION"):
                print(f"[input.py] Using random mode from config, selected: {operation}")
        elif "_" in config_operation:
            # 固定操作模式，例如 "test_addcart"
            parts = config_operation.split("_")
            base_size = parts[0]
            operation = parts[1] if len(parts) > 1 else "get"
            if os.getenv("DEBUG_INPUT_GENERATION"):
                print(f"[input.py] Using config input-size: {config_operation}, parsed operation: {operation}")
        else:
            # 配置文件只指定了 size，没有指定 operation
            base_size = config_operation
            operation = "get"
            if os.getenv("DEBUG_INPUT_GENERATION"):
                print(f"[input.py] Using config size: {base_size}, default operation: get")

    # 🆕 优先级4: 使用 size 参数（命令行传入的 test/small/large）
    elif "_" in size:
        # 固定操作模式 - size格式为 "test_get", "small_cart"等
        parts = size.split("_")
        base_size = parts[0]
        operation = parts[1] if len(parts) > 1 else "get"

    else:
        # 兼容模式 - size为 "test", "small", "large"
        base_size = size
        operation = "get"  # 默认为get，保持向后兼容

    # 验证operation是否有效
    valid_operations = ["get", "cart", "checkout", "addcart", "emptycart"]
    if operation not in valid_operations:
        print(f"Warning: Invalid operation '{operation}', defaulting to 'get'")
        operation = "get"

    # 生成用户ID
    user_id = _generate_user_id(base_size)

    # 生成操作特定的payload
    input_config = _generate_operation_payload(operation, user_id, base_size)

    # 添加operation和traceId
    input_config["operation"] = operation
    input_config["traceId"] = f"{operation}-trace-{random.randint(1000, 9999)}"

    # 🆕 传递 operationWeights 到函数容器（绕过环境变量传递）
    # input.py 在 Shell 中执行，可以读取环境变量，然后通过 input_config 传递给容器内的 function.js
    if os.getenv("OPERATION_WEIGHTS"):
        input_config["operationWeights"] = os.getenv("OPERATION_WEIGHTS")
        if os.getenv("DEBUG_INPUT_GENERATION"):
            print(f"[input.py] Added operationWeights to input: {input_config['operationWeights']}")

    # 打印调试信息（可选）
    if os.getenv("DEBUG_INPUT_GENERATION"):
        print(f"[input.py] Generated: operation={operation}, userId={user_id}")

    return input_config