import Parser from './parser.js';
import { DEFAULT_TEMPLATE_URL } from './worker.js';

// 定义节点协议列表
const NODE_PROTOCOLS = ['vless:', 'vmess:', 'trojan:', 'ss:', 'ssr:', 'hysteria:', 'tuic:', 'hy2:', 'hysteria2:'];

// 基础配置
const BASE_CONFIG = `mixed-port: 7890
allow-lan: true
external-controller: 127.0.0.1:9090
secret: ''
bind-address: '*'
mode: rule
log-level: info
ipv6: false
dns:
  enable: true
  listen: 0.0.0.0:53
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  fallback:
    - https://1.0.0.1/dns-query
    - tls://dns.google
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4
`;

export async function handleClashRequest(request, env) {
    try {
        const url = new URL(request.url);
        const directUrl = url.searchParams.get('url');
        const templateUrl = url.searchParams.get('template') || DEFAULT_TEMPLATE_URL;
        console.log('Fetching template from:', templateUrl);
        
        // 检查必需的URL参数
        let nodes = [];
        if (directUrl) {
            nodes = await Parser.parse(directUrl, env);
        } else {
            return new Response('Missing required parameters', { status: 400 });
        }

        if (!nodes || nodes.length === 0) {
            return new Response('No valid nodes found', { status: 400 });
        }

        // 获取模板配置
        const templateResponse = await fetch(templateUrl);
        console.log('Template response:', {
            status: templateResponse.status,
            contentType: templateResponse.headers.get('content-type'),
            url: templateUrl
        });
        
        // 检查是否是内部模板URL
        let templateContent;
        if (templateUrl.startsWith('https://inner.template.secret/id-')) {
            const templateId = templateUrl.replace('https://inner.template.secret/id-', '');
            const templateData = await env.TEMPLATE_CONFIG.get(templateId);
            if (!templateData) {
                return new Response('Template not found', { status: 404 });
            }
            const templateInfo = JSON.parse(templateData);
            templateContent = templateInfo.content;
        } else {
            if (!templateResponse.ok) {
                return new Response('Failed to fetch template', { status: 500 });
            }
            templateContent = await templateResponse.text();
        }

        // 生成完整的 Clash 配置
        const config = await generateClashConfig(templateContent, nodes);

        return new Response(config, {
            headers: {
                'Content-Type': 'text/yaml',
                'Content-Disposition': 'attachment; filename=config.yaml'
            }
        });
    } catch (error) {
        console.error('Clash convert error:', error);
        return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
}

async function generateClashConfig(templateContent, nodes) {
    console.log("Starting generateClashConfig with nodes:", nodes);
    
    let config = BASE_CONFIG + '\n';
    console.log("Base config:", config);
    
    // 添加代理节点
    config += 'proxies:\n';
    console.log("Converting nodes to Clash format...");
    
    const proxies = nodes.map(node => {
        console.log("Converting node:", node);
        const converted = convertNodeToClash(node);
        console.log("Converted to:", converted);
        return converted;
    }).filter(Boolean);
    
    console.log("All converted proxies:", proxies);
    
    proxies.forEach(proxy => {
        config += '  -';
        function writeValue(obj, indent = 4) {
            Object.entries(obj).forEach(([key, value]) => {
                // 跳过 undefined 和 null 值
                if (value === undefined || value === null) {
                    return;
                }
                
                const spaces = ' '.repeat(indent);
                if (typeof value === 'object') {
                    config += `\n${spaces}${key}:`;
                    writeValue(value, indent + 2);
                } else {
                    // 处理布尔值和数字
                    const formattedValue = typeof value === 'boolean' || typeof value === 'number' 
                        ? value 
                        : `"${value}"`;
                    config += `\n${spaces}${key}: ${formattedValue}`;
                }
            });
        }
        writeValue(proxy);
        config += '\n';
    });

    // 处理分组
    config += '\nproxy-groups:\n';
    const groupLines = templateContent.split('\n')
        .filter(line => line.startsWith('custom_proxy_group='));
    
    groupLines.forEach(line => {
        const [groupName, ...rest] = line.slice('custom_proxy_group='.length).split('`');
        const groupType = rest[0];
        const options = rest.slice(1);
        
        config += `  - name: "${groupName}"\n`;
        config += `    type: ${groupType === 'url-test' ? 'url-test' : 'select'}\n`;
        
        // 处理 url-test 类型的特殊配置
        if (groupType === 'url-test') {
            const testUrl = options.find(opt => opt.startsWith('http')) || 'http://www.gstatic.com/generate_204';
            const interval = 300;
            const tolerance = groupName.includes('欧美') ? 150 : 50;
            
            config += `    url: ${testUrl}\n`;
            config += `    interval: ${interval}\n`;
            config += `    tolerance: ${tolerance}\n`;
        }
        
        config += '    proxies:\n';
        let hasProxies = false;
        
        // 处理分组选项
        options.forEach(option => {
            if (option.startsWith('[]')) {
                hasProxies = true;
                const groupRef = option.slice(2);
                config += `      - ${groupRef}\n`;
            } else if (option === 'DIRECT' || option === 'REJECT') {
                hasProxies = true;
                config += `      - ${option}\n`;
            } else if (!option.startsWith('http')) {
                try {
                    let matchedCount = 0;
                    // 处理正则表达式过滤
                    let pattern = option;
                    
                    // 处理否定查找
                    if (pattern.includes('(?!')) {
                        const [excludePattern, includePattern] = pattern.split(')).*$');
                        const exclude = excludePattern.substring(excludePattern.indexOf('.*(') + 3).split('|');
                        const include = includePattern ? includePattern.slice(1).split('|') : [];
                        
                        // 添加调试日志
                        console.log('Pattern processing:', {
                            original: pattern,
                            exclude,
                            include,
                            includePattern
                        });
                        
                        const matchedProxies = proxies.filter(proxy => {
                            const isExcluded = exclude.some(keyword => 
                                proxy.name.includes(keyword)
                            );
                            if (isExcluded) return false;
                            
                            // 如果没有包含模式，则返回所有未被排除的节点
                            if (!includePattern || include.length === 0) {
                                return true;
                            }
                            // 如果有包含模式，则需要匹配包含模式
                            return include.some(keyword => 
                                proxy.name.includes(keyword)
                            );
                        });
                        
                        matchedProxies.forEach(proxy => {
                            hasProxies = true;
                            matchedCount++;
                            config += `      - ${proxy.name}\n`;
                        });
                    } else {
                        const filter = new RegExp(pattern);
                        const matchedProxies = proxies.filter(proxy => 
                            filter.test(proxy.name)
                        );
                        matchedProxies.forEach(proxy => {
                            hasProxies = true;
                            matchedCount++;
                            config += `      - ${proxy.name}\n`;
                        });
                    }
                } catch (error) {
                    console.error('Error processing proxy group option:', error);
                }
            }
        });

        // 如果分组没有任何节点，添加 DIRECT
        if (!hasProxies) {
            config += '      - "DIRECT"\n';
        }
    });

    // 处理规则
    config += '\nrules:\n';
    const ruleLines = templateContent.split('\n')
        .filter(line => line.startsWith('ruleset='))
        .map(line => line.trim());
    
    // 获取并解析所有规则列表
    for (const line of ruleLines) {
        const groupEndIndex = line.indexOf(',');
        const group = line.substring('ruleset='.length, groupEndIndex);
        const url = line.substring(groupEndIndex + 1);
        
        if (url.startsWith('[]')) {
            // 处理内置规则
            const ruleContent = url.slice(2);
            
            if (ruleContent === 'MATCH' || ruleContent === 'FINAL') {
                config += `  - MATCH,${group}\n`;
            } else if (ruleContent.startsWith('GEOIP,')) {
                config += `  - ${ruleContent},${group}\n`;
            } else {
                config += `  - ${ruleContent},${group}\n`;
            }
        } else {
            try {
                // 获取规则列表内容
                const response = await fetch(url);
                if (!response.ok) {
                    console.error(`Failed to fetch rules from ${url}: ${response.status}`);
                    continue;
                }
                
                const ruleContent = await response.text();
                const rules = ruleContent.split('\n')
                    .map(rule => rule.trim())
                    .filter(rule => rule && !rule.startsWith('#'));
                
                // 添加解析后的规则
                rules.forEach(rule => {
                    if (rule.includes(',')) {
                        const parts = rule.split(',');
                        const ruleType = parts[0];
                        const ruleValue = parts[1];
                        
                        // 跳过 USER-AGENT 和 URL-REGEX 规则
                        if (ruleType === 'USER-AGENT' || ruleType === 'URL-REGEX') {
                            return;
                        }
                        
                        // 处理规则
                        if (ruleType === 'IP-CIDR' || ruleType === 'IP-CIDR6') {
                            config += `  - ${ruleType},${ruleValue},${group},no-resolve\n`;
                        } else if (ruleType === 'FINAL') {
                            config += `  - MATCH,${group}\n`;
                        } else {
                            config += `  - ${ruleType},${ruleValue},${group}\n`;
                        }
                    }
                });
            } catch (error) {
                console.error(`Error processing rule list ${url}:`, error);
            }
        }
    }

    return config;
}

function convertNodeToClash(node) {
    console.log("Converting node type:", node.type);
    switch (node.type) {
        case 'vmess':
            return convertVmess(node);
        case 'vless':
            return convertVless(node);
        case 'trojan':
            return convertTrojan(node);
        case 'ss':
            return convertShadowsocks(node);
        case 'ssr':
            return convertShadowsocksR(node);
        case 'hysteria':
            return convertHysteria(node);
        case 'hysteria2':
            return convertHysteria2(node);
        case 'tuic':
            return convertTuic(node);
        default:
            console.warn("Unsupported node type:", node.type);
            return null;
    }
}

function convertVmess(node) {
    // 基础配置
    const config = {
        name: node.name,
        type: 'vmess',
        server: node.server,
        port: node.port,
        uuid: node.settings.id,
        alterId: node.settings.aid || 0,
        cipher: 'auto',
        udp: true
    };

    // 网络设置
    if (node.settings.net) {
        config.network = node.settings.net;
        
        // ws 配置
        if (node.settings.net === 'ws') {
            config['ws-opts'] = {
                path: node.settings.path || '/',
                headers: {
                    Host: node.settings.host || ''
                }
            };
        }
    }

    // TLS 设置
    if (node.settings.tls === 'tls') {
        config.tls = true;
        if (node.settings.sni) {
            config.servername = node.settings.sni;
        }
    }

    return config;
}

function convertVless(node) {
    const config = {
        name: node.name,
        type: 'vless',
        server: node.server,
        port: node.port,
        uuid: node.settings.id,
        network: node.settings.type || node.settings.net || 'tcp',
        'skip-cert-verify': false,
        tls: true
    };

    // 基本配置
    if (node.settings.flow) {
        config.flow = node.settings.flow;
    }

    if (node.settings.sni || node.settings.host) {
        config.servername = node.settings.sni || node.settings.host;
    }

    // Reality 配置
    if (node.settings.security === 'reality') {
        config.flow = 'xtls-rprx-vision';
        config['reality-opts'] = {
            'public-key': node.settings.pbk
        };
        config['client-fingerprint'] = node.settings.fp || 'chrome';
    }

    // WebSocket 配置
    if (node.settings.type === 'ws' || node.settings.net === 'ws') {
        config['ws-opts'] = {
            path: node.settings.path || '/',
            headers: {
                Host: node.settings.host || node.settings.sni || node.server
            }
        };
    }

    return config;
}

function convertTrojan(node) {
    return {
        name: node.name,
        type: 'trojan',
        server: node.server,
        port: node.port,
        password: node.settings.password,
        udp: true,
        'skip-cert-verify': true,
        network: node.settings.type || 'tcp',
        'ws-opts': node.settings.type === 'ws' ? {
            path: node.settings.path,
            headers: { Host: node.settings.host }
        } : undefined,
        sni: node.settings.sni || undefined,
        alpn: node.settings.alpn ? [node.settings.alpn] : undefined
    };
}

function convertShadowsocks(node) {
    return {
        name: node.name,
        type: 'ss',
        server: node.server,
        port: node.port,
        cipher: node.settings.method,
        password: node.settings.password,
        udp: true
    };
}

function convertShadowsocksR(node) {
    return {
        name: node.name,
        type: 'ssr',
        server: node.server,
        port: node.port,
        cipher: node.settings.method,
        password: node.settings.password,
        protocol: node.settings.protocol,
        'protocol-param': node.settings.protocolParam,
        obfs: node.settings.obfs,
        'obfs-param': node.settings.obfsParam,
        udp: true
    };
}

function convertHysteria(node) {
    return {
        name: node.name,
        type: 'hysteria',
        server: node.server,
        port: node.port,
        auth_str: node.settings.auth,
        up: node.settings.up,
        down: node.settings.down,
        'skip-cert-verify': true,
        sni: node.settings.sni,
        alpn: node.settings.alpn ? [node.settings.alpn] : undefined,
        obfs: node.settings.obfs
    };
}

function convertHysteria2(node) {
    return {
        name: node.name,
        type: 'hysteria2',
        server: node.server,
        port: node.port,
        password: node.settings.auth,
        'skip-cert-verify': true,
        sni: node.settings.sni,
        obfs: node.settings.obfs,
        'obfs-password': node.settings.obfsParam
    };

}

// 添加新的转换函数
function convertTuic(node) {
    return {
        name: node.name,
        type: 'tuic',
        server: node.server,
        port: node.port,
        uuid: node.settings.uuid,
        password: node.settings.password,
        'congestion-controller': node.settings.congestion_control || 'bbr',
        'udp-relay-mode': node.settings.udp_relay_mode || 'native',
        'reduce-rtt': node.settings.reduce_rtt || false,
        'skip-cert-verify': true,
        sni: node.settings.sni || undefined,
        alpn: node.settings.alpn ? [node.settings.alpn] : undefined
    };
}