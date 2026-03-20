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

def generate_input(data_dir, size, benchmarks_bucket, input_paths, output_paths, upload_func, nosql_func):
    """
    生成测试输入数据
    
    :param data_dir: 基准测试数据目录
    :param size: 工作负载大小 ('test', 'small', 'large')
    :param benchmarks_bucket: 存储桶名称（不使用）
    :param input_paths: 输入路径列表（不使用）
    :param output_paths: 输出路径列表（不使用）
    :param upload_func: 上传函数（不使用）
    :param nosql_func: NoSQL 函数（不使用）
    :return: 输入配置字典，将作为 event 传递给函数
    """
    
    # cartkvstorage 支持的操作：get, add, empty
    # 根据工作负载大小生成不同的输入
    if size == 'test':
        input_config = {
            "userId": "test-user-1",
            "operation": "get",
            "traceId": "test-trace-123"
        }
    elif size == 'small':
        input_config = {
            "userId": "small-user-1",
            "operation": "get",
            "traceId": "small-trace-123"
        }
    else:  # large
        input_config = {
            "userId": "large-user-1",
            "operation": "get",
            "traceId": "large-trace-123"
        }
    
    return input_config

